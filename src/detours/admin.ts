import { type Context, Hono } from "hono";
import { basicAuth } from "hono/basic-auth";

import type { AlertPeriod } from "../ai/analyze-alert.js";
import { ROAD_ROUTING_MAX_EXPANSIONS, ROAD_SMOOTHING_TOLERANCE, ROAD_SNAP_RADIUS } from "../config.js";
import { serviceDay } from "../gtfs-rt/scheduled-trips.js";
import { type AnalyzedAlert, hasEnded } from "../gtfs-rt/use-service-alerts.js";
import { normalizeStopName, type RoutePattern, type StaticGtfs } from "../gtfs-rt/use-static-gtfs.js";
import type { RoadGraph, RoadGraphHandle } from "../routing/road-graph.js";
import { routeOnRoad } from "../routing/route-on-road.js";
import { encodePolyline } from "../utils/encode-polyline.js";
import { HOME_NETWORK, networkOf } from "../utils/network.js";
import { sanitizeHtml } from "../utils/sanitize-html.js";
import { ADMIN_PAGE } from "./admin-page.js";
import { deduceBounds, overlappingSegments, removesStops, type SegmentBounds } from "./bounds.js";
import { countSelectableTrips } from "./build-entities.js";
import type { ModificationIndex, ResolvedModification, Suggestion } from "./modifications.js";
import type {
	CancelledDeparture,
	DetourSegment,
	DetourStore,
	ModificationInput,
	ModificationPeriod,
	Scope,
} from "./store.js";

/**
 * Nombre de quais que la recherche d'arrêts renvoie au plus. Un libellé court — « gare » — en touche
 * des dizaines, et la liste cesse d'être lisible bien avant d'être longue.
 */
const STOP_SEARCH_LIMIT = 50;

/** Bornes larges du réseau, qui n'écartent qu'une coordonnée manifestement fautive. */
const LATITUDE_RANGE = [48, 51] as const;
const LONGITUDE_RANGE = [-1, 3] as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const TIME_ZONE = "Europe/Paris";

/**
 * Combien de journées de service la liste des départs à annuler parcourt, à partir du premier jour de
 * la période qui n'est pas passé. Une semaine voit passer tous les types de journée — semaine, samedi,
 * dimanche — sans noyer la liste sous des départs qui se répètent.
 */
const DEPARTURE_WINDOW_DAYS = 7;

/** Au-delà, un horaire n'est plus celui d'une journée de service, fût-elle débordante. */
const MAX_DEPARTURE = 48 * 3600;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type AdminDependencies = {
	username: string;
	password: string;
	store: DetourStore;
	gtfs: { data: StaticGtfs };
	/** Les infos trafic analysées : de quoi rattacher une modification à l'une d'elles. */
	serviceAlerts: { alerts: AnalyzedAlert[] };
	/** Les modifications résolues et les suggestions, à rebâtir après chaque saisie. */
	modificationIndex: ModificationIndex;
	/** Le graphe routier, pour accrocher un tracé aux rues. Son absence désarme le mode, rien de plus. */
	roadGraph: RoadGraphHandle;
	/** Réassemble les entités du feed, pour qu'un enregistrement se voie sans attendre le relevé suivant. */
	rebuild: () => void;
};

/**
 * L'interface de gestion des modifications, et l'API qu'elle consomme.
 *
 * Le sous-routeur est monté sous `/admin` et s'ouvre par son authentification : tout ce qui suit est
 * en accès restreint, y compris la page elle-même — elle porte les textes des infos trafic et la
 * géographie du réseau, rien de secret, mais rien qui ait à traîner non plus.
 */
