import type { Temporal } from "temporal-polyfill";

import type { Vehicle } from "../sdh/use-sdh.js";

type CacheEntry = {
	lastStopId: number;
	lastStopTime: string;
	position: {
		latitude: number;
		longitude: number;
		bearing: number;
	};
	recordedAt: number;
};

export function useCache() {
	const cache = new Map<string, CacheEntry>();

	const isCached = (id: string, recordedAt: Temporal.ZonedDateTime, vehicle: Vehicle) => {
		const cached = cache.get(id);
		if (cached === undefined) {
			return false;
		}

		if (recordedAt.epochMilliseconds < cached.recordedAt) {
			return true;
		}

		const stopTime = vehicle.StopTimeList[0];
		if (stopTime.StopPointId !== cached.lastStopId || stopTime.ExpectedTime !== cached.lastStopTime) {
			return false;
		}

		return (
			vehicle.Latitude === cached.position.latitude &&
			vehicle.Longitude === cached.position.longitude &&
			vehicle.Bearing === cached.position.bearing
		);
	};

	const upsert = (id: string, recordedAt: Temporal.ZonedDateTime, vehicle: Vehicle) => {
		const initialInsert = !cache.has(id);

		const stopTime = vehicle.StopTimeList[0];
		cache.set(id, {
			lastStopId: stopTime.StopPointId,
			lastStopTime: stopTime.ExpectedTime,
			position: { latitude: vehicle.Latitude, longitude: vehicle.Longitude, bearing: vehicle.Bearing },
			recordedAt: recordedAt.epochMilliseconds,
		});

		return initialInsert;
	};

	return { isCached, upsert };
}
