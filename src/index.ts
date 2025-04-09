import { serve } from "@hono/node-server";
import { Hono } from "hono";
import "temporal-polyfill/global";

import { stream } from "hono/streaming";
import { GTFS_FEED, HUB_FEED, MONITORED_LINES, OLD_GTFSRT_TU_FEED, OLD_GTFSRT_VP_FEED, VEHICLE_WS } from "./config.js";
import { type Vehicle, createVehicleProvider } from "./providers/vehicle-provider.js";
import { fetchOldGtfsrt } from "./resources/fetch-old-gtfsrt.js";
import { importGtfs } from "./resources/import-gtfs.js";
import { importHub } from "./resources/import-hub.js";
import { createRealtimeStore } from "./stores/realtime-store.js";
import type {
	Position,
	StopTimeEvent,
	TripDescriptor,
	TripUpdateEntity,
	VehicleDescriptor,
	VehiclePositionEntity,
} from "./types/gtfs-rt.js";
import { buildGtfsRtFeed } from "./utils/build-gtfsrt-feed.js";
import { isArchiveStale } from "./utils/download-archive.js";
import { encodeGtfsRt } from "./utils/gtfsrt-coding.js";
import { isSus } from "./utils/is-sus.js";
import { getVehicleOccupancyStatus } from "./utils/occupancy-fetcher.js";

const REALTIME_STALE_TIME = 600; // seconds
const RESOURCE_STALE_TIME = 3600 * 1000; // milliseconds

console.log("==> GTFS-RT Producer - Transdev Rouen (TCAR) <==");

// I - Bootstrapping static resources

console.log("|> Creating realtime data store.");
const { tripUpdates, vehiclePositions } = createRealtimeStore(60, REALTIME_STALE_TIME);

console.log("|> Loading HUB resource.");
let hubResource = await importHub(HUB_FEED);
setInterval(
	async () => {
		try {
			const mustUpdate =
				(await isArchiveStale(HUB_FEED, hubResource.version)) ||
				Date.now() - hubResource.loadedAt > RESOURCE_STALE_TIME;
			if (mustUpdate) {
				console.log("|> Updating HUB resource.");
				hubResource = await importHub(HUB_FEED);
			}
		} catch (e) {
			console.error("Failed to ensure HUB fresheness.", e);
		}
	},
	5 * 60 * 1_000,
);

console.log("|> Loading GTFS resource.");
let gtfsResource = await importGtfs(GTFS_FEED);
setInterval(
	async () => {
		try {
			const mustUpdate =
				(await isArchiveStale(GTFS_FEED, gtfsResource.version)) ||
				Date.now() - gtfsResource.loadedAt > RESOURCE_STALE_TIME;
			if (mustUpdate) {
				console.log("|> Updating GTFS resource.");
				gtfsResource = await importGtfs(GTFS_FEED);
			}
		} catch (e) {
			console.error("Failed to ensure GTFS fresheness.", e);
		}
	},
	5 * 60 * 1_000,
);

const patchOldVehiclePositions = (data: VehiclePositionEntity[]) => {
	for (const vehicle of data) vehicle.vehicle.timestamp += 3600 + 3600;
	return data;
};