export function adminRoutes(deps: AdminDependencies): Hono {
	const admin = new Hono();
	admin.use(basicAuth({ username: deps.username, password: deps.password }));

	/** Après une saisie : l'index se rebâtit, puis le feed, qui le lit. */
	const refresh = () => {
		deps.modificationIndex.reindex();
		deps.rebuild();
	};

	/** La modification résolue que désigne `:uid`, ou `undefined`. */
	const resolve = (c: Context) => deps.modificationIndex.modifications.get(Number(c.req.param("uid")));

	admin.get("/", (c) => c.html(ADMIN_PAGE));

	/**
	 * Le tableau : les modifications, et les suggestions à accepter ou à ignorer. Tout part, en vigueur
	 * ou non ; c'est l'interface qui range en onglets ce qui vient, ce qui court et ce qui est fini.
	 */
	admin.get("/api/modifications", (c) => {
		const gtfs = deps.gtfs.data;
		const now = Temporal.Now.instant();
		const modifications = [...deps.modificationIndex.modifications.values()]
			.sort((a, b) => compareRows(a, b, gtfs))
			.map((modification) => summarize(modification, deps, now));
		const suggestions = [...deps.modificationIndex.suggestions]
			.sort((a, b) => compareRows(a, b, gtfs))
			.map((suggestion) => summarizeSuggestion(suggestion, deps, now));

		return c.json({ modifications, suggestions });
	});

	admin.get("/api/modifications/:uid", (c) => {
		const modification = resolve(c);
		if (modification === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);
		return c.json(detail(modification, deps));
	});

	/**
	 * Crée une modification à la main. Rattachée à une info trafic, elle en hérite ce qu'on ne saisit
	 * pas ; sans info trafic, sa raison et sa période sont obligatoires.
	 */
	admin.post("/api/modifications", async (c) => {
		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);

		const gtfs = deps.gtfs.data;
		const routeId = payload.routeId;
		const directionId = payload.directionId;
		const directions = typeof routeId === "string" ? gtfs.routeDirections.get(routeId) : undefined;
		if (typeof routeId !== "string" || directions === undefined) {
			return c.json({ code: 400, message: `Ligne « ${String(routeId)} » inconnue du GTFS.` }, 400);
		}
		if (typeof directionId !== "number" || !directions.some((direction) => direction.directionId === directionId)) {
			return c.json(
				{ code: 400, message: `La ligne ${lineName(gtfs, routeId)} n'a pas de sens ${String(directionId)}.` },
				400,
			);
		}

		let alertNumber: string | null = null;
		if (payload.alertNumber !== undefined && payload.alertNumber !== null && payload.alertNumber !== "") {
			if (!deps.serviceAlerts.alerts.some((alert) => alert.alertNumber === payload.alertNumber)) {
				return c.json(
					{ code: 400, message: `Aucune info trafic ${String(payload.alertNumber)} au flux courant.` },
					400,
				);
			}
			alertNumber = payload.alertNumber as string;
		}

		const header = parseHeader(payload, alertNumber !== null);
		if ("message" in header) return c.json({ code: 400, message: header.message }, 400);

		const patternIds = parsePatterns(payload.patternIds, patternsFor(gtfs, routeId, directionId));
		if ("message" in patternIds) return c.json({ code: 400, message: patternIds.message }, 400);

		const created = deps.store.createManual(
			{ alertNumber, routeId, directionId, label: header.label, period: header.period, patternIds: patternIds.ids },
			nowSeconds(),
		);
		refresh();
		return c.json({ uid: created.uid });
	});

	/** Enregistre tout d'un bloc : raison, période, tracés, arrêts supprimés, tronçons. */
	admin.put("/api/modifications/:uid", async (c) => {
		const modification = resolve(c);
		if (modification === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);

		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);

		const parsed = parseInput(payload, modification, deps);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		deps.store.save(modification.uid, parsed.input, nowSeconds());
		refresh();

		const saved = deps.modificationIndex.modifications.get(modification.uid);
		if (saved === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);
		return c.json(detail(saved, deps));
	});

	/** Visible ou invisible. Invisible, rien ne sort : ni ses tronçons, ni ses arrêts supprimés. */
	admin.put("/api/modifications/:uid/visible", async (c) => {
		const modification = resolve(c);
		if (modification === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);

		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);
		if (typeof payload.visible !== "boolean")
			return c.json({ code: 400, message: "Booléen « visible » attendu." }, 400);

		deps.store.setDisabled([modification.uid], !payload.visible);
		refresh();
		return c.json({ code: 200, message: payload.visible ? "Visible." : "Invisible." });
	});

	/**
	 * Supprime une modification, saisie ou de l'IA — celle-ci ne sera ni recréée ni suggérée.
	 */
	admin.delete("/api/modifications/:uid", (c) => {
		const modification = resolve(c);
		if (modification === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);

		discard(deps, [modification], []);
		refresh();
		return c.json({ code: 200, message: "Modification supprimée." });
	});

	/**
	 * Une action sur les lignes cochées du tableau, d'un bloc : les masquer, les afficher, ou les
	 * écarter — supprimer les modifications, ignorer les suggestions. Masquer ou afficher ne vaut que
	 * pour les modifications ; une suggestion ne publie rien, elle ne s'ignore que.
	 *
	 * Ce qui a disparu entre l'affichage et le clic est passé sous silence : le résultat est le même.
	 */
	admin.post("/api/bulk", async (c) => {
		const payload = await readObject(c);
		if ("message" in payload) return c.json({ code: 400, message: payload.message }, 400);

		const action = payload.action;
		if (action !== "hide" && action !== "show" && action !== "discard") {
			return c.json({ code: 400, message: "Action attendue : « hide », « show » ou « discard »." }, 400);
		}

		const uids = Array.isArray(payload.uids) ? payload.uids : [];
		const keys = Array.isArray(payload.suggestions) ? payload.suggestions : [];
		const modifications = uids.flatMap((uid) => {
			const modification = deps.modificationIndex.modifications.get(Number(uid));
			return modification === undefined ? [] : [modification];
		});
		const suggestions = deps.modificationIndex.suggestions.filter((suggestion) => keys.includes(suggestion.key));

		if (action === "discard") {
			discard(deps, modifications, suggestions);
		} else {
			deps.store.setDisabled(
				modifications.map((modification) => modification.uid),
				action === "hide",
			);
		}

		refresh();
		return c.json({ code: 200, message: `${modifications.length + suggestions.length} ligne(s) traitée(s).` });
	});

	/**
	 * Combien de courses ces bornes-là modifieraient, tracé par tracé, sans rien enregistrer.
	 * L'interface l'interroge dès qu'on change une borne : c'est le chiffre qui dit si le tronçon
	 * sortira du feed, et sur quels tracés.
	 */
	admin.get("/api/modifications/:uid/trip-count", (c) => {
		const modification = resolve(c);
		if (modification === undefined) return c.json({ code: 404, message: "Modification inconnue." }, 404);

		const bounds: SegmentBounds = { startStopId: c.req.query("start") ?? null, endStopId: c.req.query("end") ?? null };
		return c.json({ tripsByPattern: Object.fromEntries(countTripsByPattern(bounds, modification, deps)) });
	});

	/**
	 * Accepte une suggestion : elle devient une modification saisie, rattachée à son info trafic, qui
	 * en hérite tout — y compris les arrêts que l'analyse y lit. La supprimer ensuite la refait
	 * apparaître comme suggestion.
	 */
	admin.post("/api/suggestions/:key/accept", (c) => {
		const suggestion = deps.modificationIndex.suggestions.find((candidate) => candidate.key === c.req.param("key"));
		if (suggestion === undefined) return c.json({ code: 404, message: "Suggestion inconnue." }, 404);

		const created = deps.store.createManual(
			{
				alertNumber: suggestion.alertNumber,
				routeId: suggestion.routeId,
				directionId: suggestion.directionId,
				label: null,
				period: null,
				patternIds: [],
			},
			nowSeconds(),
		);
		refresh();
		return c.json({ uid: created.uid });
	});

	/** Ignore une suggestion, pour de bon. */
	admin.post("/api/suggestions/:key/dismiss", (c) => {
		const suggestion = deps.modificationIndex.suggestions.find((candidate) => candidate.key === c.req.param("key"));
		if (suggestion === undefined) return c.json({ code: 404, message: "Suggestion inconnue." }, 404);

		discard(deps, [], [suggestion]);
		refresh();
		return c.json({ code: 200, message: "Suggestion ignorée." });
	});

	/** Les lignes du réseau, leurs sens et leurs tracés : de quoi créer une modification. */
	admin.get("/api/routes", (c) => {
		const gtfs = deps.gtfs.data;
		const routes = [...gtfs.routeDirections]
			.sort(([a], [b]) => compareLines(gtfs, a, b))
			.map(([routeId, directions]) => ({
				routeId,
				line: lineName(gtfs, routeId),
				lineCode: lineCode(routeId),
				directions: directions.map((direction) => {
					const patterns = patternsFor(gtfs, routeId, direction.directionId);
					const labels = patternLabels(patterns, gtfs);
					return {
						directionId: direction.directionId,
						headsigns: direction.headsigns,
						patterns: patterns.map((pattern, index) => ({ patternId: pattern.patternId, label: labels[index] })),
					};
				}),
			}));

		return c.json(routes);
	});

	/** Les infos trafic du flux, pour y rattacher une modification. */
	admin.get("/api/alerts", (c) => {
		const alerts = deps.serviceAlerts.alerts
			.map((alert) => ({ alertNumber: alert.alertNumber, headerText: alert.headerText, periods: alert.periods }))
			.sort((a, b) => a.alertNumber.localeCompare(b.alertNumber, "fr", { numeric: true }));
		return c.json(alerts);
	});

	/**
	 * Les arrêts désignables, du GTFS comme de la base provisoire, dans une seule liste. C'est la même
	 * chose du point de vue d'une déviation — un endroit où le véhicule s'arrête — et les séparer
	 * obligerait à savoir d'avance dans laquelle des deux chercher.
	 *
	 * La recherche passe par `normalizeStopName` : on cherche « champ de mars » sans se soucier des
	 * accents ni de la casse, comme le fait déjà le rapprochement des noms d'info trafic.
	 */
	admin.get("/api/stops", (c) => {
		const query = normalizeStopName(c.req.query("q") ?? "");
		if (query.length < 2) return c.json([]);

		const gtfs = deps.gtfs.data;
		const matches: { stopId: string; name: string; latitude: number; longitude: number; provisional: boolean }[] = [];

		// Les arrêts provisoires passent devant : ils sont peu nombreux, et c'est précisément eux qu'on
		// cherche quand on en réemploie un.
		for (const stop of deps.store.provisionalStops.values()) {
			if (normalizeStopName(stop.name).includes(query)) matches.push({ ...stop, provisional: true });
		}

		for (const [stopId, name] of gtfs.stopNames) {
			if (matches.length >= STOP_SEARCH_LIMIT) break;
			if (!normalizeStopName(name).includes(query)) continue;

			const coordinates = gtfs.stopCoordinates.get(stopId);
			// Un quai sans coordonnées ne se pose pas sur la carte : il n'a rien à faire dans la liste.
			if (coordinates === undefined) continue;

			matches.push({ stopId, name, ...coordinates, provisional: false });
		}

		return matches.length === 0 ? c.json([]) : c.json(matches);
	});

	/**
	 * Tous les arrêts désignables, du GTFS comme de la base provisoire, pour les poser sur la carte : un
	 * arrêt de substitution se choisit alors d'un clic, là où il est. En tableaux plutôt qu'en objets —
	 * le réseau compte quelques milliers de quais.
	 */
	admin.get("/api/stops/all", (c) => {
		const gtfs = deps.gtfs.data;
		const stops: [stopId: string, name: string, latitude: number, longitude: number, provisional: boolean][] = [];

		for (const stop of deps.store.provisionalStops.values()) {
			stops.push([stop.stopId, stop.name, stop.latitude, stop.longitude, true]);
		}
		for (const [stopId, name] of gtfs.stopNames) {
			const coordinates = gtfs.stopCoordinates.get(stopId);
			if (coordinates === undefined) continue;
			stops.push([stopId, name, coordinates.latitude, coordinates.longitude, false]);
		}

		return c.json(stops);
	});

	/**
	 * La base des arrêts provisoires, chacun avec les modifications qui le désignent. C'est ce qu'il
	 * faut voir avant d'en renommer ou d'en déplacer un : le changement vaudra pour toutes, et un arrêt
	 * que rien ne désigne plus est le seul qu'on puisse retirer sans rien toucher d'autre.
	 */
	admin.get("/api/provisional-stops", (c) => {
		const usages = new Map<string, ReturnType<typeof describeUsage>[]>();

		for (const record of deps.store.modifications.values()) {
			const designated = new Set(record.segments.flatMap((segment) => segment.stops.map((stop) => stop.stopId)));
			for (const stopId of designated) {
				if (!deps.store.provisionalStops.has(stopId)) continue;
				const list = usages.get(stopId) ?? [];
				list.push(describeUsage(record.uid, record.routeId, record.directionId, deps));
				usages.set(stopId, list);
			}
		}

		const stops = [...deps.store.provisionalStops.values()].map((stop) => ({
			...stop,
			usages: usages.get(stop.stopId) ?? [],
		}));

		return c.json(stops.sort((a, b) => a.name.localeCompare(b.name, "fr")));
	});

	admin.post("/api/provisional-stops", async (c) => {
		const parsed = await parseProvisionalStop(c);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		const { name, latitude, longitude } = parsed;
		return c.json(deps.store.createProvisionalStop(name, latitude, longitude, Math.floor(Date.now() / 1000)));
	});

	admin.put("/api/provisional-stops/:stopId", async (c) => {
		const stopId = c.req.param("stopId");
		const parsed = await parseProvisionalStop(c);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		const { name, latitude, longitude } = parsed;
		if (!deps.store.updateProvisionalStop(stopId, name, latitude, longitude)) {
			return c.json({ code: 404, message: "Arrêt provisoire inconnu." }, 404);
		}

		// Le libellé ou la position d'un arrêt publié viennent de changer : le feed doit suivre.
		deps.rebuild();
		return c.json(deps.store.provisionalStops.get(stopId));
	});

	/** Retire un arrêt provisoire, et le retire au passage de toutes les déviations qui le désignent. */
	admin.delete("/api/provisional-stops/:stopId", (c) => {
		const withdrawn = deps.store.deleteProvisionalStop(c.req.param("stopId"), Math.floor(Date.now() / 1000));
		if (withdrawn === undefined) return c.json({ code: 404, message: "Arrêt provisoire inconnu." }, 404);

		// Des déviations publiées viennent de perdre un arrêt de substitution : le feed doit suivre.
		if (withdrawn > 0) deps.rebuild();
		return c.json({ code: 200, message: "Arrêt provisoire supprimé.", withdrawn });
	});

	/**
	 * Une jambe de tracé, accrochée aux rues : deux points cliqués, et l'itinéraire routier qui les
	 * joint.
	 *
	 * Une jambe par appel, et non le tracé entier : déplacer un point de passage ne remet en cause que
	 * les deux jambes qui le touchent, et l'interface n'a alors qu'à redemander celles-là.
	 */
	admin.post("/api/route", async (c) => {
		// Le graphe s'ouvre à la première demande, et peut refuser de s'ouvrir : fichier tronqué par un
		// transfert, ou d'une version que ce code ne sait plus lire. On rend alors la raison telle
		// quelle — l'éditeur l'affiche sur la jambe, et elle dit quoi faire.
		let graph: RoadGraph | undefined;
		try {
			graph = deps.roadGraph.graph();
		} catch (cause) {
			return c.json({ code: 500, message: cause instanceof Error ? cause.message : "Graphe routier illisible." }, 500);
		}

		if (graph === undefined) {
			return c.json({ code: 503, message: "Graphe routier absent : le mode accrochage est indisponible." }, 503);
		}

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ code: 400, message: "Corps de requête illisible." }, 400);
		}

		const payload = (body ?? {}) as Record<string, unknown>;
		const from = readPoint(payload.from);
		const to = readPoint(payload.to);
		if (from === undefined || to === undefined) {
			return c.json({ code: 400, message: "Deux points attendus, chacun en [latitude, longitude]." }, 400);
		}

		const route = routeOnRoad(graph, from, to, {
			snapRadius: ROAD_SNAP_RADIUS,
			maxExpansions: ROAD_ROUTING_MAX_EXPANSIONS,
			smoothingTolerance: ROAD_SMOOTHING_TOLERANCE,
		});

		if ("failure" in route) {
			const message =
				route.failure === "no-road" ? "Point trop éloigné d'une rue." : "Aucun itinéraire entre ces deux points.";
			return c.json({ code: 422, message }, 422);
		}

		// Les points partent en paires [latitude, longitude], comme le tracé d'un tronçon : l'interface
		// les recoud bout à bout sans rien convertir.
		return c.json({
			path: route.path.map((point) => [point.latitude, point.longitude]),
			distance: Math.round(route.distance * 1000),
			fromOffset: Math.round(route.from.offset * 1000),
			toOffset: Math.round(route.to.offset * 1000),
		});
	});

	return admin;
}

