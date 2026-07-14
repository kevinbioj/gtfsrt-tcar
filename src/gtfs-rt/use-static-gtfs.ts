import { unzipSync } from "fflate";

export type RouteDirection = { directionId: number; headsigns: string[] };

/** Un arrêt dans l'itinéraire d'une ligne : son quai (stopId) et son nom normalisé. */
export type OrderedStop = { stopId: string; name: string };

export type StaticGtfs = {
	/** Nom d'arrêt normalisé → identifiants des quais (enfants) portant ce nom. */
	stopNameIndex: Map<string, Set<string>>;
	/** routeId → directions desservies avec leurs terminus (headsigns). */
	routeDirections: Map<string, RouteDirection[]>;
	/** routeId → directionId → itinéraire ordonné des arrêts (pour étendre les plages « de X à Y »). */
	routeStopSequences: Map<string, Map<number, OrderedStop[]>>;
};

let currentInterval: NodeJS.Timeout | undefined;

export async function useStaticGtfs(url: string, refreshInterval: number, onReload?: () => void) {
	const resource = {
		data: await loadGtfs(url),
		importedAt: Temporal.Now.instant(),
	};

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(async () => {
		const next = await loadGtfs(url);
		if (next.stopNameIndex.size === 0) return; // chargement échoué → on garde l'ancien
		resource.data = next;
		resource.importedAt = Temporal.Now.instant();
		onReload?.();
	}, refreshInterval);

	return resource;
}