console.log("|> Initiating backup GTFS-RT.");
let oldVehiclePositions = patchOldVehiclePositions(
	(await fetchOldGtfsrt(OLD_GTFSRT_VP_FEED)).entity as VehiclePositionEntity[],
);
let oldTripUpdates = (await fetchOldGtfsrt(OLD_GTFSRT_TU_FEED)).entity as TripUpdateEntity[];
setInterval(async () => {
	try {
		oldVehiclePositions = patchOldVehiclePositions(
			(await fetchOldGtfsrt(OLD_GTFSRT_VP_FEED)).entity as VehiclePositionEntity[],
		);
		oldTripUpdates = (await fetchOldGtfsrt(OLD_GTFSRT_TU_FEED)).entity as TripUpdateEntity[];
	} catch (e) {
		console.error("Failed to download old GTFS-RT resource.", e);
	}

	//

	const now = Temporal.Now.instant();

	// For every active vehicle, we check if old GTFS-RT has a newer position.
	for (const vehiclePosition of vehiclePositions.values()) {
		const oldVehiclePosition = oldVehiclePositions.find((vp) => vp.vehicle.vehicle.id === vehiclePosition.vehicle.id);
		if (typeof oldVehiclePosition !== "undefined" && oldVehiclePosition.vehicle.timestamp > vehiclePosition.timestamp) {
			console.log(
				`[OLD RT INJECTOR] ${vehiclePosition.vehicle.id} Updated position for existing WS vehicle using old GTFS-RT (${oldVehiclePosition.vehicle.timestamp - vehiclePosition.timestamp}s newer)`,
			);

			const currentStopId =
				typeof oldVehiclePosition.vehicle.stopId !== "undefined"
					? gtfsResource.stopIdsByCode.get(oldVehiclePosition.vehicle.stopId)
					: undefined;

			if (typeof currentStopId !== "undefined") {
				vehiclePosition.stopId = currentStopId;
				vehiclePosition.currentStopSequence = oldVehiclePosition.vehicle.currentStopSequence;
				vehiclePosition.currentStatus = oldVehiclePosition.vehicle.currentStatus;
			}

			vehiclePosition.position = {
				latitude: oldVehiclePosition.vehicle.position.latitude,
				longitude: oldVehiclePosition.vehicle.position.longitude,
				bearing: oldVehiclePosition.vehicle.position.bearing,
			};
			vehiclePosition.timestamp = oldVehiclePosition.vehicle.timestamp;
		}
	}

	// We fill the holes of missing vehicles by consuming the old GTFS-RT.
	for (const vehiclePosition of oldVehiclePositions) {
		const parcNumber = vehiclePosition.vehicle.vehicle.id;
		const vehicleTrip = vehiclePosition.vehicle.trip!;
		if (
			now.since(Temporal.Instant.fromEpochMilliseconds(vehiclePosition.vehicle.timestamp * 1000)).total("minutes") > 5
		)
			continue;

		const lastPosition = lastPositionCache.get(parcNumber);
		if (
			typeof lastPosition === "undefined" ||
			now.since(Temporal.Instant.fromEpochMilliseconds(lastPosition.recordedAt * 1000)).total("minutes") > 10
		) {
			let trip = gtfsResource.trips.get(vehicleTrip.tripId);
			if (
				typeof trip === "undefined" ||
				trip.routeId !== vehicleTrip.routeId ||
				trip.directionId !== vehicleTrip.directionId
			) {
				console.warn(
					`[OLD RT INJECTOR] ${parcNumber}\tUnable to match with current GTFS resource, vehicle won't have trip data.`,
				);
				trip = undefined;
			}

			if (trip && !tripUpdates.has(trip.tripId)) {
				const tripUpdate = oldTripUpdates.find((t) => t.tripUpdate.trip.tripId === trip.tripId);
				if (tripUpdate) {
					tripUpdates.set(trip.tripId, {
						stopTimeUpdate: tripUpdate.tripUpdate.stopTimeUpdate?.map((stu) => {
							const matchingStopId = gtfsResource.stopIdsByCode.get(stu.stopId);
							return {
								arrival: stu.arrival ? { delay: stu.arrival.delay ?? undefined, time: stu.arrival.time } : undefined,
								departure: stu.departure
									? { delay: stu.departure.delay ?? undefined, time: stu.departure.time }
									: undefined,
								stopId: matchingStopId!,
								stopSequence: stu.stopSequence,
								scheduleRelationship: stu.scheduleRelationship,
							};
						}),
						timestamp: tripUpdate.tripUpdate.timestamp,
						trip: {
							tripId: tripUpdate.tripUpdate.trip.tripId,
							routeId: tripUpdate.tripUpdate.trip.routeId,
							directionId: tripUpdate.tripUpdate.trip.directionId ?? 0,
							scheduleRelationship: tripUpdate.tripUpdate.trip.scheduleRelationship ?? "SCHEDULED",
						},
						vehicle: {
							id: vehiclePosition.vehicle.vehicle.id,
						},
					});
				}
			}

			const currentStopId =
				typeof vehiclePosition.vehicle.stopId !== "undefined"
					? gtfsResource.stopIdsByCode.get(vehiclePosition.vehicle.stopId)
					: undefined;

			vehiclePositions.set(parcNumber, {
				...(trip ? { currentStatus: vehiclePosition.vehicle.currentStatus } : {}),
				occupancyStatus: await getVehicleOccupancyStatus(parcNumber),
				position: {
					latitude: vehiclePosition.vehicle.position.latitude,
					longitude: vehiclePosition.vehicle.position.longitude,
					bearing: vehiclePosition.vehicle.position.bearing,
				},
				...(trip ? { stopId: currentStopId, currentStopSequence: vehiclePosition.vehicle.currentStopSequence } : {}),
				timestamp: vehiclePosition.vehicle.timestamp,
				vehicle: { id: parcNumber },
				...(trip
					? { trip: { ...trip, scheduleRelationship: "SCHEDULED" } }
					: {
							trip: {
								tripId: `${parcNumber}_OLDTRIP`,
								routeId: vehicleTrip.routeId,
								directionId: vehicleTrip.directionId,
								scheduleRelationship: "UNSCHEDULED",
							},
						}),
			});

			console.warn(
				`[OLD RT INJECTOR] ${parcNumber}\tLacking in new real-time source, injecting (route ${trip?.routeId ?? "NONE"}).`,
			);
		}
	}
}, 10 * 1_000);