// ---

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * Supprime ou ignore, selon ce que c'est. Une modification saisie se supprime, rien de plus : la
 * suggestion qu'elle couvrait peut reparaître. Une modification de l'IA s'efface ET son trio s'écarte,
 * sans quoi le relevé suivant la recréerait ; une suggestion, elle, n'a que son trio à écarter.
 */
function discard(
	deps: AdminDependencies,
	modifications: readonly ResolvedModification[],
	suggestions: readonly Suggestion[],
) {
	const scopes: Scope[] = [...suggestions];
	for (const modification of modifications) {
		if (modification.origin !== "ai" || modification.alertNumber === null) continue;
		scopes.push({
			alertNumber: modification.alertNumber,
			routeId: modification.routeId,
			directionId: modification.directionId,
		});
	}

	deps.store.discard(
		modifications.map((modification) => modification.uid),
		scopes,
		nowSeconds(),
	);
}

/** Le corps d'une requête, s'il est un objet JSON. */
async function readObject(c: Context): Promise<Record<string, unknown> | { message: string }> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return { message: "Corps de requête illisible." };
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { message: "Corps de requête attendu : un objet." };
	}
	return body as Record<string, unknown>;
}

/** Les tracés d'une ligne et d'un sens, du plus long au plus court. */
function patternsFor(gtfs: StaticGtfs, routeId: string, directionId: number): RoutePattern[] {
	return gtfs.routePatterns.get(routeId)?.get(directionId) ?? [];
}

