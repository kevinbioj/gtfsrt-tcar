import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import { ANTHROPIC_MODEL } from "../config.js";
import type { RouteDirection } from "../gtfs-rt/use-static-gtfs.js";

export type AlertRouteContext = {
	routeId: string;
	shortName: string;
	directions: RouteDirection[];
};

export type AlertInput = {
	id: string;
	headerText: string;
	descriptionText: string;
	routes: AlertRouteContext[];
	/** Date du jour (ISO AAAA-MM-JJ) pour lever les ambiguïtés de dates relatives / années à 2 chiffres. */
	today: string;
};

/**
 * Un arrêt supprimé (ou une plage d'arrêts), avec les lignes/sens concernés.
 * `directionId: null` = les deux sens. `toStopName` non vide = plage « de stopName à toStopName »
 * (tous les arrêts intermédiaires de l'itinéraire sont aussi supprimés).
 */
export type RemovedStop = {
	stopName: string;
	toStopName: string;
	routes: { routeId: string; directionId: number | null }[];
};

/**
 * Tranche horaire quotidienne (heures locales) d'une perturbation récurrente. `to` <= `from`
 * signifie que la tranche passe minuit (elle se termine le lendemain matin).
 */
export type DailyWindow = { from: string; to: string };

/**
 * Période d'effet de la perturbation, extraite du texte. `null` = non précisé / ouvert.
 * Les bornes valent soit `AAAA-MM-JJ` (journée entière, fin incluse), soit `AAAA-MM-JJTHH:MM`
 * (instant exact, fin exclue). `dailyWindow` non nul restreint la période à une tranche horaire
 * répétée chaque jour de l'enveloppe.
 */
export type AlertPeriod = { start: string | null; end: string | null; dailyWindow: DailyWindow | null };

export type AlertAnalysis = { removedStops: RemovedStop[]; period: AlertPeriod };

// Toutes les alertes sont analysées en UN seul appel : le schéma renvoie un résultat par alerte,
// identifié par l'`id` fourni en entrée.
const BATCH_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		results: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string" },
					removedStops: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								stopName: { type: "string" },
								toStopName: { type: "string" },
								routes: {
									type: "array",
									items: {
										type: "object",
										additionalProperties: false,
										properties: {
											routeId: { type: "string" },
											directionId: { type: "string", enum: ["0", "1", "any"] },
										},
										required: ["routeId", "directionId"],
									},
								},
							},
							required: ["stopName", "toStopName", "routes"],
						},
					},
					period: {
						type: "object",
						additionalProperties: false,
						properties: {
							start: { type: "string" },
							end: { type: "string" },
							dailyWindow: {
								type: "object",
								additionalProperties: false,
								properties: {
									from: { type: "string" },
									to: { type: "string" },
								},
								required: ["from", "to"],
							},
						},
						required: ["start", "end", "dailyWindow"],
					},
				},
				required: ["id", "removedStops", "period"],
			},
		},
	},
	required: ["results"],
} as const;

