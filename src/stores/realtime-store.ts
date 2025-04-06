import type { TripUpdate, VehiclePosition } from "../types/gtfs-rt.js";

export function createRealtimeStore(sweepInterval: number, staleThreshold: number) {
	const tripUpdates = new Map<string, TripUpdate>();
	const vehiclePositions = new Map<string, VehiclePosition>();

	setInterval(() => {
		console.log("|> Sweeping outdated trip update and vehicle position entries.");
		const now = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000);

		for (const [key, tripUpdate] of tripUpdates) {
			const lastStopTime = tripUpdate.stopTimeUpdate.at(-1);
			if (typeof lastStopTime !== "undefined") {
				if (typeof lastStopTime.arrival !== "undefined") {
					const aimedArrivalTime = lastStopTime.arrival.time - lastStopTime.arrival.delay;
					if (now - aimedArrivalTime > staleThreshold) {
						tripUpdates.delete(key);
					}
				} else if (now - tripUpdate.timestamp > staleThreshold) {
					tripUpdates.delete(key);
				}
			} else {
				tripUpdates.delete(key);
			}
		}

		for (const [key, vehicle] of vehiclePositions) {
			if (typeof vehicle.trip !== "undefined") {
				const tripUpdate = tripUpdates.get(vehicle.trip.tripId);
				if (typeof tripUpdate === "undefined" && now - vehicle.timestamp > staleThreshold) {
					vehiclePositions.delete(key);
				}
			} else if (now - vehicle.timestamp > staleThreshold) {
				vehiclePositions.delete(key);
			}
		}
	}, sweepInterval * 1000);

	return { tripUpdates, vehiclePositions };
}
