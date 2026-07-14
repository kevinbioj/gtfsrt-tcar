import GtfsRealtime from "gtfs-realtime-bindings";
import {
	type AlertInput,
	type AlertPeriod,
	type AlertRouteContext,
	analyzeAlerts,
	flushCache,
	pruneCache,
	type RemovedStop,
} from "../ai/analyze-alert.js";
import { ALLOWED_LINES } from "../config.js";
import { normalizeStopName, type OrderedStop, type StaticGtfs } from "./use-static-gtfs.js";

export type SkipBucket = { directionId: number | null; stopIds: Set<string> };
/** routeId → buckets d'arrêts à sauter (SKIPPED), par sens. */
export type SkipIndex = Map<string, SkipBucket[]>;

type AlertsState = { headerTimestamp: string | null; buildDate: string | null };
type PollResult = { skipIndex: SkipIndex; headerTimestamp: string | null; buildDate: string };

let currentInterval: NodeJS.Timeout | undefined;

export function useServiceAlerts(url: string, pollInterval: number, gtfs: { data: StaticGtfs }) {
	const state: AlertsState = { headerTimestamp: null, buildDate: null };
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
			state.buildDate = next.buildDate;
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
		const today = Temporal.Now.plainDateISO("Europe/Paris").toString();

		// Flux inchangé (même timestamp) ET même jour → rien à retraiter (le jour est réévalué
		// pour re-jauger les périodes IA aux frontières de journée sans réappeler l'IA).
		if (headerTimestamp !== null && headerTimestamp === previous.headerTimestamp && today === previous.buildDate) {
			console.log(`✓ Service alerts unchanged (feed ${headerTimestamp}).`);
			return null;
		}

		const skipIndex: SkipIndex = new Map();
		const feedAlertIds = new Set<string>();

		// 1. Collecte des alertes touchant une ligne autorisée.
		const inputs: AlertInput[] = [];
		const allowedById = new Map<string, Set<string>>();
		for (const entity of feed.entity) {
			const alert = entity.alert;
			if (!alert) continue;
			feedAlertIds.add(entity.id);

			const allowedRouteIds = collectAllowedRoutes(alert);
			if (allowedRouteIds.size === 0) continue;

			allowedById.set(entity.id, allowedRouteIds);
			inputs.push({
				id: entity.id,
				headerText: joinTranslations(alert.headerText),
				descriptionText: joinTranslations(alert.descriptionText),
				routes: buildRouteContext(allowedRouteIds, gtfs),
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

			const allowedRouteIds = allowedById.get(input.id) ?? new Set();
			for (const removedStop of analysis.removedStops) {
				for (const route of removedStop.routes) {
					if (!allowedRouteIds.has(route.routeId)) continue;
					removedCount += applyRemovedStop(skipIndex, gtfs, removedStop, route.routeId, route.directionId);
				}
			}
		}

		// Persiste le cache IA (alertes disparues purgées) pour éviter tout réappel au redémarrage.
		pruneCache(feedAlertIds);
		flushCache();

		console.log(`✓ ${skipIndex.size} routes with skipped stops (${removedCount} entries).`);
		return { skipIndex, headerTimestamp, buildDate: today };
	} catch (cause) {
		console.error("✘ Failed to load service alerts!", cause);
		return null;
	}
}

function isPeriodActive(period: AlertPeriod, now: Temporal.Instant): boolean {
	const start = period.start ? startOfDay(period.start) : null;
	// La borne de fin est inclusive : active tant que `now` précède le début du lendemain.
	const endExclusive = period.end ? startOfDay(period.end, 1) : null;

	return (
		(start === null || Temporal.Instant.compare(now, start) >= 0) &&
		(endExclusive === null || Temporal.Instant.compare(now, endExclusive) < 0)
	);
}

function startOfDay(date: string, addDays = 0): Temporal.Instant | null {
	try {
		return Temporal.PlainDate.from(date).add({ days: addDays }).toZonedDateTime("Europe/Paris").toInstant();
	} catch {
		return null;
	}
}

function collectAllowedRoutes(alert: GtfsRealtime.transit_realtime.IAlert): Set<string> {
	const routeIds = new Set<string>();
	for (const informed of alert.informedEntity ?? []) {
		const routeId = informed.routeId;
		if (!routeId) continue;
		const lineId = routeId.split(":").at(-1) ?? "";
		if (ALLOWED_LINES.has(lineId)) routeIds.add(routeId);
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

	// Arrêt seul : tous les quais portant ce nom (le filtrage par trip garantit la pertinence).
	if (!removedStop.toStopName) {
		const stopIds = gtfs.stopNameIndex.get(startName);
		if (stopIds === undefined) return 0; // hors périmètre GTFS → ignoré
		mergeSkip(skipIndex, routeId, directionId, stopIds);
		return 1;
	}

	// Plage : on étend le long de l'itinéraire de la ligne, par sens.
	const endName = normalizeStopName(removedStop.toStopName);
	const directions = directionId === null ? [0, 1] : [directionId];
	let count = 0;

	for (const dir of directions) {
		const sequence = gtfs.routeStopSequences.get(routeId)?.get(dir);
		const rangeIds = sequence ? sliceRange(sequence, startName, endName) : undefined;

		if (rangeIds && rangeIds.size > 0) {
			mergeSkip(skipIndex, routeId, dir, rangeIds);
			count += 1;
			continue;
		}

		// Repli : au moins les extrémités connues du GTFS (pas de régression si l'itinéraire manque).
		const fallback = new Set<string>();
		for (const id of gtfs.stopNameIndex.get(startName) ?? []) fallback.add(id);
		for (const id of gtfs.stopNameIndex.get(endName) ?? []) fallback.add(id);
		if (fallback.size > 0) {
			mergeSkip(skipIndex, routeId, dir, fallback);
			count += 1;
		}
	}

	return count;
}

/** Renvoie les stopId de l'itinéraire entre deux arrêts (inclus), quel que soit le sens de citation. */
function sliceRange(sequence: OrderedStop[], startName: string, endName: string): Set<string> | undefined {
	const startIndex = sequence.findIndex((stop) => stop.name === startName);
	const endIndex = sequence.findIndex((stop) => stop.name === endName);
	if (startIndex === -1 || endIndex === -1) return undefined;

	const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
	const ids = new Set<string>();
	for (let i = lo; i <= hi; i += 1) ids.add(sequence[i]!.stopId);
	return ids;
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