/**
 * Par ligne, dans l'ordre du réseau, puis par sens ; en vigueur d'abord au sein d'un même sens. Le
 * reste du rangement — onglets, groupes, tri choisi — se fait dans l'interface.
 */
function compareRows(
	a: { routeId: string; directionId: number; active: boolean },
	b: { routeId: string; directionId: number; active: boolean },
	gtfs: StaticGtfs,
): number {
	if (a.routeId !== b.routeId) return compareLines(gtfs, a.routeId, b.routeId);
	if (a.directionId !== b.directionId) return a.directionId - b.directionId;
	if (a.active !== b.active) return a.active ? -1 : 1;
	return 0;
}

/**
 * Le nom commercial d'une ligne (« F7 », « Métro »), ou à défaut le bout de son identifiant. Hors
 * TCAR, il est précédé de son réseau (« TAE 311 ») : les trois réseaux partagent des numéros, et la
 * 311 d'Elbeuf n'est pas celle de Rouen.
 */
function lineName(gtfs: StaticGtfs, routeId: string): string {
	const name = gtfs.routeNames.get(routeId) ?? routeId.split(":").at(-1) ?? routeId;
	const network = networkOf(routeId);
	return network === HOME_NETWORK ? name : `${network} ${name}`;
}

/**
 * Le bout de l'identifiant de ligne (« TCAR:07 » → « 07 ») : c'est lui qui nomme les cartouches.
 * `null` hors TCAR, dont les cartouches ne sont pas publiés : la ligne s'affiche alors en clair.
 */
function lineCode(routeId: string): string | null {
	return networkOf(routeId) === HOME_NETWORK ? (routeId.split(":").at(-1) ?? routeId) : null;
}

/** Le métro, puis les lignes T, puis les lignes F, puis tout le reste. */
function lineRank(name: string): number {
	if (/^m[ée]tro$/i.test(name)) return 0;
	if (/^T\d+$/.test(name)) return 1;
	if (/^F\d+$/.test(name)) return 2;
	return 3;
}

/**
 * TCAR d'abord, puis les autres réseaux ; dans chacun, par rang puis par nom, les nombres comparés
 * comme tels (F2 avant F10).
 */
function compareLines(gtfs: StaticGtfs, a: string, b: string): number {
	const networkA = networkOf(a);
	const networkB = networkOf(b);
	if (networkA !== networkB) {
		if (networkA === HOME_NETWORK || networkB === HOME_NETWORK) return networkA === HOME_NETWORK ? -1 : 1;
		return networkA.localeCompare(networkB);
	}

	const nameA = lineName(gtfs, a);
	const nameB = lineName(gtfs, b);
	return lineRank(nameA) - lineRank(nameB) || nameA.localeCompare(nameB, "fr", { numeric: true });
}

/** Les destinations d'un sens, telles que le GTFS les affiche. */
function headsignsOf(gtfs: StaticGtfs, routeId: string, directionId: number): string[] {
	return gtfs.routeDirections.get(routeId)?.find((direction) => direction.directionId === directionId)?.headsigns ?? [];
}

/**
 * Où se range une ligne du tableau : ce qui n'a pas commencé, ce qui court, ce qui est fini. Une
 * période sans borne court toujours.
 */
function phaseOf(periods: AlertPeriod[], active: boolean, now: Temporal.Instant): "upcoming" | "current" | "ended" {
	if (active) return "current";
	return hasEnded(periods, now) ? "ended" : "upcoming";
}

/** Ce que le tableau affiche d'une modification, sans la géographie que seule l'édition demande. */
function summarize(modification: ResolvedModification, deps: AdminDependencies, now: Temporal.Instant) {
	const gtfs = deps.gtfs.data;
	const record = modification.record;
	const publishable = record.segments.filter((segment) => isSegmentPublishable(segment, modification, gtfs));

	return {
		kind: "modification" as const,
		uid: modification.uid,
		origin: modification.origin,
		alertNumber: modification.alertNumber,
		alertHeader: modification.alertHeader,
		label: modification.label,
		routeId: modification.routeId,
		line: lineName(gtfs, modification.routeId),
		lineCode: lineCode(modification.routeId),
		directionId: modification.directionId,
		headsigns: headsignsOf(gtfs, modification.routeId, modification.directionId),
		periods: modification.periods,
		phase: phaseOf(modification.periods, modification.active, now),
		disabled: modification.disabled,
		removedStopCount: removedOnCourse(modification, gtfs).length,
		patternCount: record.patternIds.length,
		patternTotal: patternsFor(gtfs, modification.routeId, modification.directionId).length,
		segmentCount: record.segments.length,
		cancelledCount: record.cancelledDepartures.length,
		publishableSegments: publishable.length,
		stopCount: record.segments.reduce((total, segment) => total + segment.stops.length, 0),
		firstSeenAt: modification.firstSeenAt,
	};
}

/**
 * Les arrêts supprimés que desservent les tracés visés. L'analyse porte tous les quais d'un nom — ceux
 * d'autres lignes, de l'autre sens — qui ne suppriment rien ici et n'ont pas à se compter.
 */
function removedOnCourse(modification: ResolvedModification, gtfs: StaticGtfs): string[] {
	const served = new Set<string>();
	for (const pattern of patternsFor(gtfs, modification.routeId, modification.directionId)) {
		if (modification.patternIds.length > 0 && !modification.patternIds.includes(pattern.patternId)) continue;
		for (const stop of pattern.stops) served.add(stop.stopId);
	}
	return [...modification.removedStopIds].filter((stopId) => served.has(stopId));
}

