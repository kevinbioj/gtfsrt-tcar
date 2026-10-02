import { unzipSync } from "fflate";

import { LEGACY_TERMINUS_TOLERANCE } from "../config.js";
import { type Coordinates, haversine } from "../utils/geometry.js";
import { HOME_NETWORK, networkOf } from "../utils/network.js";
import { fetchSignature, parseCsv, parseServiceTime, type StaticGtfs, signatureOf } from "./use-static-gtfs.js";

/**
 * Ce que le GTFS de l'ancien GTFS-RT dit d'une course — juste de quoi la reconnaître dans le GTFS
 * publié : sa ligne, son sens, ses horaires de passage et ses deux terminus.
 *
 * Les quais n'y sont pas comparables d'un GTFS à l'autre (« 201887 » d'un côté, « TCAR:RONCE1 » de
 * l'autre) : seules leurs coordonnées le sont.
 */
export type LegacyTrip = {
	/** Ligne préfixée comme le GTFS publié (« TCAR:01 »). */
	routeId: string;
	directionId: number;
	/** Arrivées théoriques, arrêt après arrêt, en secondes depuis minuit de la journée de service. */
	arrivals: number[];
	origin: Coordinates | undefined;
	destination: Coordinates | undefined;
};

let currentInterval: NodeJS.Timeout | undefined;

/**
 * Tient à jour le GTFS dont l'ancien GTFS-RT tire ses identifiants de course. Ce n'est pas celui que
 * le feed publie : les deux sont régénérés chacun de leur côté, et rien ne garantit qu'un même
 * `trip_id` y désigne la même course (cf. {@link matchLegacyTrip}).
 *
 * Comme le GTFS publié, il n'est retéléchargé que lorsque sa signature (Last-Modified) change.
 */
export async function useLegacyGtfs(url: string, checkInterval: number) {
	const loaded = await loadLegacyGtfs(url);
	const resource = {
		trips: loaded?.trips ?? new Map<string, LegacyTrip>(),
		importedAt: Temporal.Now.instant(),
	};
	let signature = loaded?.signature ?? null;

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(async () => {
		const remote = await fetchSignature(url);
		if (remote === null || remote === signature) return;

		const next = await loadLegacyGtfs(url);
		if (next === undefined) return; // chargement échoué → on garde l'ancien
		resource.trips = next.trips;
		resource.importedAt = Temporal.Now.instant();
		signature = next.signature;
		console.log("✓ Legacy GTFS updated (new version published).");
	}, checkInterval);

	return resource;
}

/**
 * La course du GTFS publié qui correspond à celle qu'annonce l'ancien GTFS-RT sous `tripId` (son
 * identifiant brut, sans préfixe), ou `undefined` si aucune ne lui correspond.
 *
 * Les deux GTFS partagent d'ordinaire leurs identifiants, mais ils sont régénérés chacun de leur
 * côté : un même `trip_id` peut y désigner deux courses différentes, et l'annonce injecterait alors
 * un véhicule sur une course qu'il n'assure pas. On vérifie donc, dans cet ordre :
 *
 *  1. que la course homonyme du GTFS publié est bien la même — même ligne, même sens, mêmes
 *     horaires de passage ;
 *  2. à défaut, on cherche dans le GTFS publié une course qui partage ces trois choses ;
 *  3. à défaut encore — une course retouchée d'une minute en cours de route —, une course de même
 *     ligne et même sens qui part et arrive aux mêmes heures, depuis et vers les mêmes terminus (à
 *     {@link LEGACY_TERMINUS_TOLERANCE} près).
 *
 * Plusieurs courses publiées peuvent convenir : ce sont les versions d'une même course, une par
 * service (cf. `courseVersions`). N'importe laquelle fait l'affaire, la journée de service tranche
 * ensuite (cf. `resolveNearestRun`).
 *
 * Une course que le GTFS de l'ancien flux ne connaît pas n'est pas vérifiable : `undefined` aussi.
 * L'appelant décide alors quoi faire de l'identifiant brut.
 */