/** Normalise un nom d'arrêt : minuscules, sans accents, alphanumérique compacté. */
export function normalizeStopName(name: string): string {
	return name
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

// ---

async function loadGtfs(url: string): Promise<StaticGtfs> {
	console.log("➔ Fetching static GTFS.");

	const empty: StaticGtfs = { stopNameIndex: new Map(), routeDirections: new Map(), routeStopSequences: new Map() };

	try {
		const response = await fetch(url);
		if (!response.ok) {
			console.error(`✘ Failed to fetch static GTFS (HTTP ${response.status}).`);
			return empty;
		}

		const buffer = new Uint8Array(await response.arrayBuffer());
		const files = unzipSync(buffer, {
			filter: (file) => file.name === "stops.txt" || file.name === "trips.txt" || file.name === "stop_times.txt",
		});

		if (!files["stops.txt"] || !files["trips.txt"]) {
			console.error("✘ Static GTFS is missing stops.txt or trips.txt.");
			return empty;
		}

		const decoder = new TextDecoder();
		const { stopNameIndex, idToName } = buildStops(decoder.decode(files["stops.txt"]));
		const { routeDirections, tripMeta } = buildTrips(decoder.decode(files["trips.txt"]));
		const routeStopSequences = files["stop_times.txt"]
			? buildRouteStopSequences(decoder.decode(files["stop_times.txt"]), tripMeta, idToName)
			: new Map<string, Map<number, OrderedStop[]>>();

		console.log(
			`✓ Loaded ${stopNameIndex.size} stop names, ${routeDirections.size} routes, ${routeStopSequences.size} route itineraries from GTFS.`,
		);
		return { stopNameIndex, routeDirections, routeStopSequences };
	} catch (cause) {
		console.error("✘ Failed to load static GTFS!", cause);
		return empty;
	}
}

function buildStops(csv: string): { stopNameIndex: Map<string, Set<string>>; idToName: Map<string, string> } {
	const stopNameIndex = new Map<string, Set<string>>();
	const idToName = new Map<string, string>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { stopNameIndex, idToName };

	const idCol = header.indexOf("stop_id");
	const nameCol = header.indexOf("stop_name");
	if (idCol === -1 || nameCol === -1) return { stopNameIndex, idToName };

	for (const row of rows) {
		const stopId = row[idCol];
		const stopName = row[nameCol];
		// On indexe uniquement les quais (enfants), pas les stations parentes.
		if (!stopId || !stopName || stopId.startsWith("TCAR:ST:")) continue;

		idToName.set(stopId, stopName);

		const key = normalizeStopName(stopName);
		if (!key) continue;

		let ids = stopNameIndex.get(key);
		if (ids === undefined) {
			ids = new Set();
			stopNameIndex.set(key, ids);
		}
		ids.add(stopId);
	}

	return { stopNameIndex, idToName };
}

function buildTrips(csv: string): {
	routeDirections: Map<string, RouteDirection[]>;
	tripMeta: Map<string, { routeId: string; directionId: number }>;
} {
	const tripMeta = new Map<string, { routeId: string; directionId: number }>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { routeDirections: new Map(), tripMeta };

	const routeCol = header.indexOf("route_id");
	const tripCol = header.indexOf("trip_id");
	const headsignCol = header.indexOf("trip_headsign");
	const directionCol = header.indexOf("direction_id");
	if (routeCol === -1 || directionCol === -1) return { routeDirections: new Map(), tripMeta };

	// routeId → directionId → set de headsigns
	const grouped = new Map<string, Map<number, Set<string>>>();

	for (const row of rows) {
		const routeId = row[routeCol];
		if (!routeId) continue;

		const directionId = Number.parseInt(row[directionCol] ?? "", 10);
		if (Number.isNaN(directionId)) continue;

		const tripId = tripCol === -1 ? "" : (row[tripCol] ?? "");
		if (tripId) tripMeta.set(tripId, { routeId, directionId });

		const headsign = headsignCol === -1 ? "" : (row[headsignCol] ?? "");

		let directions = grouped.get(routeId);
		if (directions === undefined) {
			directions = new Map();
			grouped.set(routeId, directions);
		}

		let headsigns = directions.get(directionId);
		if (headsigns === undefined) {
			headsigns = new Set();
			directions.set(directionId, headsigns);
		}
		if (headsign) headsigns.add(headsign);
	}

	const routeDirections = new Map<string, RouteDirection[]>();
	for (const [routeId, directions] of grouped) {
		routeDirections.set(
			routeId,
			[...directions.entries()].map(([directionId, headsigns]) => ({ directionId, headsigns: [...headsigns] })),
		);
	}

	return { routeDirections, tripMeta };
}

/**
 * Construit, par (routeId, directionId), l'itinéraire ordonné des arrêts, à partir du trip le
 * plus long de chaque sens (itinéraire de référence). Sert à étendre les plages « de X à Y ».
 */
function buildRouteStopSequences(
	csv: string,
	tripMeta: Map<string, { routeId: string; directionId: number }>,
	idToName: Map<string, string>,
): Map<string, Map<number, OrderedStop[]>> {
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return new Map();

	const tripCol = header.indexOf("trip_id");
	const stopCol = header.indexOf("stop_id");
	const seqCol = header.indexOf("stop_sequence");
	if (tripCol === -1 || stopCol === -1 || seqCol === -1) return new Map();

	// Regroupe les arrêts par trip.
	const perTrip = new Map<string, [number, string][]>();
	for (const row of rows) {
		const tripId = row[tripCol];
		const stopId = row[stopCol];
		if (!tripId || !stopId || !tripMeta.has(tripId)) continue;
		const seq = Number.parseInt(row[seqCol] ?? "", 10);
		if (Number.isNaN(seq)) continue;

		let stops = perTrip.get(tripId);
		if (stops === undefined) {
			stops = [];
			perTrip.set(tripId, stops);
		}
		stops.push([seq, stopId]);
	}

	// Conserve, par (routeId, directionId), le trip ayant le plus d'arrêts.
	const result = new Map<string, Map<number, OrderedStop[]>>();
	const bestLength = new Map<string, number>();
	for (const [tripId, stops] of perTrip) {
		const meta = tripMeta.get(tripId);
		if (meta === undefined) continue;

		const key = `${meta.routeId}:${meta.directionId}`;
		if ((bestLength.get(key) ?? 0) >= stops.length) continue;
		bestLength.set(key, stops.length);

		const ordered = stops
			.sort((a, b) => a[0] - b[0])
			.map(([, stopId]) => ({ stopId, name: normalizeStopName(idToName.get(stopId) ?? "") }));

		let directions = result.get(meta.routeId);
		if (directions === undefined) {
			directions = new Map();
			result.set(meta.routeId, directions);
		}
		directions.set(meta.directionId, ordered);
	}

	return result;
}

/** Parseur CSV minimal gérant les champs entre guillemets. */
function* parseCsv(csv: string): Generator<string[]> {
	for (const line of csv.split("\n")) {
		const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (trimmed.length === 0) continue;
		yield parseCsvLine(trimmed);
	}
}

function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (inQuotes) {
			if (char === '"') {
				if (line[i + 1] === '"') {
					current += '"';
					i += 1;
				} else {
					inQuotes = false;
				}
			} else {
				current += char;
			}
		} else if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			out.push(current);
			current = "";
		} else {
			current += char;
		}
	}

	out.push(current);
	return out;
}