// II - Connecting to the vehicle service

console.log("|> Connecting to the vehicle provider.");
let vehicleProvider = await createVehicleProvider(VEHICLE_WS, MONITORED_LINES, handleVehicle);
vehicleProvider.onclose(async (error) => {
	if (error) {
		console.error("|> Creating another connection because of WebSocket error:", error);
		vehicleProvider = await createVehicleProvider(VEHICLE_WS, MONITORED_LINES, handleVehicle);
	}
});

// III - Handle vehicle provisioning

const lastPositionCache = new Map<string, { position: Position; recordedAt: number }>();

const isCommercialTrip = (destination: string) =>
	!["Dépôt 2 Rivières", "Dépôt St-Julien", "ROUEN DEPOT", "Dépôt TNI Carnot", "Dépôt Lincoln"].includes(destination);

async function handleVehicle(line: string, vehicle: Vehicle) {
	const vehicleId = vehicle.VehicleRef.split(":")[3]!;
	console.debug(`[${line}] ${vehicleId}\t${vehicle.VJourneyId}\t${vehicle.LineNumber} -> ${vehicle.Destination}`);

	const operationCode = hubResource.courseOperation.get(vehicle.VJourneyId);
	if (typeof operationCode === "undefined")
		return console.warn(`Unknown operation code for journey id '${vehicle.VJourneyId}'.`);

	const trip = gtfsResource.trips.get(operationCode);
	if (typeof trip === "undefined") return console.warn(`Unknown trip for operation code '${operationCode}'.`);

	const oldVehiclePosition = oldVehiclePositions.find((vp) => vp.vehicle.vehicle.id === vehicleId)?.vehicle;
	const position: Position = {
		latitude: vehicle.Latitude,
		longitude: vehicle.Longitude,
		bearing: vehicle.Bearing,
	};

	const existingVehicle = vehiclePositions.get(vehicleId);

	let recordedAt = Temporal.PlainDateTime.from(vehicle.RecordedAtTime).toZonedDateTime("Europe/Paris").toInstant();
	const recordedAtEpoch = () => Math.floor(recordedAt.epochMilliseconds / 1000);

	const lastPosition = lastPositionCache.get(vehicleId);
	if (typeof lastPosition !== "undefined") {
		if (recordedAtEpoch() < lastPosition.recordedAt || recordedAtEpoch() < (existingVehicle?.timestamp ?? 0)) {
			console.warn("\t\t  The position of this entry is older than the cached position, ignoring.");
			return;
		}
		if (vehicle.Latitude === lastPosition.position.latitude && vehicle.Longitude === lastPosition.position.longitude) {
			recordedAt = Temporal.Instant.fromEpochMilliseconds(lastPosition.recordedAt * 1000);
		}
		if (Temporal.Now.instant().since(recordedAt).total("minutes") > 10) {
			return;
		}
	}

	lastPositionCache.set(vehicleId, { position, recordedAt: recordedAtEpoch() });

	if (isCommercialTrip(vehicle.Destination) && isSus(vehicle, trip, oldVehiclePosition)) {
		if (existingVehicle) {
			existingVehicle.position = position;
			existingVehicle.timestamp = recordedAtEpoch();
		}
		return;
	}

	const monitoredStop = vehicle.StopTimeList.at(0);
	if (typeof monitoredStop === "undefined") return console.warn("No monitored stop for this vehicle, ignoring.");

	const vehicleDescriptor: VehicleDescriptor = {
		id: vehicleId,
		label: vehicle.Destination,
	};

	let tripDescriptor: TripDescriptor | undefined;

	if (isCommercialTrip(vehicle.Destination)) {
		tripDescriptor = {
			tripId: trip.tripId,
			routeId: trip.routeId,
			directionId: trip.directionId,
			scheduleRelationship: "SCHEDULED",
		};

		tripUpdates.set(trip.tripId, {
			stopTimeUpdate: vehicle.StopTimeList.flatMap((stopTime) => {
				const partialStopTimeUpdate = {
					stopId: stopTime.StopPointId.toString(),
				};

				if (stopTime.IsCancelled) {
					return { ...partialStopTimeUpdate, scheduleRelationship: "SKIPPED" };
				}

				if (!stopTime.IsMonitored) {
					return [];
				}

				const aimedTime = Temporal.PlainDateTime.from(stopTime.AimedTime).toZonedDateTime("Europe/Paris");
				const expectedTime = Temporal.Instant.from(stopTime.ExpectedTime).toZonedDateTimeISO("Europe/Paris");
				const event: StopTimeEvent = {
					delay: expectedTime.since(aimedTime).total("seconds"),
					time: Math.floor(expectedTime.epochMilliseconds / 1000),
				};

				return {
					arrival: event,
					departure: event,
					...partialStopTimeUpdate,
					scheduleRelationship: "SCHEDULED",
				};
			}),
			timestamp: recordedAtEpoch(),
			trip: tripDescriptor,
			vehicle: vehicleDescriptor,
		});
	}

	vehiclePositions.set(vehicleId, {
		...(tripDescriptor
			? {
					currentStatus: vehicle.VehicleAtStop
						? "STOPPED_AT"
						: monitoredStop.WaitingTime < 1
							? "INCOMING_AT"
							: "IN_TRANSIT_TO",
					stopId: monitoredStop.StopPointId.toString(),
				}
			: {}),
		occupancyStatus: isCommercialTrip(vehicle.Destination)
			? await getVehicleOccupancyStatus(vehicleId)
			: "NOT_BOARDABLE",
		position,
		timestamp: recordedAtEpoch(),
		trip: tripDescriptor,
		vehicle: vehicleDescriptor,
	});
}

// IV - Provide data via an API

console.log("|> Publishing data on port 8080.");

const hono = new Hono();
hono.get("/trip-updates", (c) =>
	stream(c, async (stream) => {
		const data = encodeGtfsRt(buildGtfsRtFeed(tripUpdates.values()));
		await stream.write(data);
	}),
);
hono.get("/trip-updates.json", (c) => c.json(buildGtfsRtFeed(tripUpdates.values())));
hono.get("/vehicle-positions", (c) =>
	stream(c, async (stream) => {
		const data = encodeGtfsRt(buildGtfsRtFeed(vehiclePositions.values()));
		await stream.write(data);
	}),
);
hono.get("/vehicle-positions.json", (c) => c.json(buildGtfsRtFeed(vehiclePositions.values())));
serve({ fetch: hono.fetch, port: +(process.env.PORT ?? 8080) });
