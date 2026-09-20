import GtfsRealtime from "gtfs-realtime-bindings";
import {
	type AlertInput,
	type AlertPeriod,
	type AlertRouteContext,
	analyzeAlerts,
	type DailyWindow,
	flushCache,
	pruneCache,
	type RemovedStop,
} from "../ai/analyze-alert.js";
import { SERVED_STOPS } from "../config.js";
import { detourKey } from "../detours/store.js";
import {
	normalizeStopName,
	type OrderedStop,
	type StaticGtfs,
	stopNameKey,
	stopNameMatches,
	stopNameTokens,
	type TripStop,
} from "./use-static-gtfs.js";

const SKIPPED = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;
const NO_DATA = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA;

const TIME_ZONE = "Europe/Paris";

/** Aucune exception : partagé plutôt que réalloué pour chaque ligne de chaque alerte. */
const EMPTY_SERVED: ReadonlySet<string> = new Set();

export type SkipBucket = { directionId: number | null; stopIds: Set<string> };
/** routeId → buckets d'arrêts à sauter (SKIPPED), par sens. */
export type SkipIndex = Map<string, SkipBucket[]>;

/**
 * Le périmètre d'une perturbation, à la maille où se déclare une déviation : une info trafic, une
 * ligne, un sens. C'est la même maille que le {@link SkipIndex}, et elle est construite dans la même
 * passe — à ceci près qu'elle retient aussi les perturbations À VENIR, que le `SkipIndex` écarte.
 * L'interface en a besoin : un tracé de déviation se prépare avant le début des travaux, pas le
 * matin même.
 *
 * Un bucket « les deux sens » y donne deux scopes, un par sens : une déviation se déclare sens par
 * sens — le tracé et les arrêts provisoires n'y sont jamais les mêmes.
 */
export type AlertScope = {
	/** Clé stable `<numéro d'info trafic>:<routeId>:<directionId>`. */
	key: string;
	/** L'identifiant d'entité du flux amont, tel quel : c'est lui que porte `serviceAlertId`. */
	alertId: string;
	/** Le numéro d'info trafic (cf. {@link alertNumber}), qui sert de clé aux déclarations. */
	alertNumber: string;
	routeId: string;
	directionId: number;
	headerText: string;
	descriptionText: string;
	periods: AlertPeriod[];
	/** Vrai lorsque l'une des périodes couvre l'instant du relevé. */
	active: boolean;
	/** Les quais supprimés pour ce sens, une fois retranchés ceux que {@link SERVED_STOPS} rétablit. */
	removedStopIds: Set<string>;
};

/** Les perturbations connues, par {@link AlertScope.key}. */
export type AlertScopeIndex = Map<string, AlertScope>;

/**
 * Une info trafic analysée, réduite à ce qui sert à bâtir les index.
 *
 * Elle est retenue telle quelle d'un relevé à l'autre, et c'est ce qui permet de reconstruire
 * `skipIndex` et `alertScopes` à tout moment — quand les périodes basculent, ou quand un périmètre
 * est saisi à la main — sans refaire tourner l'IA ni attendre le relevé suivant.
 */
export type AnalyzedAlert = {
	/** L'identifiant d'entité du flux amont : c'est lui que porte `serviceAlertId`. */
	alertId: string;
	alertNumber: string;
	headerText: string;
	descriptionText: string;
	periods: AlertPeriod[];
	/** Les lignes du réseau que l'info trafic cite, dans l'ordre où elle les cite. */
	routeIds: string[];
	/** Les quais supprimés que l'analyse donne, par ligne et par sens — `null` pour les deux sens. */
	contributions: AlertContribution[];
};

/** Des quais supprimés sur une ligne, dans un sens ou dans les deux. */
export type AlertContribution = { routeId: string; directionId: number | null; stopIds: Set<string> };

/**
 * Les périmètres saisis à la main, par {@link detourKey}. C'est la forme minimale de
 * `ScopeOverride` dont l'indexation a besoin — de quoi ne pas faire dépendre ce module de la base
 * des déviations.
 */
export type ScopeOverrideIndex = ReadonlyMap<
	string,
	{ alertNumber: string; routeId: string; directionId: number; removedStopIds: string[] }
>;

/** Numéro d'info trafic → routeId → quais que cette alerte ne doit PAS faire sauter. */
type ServedStopIndex = Map<string, Map<string, Set<string>>>;

type AlertsState = { headerTimestamp: string | null };
type PollResult = { alerts: AnalyzedAlert[]; headerTimestamp: string | null };

let currentInterval: NodeJS.Timeout | undefined;

/**
 * Les infos trafic, analysées puis indexées.
 *
 * `overrides` rend les périmètres saisis à la main, et il est relu à CHAQUE indexation plutôt que
 * retenu : une saisie doit valoir tout de suite, et `reindex` est là pour ça — l'indexation ne
 * touche pas au réseau, elle se rejoue en quelques millisecondes.
 */
