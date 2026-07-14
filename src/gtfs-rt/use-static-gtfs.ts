import { unzipSync } from "fflate";

export type RouteDirection = { directionId: number; headsigns: string[] };

export type StaticGtfs = {
	/** Nom d'arrêt normalisé → identifiants des quais (enfants) portant ce nom. */
	stopNameIndex: Map<string, Set<string>>;
	/** routeId → directions desservies avec leurs terminus (headsigns). */
	routeDirections: Map<string, RouteDirection[]>;
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
		if (next.stopNameIndex.size === 0) return;
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

	const empty: StaticGtfs = { stopNameIndex: new Map(), routeDirections: new Map() };

	try {
		const response = await fetch(url);
		if (!response.ok) {
			console.error(`✘ Failed to fetch static GTFS (HTTP ${response.status}).`);
			return empty;
		}

		const buffer = new Uint8Array(await response.arrayBuffer());
		const files = unzipSync(buffer, {
			filter: (file) => file.name === "stops.txt" || file.name === "trips.txt",
		});

		if (!files["stops.txt"] || !files["trips.txt"]) {
			console.error("✘ Static GTFS is missing stops.txt or trips.txt.");
			return empty;
		}

		const decoder = new TextDecoder();
		const stopNameIndex = buildStopNameIndex(decoder.decode(files["stops.txt"]));
		const routeDirections = buildRouteDirections(decoder.decode(files["trips.txt"]));

		console.log(`✓ Loaded ${stopNameIndex.size} stop names, ${routeDirections.size} routes from GTFS.`);
		return { stopNameIndex, routeDirections };
	} catch (cause) {
		console.error("✘ Failed to load static GTFS!", cause);
		return empty;
	}
}

function buildStopNameIndex(csv: string): Map<string, Set<string>> {
	const index = new Map<string, Set<string>>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return index;

	const idCol = header.indexOf("stop_id");
	const nameCol = header.indexOf("stop_name");
	if (idCol === -1 || nameCol === -1) return index;

	for (const row of rows) {
		const stopId = row[idCol];
		const stopName = row[nameCol];
		// On indexe uniquement les quais (enfants), pas les stations parentes.
		if (!stopId || !stopName || stopId.startsWith("TCAR:ST:")) continue;

		const key = normalizeStopName(stopName);
		if (!key) continue;

		let ids = index.get(key);
		if (ids === undefined) {
			ids = new Set();
			index.set(key, ids);
		}
		ids.add(stopId);
	}

	return index;
}

function buildRouteDirections(csv: string): Map<string, RouteDirection[]> {
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return new Map();

	const routeCol = header.indexOf("route_id");
	const headsignCol = header.indexOf("trip_headsign");
	const directionCol = header.indexOf("direction_id");
	if (routeCol === -1 || directionCol === -1) return new Map();

	// routeId → directionId → set de headsigns
	const grouped = new Map<string, Map<number, Set<string>>>();

	for (const row of rows) {
		const routeId = row[routeCol];
		if (!routeId) continue;

		const directionId = Number.parseInt(row[directionCol] ?? "", 10);
		if (Number.isNaN(directionId)) continue;

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

	const result = new Map<string, RouteDirection[]>();
	for (const [routeId, directions] of grouped) {
		result.set(
			routeId,
			[...directions.entries()].map(([directionId, headsigns]) => ({ directionId, headsigns: [...headsigns] })),
		);
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
