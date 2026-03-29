import GtfsRealtime from "gtfs-realtime-bindings";
import { Temporal } from "temporal-polyfill";
import type { useHubResource } from "../hub/load-resource.js";

let currentInterval: NodeJS.Timeout | undefined;

export async function useVerificationFeed(
	vehicleUrl: string,
	tripUpdatesUrl: string,
	hubResource: Awaited<ReturnType<typeof useHubResource>>,
) {
	const initialResource = await loadResource(vehicleUrl, tripUpdatesUrl, hubResource);

	const resource = {
		verifiedVehicles: initialResource,
		importedAt: Temporal.Now.instant(),
	};

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(
		async () => {
			const newResource = await loadResource(vehicleUrl, tripUpdatesUrl, hubResource);
			resource.verifiedVehicles = newResource;
			resource.importedAt = Temporal.Now.instant();
		},
		Temporal.Duration.from({ minutes: 1 }).total("milliseconds"),
	);

	return resource;
}

// --- loadResource

export type VerifiedVehicle = {
	position: {
		latitude: number;
		longitude: number;
		bearing: number;
	};
	recordedAt: number;
	routeId: string;
	tripId?: string;
	directionId?: number;
	stopTimeUpdate?: GtfsRealtime.transit_realtime.TripUpdate.IStopTimeUpdate[];
};

async function loadResource(
	vehicleUrl: string,
	tripUpdatesUrl: string,
	hubResource: Awaited<ReturnType<typeof useHubResource>>,
) {
	console.log("➔ Fetching verification feeds.");

	try {
		const verifiedVehicles = new Map<string, VerifiedVehicle>();

		const vehicleResponse = await fetch(vehicleUrl);
		if (!vehicleResponse.ok || vehicleResponse.status === 204) {
			console.error(`✘ Failed to fetch vehicle positions feed (HTTP ${vehicleResponse.status}).`);
			return verifiedVehicles;
		}

		const vehicleBuffer = Buffer.from(await vehicleResponse.arrayBuffer());
		const vehicleFeed = GtfsRealtime.transit_realtime.FeedMessage.decode(vehicleBuffer);
		const vehicleTrip = new Map<string, string>();

		const now = Temporal.Now.instant();
		const offsetSeconds = Math.floor(now.toZonedDateTimeISO("Europe/Paris").offsetNanoseconds / 1_000_000_000);

		if (
			now.since(Temporal.Instant.fromEpochMilliseconds(+vehicleFeed.header.timestamp! * 1000)).total("minutes") >= 30
		) {
			return verifiedVehicles;
		}

		vehicleFeed.entity.forEach((entity) => {
			const timestamp = +entity.vehicle!.timestamp! + offsetSeconds;

			if (
				!entity.vehicle?.vehicle?.id ||
				!entity.vehicle?.trip?.routeId ||
				now.since(Temporal.Instant.fromEpochMilliseconds(timestamp * 1000)).total("minutes") >= 30
			) {
				return;
			}

			verifiedVehicles.set(entity.vehicle.vehicle.id, {
				position: {
					latitude: entity.vehicle.position!.latitude,
					longitude: entity.vehicle.position!.longitude,
					bearing: entity.vehicle.position!.bearing!,
				},
				recordedAt: +entity.vehicle.timestamp!,
				routeId: `TCAR:${entity.vehicle.trip.routeId}`,
				tripId: `TCAR:${entity.vehicle.trip.tripId}`,
				directionId: entity.vehicle.trip.directionId ?? 0,
			});

			vehicleTrip.set(entity.vehicle.trip.tripId!, entity.vehicle.vehicle.id);
		});

		const tripResponse = await fetch(tripUpdatesUrl);
		if (!tripResponse.ok || tripResponse.status === 204) {
			console.warn(`✘ Failed to fetch trip updates feed (HTTP ${tripResponse.status}).`);
			return verifiedVehicles;
		}

		const tripBuffer = Buffer.from(await tripResponse.arrayBuffer());
		const tripFeed = GtfsRealtime.transit_realtime.FeedMessage.decode(tripBuffer);

		tripFeed.entity.forEach((entity) => {
			const vehicleId = vehicleTrip.get(entity.tripUpdate!.trip.tripId!);
			if (vehicleId === undefined) {
				return;
			}

			const vehicle = verifiedVehicles.get(vehicleId);
			if (vehicle !== undefined) {
				vehicle.stopTimeUpdate = entity.tripUpdate!.stopTimeUpdate!.map((stopTimeUpdate) => ({
					...stopTimeUpdate,
					stopId: hubResource.hub.idapCode.get(+stopTimeUpdate.stopId!),
					scheduleRelationship: GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED,
				}));
			}
		});

		console.log("✓ Successfully loaded verification resources!");
		return verifiedVehicles;
	} catch (cause) {
		console.log("✘ Failed to update verification feeds!", cause);
	}
}