/** Ce que le tableau affiche d'une suggestion. */
function summarizeSuggestion(suggestion: Suggestion, deps: AdminDependencies, now: Temporal.Instant) {
	const gtfs = deps.gtfs.data;
	return {
		kind: "suggestion" as const,
		key: suggestion.key,
		alertNumber: suggestion.alertNumber,
		alertHeader: suggestion.alertHeader,
		label: suggestion.alertHeader,
		routeId: suggestion.routeId,
		line: lineName(gtfs, suggestion.routeId),
		lineCode: lineCode(suggestion.routeId),
		directionId: suggestion.directionId,
		headsigns: headsignsOf(gtfs, suggestion.routeId, suggestion.directionId),
		periods: suggestion.periods,
		phase: phaseOf(suggestion.periods, suggestion.active, now),
		removedStopCount: suggestion.removedStopIds.length,
		firstSeenAt: suggestion.firstSeenAt,
	};
}

/**
 * Un tronçon n'entre dans le feed qu'avec ses deux bornes — ce sont elles qui désignent les courses —
 * et de quoi dire quelque chose.
 *
 * Quand sa plage supprime des arrêts, ce quelque chose est des arrêts de substitution, un tracé, ou
 * les deux : le tracé seul suffit, le segment est alors supprimé sans report, et l'itinéraire porte
 * toute l'information. Quand elle n'en supprime aucun, c'est le tracé et rien d'autre — il n'y a
 * rien à remplacer (cf. `removesStops`).
 */
function isSegmentPublishable(segment: DetourSegment, modification: ResolvedModification, gtfs: StaticGtfs): boolean {
	if (segment.startStopId === null || segment.endStopId === null) return false;
	const removes = removesStops(
		gtfs,
		modification.routeId,
		modification.directionId,
		modification.patternIds,
		modification.removedStopIds,
		segment,
	);
	if (!removes) return segment.path.length >= 2;
	return segment.stops.length > 0 || segment.path.length >= 2;
}

/**
 * Tout ce que l'édition doit afficher, en un seul aller-retour : ce qui a été saisi et ce qui est
 * hérité de l'info trafic, les tracés du sens avec leurs arrêts, leurs shapes, les bornes déduites,
 * et les tronçons.
 *
 * Les shapes partent en polylignes encodées plutôt qu'en tableaux de coordonnées : une ligne de bus
 * en compte quelques milliers de points, et la page sait les décoder en quinze lignes.
 */
function detail(modification: ResolvedModification, deps: AdminDependencies) {
	const gtfs = deps.gtfs.data;
	const record = modification.record;
	const { routeId, directionId } = modification;
	const alert =
		modification.alertNumber === null
			? undefined
			: deps.serviceAlerts.alerts.find((candidate) => candidate.alertNumber === modification.alertNumber);

	// Les tracés empruntés du sens, services partiels compris : la modification peut n'en viser que
	// certains, et c'est sur leurs arrêts que se choisissent les bornes de ses tronçons.
	const routePatterns = patternsFor(gtfs, routeId, directionId);
	const labels = patternLabels(routePatterns, gtfs);
	const patterns = routePatterns.map((pattern, index) => ({
		patternId: pattern.patternId,
		shapeId: pattern.shapeId,
		label: labels[index],
		sequence: pattern.stops.map((stop) => ({
			stopId: stop.stopId,
			name: gtfs.stopNames.get(stop.stopId) ?? stop.name,
			...(gtfs.stopCoordinates.get(stop.stopId) ?? { latitude: null, longitude: null }),
			removed: modification.removedStopIds.has(stop.stopId),
		})),
	}));

	const shapes = [...new Set(routePatterns.map((pattern) => pattern.shapeId))].flatMap((shapeId) => {
		const points = gtfs.shapes.get(shapeId);
		return points === undefined ? [] : [{ shapeId, encodedPolyline: encodePolyline(points) }];
	});

	// Rien n'a encore été déclaré : les suites d'arrêts supprimés du meilleur itinéraire proposent
	// d'emblée un tronçon chacune. Sans arrêt supprimé, c'est un tronçon vierge qu'on propose — entre
	// quels arrêts la course passe ailleurs reste à choisir.
	const boundsCandidates = deduceBounds(
		gtfs,
		routeId,
		directionId,
		modification.removedStopIds,
		modification.patternIds,
	);
	const proposed = boundsCandidates.filter((bounds) => bounds.itinerary === boundsCandidates[0]?.itinerary);
	const fallback: DetourSegment[] = (
		modification.removedStopIds.size === 0 ? [{ startStopId: null, endStopId: null }] : proposed
	).map((bounds) => ({
		startStopId: bounds.startStopId,
		endStopId: bounds.endStopId,
		propagatedDelay: 0,
		stops: [],
		waypoints: [],
		path: [],
	}));
	const segments = record.segments.length > 0 ? record.segments : fallback;

	return {
		...summarize(modification, deps, Temporal.Now.instant()),
		// Ce qui a été saisi, et ce qui s'hérite : l'interface montre le second en attente du premier.
		labelInput: record.label,
		periodInput:
			record.period === null
				? null
				: {
						start: splitBound(record.period.start),
						end: record.period.end === null ? null : splitBound(record.period.end),
					},
		alertPeriods: alert?.periods ?? [],
		// Le texte d'une info trafic est du HTML : le flux amont reprend ce que le CMS de l'exploitant a
		// saisi, listes et plans de déviation compris. Il part nettoyé plutôt qu'échappé — la page
		// l'affiche tel quel, et n'a pas à savoir d'où il vient (cf. `sanitizeHtml`).
		alertDescriptionHtml: sanitizeHtml(modification.alertDescription),
		// L'éditeur ne propose l'accrochage aux rues que si le graphe est là.
		roadRouting: deps.roadGraph.available,
		patternIds: record.patternIds,
		removedStopIds: [...modification.removedStopIds],
		removedFromAnalysis: modification.removedFromAnalysis,
		analysisStopIds: [...modification.analysisStopIds],
		patterns,
		shapes,
		boundsCandidates,
		// Les départs qu'on peut annuler, et ceux qui le sont.
		departures: departuresOf(modification, gtfs),
		cancelledDepartures: record.cancelledDepartures,
		// Un arrêt n'est que désigné : son libellé et sa position se relisent à l'affichage, du GTFS ou de
		// la base provisoire. `tripsByPattern` dit combien de courses ces bornes-là modifieraient sur
		// chaque tracé — zéro partout, et le tronçon ne sortira pas du tout dans le feed.
		segments: segments.map((segment) => ({
			startStopId: segment.startStopId,
			endStopId: segment.endStopId,
			propagatedDelay: segment.propagatedDelay,
			stops: segment.stops.map((stop) => ({ ...stop, ...describeStop(stop.stopId, deps) })),
			waypoints: segment.waypoints,
			path: segment.path,
			publishable: isSegmentPublishable(segment, modification, gtfs),
			tripsByPattern: Object.fromEntries(countTripsByPattern(segment, modification, deps)),
		})),
	};
}

/**
 * Les départs de la ligne et du sens qu'on peut annuler : ceux des courses qui circulent au moins
 * une journée de la période, parmi les {@link DEPARTURE_WINDOW_DAYS} qui suivent son premier jour non
 * passé. Chacun dit de quels tracés il relève : la page ne montre que ceux des tracés cochés.
 *
 * Une période close avant aujourd'hui n'en propose aucun.
 */
