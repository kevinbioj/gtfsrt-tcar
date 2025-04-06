import { LINES_DATASET } from "../config.js";
import type { Vehicle } from "../providers/vehicle-provider.js";
import type { Trip } from "../resources/import-gtfs.js";
import type { VehiclePosition } from "../types/gtfs-rt.js";

export function isSus(vehicle: Vehicle, trip: Trip, oldVehiclePosition?: VehiclePosition) {
	const lineData = LINES_DATASET.get(vehicle.LineNumber);

	if (typeof lineData !== "undefined") {
		if (lineData.code !== trip.routeId || vehicle.Direction - 1 !== trip.directionId) {
			console.warn("\t\t  Something looks wrong. Are the GTFS and HUB resources up-to-date? Definitely sus!");
			return true;
		}

		if (typeof oldVehiclePosition === "undefined" && !lineData.destinations.includes(vehicle.Destination)) {
			console.warn("\t\t  Missing from old GTFS-RT, and destination is unknown: probably sus.");
			return true;
		}
	}

	if (typeof oldVehiclePosition !== "undefined") {
		const oldTrip = oldVehiclePosition.trip!;
		if (trip.routeId !== oldTrip.routeId) {
			console.warn("\t\t  Mismatch between matched trip and old GTFS-RT routes: is sus.");
			console.warn(`\t\t  Matched trip: ${trip.routeId} | Old GTFS-RT: ${oldTrip.routeId}`);
			return true;
		}

		if (typeof lineData !== "undefined" && !lineData.destinations.includes(vehicle.Destination)) {
			console.warn("\t\t  Match between matched trip and old GTFS-RT, but destination is unknown: probably not sus.");
			return false;
		}
	}

	if (typeof lineData !== "undefined" && typeof oldVehiclePosition !== "undefined") {
		const oldTrip = oldVehiclePosition.trip!;
		if (
			!lineData.destinations.includes(vehicle.Destination) &&
			(trip.routeId !== oldTrip.routeId || trip.directionId !== (oldTrip.directionId ?? 0))
		) {
			console.warn("\t\t  Mismatch between matched trip and old GTFS-RT, plus destination is unknown: probably sus.");
			return true;
		}
	}

	// By default, not sus.
	return false;
}
