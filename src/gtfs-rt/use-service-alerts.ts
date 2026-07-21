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
import {
	normalizeStopName,
	type OrderedStop,
	type StaticGtfs,
	stopNameKey,
	stopNameTokens,
} from "./use-static-gtfs.js";

const SKIPPED = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;

const TIME_ZONE = "Europe/Paris";

export type SkipBucket = { directionId: number | null; stopIds: Set<string> };
/** routeId → buckets d'arrêts à sauter (SKIPPED), par sens. */
export type SkipIndex = Map<string, SkipBucket[]>;

type AlertsState = { headerTimestamp: string | null };
type PollResult = { skipIndex: SkipIndex; headerTimestamp: string | null };

let currentInterval: NodeJS.Timeout | undefined;

export function useServiceAlerts(url: string, pollInterval: number, gtfs: { data: StaticGtfs }) {
	const state: AlertsState = { headerTimestamp: null };
	const resource = {
		skipIndex: new Map<string, SkipBucket[]>(),
		importedAt: Temporal.Now.instant(),
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
			resource.skipIndex = next.skipIndex;
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
	const stopIds = skippedStopIds(skipIndex, routeId, directionId);
	if (stopIds.size === 0) return;

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
	const tripId = tripUpdate.trip?.tripId;
	const schedule = tripId ? gtfs.tripStopSequences.get(tripId) : undefined;
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
 * Réduit un trip update aux seuls arrêts SKIPPED, en retirant tout horaire. À appliquer aux lignes
 * hors {@link REALTIME_LINES}, dont la source rebadge le théorique en temps réel : ces horaires ne
 * valent rien et ne doivent pas être diffusés, alors que les suppressions d'arrêt — issues des
 * alertes, pas de la source — restent une information exploitable.
 *
 * Un trip qui ne saute aucun arrêt se retrouve donc sans stopTimeUpdate : il n'a plus rien à dire.
 */
export function keepOnlySkippedStops(tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate) {
	tripUpdate.stopTimeUpdate = (tripUpdate.stopTimeUpdate ?? []).filter(
		(stopTimeUpdate) => stopTimeUpdate.scheduleRelationship === SKIPPED,
	);
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
		// Les activePeriod du GTFS-RT ne sont pas fiables : on s'appuie sur les dates extraites du texte par l'IA.
		const now = Temporal.Now.instant();
		const today = Temporal.Now.plainDateISO(TIME_ZONE).toString();

		// L'index est TOUJOURS reconstruit, même à flux inchangé : les périodes extraites par l'IA portent
		// des heures (travaux de nuit), et leurs bornes doivent être re-jaugées à chaque poll. Aucun réappel
		// IA n'en découle : à texte inchangé, `analyzeAlerts` sert entièrement le cache.
		if (headerTimestamp !== null && headerTimestamp === previous.headerTimestamp) {
			console.log(`✓ Service alerts unchanged (feed ${headerTimestamp}) — re-evaluating periods.`);
		}

		const skipIndex: SkipIndex = new Map();
		const feedAlertIds = new Set<string>();

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

		// 3. Construction de l'index de suppressions.
		let removedCount = 0;
		for (const input of inputs) {
			const analysis = analyses.get(input.id);
			if (!analysis || analysis.removedStops.length === 0 || !isPeriodActive(analysis.period, now)) continue;

			const routeIds = routesById.get(input.id) ?? new Set();
			for (const removedStop of analysis.removedStops) {
				for (const route of removedStop.routes) {
					if (!routeIds.has(route.routeId)) continue;
					removedCount += applyRemovedStop(skipIndex, gtfs, removedStop, route.routeId, route.directionId);
				}
			}
		}

		// Persiste le cache IA (alertes disparues purgées) pour éviter tout réappel au redémarrage.
		pruneCache(feedAlertIds);
		flushCache();

		console.log(`✓ ${skipIndex.size} routes with skipped stops (${removedCount} entries).`);
		return { skipIndex, headerTimestamp };
	} catch (cause) {
		console.error("✘ Failed to load service alerts!", cause);
		return null;
	}
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
 * Ajoute à l'index les arrêts à sauter pour un arrêt supprimé (ou une plage « de X à Y »)
 * sur une ligne/sens. Renvoie le nombre de contributions (pour les logs). Hors périmètre → 0.
 */
function applyRemovedStop(
	skipIndex: SkipIndex,
	gtfs: StaticGtfs,
	removedStop: RemovedStop,
	routeId: string,
	directionId: number | null,
): number {
	const startName = normalizeStopName(removedStop.stopName);
	const directions = directionId === null ? [0, 1] : [directionId];

	// Arrêt seul.
	if (!removedStop.toStopName) {
		// Match global, exact puis tolérant (chemin rapide).
		const resolved = resolveStopIds(gtfs, startName);
		if (resolved !== undefined) {
			mergeSkip(skipIndex, routeId, directionId, resolved);
			return 1;
		}
		// Sinon, match flou dans le contexte de la ligne (ex. « Piscine » → « Piscine de Bihorel »).
		let count = 0;
		for (const dir of directions) {
			const sequence = gtfs.routeStopSequences.get(routeId)?.get(dir);
			const canonical = sequence?.find((stop) => stopNameMatches(startName, stop.name))?.name;
			const stopIds = canonical ? gtfs.stopNameIndex.get(canonical) : undefined;
			if (stopIds && stopIds.size > 0) {
				mergeSkip(skipIndex, routeId, dir, stopIds);
				count += 1;
			}
		}
		return count;
	}

	// Plage : on détermine les arrêts entre les deux extrémités le long de l'itinéraire (par sens),
	// puis on supprime TOUS les quais de chaque nom (comme pour un arrêt seul) — robuste aux
	// variantes de quais empruntées par les différentes courses.
	const endName = normalizeStopName(removedStop.toStopName);
	let count = 0;

	for (const dir of directions) {
		const sequence = gtfs.routeStopSequences.get(routeId)?.get(dir);
		const rangeNames = sequence ? sliceRangeNames(sequence, startName, endName) : undefined;
		// Repli : si l'itinéraire manque ou qu'une extrémité n'y figure pas, on ne supprime que
		// les extrémités connues du GTFS (pas de régression, best-effort).
		const names = rangeNames ?? [startName, endName];

		const stopIds = new Set<string>();
		for (const name of names) {
			for (const id of resolveStopIds(gtfs, name) ?? []) stopIds.add(id);
		}

		if (stopIds.size > 0) {
			mergeSkip(skipIndex, routeId, dir, stopIds);
			count += 1;
		}
	}

	return count;
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

/** Renvoie les noms d'arrêts de l'itinéraire entre deux arrêts (inclus), quel que soit le sens de citation. */
function sliceRangeNames(sequence: OrderedStop[], startName: string, endName: string): string[] | undefined {
	const startIndex = sequence.findIndex((stop) => stopNameMatches(startName, stop.name));
	const endIndex = sequence.findIndex((stop) => stopNameMatches(endName, stop.name));
	if (startIndex === -1 || endIndex === -1) return undefined;

	const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
	return sequence.slice(lo, hi + 1).map((stop) => stop.name);
}

/**
 * Rapproche un nom d'arrêt d'alerte d'un nom d'arrêt GTFS (déjà normalisés). Vrai si le nom de
 * l'alerte est une sous-séquence contiguë de mots du nom GTFS — gère les libellés abrégés de l'info
 * trafic (« Piscine » → « Piscine de Bihorel », « Michelet » → « Collège Michelet »). La comparaison
 * porte sur les tokens ({@link stopNameTokens}), à une faute de frappe près par mot : l'appel se
 * fait dans le contexte d'une ligne (quelques dizaines d'arrêts), où le risque de confusion est faible.
 *
 * Le rapprochement est volontairement à SENS UNIQUE : un nom d'alerte plus précis que le nom GTFS
 * ne matche pas. Les mots en trop désignent presque toujours un autre lieu — « Pôle Multimodal-Cotoni »
 * n'est pas l'arrêt « Pôle Multimodal ». Les noms de pôle (station parente) restent rapprochés par
 * `stopNameIndex`, qui les indexe vers leurs quais.
 */
function stopNameMatches(alertName: string, gtfsName: string): boolean {
	if (alertName === gtfsName) return true;
	return containsRun(stopNameTokens(alertName), stopNameTokens(gtfsName));
}

/** Vrai si `needle` apparaît comme une suite contiguë de mots dans `haystack`. */
function containsRun(needle: string[], haystack: string[]): boolean {
	if (needle.length === 0 || needle.length > haystack.length) return false;

	for (let i = 0; i <= haystack.length - needle.length; i += 1) {
		let match = true;
		for (let j = 0; j < needle.length; j += 1) {
			if (!tokenMatches(haystack[i + j] as string, needle[j] as string)) {
				match = false;
				break;
			}
		}
		if (match) return true;
	}
	return false;
}

/**
 * Vrai si deux mots sont identiques, ou à une faute près. La tolérance est réservée aux mots assez
 * longs : sur les courts, une faute d'écart confond des noms bel et bien distincts.
 */
function tokenMatches(a: string, b: string): boolean {
	if (a === b) return true;
	if (a.length < 5 && b.length < 5) return false;
	return withinOneEdit(a, b);
}

/** Vrai si une seule insertion, suppression ou substitution suffit à passer de `a` à `b`. */
function withinOneEdit(a: string, b: string): boolean {
	if (Math.abs(a.length - b.length) > 1) return false;

	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	let edited = false;
	let i = 0;
	for (let j = 0; j < long.length; j += 1) {
		if (short[i] === long[j]) {
			i += 1;
			continue;
		}
		if (edited) return false;
		edited = true;
		// Longueurs égales → substitution (on avance des deux côtés) ; sinon insertion dans `long`.
		if (short.length === long.length) i += 1;
	}
	return true;
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
