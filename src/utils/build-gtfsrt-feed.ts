import type { Header, TripUpdate, VehiclePosition } from "../types/gtfs-rt.js";

export function buildGtfsRtFeed(items: Iterable<TripUpdate | VehiclePosition>) {
	const header: Header = {
		gtfsRealtimeVersion: "2.0",
		incrementality: "FULL_DATASET",
		timestamp: Temporal.Now.instant().epochSeconds,
	};

	return {
		header,
		entity: [...items].map((item) =>
			"position" in item
				? {
						id: `VM:${item.vehicle.id}`,
						vehicle: item,
					}
				: {
						id: `SM:${item.trip.tripId}`,
						tripUpdate: item,
					},
		),
	};
}