const SYSTEM_PROMPT = `Tu analyses des alertes de service d'un réseau de transport en commun à Rouen (bus/tram/métro).
On te fournit PLUSIEURS alertes en une seule fois. Pour CHACUNE, identifie UNIQUEMENT les arrêts (stations) qui ne sont PAS desservis / supprimés pendant la perturbation.

Renvoie un objet par alerte dans "results", en réutilisant EXACTEMENT l'"id" fourni en entrée. Traite toutes les alertes, même celles sans arrêt supprimé (removedStops vide).

RÈGLES STRICTES :
- Ne retourne QUE les arrêts explicitement non desservis, supprimés ou sautés.
- N'inclus PAS les arrêts simplement reportés, déplacés de quelques mètres, déviés, ni les arrêts de report/substitution, ni les informations d'ascenseurs/escaliers/quais.
- Pour chaque arrêt supprimé, indique les lignes concernées (uniquement parmi celles fournies) et le sens.
- Sens : sers-toi des terminus (headsigns) fournis pour chaque ligne afin de déduire directionId ("0" ou "1").
  - La direction est souvent donnée par le SENS DE LA DÉVIATION, indiqué globalement en tête de l'alerte (« Déviation en direction de X », « vers X »), parfois différent par ligne (« Déviation en direction de X (F2), Y (F7) et Z (22) »). Dans ce cas, applique cette direction aux arrêts supprimés de la ligne concernée, MÊME SI la phrase de suppression ne répète pas le sens. Rapproche le terminus/lieu cité (X) du headsign de la ligne pour trouver directionId.
  - « dans les deux sens » → "any".
  - N'utilise "any" que si AUCUNE direction n'est déductible pour la ligne.
- Utilise EXACTEMENT le nom de l'arrêt tel qu'il est écrit dans l'alerte.
- Si aucun arrêt n'est supprimé, retourne une liste vide.

PLAGES D'ARRÊTS :
- Si le texte décrit une PLAGE d'arrêts consécutifs ("de X à Y", "entre X et Y", "des arrêts X à Y", "de X jusqu'à Y"), renvoie UN SEUL removedStop avec stopName="X" (premier arrêt de la plage) et toStopName="Y" (dernier arrêt). Tous les arrêts intermédiaires seront supprimés automatiquement.
- Pour un arrêt seul, ou une liste explicite ("X, Y et Z"), renvoie des entrées séparées avec toStopName="".

PÉRIODE D'EFFET (champ "period") :
- Extrais du texte le DÉBUT et la FIN de la perturbation (la période pendant laquelle l'arrêt n'est pas desservi).
- Format : "AAAA-MM-JJ" si le texte ne donne qu'une date, "AAAA-MM-JJTHH:MM" (heure locale) dès qu'il précise une heure.
- Une borne "AAAA-MM-JJ" couvre la journée entière : le début vaut 00:00 et la fin est INCLUSIVE (toute la journée citée).
- Une borne "AAAA-MM-JJTHH:MM" est exacte, et la fin est EXCLUSIVE (la perturbation s'arrête à cette heure précise).
- Utilise les heures DÈS QU'ELLES SONT DONNÉES, y compris pour les interventions courtes ou de nuit.
  - « Travaux de nuit le 21 juillet (20h>5h) — nuit du mardi 21 juillet de 20h à 5h, reprise le mercredi 22 juillet à 5h »
    → start "2026-07-21T20:00", end "2026-07-22T05:00" (et surtout PAS start "2026-07-21" qui l'activerait dès le matin).
  - « le 3 mars de 9h à 16h » → start "2026-03-03T09:00", end "2026-03-03T16:00".
- Si une borne n'est pas précisée ou est ouverte ("à nouvel avis", "jusqu'à nouvel ordre", "durée indéterminée"), mets la chaîne vide "".
- NE CONFONDS PAS la date d'édition/publication de l'info (ex. "Info ASTUCE 20/06/2026") avec la période de la perturbation.
- Interprète les années à 2 chiffres (ex. "20/01/26" = 2026) et sers-toi de la date du jour fournie pour lever toute ambiguïté.

ANNONCE D'UN RETOUR À LA NORMALE :
- Le réseau réécrit souvent l'info quelques jours avant la fin pour ANNONCER LA REPRISE plutôt que la perturbation
  (« Le 22.07.26, parcours normal route d'Houppeville », « Mercredi 22 juillet 2026 : reprise du parcours normal »,
  « à compter du 5 mai, retour à l'itinéraire habituel », « fin des travaux le 30 août »).
- La date citée est alors la date de FIN de la perturbation, PAS son début : la perturbation reste en vigueur
  JUSQU'À ce moment, EXCLU.
- Renseigne donc end à l'INSTANT de la reprise, pour que le dernier jour perturbé soit bien la veille :
  « Le 22.07.26, parcours normal » → end "2026-07-22T00:00" (perturbé jusqu'au mardi 21/07 au soir inclus).
  « reprise le 22 juillet à 5h » → end "2026-07-22T05:00".
  N'écris SURTOUT PAS end "2026-07-22" (qui prolongerait à tort la perturbation toute la journée du 22),
  ni start "2026-07-22" (qui la ferait commencer le jour même de la reprise).
- start reste "" si le texte ne dit pas quand la perturbation a commencé : elle est déjà en cours.
- Les arrêts non desservis à renvoyer sont ceux de la perturbation ENCORE EN COURS. N'inclus pas un arrêt
  uniquement cité comme redevenant desservi à la reprise.
- Si la reprise ne concerne qu'une PARTIE des lignes (« lignes F2 et 22 : reprise du parcours normal, lignes F8-10-43 :
  reprise de la déviation par la route de Maromme »), borne quand même l'alerte à cette date : mieux vaut cesser trop tôt
  d'annoncer un arrêt non desservi que d'en annoncer un qui l'est de nouveau. Le réseau republie une info à jour pour
  les lignes encore déviées.

TRANCHE HORAIRE RÉCURRENTE (champ "period.dailyWindow") :
- À remplir UNIQUEMENT si la perturbation se répète chaque jour sur une même tranche horaire, sur PLUSIEURS jours
  (ex. « du 20 au 24 juillet, chaque nuit de 20h à 5h », « tous les jours de 9h à 16h jusqu'au 30 août »).
- Renseigne alors from/to au format "HH:MM" ; si "to" est <= "from", la tranche passe minuit et se termine le lendemain matin.
- Dans ce cas, start/end sont des DATES SEULES "AAAA-MM-JJ" délimitant les jours où la tranche DÉBUTE
  (start = premier jour concerné, end = dernier jour où la tranche commence).
- Pour une perturbation continue, ou limitée à une seule nuit / une seule journée, laisse from et to vides ("") et exprime tout via start/end.`;

