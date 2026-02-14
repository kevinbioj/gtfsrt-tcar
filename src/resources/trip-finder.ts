import { CUR_GTFSRT_VP_FEED } from "../config.js";

import { fetchGtfsrt } from "./fetch-gtfsrt.js";

const tripIdByVehicleId = new Map<
	string,
	{ tripId: string; recordedAt: number }
>();

const updateTripIdByVehicleId = async () => {
	const feed = await fetchGtfsrt(CUR_GTFSRT_VP_FEED);

	feed.entity.forEach((entity) => {
		if ("vehicle" in entity && entity.vehicle.trip !== undefined) {
			tripIdByVehicleId.set(entity.vehicle.vehicle.id, {
				tripId: entity.vehicle.trip.tripId,
				recordedAt: Date.now(),
			});
		}
	});
};

updateTripIdByVehicleId();
setInterval(updateTripIdByVehicleId, 30_000);

export const getTripIdByVehicleId = async (vehicleId: string) => {
	const info = tripIdByVehicleId.get(vehicleId);
	if (info === undefined || Date.now() - info.recordedAt > 3_600_000) {
		return;
	}

	return info.tripId;
};