function departuresOf(modification: ResolvedModification, gtfs: StaticGtfs) {
	const today = Temporal.Now.plainDateISO(TIME_ZONE);
	const dateOf = (bound: string) => Temporal.PlainDate.from(bound.slice(0, 10));

	const starts = modification.periods.map((period) => (period.start === null ? today : dateOf(period.start)));
	const ends = modification.periods.map((period) => (period.end === null ? null : dateOf(period.end)));

	let first = starts.reduce((a, b) => (Temporal.PlainDate.compare(a, b) <= 0 ? a : b), today);
	if (Temporal.PlainDate.compare(first, today) < 0) first = today;
	let last = first.add({ days: DEPARTURE_WINDOW_DAYS - 1 });
	if (ends.length > 0 && ends.every((end) => end !== null)) {
		const end = (ends as Temporal.PlainDate[]).reduce((a, b) => (Temporal.PlainDate.compare(a, b) >= 0 ? a : b));
		if (Temporal.PlainDate.compare(end, last) < 0) last = end;
	}

	const departures = new Map<
		string,
		{ stopId: string; departure: number; name: string; headsign: string; patternIds: Set<string> }
	>();

	for (let date = first; Temporal.PlainDate.compare(date, last) <= 0; date = date.add({ days: 1 })) {
		for (const serviceId of serviceDay(gtfs, date).services) {
			for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
				const meta = gtfs.trips.get(tripId);
				if (meta === undefined || meta.routeId !== modification.routeId) continue;
				if (meta.directionId !== modification.directionId) continue;

				const origin = gtfs.tripStopSequences.get(tripId)?.[0];
				const departure = gtfs.tripDepartures.get(tripId);
				const patternId = gtfs.tripPatterns.get(tripId);
				if (origin === undefined || departure === undefined || patternId === undefined) continue;

				const key = `${origin.stopId}|${departure}`;
				const known = departures.get(key);
				if (known !== undefined) {
					known.patternIds.add(patternId);
					continue;
				}
				departures.set(key, {
					stopId: origin.stopId,
					departure,
					name: gtfs.stopNames.get(origin.stopId) ?? origin.stopId,
					headsign: meta.headsign,
					patternIds: new Set([patternId]),
				});
			}
		}
	}

	return [...departures.values()]
		.sort((a, b) => a.departure - b.departure || a.name.localeCompare(b.name, "fr"))
		.map((entry) => ({ ...entry, patternIds: [...entry.patternIds] }));
}

/**
 * Le libellé d'un tracé : « premier arrêt → dernier arrêt ». Deux tracés qui partent et arrivent au
 * même endroit se départagent par le premier arrêt que l'un dessert et pas l'autre.
 */
function patternLabels(patterns: readonly RoutePattern[], gtfs: StaticGtfs): string[] {
	const nameOf = (stopId: string | undefined) => (stopId === undefined ? "?" : (gtfs.stopNames.get(stopId) ?? stopId));
	const base = patterns.map(
		(pattern) => `${nameOf(pattern.stops[0]?.stopId)} → ${nameOf(pattern.stops.at(-1)?.stopId)}`,
	);

	return patterns.map((pattern, index) => {
		const twins = patterns.filter((_, other) => other !== index && base[other] === base[index]);
		if (twins.length === 0) return base[index] as string;

		const elsewhere = new Set(twins.flatMap((twin) => twin.stops.map((stop) => stop.stopId)));
		const own = pattern.stops.find((stop) => !elsewhere.has(stop.stopId));
		return own === undefined
			? `${base[index]} (${pattern.stops.length} arrêts)`
			: `${base[index]} via ${nameOf(own.stopId)}`;
	});
}

/**
 * Combien de courses les bornes d'un tronçon désignent sur chaque tracé du sens, visé ou non. Rien
 * tant qu'elles ne sont pas arrêtées.
 */
function countTripsByPattern(
	bounds: SegmentBounds,
	modification: ResolvedModification,
	deps: AdminDependencies,
): Map<string, number> {
	if (bounds.startStopId === null || bounds.endStopId === null) return new Map();

	return countSelectableTrips(
		deps.gtfs.data,
		modification.routeId,
		modification.directionId,
		bounds.startStopId,
		bounds.endStopId,
		nowSeconds(),
	);
}

/**
 * La raison et la période d'une modification. Rattachée à une info trafic, l'une et l'autre peuvent
 * rester vides : elles suivent alors l'info trafic. Sans elle, les deux sont obligatoires.
 *
 * Chaque borne est un objet `{ date, time }` : la date est obligatoire, l'heure facultative. La fin
 * peut manquer — la période est alors ouverte — et doit sinon venir après le début.
 */
function parseHeader(
	payload: Record<string, unknown>,
	attached: boolean,
): { label: string | null; period: ModificationPeriod | null } | { message: string } {
	if (payload.label !== undefined && payload.label !== null && typeof payload.label !== "string") {
		return { message: "Raison attendue : un texte." };
	}
	const label = typeof payload.label === "string" && payload.label.trim().length > 0 ? payload.label.trim() : null;
	if (label === null && !attached) return { message: "La raison est obligatoire sans info trafic." };

	const start = readBound(payload.start, "début");
	if ("message" in start) return start;
	const end = readBound(payload.end, "fin");
	if ("message" in end) return end;

	if (start.bound === null) {
		if (end.bound !== null) return { message: "Une fin sans début : saisir aussi la date de début." };
		if (!attached) return { message: "La date de début est obligatoire sans info trafic." };
		return { label, period: null };
	}

	// La fin se compare comme elle se jauge : exclusive, et à la journée entière quand elle est sans
	// heure (cf. `periodEnd`). « Du 24 au 24 » couvre donc bien la journée.
	if (end.bound !== null) {
		const from = start.time === null ? start.date.toPlainDateTime() : start.date.toPlainDateTime(start.time);
		const until = end.time === null ? end.date.add({ days: 1 }).toPlainDateTime() : end.date.toPlainDateTime(end.time);
		if (Temporal.PlainDateTime.compare(until, from) <= 0) return { message: "La fin doit venir après le début." };
	}

	return { label, period: { start: start.bound, end: end.bound } };
}

/**
 * Les tracés visés. Facultatifs : sans eux, la modification les vise tous. Un tracé inconnu est
 * refusé plutôt qu'écarté — l'écarter élargirait en silence la modification à des courses qu'on n'a
 * pas choisies. Les nommer tous revient à n'en nommer aucun, et cette forme-là survit à un tracé que
 * le GTFS ajouterait demain.
 */
function parsePatterns(raw: unknown, patterns: readonly RoutePattern[]): { ids: string[] } | { message: string } {
	if (raw === undefined || raw === null) return { ids: [] };
	if (!Array.isArray(raw)) return { message: "Tracés visés attendus : une liste." };

	const ids: string[] = [];
	for (const patternId of raw) {
		if (typeof patternId !== "string" || !patterns.some((pattern) => pattern.patternId === patternId)) {
			return { message: `Tracé « ${String(patternId)} » inconnu du GTFS pour cette ligne et ce sens.` };
		}
		if (!ids.includes(patternId)) ids.push(patternId);
	}

	return { ids: ids.length === patterns.length ? [] : ids };
}