export function matchLegacyTrip(
	legacyTrips: ReadonlyMap<string, LegacyTrip>,
	gtfs: StaticGtfs,
	tripId: string,
): string | undefined {
	const legacy = legacyTrips.get(tripId);
	if (legacy === undefined) return undefined;

	const matcher = matcherFor(legacyTrips, gtfs);
	const cached = matcher.results.get(tripId);
	if (cached !== undefined || matcher.results.has(tripId)) return cached;

	const homonym = `${HOME_NETWORK}:${tripId}`;
	const match =
		scheduleKeyOf(gtfs, homonym) === legacyScheduleKey(legacy)
			? homonym
			: (matcher.bySchedule.get(legacyScheduleKey(legacy))?.[0] ??
				matcher.bySlot.get(legacySlotKey(legacy))?.find((candidate) => sameTermini(gtfs, candidate, legacy)));

	if (match !== homonym) {
		console.warn(
			`\t⚠ Legacy trip ${tripId} ${match === undefined ? "has no counterpart in the published GTFS, kept as is" : `matched to ${match}`}.`,
		);
	}

	matcher.results.set(tripId, match);
	return match;
}

// ---

/**
 * Index du GTFS publié pour un couple de versions des deux GTFS, et rapprochements déjà tranchés. Il
 * est rebâti dès que l'un des deux change.
 */
type Matcher = {
	legacyTrips: ReadonlyMap<string, LegacyTrip>;
	/** Ligne, sens et horaires de passage → courses TCAR publiées. */
	bySchedule: Map<string, string[]>;
	/** Ligne, sens, départ et arrivée → courses TCAR publiées. */
	bySlot: Map<string, string[]>;
	results: Map<string, string | undefined>;
};

const matchers = new WeakMap<StaticGtfs, Matcher>();

function matcherFor(legacyTrips: ReadonlyMap<string, LegacyTrip>, gtfs: StaticGtfs): Matcher {
	const existing = matchers.get(gtfs);
	if (existing?.legacyTrips === legacyTrips) return existing;

	const bySchedule = new Map<string, string[]>();
	const bySlot = new Map<string, string[]>();
	const push = (index: Map<string, string[]>, key: string, tripId: string) => {
		const list = index.get(key);
		if (list === undefined) index.set(key, [tripId]);
		else list.push(tripId);
	};

	for (const tripId of gtfs.trips.keys()) {
		if (networkOf(tripId) !== HOME_NETWORK) continue;

		const scheduleKey = scheduleKeyOf(gtfs, tripId);
		const slotKey = slotKeyOf(gtfs, tripId);
		if (scheduleKey !== undefined) push(bySchedule, scheduleKey, tripId);
		if (slotKey !== undefined) push(bySlot, slotKey, tripId);
	}

	const matcher: Matcher = { legacyTrips, bySchedule, bySlot, results: new Map() };
	matchers.set(gtfs, matcher);
	return matcher;
}

function scheduleKeyOf(gtfs: StaticGtfs, tripId: string): string | undefined {
	const meta = gtfs.trips.get(tripId);
	const schedule = gtfs.tripStopSequences.get(tripId);
	if (meta === undefined || schedule === undefined) return undefined;
	return `${meta.routeId}|${meta.directionId}|${schedule.map(({ arrival }) => arrival).join(",")}`;
}

function legacyScheduleKey(legacy: LegacyTrip): string {
	return `${legacy.routeId}|${legacy.directionId}|${legacy.arrivals.join(",")}`;
}

function slotKeyOf(gtfs: StaticGtfs, tripId: string): string | undefined {
	const meta = gtfs.trips.get(tripId);
	const schedule = gtfs.tripStopSequences.get(tripId);
	const first = schedule?.[0]?.arrival;
	const last = schedule?.at(-1)?.arrival;
	if (meta === undefined || first === undefined || last === undefined) return undefined;
	return `${meta.routeId}|${meta.directionId}|${first}|${last}`;
}

function legacySlotKey(legacy: LegacyTrip): string {
	return `${legacy.routeId}|${legacy.directionId}|${legacy.arrivals[0]}|${legacy.arrivals.at(-1)}`;
}

/** Vrai si la course publiée part et arrive aux mêmes endroits que celle de l'ancien GTFS. */
function sameTermini(gtfs: StaticGtfs, tripId: string, legacy: LegacyTrip): boolean {
	const schedule = gtfs.tripStopSequences.get(tripId);
	const origin = gtfs.stopCoordinates.get(schedule?.[0]?.stopId ?? "");
	const destination = gtfs.stopCoordinates.get(schedule?.at(-1)?.stopId ?? "");
	if (origin === undefined || destination === undefined) return false;
	if (legacy.origin === undefined || legacy.destination === undefined) return false;

	return (
		haversine(origin, legacy.origin) <= LEGACY_TERMINUS_TOLERANCE &&
		haversine(destination, legacy.destination) <= LEGACY_TERMINUS_TOLERANCE
	);
}