const cache = new Map<string, { hash: string; result: AlertAnalysis }>();

let client: Anthropic | undefined;
let warnedMissingKey = false;
let cachePath: string | undefined;
let dirty = false;

const EMPTY: AlertAnalysis = { removedStops: [], period: { start: null, end: null, dailyWindow: null } };

/** Charge le cache persistant depuis le disque au démarrage (aucun ré-appel IA si inchangé). */
export function loadCache(path: string) {
	cachePath = path;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, { hash?: unknown; result?: unknown }>;
		let loaded = 0;
		for (const [id, entry] of Object.entries(raw)) {
			if (typeof entry?.hash !== "string" || !isAlertAnalysis(entry.result)) continue;
			cache.set(id, { hash: entry.hash, result: entry.result });
			loaded += 1;
		}
		console.log(`✓ Loaded ${loaded} cached alert analyses.`);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn("✘ Failed to read alert cache — starting fresh.", cause);
		}
	}
}

/** Supprime du cache les alertes qui ne sont plus présentes dans le flux. */
export function pruneCache(currentIds: Set<string>) {
	for (const id of cache.keys()) {
		if (!currentIds.has(id)) {
			cache.delete(id);
			dirty = true;
		}
	}
}

/** Écrit le cache sur disque s'il a changé. */
export function flushCache() {
	if (!dirty || cachePath === undefined) return;
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)));
		dirty = false;
	} catch (cause) {
		console.error("✘ Failed to persist alert cache:", cause);
	}
}

/**
 * Analyse un lot d'alertes. Les alertes déjà en cache (hash inchangé) ne sont pas renvoyées à
 * l'IA ; toutes les autres sont traitées en UN SEUL appel. Renvoie un résultat par alerte.
 */
export async function analyzeAlerts(alerts: AlertInput[]): Promise<Map<string, AlertAnalysis>> {
	const result = new Map<string, AlertAnalysis>();
	const hashById = new Map<string, string>();
	const toAnalyze: AlertInput[] = [];

	for (const alert of alerts) {
		const hash = hashAlert(alert);
		hashById.set(alert.id, hash);
		const cached = cache.get(alert.id);
		if (cached?.hash === hash) {
			result.set(alert.id, cached.result);
		} else {
			toAnalyze.push(alert);
		}
	}

	if (toAnalyze.length > 0) {
		const analyses = await runBatch(toAnalyze);
		for (const alert of toAnalyze) {
			const analysis = analyses.get(alert.id);
			if (analysis !== undefined) {
				// Mise en cache uniquement des alertes réellement renvoyées : une troncature ou une
				// erreur ne fige pas un résultat vide (elles seront réanalysées au prochain changement).
				cache.set(alert.id, { hash: hashById.get(alert.id)!, result: analysis });
				dirty = true;
				result.set(alert.id, analysis);
			} else {
				result.set(alert.id, EMPTY);
			}
		}
	}

	return result;
}

// ---

async function runBatch(alerts: AlertInput[]): Promise<Map<string, AlertAnalysis>> {
	const out = new Map<string, AlertAnalysis>();

	const anthropic = getClient();
	if (anthropic === undefined) return out;

	const payload = alerts.map((alert) => ({
		id: alert.id,
		headerText: alert.headerText,
		descriptionText: alert.descriptionText,
		routes: alert.routes,
	}));

	const userContent = [
		`Date du jour : ${alerts[0]?.today ?? ""}`,
		"",
		"Alertes à analyser (chaque objet : id, headerText, descriptionText, routes[routeId, nom, sens/terminus]) :",
		JSON.stringify(payload),
	].join("\n");

	try {
		const response = await anthropic.messages.create({
			model: ANTHROPIC_MODEL,
			max_tokens: 16_000,
			system: SYSTEM_PROMPT,
			output_config: { format: { type: "json_schema", schema: BATCH_SCHEMA } },
			messages: [{ role: "user", content: userContent }],
		});

		const text = response.content.find((block) => block.type === "text")?.text;
		if (!text) return out;

		const parsed = JSON.parse(text) as { results?: unknown };
		if (Array.isArray(parsed.results)) {
			for (const item of parsed.results) {
				const id = (item as { id?: unknown }).id;
				if (typeof id === "string") out.set(id, normalizeAnalysis(item));
			}
		}
	} catch (cause) {
		console.error("✘ Alert batch analysis failed:", cause);
	}

	return out;
}