/**
 * Relit et contrôle ce que l'interface envoie. Tout est vérifié ici : au-delà, on écrit en base et on
 * publie dans le feed, où une coordonnée fantaisiste ou un temps de parcours qui recule se verrait
 * chez tous les consommateurs.
 */
function parseInput(
	payload: Record<string, unknown>,
	modification: ResolvedModification,
	deps: AdminDependencies,
): { input: ModificationInput } | { message: string } {
	const gtfs = deps.gtfs.data;
	const attached = modification.alertNumber !== null;

	const header = parseHeader(payload, attached);
	if ("message" in header) return header;

	const patternIds = parsePatterns(
		payload.patternIds,
		patternsFor(gtfs, modification.routeId, modification.directionId),
	);
	if ("message" in patternIds) return patternIds;

	// Les arrêts supprimés : une liste, fût-elle vide, qui fait foi ; ou `null` pour suivre l'analyse —
	// ce qui n'a de sens qu'avec une info trafic.
	let removedStopIds: string[] | null = null;
	if (payload.removedStopIds !== null && payload.removedStopIds !== undefined) {
		if (!Array.isArray(payload.removedStopIds)) return { message: "Arrêts supprimés attendus : une liste." };
		removedStopIds = [];
		for (const stopId of payload.removedStopIds) {
			if (typeof stopId !== "string" || !gtfs.stopNames.has(stopId)) {
				return { message: `Arrêt « ${String(stopId)} » inconnu du GTFS.` };
			}
			removedStopIds.push(stopId);
		}
	}
	if (removedStopIds === null && !attached) removedStopIds = [];

	if (!Array.isArray(payload.cancelledDepartures)) return { message: "Liste de départs annulés attendue." };
	const cancelledDepartures: CancelledDeparture[] = [];
	for (const [index, raw] of payload.cancelledDepartures.entries()) {
		const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
		if (typeof entry.stopId !== "string" || !gtfs.stopNames.has(entry.stopId)) {
			return { message: `Départ annulé ${index + 1} : arrêt inconnu du GTFS.` };
		}
		const departure = entry.departure;
		if (typeof departure !== "number" || !Number.isInteger(departure) || departure < 0 || departure >= MAX_DEPARTURE) {
			return { message: `Départ annulé ${index + 1} : horaire attendu en secondes depuis minuit.` };
		}
		cancelledDepartures.push({ stopId: entry.stopId, departure });
	}

	if (!Array.isArray(payload.segments)) return { message: "Liste de tronçons attendue." };

	const segments: DetourSegment[] = [];
	// Deux entrées qui désignent le même arrêt donneraient deux `replacement_stops` de même `stop_id` :
	// la course s'y arrêterait deux fois. Tous tronçons confondus — ils se suivent sur la même course.
	const designated = new Set<string>();

	for (const [index, raw] of payload.segments.entries()) {
		const parsed = parseSegment(raw, `Tronçon ${index + 1}`, designated, gtfs, deps.store);
		if ("message" in parsed) return parsed;
		segments.push(parsed.segment);
	}

	const overlap = overlappingSegments(gtfs, modification.routeId, modification.directionId, patternIds.ids, segments);
	if (overlap !== undefined) {
		return {
			message:
				`Tronçons ${overlap[0] + 1} et ${overlap[1] + 1} : leurs plages se recoupent sur l'un des tracés visés. ` +
				"Un même arrêt ne peut être supprimé deux fois — fondre les deux tronçons, ou reprendre les bornes.",
		};
	}

	return {
		input: {
			label: header.label,
			period: header.period,
			patternIds: patternIds.ids,
			removedStopIds,
			segments,
			cancelledDepartures,
		},
	};
}

/** Un tronçon tel que l'interface l'envoie, contrôlé de bout en bout. */
function parseSegment(
	raw: unknown,
	label: string,
	designated: Set<string>,
	gtfs: StaticGtfs,
	store: DetourStore,
): { segment: DetourSegment } | { message: string } {
	if (typeof raw !== "object" || raw === null) return { message: `${label} : illisible.` };
	const payload = raw as Record<string, unknown>;

	const startStopId = payload.startStopId ?? null;
	const endStopId = payload.endStopId ?? null;
	if (startStopId !== null && (typeof startStopId !== "string" || !gtfs.stopNames.has(startStopId))) {
		return { message: `${label} : borne amont inconnue du GTFS.` };
	}
	if (endStopId !== null && (typeof endStopId !== "string" || !gtfs.stopNames.has(endStopId))) {
		return { message: `${label} : borne aval inconnue du GTFS.` };
	}

	const propagatedDelay = payload.propagatedDelay ?? 0;
	if (!Number.isInteger(propagatedDelay)) {
		return { message: `${label} : le délai propagé doit être un entier de secondes.` };
	}
	// Rien n'est refusé ici à un tronçon dont la plage ne supprime aucun arrêt : le périmètre peut
	// changer APRÈS l'enregistrement, et cet état-là est de toute façon à traverser. Ses arrêts de
	// substitution sont alors laissés de côté à la publication, qui le dit (cf. `collectCandidates`).
	if (!Array.isArray(payload.stops)) return { message: `${label} : liste d'arrêts de substitution attendue.` };
	const stops: DetourSegment["stops"] = [];
	let previousTravelTime = Number.NEGATIVE_INFINITY;

	for (const [index, entry] of payload.stops.entries()) {
		if (typeof entry !== "object" || entry === null) return { message: `${label}, arrêt ${index + 1} : illisible.` };
		const stop = entry as Record<string, unknown>;

		// Un tronçon ne fait que DÉSIGNER des arrêts : ce qu'ils sont — leur nom, leur position — vit
		// dans le GTFS ou dans la base provisoire, jamais ici. Rien à valider de plus que l'existence.
		const stopId = stop.stopId;
		if (typeof stopId !== "string" || stopId.length === 0) {
			return { message: `${label}, arrêt ${index + 1} : identifiant manquant.` };
		}
		if (!gtfs.stopNames.has(stopId) && !store.provisionalStops.has(stopId)) {
			return {
				message: `${label}, arrêt ${index + 1} : « ${stopId} » n'existe ni dans le GTFS ni dans les arrêts provisoires.`,
			};
		}
		if (designated.has(stopId)) {
			return { message: `${label}, arrêt ${index + 1} : cet arrêt figure déjà dans la déclaration.` };
		}
		designated.add(stopId);

		const travelTime = stop.travelTime;
		if (!Number.isInteger(travelTime)) {
			return { message: `${label}, arrêt ${index + 1} : temps de parcours attendu en secondes.` };
		}
		// La spec l'exige croissant : c'est un temps cumulé depuis l'arrêt de référence, pas un intervalle.
		if ((travelTime as number) <= previousTravelTime) {
			return {
				message: `${label}, arrêt ${index + 1} : le temps de parcours doit dépasser celui de l'arrêt précédent.`,
			};
		}
		previousTravelTime = travelTime as number;

		stops.push({ stopId, travelTime: travelTime as number });
	}

	if (!Array.isArray(payload.path)) return { message: `${label} : tracé attendu, une liste de points.` };
	const path = [];
	for (const [index, entry] of payload.path.entries()) {
		const point = Array.isArray(entry) ? readCoordinates(entry[0], entry[1]) : undefined;
		if (point === undefined) return { message: `${label}, point ${index + 1} du tracé : coordonnées hors du réseau.` };
		path.push(point);
	}
	// Un tracé d'un seul point ne décrit rien, et `Shape` en réclame deux au minimum.
	if (path.length === 1) return { message: `${label} : un tracé doit compter au moins deux points.` };

	// Les points de passage sont facultatifs : sans eux, le tracé EST sa propre suite de points de
	// passage, tirés droit — c'est le dessin libre d'avant, et un PUT écrit à la main reste valable.
	const waypoints: DetourSegment["waypoints"] = [];
	if (payload.waypoints === undefined) {
		waypoints.push(...path.map((point) => ({ ...point, mode: "free" as const })));
	} else {
		if (!Array.isArray(payload.waypoints)) return { message: `${label} : points de passage attendus, une liste.` };

		for (const [index, entry] of payload.waypoints.entries()) {
			if (typeof entry !== "object" || entry === null) {
				return { message: `${label}, point de passage ${index + 1} : illisible.` };
			}
			const waypoint = entry as Record<string, unknown>;

			const point = Array.isArray(waypoint.point) ? readCoordinates(waypoint.point[0], waypoint.point[1]) : undefined;
			if (point === undefined) {
				return { message: `${label}, point de passage ${index + 1} : coordonnées hors du réseau.` };
			}
			if (waypoint.mode !== "route" && waypoint.mode !== "free") {
				return { message: `${label}, point de passage ${index + 1} : mode attendu, « route » ou « free ».` };
			}

			waypoints.push({ ...point, mode: waypoint.mode });
		}
	}

	// Le seul lien qu'on impose entre les deux : ils vont de pair. On ne vérifie PAS que le tracé
	// redérive des points de passage — ce serait rejouer le routage ici, et le tracé, déjà contrôlé
	// point par point, fait foi de toute façon.
	if (waypoints.length === 1) return { message: `${label} : un tracé doit compter au moins deux points de passage.` };
	if ((path.length === 0) !== (waypoints.length === 0)) {
		return { message: `${label} : tracé et points de passage doivent être tous deux vides, ou tous deux remplis.` };
	}

	return {
		segment: {
			startStopId: startStopId as string | null,
			endStopId: endStopId as string | null,
			propagatedDelay: propagatedDelay as number,
			stops,
			waypoints,
			path,
		},
	};
}