export function useServiceAlerts(
	url: string,
	pollInterval: number,
	gtfs: { data: StaticGtfs },
	overrides: () => ScopeOverrideIndex,
) {
	const state: AlertsState = { headerTimestamp: null };
	const resource = {
		skipIndex: new Map<string, SkipBucket[]>(),
		/** Les perturbations connues, en vigueur ou à venir (cf. {@link AlertScope}). */
		alertScopes: new Map<string, AlertScope>() as AlertScopeIndex,
		/** Les infos trafic analysées, périmètre saisi à la main non compris (cf. {@link AnalyzedAlert}). */
		alerts: [] as AnalyzedAlert[],
		importedAt: Temporal.Now.instant(),
		/**
		 * Rebâtit les index depuis la dernière analyse. À appeler dès qu'un périmètre est saisi ou
		 * retiré : le relevé suivant ferait tout autant, mais vingt minutes plus tard.
		 */
		reindex() {
			const indexed = indexAlerts(resource.alerts, overrides(), Temporal.Now.instant());
			resource.skipIndex = indexed.skipIndex;
			resource.alertScopes = indexed.alertScopes;
		},
	};
	let running = false;

	// Le premier build (analyse IA de toutes les alertes) tourne en arrière-plan : il ne doit
	// pas immobiliser le démarrage du serveur. L'index se remplit dès que l'analyse est prête.
	const runPoll = async () => {
		if (running) return; // évite tout chevauchement si un poll dépasse l'intervalle
		running = true;
		try {
			const next = await pollAlerts(url, gtfs.data, state);
			if (!next) return; // flux inchangé, erreur, ou GTFS indisponible → on garde l'index courant
			resource.alerts = next.alerts;
			resource.reindex();
			resource.importedAt = Temporal.Now.instant();
			state.headerTimestamp = next.headerTimestamp;
		} finally {
			running = false;
		}
	};

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	void runPoll();
	currentInterval = setInterval(runPoll, pollInterval);

	return resource;
}

/** Renvoie l'ensemble des stopId à sauter pour un (routeId, directionId) donné. */
export function skippedStopIds(skipIndex: SkipIndex, routeId: string, directionId: number): Set<string> {
	const buckets = skipIndex.get(routeId);
	if (buckets === undefined) return new Set();

	const stopIds = new Set<string>();
	for (const bucket of buckets) {
		if (bucket.directionId !== null && bucket.directionId !== directionId) continue;
		for (const stopId of bucket.stopIds) stopIds.add(stopId);
	}
	return stopIds;
}

/**
 * Marque en SKIPPED les arrêts supprimés d'un trip. Deux cas :
 *  1. arrêt présent dans le GTFS-RT → on le bascule en SKIPPED (temps retirés) ;
 *  2. arrêt supprimé mais ABSENT du GTFS-RT (la source l'a retiré) → on le réinsère comme entrée
 *     SKIPPED, à sa position (stop_sequence issu de l'horaire théorique du trip).
 *
 * Les terminus que la course dessert encore sont préservés dans les deux cas (cf.
 * {@link keepEffectiveTermini}).
 */
export function applySkippedStops(
	tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate,
	routeId: string,
	skipIndex: SkipIndex,
	gtfs: StaticGtfs,
) {
	const stopTimeUpdates = tripUpdate.stopTimeUpdate;
	if (!stopTimeUpdates?.length) return;

	const directionId = tripUpdate.trip?.directionId ?? 0;
	let stopIds = skippedStopIds(skipIndex, routeId, directionId);
	if (stopIds.size === 0) return;

	// L'horaire théorique sert au garde-fou (terminus de la course) puis à la réinsertion.
	const tripId = tripUpdate.trip?.tripId;
	const schedule = tripId ? gtfs.tripStopSequences.get(tripId) : undefined;
	if (schedule !== undefined) {
		stopIds = keepEffectiveTermini(stopIds, schedule, gtfs, routeId, directionId);
		if (stopIds.size === 0) return;
	}

	// 1. Arrêts déjà présents → bascule en SKIPPED.
	const presentIds = new Set<string>();
	for (const stopTimeUpdate of stopTimeUpdates) {
		if (stopTimeUpdate.stopId) presentIds.add(stopTimeUpdate.stopId);
		if (stopTimeUpdate.stopId && stopIds.has(stopTimeUpdate.stopId)) {
			stopTimeUpdate.scheduleRelationship = SKIPPED;
			stopTimeUpdate.arrival = null;
			stopTimeUpdate.departure = null;
		}
	}

	// 2. Arrêts supprimés absents du GTFS-RT → réinsertion (à partir de l'horaire théorique du trip).
	if (schedule === undefined) return;

	const inserted: GtfsRealtime.transit_realtime.TripUpdate.IStopTimeUpdate[] = [];
	for (const { stopSequence, stopId } of schedule) {
		if (stopIds.has(stopId) && !presentIds.has(stopId)) {
			inserted.push({ stopSequence, stopId, scheduleRelationship: SKIPPED });
		}
	}
	if (inserted.length > 0) {
		tripUpdate.stopTimeUpdate = [...stopTimeUpdates, ...inserted].sort(
			(a, b) => (a.stopSequence ?? 0) - (b.stopSequence ?? 0),
		);
	}
}

