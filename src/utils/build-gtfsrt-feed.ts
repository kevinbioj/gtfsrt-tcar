// import type { HubResource } from "../resources/import-hub.js";
import type { Header, TripUpdate, VehiclePosition } from "../types/gtfs-rt.js";

// const IDS_PREFIX = "TCAR";

export function buildGtfsRtFeed(
	items: Iterable<TripUpdate | VehiclePosition>,
	// hubResource: HubResource,
	// transformIds: boolean,
) {
	const header: Header = {
		gtfsRealtimeVersion: "2.0",
		incrementality: "FULL_DATASET",
		timestamp: Math.floor(Temporal.Now.instant().epochMilliseconds / 1000),
	};

	return {
		header,
		entity: [...items].map((item) => {
			const itemCopy = structuredClone(item);

			// if (transformIds) {
			// 	// map TripDescriptor's tripId and routeId
			// 	if (typeof itemCopy.trip !== "undefined") {
			// 		itemCopy.trip.routeId = `${IDS_PREFIX}:${itemCopy.trip.routeId}`;

			// 		const courseNumero = hubResource.courseOperation.get(
			// 			itemCopy.trip.tripId,
			// 		);
			// 		if (typeof courseNumero !== "undefined") {
			// 			itemCopy.trip.tripId = `${IDS_PREFIX}:${itemCopy.trip.tripId}:${hubResource.courseVersion.get(courseNumero)}`;
			// 		}
			// 	}

			// 	if ("position" in itemCopy) {
			// 		itemCopy.vehicle.id = `${IDS_PREFIX}:${itemCopy.vehicle.id}`;

			// 		if (typeof itemCopy.stopId !== "undefined") {
			// 			const mappedStopId = hubResource.arretIdapToCode.get(
			// 				+itemCopy.stopId,
			// 			);
			// 			if (typeof mappedStopId !== "undefined") {
			// 				itemCopy.stopId = `${IDS_PREFIX}:${mappedStopId}`;
			// 			}
			// 		}
			// 	} else {
			// 		for (const stopTimeUpdate of itemCopy.stopTimeUpdate) {
			// 			const mappedStopId = hubResource.arretIdapToCode.get(
			// 				+stopTimeUpdate.stopId,
			// 			);
			// 			if (typeof mappedStopId !== "undefined") {
			// 				stopTimeUpdate.stopId = `${IDS_PREFIX}:${mappedStopId}`;
			// 			}
			// 		}
			// 	}
			// }

			return "position" in itemCopy
				? {
						id: `VM:${itemCopy.vehicle.id}`,
						vehicle: itemCopy,
					}
				: {
						id: `SM:${itemCopy.trip.tripId}`,
						tripUpdate: itemCopy,
					};
		}),
	};
}
