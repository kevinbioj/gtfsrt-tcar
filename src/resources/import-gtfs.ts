import { join } from "node:path";

import { downloadArchive } from "../utils/download-archive.js";
import { loadCsv } from "../utils/load-csv.js";

export type Trip = {
	tripId: string;
	routeId: string;
	directionId: number;
};

export async function importGtfs(href: string) {
	const { directory, version } = await downloadArchive(href);
	return {
		trips: await loadTrips(directory),
		stopIdsByCode: await loadStopIdsByCode(directory),
		loadedAt: Date.now(),
		version,
	};
}

// ---

async function loadStopIdsByCode(directory: string) {
	const stopIdsByCode = new Map<string, string>();
	await loadCsv<"stop_id" | "stop_code">(
		join(directory, "stops.txt"),
		(record) => {
			stopIdsByCode.set(record.stop_code, record.stop_id);
		},
	);
	return stopIdsByCode;
}

async function loadTrips(directory: string) {
	const trips = new Map<string, Trip>();
	await loadCsv<"trip_id" | "route_id" | "direction_id">(
		join(directory, "trips.txt"),
		(record) => {
			trips.set(record.trip_id, {
				tripId: record.trip_id,
				routeId: record.route_id,
				directionId: +record.direction_id,
			});
		},
	);
	return trips;
}