/**
 * Cette course annonce-t-elle au moins un arrêt supprimé ? Sans temps réel ni suppression, il ne
 * reste d'elle que le NO_DATA de son premier arrêt — rien que l'horaire théorique ne dise déjà. Elle
 * n'est alors pas publiée du tout, qu'elle vienne du flux source ou du théorique.
 */
export function hasSkippedStops(tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate): boolean {
	return tripUpdate.stopTimeUpdate?.some((stopTimeUpdate) => stopTimeUpdate.scheduleRelationship === SKIPPED) ?? false;
}

/**
 * Réduit un trip update à ce qu'on sait de sûr d'une course sans temps réel : qu'elle circule, et
 * quels arrêts elle ne dessert pas. Ses horaires, eux, ne valent rien et ne doivent pas être
 * diffusés — la source rebadge le théorique en temps réel sur les lignes hors
 * {@link REALTIME_LINES}, et une course qu'elle ignore n'en a tout simplement aucun. Les
 * suppressions d'arrêt, elles, viennent des alertes et non de la source : elles restent exploitables.
 *
 * Le premier arrêt de l'horaire théorique ouvre donc la liste en NO_DATA, qui vaut « pas de temps
 * réel ici » pour lui comme pour toute la suite de la course, et le distingue d'une course qu'on
 * aurait passée sous silence. Sauf lorsqu'il est lui-même supprimé : la suppression prime, elle en
 * dit davantage. Suivent les arrêts supprimés.
 *
 * Une course dont l'horaire théorique est introuvable — un GTFS antérieur au service en cours — et
 * qui ne saute aucun arrêt se retrouve sans stopTimeUpdate : elle n'a alors plus rien à dire, et
 * `createFeed` l'écarte à l'émission.
 */
export function declareNoRealtime(
	tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate,
	schedule: TripStop[] | undefined,
) {
	const skipped = (tripUpdate.stopTimeUpdate ?? []).filter(
		(stopTimeUpdate) => stopTimeUpdate.scheduleRelationship === SKIPPED,
	);

	// L'horaire étant trié, un premier arrêt supprimé est nécessairement le premier des SKIPPED.
	const origin = schedule?.[0];
	tripUpdate.stopTimeUpdate =
		origin === undefined || skipped[0]?.stopId === origin.stopId
			? skipped
			: [{ stopSequence: origin.stopSequence, stopId: origin.stopId, scheduleRelationship: NO_DATA }, ...skipped];

	// Retard global calculé sur du faux temps réel → sans objet.
	tripUpdate.delay = null;
}

// ---