async function loadLegacyGtfs(
	url: string,
): Promise<{ trips: Map<string, LegacyTrip>; signature: string | null } | undefined> {
	console.log("➔ Fetching legacy GTFS.");

	try {
		const response = await fetch(url);
		if (!response.ok) {
			console.error(`✘ Failed to fetch legacy GTFS (HTTP ${response.status}).`);
			return undefined;
		}

		const signature = signatureOf(response);
		const files = unzipSync(new Uint8Array(await response.arrayBuffer()), {
			filter: (file) => file.name === "stops.txt" || file.name === "trips.txt" || file.name === "stop_times.txt",
		});
		const stopsFile = files["stops.txt"];
		const tripsFile = files["trips.txt"];
		const stopTimesFile = files["stop_times.txt"];
		if (!stopsFile || !tripsFile || !stopTimesFile) {
			console.error("✘ Legacy GTFS is missing stops.txt, trips.txt or stop_times.txt.");
			return undefined;
		}

		// Ses fichiers commencent par une marque d'ordre des octets : le décodeur par défaut l'écarte, elle
		// collerait sinon au premier en-tête.
		const decoder = new TextDecoder();

		const coordinates = new Map<string, Coordinates>();
		for (const { stop_id, stop_lat, stop_lon } of rowsOf(decoder.decode(stopsFile))) {
			const latitude = Number.parseFloat(stop_lat ?? "");
			const longitude = Number.parseFloat(stop_lon ?? "");
			if (stop_id && Number.isFinite(latitude) && Number.isFinite(longitude))
				coordinates.set(stop_id, { latitude, longitude });
		}

		const meta = new Map<string, { routeId: string; directionId: number }>();
		for (const { trip_id, route_id, direction_id } of rowsOf(decoder.decode(tripsFile))) {
			const directionId = Number.parseInt(direction_id ?? "", 10);
			if (trip_id && route_id && !Number.isNaN(directionId))
				meta.set(trip_id, { routeId: `${HOME_NETWORK}:${route_id}`, directionId });
		}

		const perTrip = new Map<string, { stopSequence: number; stopId: string; arrival: number }[]>();
		for (const { trip_id, stop_id, stop_sequence, arrival_time } of rowsOf(decoder.decode(stopTimesFile))) {
			const stopSequence = Number.parseInt(stop_sequence ?? "", 10);
			if (!trip_id || !stop_id || Number.isNaN(stopSequence) || !meta.has(trip_id)) continue;

			let stops = perTrip.get(trip_id);
			if (stops === undefined) {
				stops = [];
				perTrip.set(trip_id, stops);
			}
			stops.push({ stopSequence, stopId: stop_id, arrival: parseServiceTime(arrival_time ?? "") });
		}

		const trips = new Map<string, LegacyTrip>();
		for (const [tripId, stops] of perTrip) {
			const tripMeta = meta.get(tripId);
			if (tripMeta === undefined) continue;

			stops.sort((a, b) => a.stopSequence - b.stopSequence);
			trips.set(tripId, {
				...tripMeta,
				arrivals: stops.map(({ arrival }) => arrival),
				origin: coordinates.get(stops[0]?.stopId ?? ""),
				destination: coordinates.get(stops.at(-1)?.stopId ?? ""),
			});
		}

		console.log(`✓ Loaded ${trips.size} trips from legacy GTFS.`);
		return { trips, signature };
	} catch (cause) {
		console.error("✘ Failed to load legacy GTFS!", cause);
		return undefined;
	}
}

/** Les lignes d'un CSV, chacune indexée par les noms de colonnes de l'en-tête. */
function* rowsOf(csv: string): Generator<Record<string, string | undefined>> {
	const rows = parseCsv(csv);
	const header: string[] | undefined = rows.next().value;
	if (!header) return;

	for (const row of rows) {
		yield Object.fromEntries(header.map((column, index) => [column, row[index]]));
	}
}