/**
 * Une modification qui désigne un arrêt provisoire, telle que la liste des arrêts la cite. Son info
 * trafic peut avoir quitté le flux : la modification reste en base, mais n'a plus d'édition à ouvrir
 * — `open` le dit.
 */
function describeUsage(uid: number, routeId: string, directionId: number, deps: AdminDependencies) {
	const modification = deps.modificationIndex.modifications.get(uid);

	return {
		uid,
		line: lineName(deps.gtfs.data, routeId),
		lineCode: lineCode(routeId),
		directionId,
		headsigns: headsignsOf(deps.gtfs.data, routeId, directionId),
		label: modification?.label ?? null,
		open: modification !== undefined,
	};
}

/** Ce qu'un arrêt désigné est, pour l'affichage : son libellé, sa position, et d'où il vient. */
function describeStop(stopId: string, deps: AdminDependencies) {
	const provisional = deps.store.provisionalStops.get(stopId);
	if (provisional !== undefined) {
		return {
			name: provisional.name,
			latitude: provisional.latitude,
			longitude: provisional.longitude,
			provisional: true,
		};
	}

	const coordinates = deps.gtfs.data.stopCoordinates.get(stopId);
	return {
		name: deps.gtfs.data.stopNames.get(stopId) ?? stopId,
		latitude: coordinates?.latitude ?? null,
		longitude: coordinates?.longitude ?? null,
		provisional: false,
	};
}

/** Une borne `{ date, time }` telle que le formulaire l'envoie, ou `null` pour une borne absente. */
function readBound(
	raw: unknown,
	which: string,
):
	| { bound: string; date: Temporal.PlainDate; time: Temporal.PlainTime | null }
	| { bound: null }
	| { message: string } {
	if (raw === undefined || raw === null) return { bound: null };
	if (typeof raw !== "object") return { message: `Borne de ${which} illisible.` };

	const payload = raw as Record<string, unknown>;
	const date = typeof payload.date === "string" ? payload.date.trim() : "";
	const time = typeof payload.time === "string" ? payload.time.trim() : "";

	if (date.length === 0) {
		return time.length === 0 ? { bound: null } : { message: `Heure de ${which} sans date.` };
	}
	if (!DATE_PATTERN.test(date)) return { message: `Date de ${which} attendue au format AAAA-MM-JJ.` };
	if (time.length > 0 && !TIME_PATTERN.test(time)) return { message: `Heure de ${which} attendue au format HH:MM.` };

	let plainDate: Temporal.PlainDate;
	try {
		plainDate = Temporal.PlainDate.from(date, { overflow: "reject" });
	} catch {
		return { message: `Date de ${which} invalide.` };
	}

	return time.length === 0
		? { bound: date, date: plainDate, time: null }
		: { bound: `${date}T${time}`, date: plainDate, time: Temporal.PlainTime.from(time) };
}

/** « 2026-09-24T08:30 » donne `{ date: "2026-09-24", time: "08:30" }` ; sans heure, `time` est null. */
function splitBound(bound: string) {
	const [date, time] = bound.split("T");
	return { date: date as string, time: time ?? null };
}

/** Relit le corps d'une création ou d'une modification d'arrêt provisoire. */
async function parseProvisionalStop(
	c: Context,
): Promise<{ name: string; latitude: number; longitude: number } | { message: string }> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return { message: "Corps de requête illisible." };
	}

	if (typeof body !== "object" || body === null) return { message: "Corps de requête attendu : un objet." };
	const payload = body as Record<string, unknown>;

	const name = typeof payload.name === "string" ? payload.name.trim() : "";
	if (name.length === 0) return { message: "Le nom de l'arrêt est obligatoire." };

	const coordinates = readCoordinates(payload.latitude, payload.longitude);
	if (coordinates === undefined) return { message: "Coordonnées hors du réseau." };

	return { name, ...coordinates };
}

/** Un point tel que l'interface l'envoie : une paire [latitude, longitude]. */
function readPoint(raw: unknown) {
	return Array.isArray(raw) ? readCoordinates(raw[0], raw[1]) : undefined;
}

function readCoordinates(latitude: unknown, longitude: unknown) {
	if (typeof latitude !== "number" || typeof longitude !== "number") return undefined;
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
	if (latitude < LATITUDE_RANGE[0] || latitude > LATITUDE_RANGE[1]) return undefined;
	if (longitude < LONGITUDE_RANGE[0] || longitude > LONGITUDE_RANGE[1]) return undefined;
	return { latitude, longitude };
}
