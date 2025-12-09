import { CUR_GTFSRT_VP_FEED } from "../config.js";

import { fetchGtfsrt } from "./fetch-gtfsrt.js";

const tripIdByVehicleId = new Map<string, string>();

const updateTripIdByVehicleId = async () => {
	const feed = await fetchGtfsrt(CUR_GTFSRT_VP_FEED);

	feed.entity.forEach((entity) => {
		if ("vehicle" in entity && entity.vehicle.trip !== undefined) {
			tripIdByVehicleId.set(
				entity.vehicle.vehicle.id,
				entity.vehicle.trip.tripId,
			);
		}
	});
};

updateTripIdByVehicleId();
setInterval(updateTripIdByVehicleId, 30_000);

export const getTripIdByVehicleId = (vehicleId: string) =>
	tripIdByVehicleId.get(vehicleId);