function normalizeAnalysis(raw: unknown): AlertAnalysis {
	if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { removedStops?: unknown }).removedStops)) {
		return EMPTY;
	}

	const removedStops: RemovedStop[] = [];
	for (const stop of (raw as { removedStops: unknown[] }).removedStops) {
		if (typeof stop !== "object" || stop === null) continue;
		const stopName = (stop as { stopName?: unknown }).stopName;
		const toStopNameRaw = (stop as { toStopName?: unknown }).toStopName;
		const routesRaw = (stop as { routes?: unknown }).routes;
		if (typeof stopName !== "string" || !Array.isArray(routesRaw)) continue;

		const routes: RemovedStop["routes"] = [];
		for (const route of routesRaw) {
			if (typeof route !== "object" || route === null) continue;
			const routeId = (route as { routeId?: unknown }).routeId;
			const directionId = (route as { directionId?: unknown }).directionId;
			if (typeof routeId !== "string") continue;
			routes.push({ routeId, directionId: parseDirection(directionId) });
		}

		const toStopName = typeof toStopNameRaw === "string" ? toStopNameRaw : "";
		if (routes.length > 0) removedStops.push({ stopName, toStopName, routes });
	}

	return { removedStops, period: parsePeriod((raw as { period?: unknown }).period) };
}

/** Validation légère d'un résultat lu depuis le cache disque (forme finale, directionId numérique). */
function isAlertAnalysis(value: unknown): value is AlertAnalysis {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { removedStops?: unknown; period?: unknown };
	return Array.isArray(candidate.removedStops) && typeof candidate.period === "object" && candidate.period !== null;
}

function parsePeriod(raw: unknown): AlertPeriod {
	if (typeof raw !== "object" || raw === null) return { start: null, end: null, dailyWindow: null };
	return {
		start: parseDate((raw as { start?: unknown }).start),
		end: parseDate((raw as { end?: unknown }).end),
		dailyWindow: parseDailyWindow((raw as { dailyWindow?: unknown }).dailyWindow),
	};
}

function parseDate(value: unknown): string | null {
	if (typeof value !== "string") return null;
	// L'IA renvoie "AAAA-MM-JJ", "AAAA-MM-JJTHH:MM" ou "" (borne inconnue / ouverte).
	return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value) ? value : null;
}

/** Tranche horaire quotidienne, ignorée si l'une des deux bornes manque (cas courant : perturbation continue). */
function parseDailyWindow(value: unknown): DailyWindow | null {
	if (typeof value !== "object" || value === null) return null;
	const from = (value as { from?: unknown }).from;
	const to = (value as { to?: unknown }).to;
	if (typeof from !== "string" || typeof to !== "string") return null;
	if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) return null;
	return { from, to };
}

function parseDirection(value: unknown): number | null {
	if (value === "0") return 0;
	if (value === "1") return 1;
	return null;
}

function getClient(): Anthropic | undefined {
	if (client !== undefined) return client;
	if (!process.env.ANTHROPIC_API_KEY) {
		if (!warnedMissingKey) {
			console.warn("✘ ANTHROPIC_API_KEY is not set — skipped-stop detection is disabled.");
			warnedMissingKey = true;
		}
		return undefined;
	}
	client = new Anthropic({ timeout: 60_000, maxRetries: 3 });
	return client;
}

// Version du schéma/prompt d'analyse : à incrémenter quand la logique change, pour invalider
// proprement les caches existants (ex. ajout des bornes horaires dans la période d'effet).
const ANALYSIS_VERSION = 5;

function hashAlert(alert: AlertInput): string {
	// On inclut le contexte des lignes (terminus/sens) : si le GTFS change, l'analyse est
	// ré-invalidée automatiquement pour les seules alertes concernées. `today` est exclu
	// à dessein (les dates extraites sont absolues → pas d'invalidation quotidienne).
	return JSON.stringify({
		v: ANALYSIS_VERSION,
		header: alert.headerText,
		desc: alert.descriptionText,
		routes: alert.routes,
	});
}