async function pollAlerts(url: string, gtfs: StaticGtfs, previous: AlertsState): Promise<PollResult | null> {
	console.log("➔ Fetching service alerts.");

	if (gtfs.stopNameIndex.size === 0) {
		console.warn("✘ Static GTFS unavailable — skipping service-alert analysis.");
		return null;
	}

	try {
		const response = await fetch(url);
		if (!response.ok || response.status === 204) {
			console.error(`✘ Failed to fetch service alerts (HTTP ${response.status}).`);
			return null;
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const feed = GtfsRealtime.transit_realtime.FeedMessage.decode(buffer);
		const headerTimestamp = feed.header?.timestamp != null ? String(feed.header.timestamp) : null;
		const today = Temporal.Now.plainDateISO(TIME_ZONE).toString();

		// L'analyse est TOUJOURS rejouée, même à flux inchangé : les périodes qu'elle porte ont des heures
		// (travaux de nuit), et l'indexation qui suit doit les re-jauger. Aucun réappel IA n'en découle :
		// à texte inchangé, `analyzeAlerts` sert entièrement le cache.
		if (headerTimestamp !== null && headerTimestamp === previous.headerTimestamp) {
			console.log(`✓ Service alerts unchanged (feed ${headerTimestamp}) — re-evaluating periods.`);
		}

		const feedAlertIds = new Set<string>();
		// Résolu à chaque poll : le GTFS statique se recharge sous nos pieds, et avec lui les quais.
		const servedStops = resolveServedStops(gtfs);

		// 1. Collecte des alertes touchant une ligne du réseau.
		const inputs: AlertInput[] = [];
		const routesById = new Map<string, Set<string>>();
		for (const entity of feed.entity) {
			const alert = entity.alert;
			if (!alert) continue;
			feedAlertIds.add(entity.id);

			const routeIds = collectNetworkRoutes(alert, gtfs);
			if (routeIds.size === 0) continue;

			routesById.set(entity.id, routeIds);
			inputs.push({
				id: entity.id,
				headerText: joinTranslations(alert.headerText),
				descriptionText: joinTranslations(alert.descriptionText),
				routes: buildRouteContext(routeIds, gtfs),
				today,
			});
		}

		// 2. Analyse groupée (un seul appel IA pour toutes les alertes nouvelles/modifiées).
		const analyses = await analyzeAlerts(inputs);

		// 3. Résolution des noms d'arrêt en quais, ligne par ligne et sens par sens.
		//
		// Elle tourne pour TOUTES les alertes, en vigueur ou non : c'est l'indexation qui départage —
		// le feed ne doit annoncer que ce qui est en vigueur, quand l'interface doit aussi montrer ce
		// qui vient, un tracé de déviation se préparant à l'avance.
		const alerts: AnalyzedAlert[] = [];
		for (const input of inputs) {
			const analysis = analyses.get(input.id);
			if (!analysis) continue;

			const routeIds = routesById.get(input.id) ?? new Set();
			const served = servedStops.get(alertNumber(input.id));
			const contributions: AlertContribution[] = [];

			for (const removedStop of analysis.removedStops) {
				for (const route of removedStop.routes) {
					if (!routeIds.has(route.routeId)) continue;
					const servedIds = served?.get(route.routeId) ?? EMPTY_SERVED;
					const { routeId, directionId } = route;

					for (const [bucketDirection, stopIds] of resolveRemovedStop(
						gtfs,
						removedStop,
						routeId,
						directionId,
						servedIds,
					)) {
						contributions.push({ routeId, directionId: bucketDirection, stopIds });
					}
				}
			}

			alerts.push({
				alertId: input.id,
				alertNumber: alertNumber(input.id),
				headerText: input.headerText,
				descriptionText: input.descriptionText,
				periods: analysis.periods,
				routeIds: [...routeIds],
				contributions,
			});
		}

		// Persiste le cache IA (alertes disparues purgées) pour éviter tout réappel au redémarrage.
		pruneCache(feedAlertIds);
		flushCache();

		return { alerts, headerTimestamp };
	} catch (cause) {
		console.error("✘ Failed to load service alerts!", cause);
		return null;
	}
}

/**
 * Les deux index que tout le reste consomme : les quais à sauter dans les trip updates, et le
 * périmètre des déviations déclarables.
 *
 * Purement synchrone, et rejouable autant de fois qu'on veut : elle ne fait que relire la dernière
 * analyse. C'est ce qui permet de re-jauger les périodes à chaque relevé et de prendre en compte un
 * périmètre saisi à la main sans attendre — ni rappeler l'IA.
 *
 * Un périmètre saisi REMPLACE l'analyse pour son couple ligne/sens : ses arrêts sont les arrêts
 * supprimés, fût-ce aucun. La règle vaut dans les deux sens du terme — l'analyse est écartée là où
 * elle voyait quelque chose, et la saisie crée le périmètre là où elle ne voyait rien.
 */
export function indexAlerts(
	alerts: readonly AnalyzedAlert[],
	overrides: ScopeOverrideIndex,
	now: Temporal.Instant,
): { skipIndex: SkipIndex; alertScopes: AlertScopeIndex } {
	const skipIndex: SkipIndex = new Map();
	const alertScopes: AlertScopeIndex = new Map();
	let removedCount = 0;

	for (const alert of alerts) {
		const active = isActive(alert.periods, now);

		for (const { routeId, directionId, stopIds } of alert.contributions) {
			// Un bucket « les deux sens » se dédouble : la maille d'une déviation est le sens, et un seul
			// des deux peut avoir été repris à la main — l'autre garde alors ce que l'analyse en dit.
			const directions = directionId === null ? [0, 1] : [directionId];
			const free = directions.filter((direction) => !overrides.has(detourKey(alert.alertNumber, routeId, direction)));
			if (free.length === 0) continue;

			if (active) {
				mergeSkip(skipIndex, routeId, free.length === directions.length ? directionId : (free[0] as number), stopIds);
				removedCount += 1;
			}

			for (const direction of free) mergeScope(alertScopes, alert, routeId, direction, stopIds, active);
		}
	}

	// Les périmètres saisis viennent en dernier, sur un terrain que la boucle ci-dessus leur a laissé
	// libre : ils n'ont donc rien à écraser, seulement à poser.
	const byNumber = new Map<string, AnalyzedAlert>();
	for (const alert of alerts) if (!byNumber.has(alert.alertNumber)) byNumber.set(alert.alertNumber, alert);

	for (const override of overrides.values()) {
		const alert = byNumber.get(override.alertNumber);
		// L'info trafic n'est plus au flux : il n'y a plus de perturbation à porter. La saisie reste en
		// base — les travaux reprennent, et le numéro avec eux.
		if (alert === undefined) continue;

		const active = isActive(alert.periods, now);
		const stopIds = new Set(override.removedStopIds);
		mergeScope(alertScopes, alert, override.routeId, override.directionId, stopIds, active);

		if (active && stopIds.size > 0) {
			mergeSkip(skipIndex, override.routeId, override.directionId, stopIds);
			removedCount += 1;
		}
	}

	console.log(
		`✓ ${skipIndex.size} routes with skipped stops (${removedCount} entries, ${alertScopes.size} detour scopes, ${overrides.size} hand-written).`,
	);

	return { skipIndex, alertScopes };
}

/**
 * Une alerte peut porter plusieurs plages de dates disjointes (« du 17 au 21 et les 24 et 25 août ») :
 * elle est active dès que l'une d'elles l'est. Aucune période = aucune borne connue, donc toujours active.
 */
export function isActive(periods: AlertPeriod[], now: Temporal.Instant): boolean {
	return periods.length === 0 || periods.some((period) => isPeriodActive(period, now));
}

/**
 * Une perturbation récurrente n'est active que pendant sa tranche horaire, chaque jour de l'enveloppe
 * `start`/`end` ; sinon, la période va de `start` à `end`, avec des bornes à la journée ou à la minute
 * selon ce que le texte de l'alerte précisait (cf. {@link AlertPeriod}).
 */
function isPeriodActive(period: AlertPeriod, now: Temporal.Instant): boolean {
	if (period.dailyWindow) return isDailyWindowActive(period, period.dailyWindow, now);

	const start = period.start ? periodStart(period.start) : null;
	const endExclusive = period.end ? periodEnd(period.end) : null;

	return (
		(start === null || Temporal.Instant.compare(now, start) >= 0) &&
		(endExclusive === null || Temporal.Instant.compare(now, endExclusive) < 0)
	);
}

/**
 * Active si `now` tombe dans la tranche horaire d'un jour couvert par l'enveloppe. On teste aussi la
 * tranche ouverte la VEILLE : une tranche de nuit (« 20h > 5h ») déborde sur le lendemain matin.
 */
function isDailyWindowActive(period: AlertPeriod, window: DailyWindow, now: Temporal.Instant): boolean {
	const zoned = now.toZonedDateTimeISO(TIME_ZONE);
	// `to` <= `from` → la tranche passe minuit et se termine le lendemain.
	const spansMidnight = window.to <= window.from;

	for (const dayOffset of [0, -1]) {
		const day = zoned.toPlainDate().add({ days: dayOffset });
		if (!isDayInEnvelope(period, day)) continue;

		const from = atTime(day, window.from);
		const to = atTime(spansMidnight ? day.add({ days: 1 }) : day, window.to);
		if (from === null || to === null) continue;

		if (Temporal.Instant.compare(now, from) >= 0 && Temporal.Instant.compare(now, to) < 0) return true;
	}

	return false;
}

/** Vrai si `day` est un jour où la tranche horaire démarre (bornes de l'enveloppe incluses). */
function isDayInEnvelope(period: AlertPeriod, day: Temporal.PlainDate): boolean {
	const start = period.start ? plainDate(period.start) : null;
	const end = period.end ? plainDate(period.end) : null;

	if (start !== null && Temporal.PlainDate.compare(day, start) < 0) return false;
	if (end !== null && Temporal.PlainDate.compare(day, end) > 0) return false;
	return true;
}

/** Borne de début : minuit pour une date seule, l'instant exact pour un « AAAA-MM-JJTHH:MM ». */
function periodStart(value: string): Temporal.Instant | null {
	return hasTime(value) ? toInstant(value) : startOfDay(value);
}

/** Borne de fin : exclusive. Une date seule couvre toute la journée, une heure précise arrête net. */
function periodEnd(value: string): Temporal.Instant | null {
	return hasTime(value) ? toInstant(value) : startOfDay(value, 1);
}

function hasTime(value: string): boolean {
	return value.includes("T");
}

function startOfDay(date: string, addDays = 0): Temporal.Instant | null {
	try {
		return Temporal.PlainDate.from(date).add({ days: addDays }).toZonedDateTime(TIME_ZONE).toInstant();
	} catch {
		return null;
	}
}

function toInstant(dateTime: string): Temporal.Instant | null {
	try {
		return Temporal.PlainDateTime.from(dateTime).toZonedDateTime(TIME_ZONE).toInstant();
	} catch {
		return null;
	}
}

function atTime(day: Temporal.PlainDate, time: string): Temporal.Instant | null {
	try {
		return day.toPlainDateTime(Temporal.PlainTime.from(time)).toZonedDateTime(TIME_ZONE).toInstant();
	} catch {
		return null;
	}
}

/** Partie date d'une borne, qu'elle porte ou non une heure. */
function plainDate(value: string): Temporal.PlainDate | null {
	try {
		return Temporal.PlainDate.from(value.slice(0, 10));
	} catch {
		return null;
	}
}

/**
 * Routes du réseau touchées par l'alerte. Le flux couvre plusieurs opérateurs (TAE…) : on ne
 * retient que les routes présentes dans notre GTFS, seules exploitables en aval.
 */
function collectNetworkRoutes(alert: GtfsRealtime.transit_realtime.IAlert, gtfs: StaticGtfs): Set<string> {
	const routeIds = new Set<string>();
	for (const informed of alert.informedEntity ?? []) {
		const routeId = informed.routeId;
		if (!routeId) continue;
		if (gtfs.routeDirections.has(routeId)) routeIds.add(routeId);
	}
	return routeIds;
}

function buildRouteContext(routeIds: Set<string>, gtfs: StaticGtfs): AlertRouteContext[] {
	return [...routeIds].map((routeId) => ({
		routeId,
		shortName: routeId.split(":").at(-1) ?? routeId,
		directions: gtfs.routeDirections.get(routeId) ?? [],
	}));
}

/**
 * Les quais à sauter pour un arrêt supprimé (ou une plage « de X à Y ») sur une ligne/sens, rangés
 * par bucket de sens — `null` valant « les deux ». Rien à sauter, ou hors périmètre → aucune entrée.
 *
 * Le versement dans l'index est laissé à l'appelant : les mêmes quais alimentent aussi le périmètre
 * des déviations, qui ne retient pas les mêmes alertes (cf. la passe commune de `pollAlerts`).
 *
 * `served` porte les quais que l'alerte en cours ne doit pas faire sauter (cf. {@link SERVED_STOPS}) :
 * ils sont retranchés de chaque contribution.
 */
function resolveRemovedStop(
	gtfs: StaticGtfs,
	removedStop: RemovedStop,
	routeId: string,
	directionId: number | null,
	served: ReadonlySet<string>,
): Map<number | null, Set<string>> {
	const contributions = new Map<number | null, Set<string>>();

	/** Verse les quais retenus dans le bucket du sens, ceux que `served` rétablit en moins. */
	const contribute = (bucketDirection: number | null, stopIds: Set<string>) => {
		const kept = keepUnlessServed(stopIds, served);
		if (kept.size === 0) return;

		const existing = contributions.get(bucketDirection);
		if (existing === undefined) contributions.set(bucketDirection, kept);
		else for (const stopId of kept) existing.add(stopId);
	};

	const startName = normalizeStopName(removedStop.stopName);
	const directions = directionId === null ? [0, 1] : [directionId];

	// Arrêt seul.
	if (!removedStop.toStopName) {
		// Match global, exact puis tolérant (chemin rapide).
		const resolved = resolveStopIds(gtfs, startName);
		if (resolved !== undefined) {
			contribute(directionId, resolved);
			return contributions;
		}
		// Sinon, match flou dans le contexte de la ligne (ex. « Piscine » → « Piscine de Bihorel »).
		for (const dir of directions) {
			const stops = (gtfs.routeStopSequences.get(routeId)?.get(dir) ?? []).flat();
			const canonical = stops[findStopIndex(stops, startName)]?.name;
			const stopIds = canonical ? gtfs.stopNameIndex.get(canonical) : undefined;
			if (stopIds && stopIds.size > 0) contribute(dir, stopIds);
		}
		return contributions;
	}

	// Plage : on détermine les arrêts entre les deux extrémités le long de l'itinéraire, puis on
	// supprime TOUS les quais de chaque nom (comme pour un arrêt seul) — robuste aux variantes de
	// quais empruntées par les différentes courses.
	//
	// Les noms de la plage sont calculés en RÉUNISSANT les deux sens, et tous les itinéraires de
	// chacun. Une extrémité peut n'être desservie que dans un sens (arrêt à quai unique, ex. « Église
	// Saint-Romain » sur la 22, absente du trajet retour) ou n'exister que sur une branche (le métro
	// vers Georges Braque) : le découpage échouerait alors et retomberait sur les seules extrémités,
	// perdant tous les arrêts intermédiaires. Le segment physique étant le même quel que soit le sens
	// de parcours, l'union donne le bon ensemble d'arrêts ; supprimer par nom ne touche de toute façon
	// que les quais réellement desservis par chaque course.
	const endName = normalizeStopName(removedStop.toStopName);

	const rangeNames = new Set<string>();
	for (const dir of [0, 1]) {
		for (const sequence of gtfs.routeStopSequences.get(routeId)?.get(dir) ?? []) {
			const sliced = sliceRangeNames(sequence, startName, endName);
			if (sliced) for (const name of sliced) rangeNames.add(name);
		}
	}
	const sliced = rangeNames.size > 0;

	if (removedStop.interruption) {
		// Circulation coupée : les véhicules font demi-tour aux points cités, qui restent desservis en
		// terminus provisoire. Seule saute la borne qui est DÉJÀ un terminus de la ligne — au-delà, il
		// n'y a plus rien à desservir (« métro interrompu entre JF Kennedy et Georges Braque » : Kennedy
		// devient le terminus, Georges Braque et les arrêts qui l'en séparent ne sont plus desservis).
		//
		// Sans itinéraire, on ne sait pas départager les bornes : ne rien annoncer vaut mieux que
		// supprimer un arrêt qui reste desservi. De même si la coupure ne laisse aucun arrêt entre deux
		// terminus provisoires voisins — le tronçon perdu ne contient alors aucun arrêt.
		if (!sliced) return contributions;
		removeProvisionalTermini(rangeNames, gtfs, routeId, [startName, endName]);
		if (rangeNames.size === 0) return contributions;
	}

	// Repli : aucune extrémité sur un itinéraire connu → on ne supprime que les extrémités citées.
	const names = sliced ? [...rangeNames] : [startName, endName];

	const stopIds = new Set<string>();
	for (const name of names) {
		for (const id of resolveStopIds(gtfs, name) ?? []) stopIds.add(id);
	}
	if (stopIds.size === 0) return contributions;

	for (const dir of directions) contribute(dir, stopIds);

	return contributions;
}

/**
 * Indexe la table {@link SERVED_STOPS} par info trafic et par ligne. Un quai que le GTFS courant ne
 * connaît pas — coquille, identifiant renuméroté — est ignoré : mieux vaut annoncer l'arrêt supprimé,
 * comme le veut l'info trafic, que de croire neutraliser une suppression sans rien neutraliser.
 */
function resolveServedStops(gtfs: StaticGtfs): ServedStopIndex {
	const index: ServedStopIndex = new Map();

	for (const servedStop of SERVED_STOPS) {
		const alertId = alertNumber(servedStop.alertId);
		let routes = index.get(alertId);
		if (routes === undefined) {
			routes = new Map();
			index.set(alertId, routes);
		}

		let stopIds = routes.get(servedStop.routeId);
		if (stopIds === undefined) {
			stopIds = new Set();
			routes.set(servedStop.routeId, stopIds);
		}

		for (const stopId of servedStop.stopIds) {
			if (!gtfs.stopNames.has(stopId)) {
				console.warn(`✘ Served stop ignored: unknown stop "${stopId}".`);
				continue;
			}
			stopIds.add(stopId);
		}
	}

	return index;
}

/**
 * Numéro d'info trafic porté par un identifiant d'entité du flux d'alertes
 * (« 00000000-0000-0000-0000-000000022467 » → « 22467 »). Les numéros déclarés dans
 * {@link SERVED_STOPS} passent par la même moulinette, qu'ils soient écrits nus ou en entier.
 */
export function alertNumber(alertId: string): string {
	const tail = alertId.split("-").at(-1) ?? alertId;
	return tail.replace(/^0+(?=\d)/, "");
}

/**
 * Les quais à sauter, moins ceux que `served` déclare desservis.
 *
 * Le retranchement ne regarde pas le sens : un quai n'est desservi que dans un sens, celui-là même
 * que l'exception vise. Un quai que les deux sens empruntent est de toute façon desservi dans les
 * deux — l'exception dit qu'on s'y arrête, pas qu'on s'y arrête dans un sens seulement.
 */
function keepUnlessServed(stopIds: Set<string>, served: ReadonlySet<string>): Set<string> {
	if (served.size === 0) return new Set(stopIds);

	const kept = new Set<string>();
	for (const stopId of stopIds) {
		if (!served.has(stopId)) kept.add(stopId);
	}
	return kept;
}

/**
 * Verse les quais supprimés dans le périmètre de la déviation correspondante, en la créant au
 * besoin. Une même info trafic cite souvent le même sens plusieurs fois — une plage, puis un arrêt
 * isolé — et tout se réunit sous la même clé.
 *
 * `active` ne se recalcule pas d'une contribution à l'autre : il vaut pour l'alerte entière.
 */
function mergeScope(
	scopes: AlertScopeIndex,
	alert: AnalyzedAlert,
	routeId: string,
	directionId: number,
	stopIds: ReadonlySet<string>,
	active: boolean,
) {
	// La même clé que celle des déclarations, et empruntée à elles : c'est le seul lien entre les deux
	// modules, et le réécrire ici serait la meilleure façon de le laisser diverger un jour.
	const key = detourKey(alert.alertNumber, routeId, directionId);

	let scope = scopes.get(key);
	if (scope === undefined) {
		scope = {
			key,
			alertId: alert.alertId,
			alertNumber: alert.alertNumber,
			routeId,
			directionId,
			headerText: alert.headerText,
			descriptionText: alert.descriptionText,
			periods: alert.periods,
			active,
			removedStopIds: new Set(),
		};
		scopes.set(key, scope);
	}

	for (const stopId of stopIds) scope.removedStopIds.add(stopId);
}

/**
 * Quais portant ce nom (déjà normalisé) : match exact, sinon rapprochement tolérant aux
 * approximations de la source (« Champs de Mars » → « Champ de Mars »). Une clé tolérante qui
 * recouvre plusieurs arrêts distincts est écartée — mieux vaut ne rien supprimer et laisser le
 * repli par itinéraire trancher que supprimer le mauvais arrêt.
 */
function resolveStopIds(gtfs: StaticGtfs, normalizedName: string): Set<string> | undefined {
	const exact = gtfs.stopNameIndex.get(normalizedName);
	if (exact !== undefined) return exact;

	const names = gtfs.stopKeyIndex.get(stopNameKey(normalizedName));
	if (names === undefined || names.size !== 1) return undefined;
	return gtfs.stopNameIndex.get([...names][0] as string);
}

/**
 * Écarte des arrêts à sauter les TERMINUS que la course dessert encore. Quand le GTFS a déjà intégré
 * une interruption, il tronque les courses au point de rebroussement : ce point devient leur terminus,
 * et le tronçon supprimé commence juste après. L'annoncer supprimé serait faux — une course qui finit
 * là s'y arrête bel et bien, et n'aurait plus aucun terminus desservi.
 *
 * La coupure se reconnaît au VOISIN : sur l'itinéraire complet de la ligne, l'arrêt situé AU-DELÀ du
 * terminus (donc hors de la course) est lui aussi supprimé. Sans ce test, on interdirait du même coup
 * les suppressions de terminus légitimes, celles où le GTFS n'a PAS encore été mis à jour (« terminus
 * provisoire Technopôle, arrêt non desservi ESIGELEC » : ESIGELEC termine l'itinéraire, rien au-delà).
 */
function keepEffectiveTermini(
	stopIds: Set<string>,
	schedule: TripStop[],
	gtfs: StaticGtfs,
	routeId: string,
	directionId: number,
): Set<string> {
	const first = schedule[0];
	const last = schedule.at(-1);
	if (first === undefined || last === undefined) return stopIds;

	const sequences = gtfs.routeStopSequences.get(routeId)?.get(directionId) ?? [];
	// Le début de la course a son au-delà en amont de l'itinéraire, la fin en aval.
	const termini = [
		{ stopId: first.stopId, step: -1 },
		{ stopId: last.stopId, step: 1 },
	];

	let kept = stopIds;
	for (const { stopId, step } of termini) {
		if (!kept.has(stopId) || !isTruncatedAt(sequences, stopId, step, stopIds)) continue;
		if (kept === stopIds) kept = new Set(stopIds);
		kept.delete(stopId);
	}

	return kept;
}

/** Vrai si l'arrêt voisin de `stopId`, au-delà du terminus de la course, est lui aussi supprimé. */
function isTruncatedAt(sequences: OrderedStop[][], stopId: string, step: number, stopIds: Set<string>): boolean {
	for (const sequence of sequences) {
		const index = sequence.findIndex((stop) => stop.stopId === stopId);
		if (index === -1) continue;

		const beyond = sequence[index + step];
		if (beyond !== undefined && stopIds.has(beyond.stopId)) return true;
	}

	return false;
}

/**
 * Retire de la plage les bornes citées qui deviennent des TERMINUS PROVISOIRES : sur une circulation
 * interrompue, les véhicules s'y arrêtent au lieu de poursuivre. Une borne qui est déjà un terminus
 * de la ligne est conservée dans la plage — le service n'y va plus du tout.
 */
function removeProvisionalTermini(rangeNames: Set<string>, gtfs: StaticGtfs, routeId: string, bounds: string[]) {
	const termini = routeTerminusNames(gtfs, routeId);

	for (const name of [...rangeNames]) {
		if (termini.has(name)) continue;
		if (bounds.some((bound) => stopNameMatches(bound, name))) rangeNames.delete(name);
	}
}

/** Noms des terminus de la ligne : première et dernière position de chacun de ses itinéraires. */
function routeTerminusNames(gtfs: StaticGtfs, routeId: string): Set<string> {
	const names = new Set<string>();

	for (const sequences of gtfs.routeStopSequences.get(routeId)?.values() ?? []) {
		for (const sequence of sequences) {
			const first = sequence[0];
			const last = sequence.at(-1);
			if (first) names.add(first.name);
			if (last) names.add(last.name);
		}
	}

	return names;
}

/** Renvoie les noms d'arrêts de l'itinéraire entre deux arrêts (inclus), quel que soit le sens de citation. */
function sliceRangeNames(sequence: OrderedStop[], startName: string, endName: string): string[] | undefined {
	const startIndex = findStopIndex(sequence, startName);
	const endIndex = findStopIndex(sequence, endName);
	if (startIndex === -1 || endIndex === -1) return undefined;

	const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
	return sequence.slice(lo, hi + 1).map((stop) => stop.name);
}

/**
 * Position d'un arrêt (nom normalisé) dans un itinéraire, du candidat le plus fidèle au plus lâche.
 * Le rapprochement tolérant de {@link stopNameMatches} colle parfois à PLUSIEURS arrêts d'une même
 * ligne, et le premier rencontré n'est pas forcément le bon : sur la F8, « La Vielle » se retrouve
 * dans « Hôtel de Ville Belvédère » (`vielle` ↔ `ville`, une lettre d'écart) — situé bien avant le
 * vrai arrêt dans le sens aller, il élargissait la plage supprimée à tout le tronçon intermédiaire.
 *
 * On essaie donc, dans l'ordre : le nom identique, puis le nom entier rapproché (même nombre de mots,
 * à une faute près par mot — « La Vielle » ↔ « La Vieille »), et seulement en dernier recours le
 * rapprochement d'un libellé abrégé dans un nom plus long (« Piscine » → « Piscine de Bihorel »).
 * Renvoie -1 si aucun arrêt ne correspond.
 */
function findStopIndex(sequence: OrderedStop[], normalizedName: string): number {
	const exact = sequence.findIndex((stop) => stop.name === normalizedName);
	if (exact !== -1) return exact;

	const wordCount = stopNameTokens(normalizedName).length;
	const whole = sequence.findIndex(
		(stop) => stopNameTokens(stop.name).length === wordCount && stopNameMatches(normalizedName, stop.name),
	);
	if (whole !== -1) return whole;

	return sequence.findIndex((stop) => stopNameMatches(normalizedName, stop.name));
}

function mergeSkip(skipIndex: SkipIndex, routeId: string, directionId: number | null, stopIds: Set<string>) {
	let buckets = skipIndex.get(routeId);
	if (buckets === undefined) {
		buckets = [];
		skipIndex.set(routeId, buckets);
	}

	let bucket = buckets.find((candidate) => candidate.directionId === directionId);
	if (bucket === undefined) {
		bucket = { directionId, stopIds: new Set() };
		buckets.push(bucket);
	}
	for (const stopId of stopIds) bucket.stopIds.add(stopId);
}

function joinTranslations(text: GtfsRealtime.transit_realtime.ITranslatedString | null | undefined): string {
	if (!text?.translation?.length) return "";
	return text.translation
		.map((translation) => translation.text ?? "")
		.filter(Boolean)
		.join(" / ");
}
