import { serve } from "@hono/node-server";
import GtfsRealtime from "gtfs-realtime-bindings";
import { Hono } from "hono";
import { Temporal } from "temporal-polyfill";
import { match } from "ts-pattern";

import { useCache } from "./cache/use-cache.js";
import { HUB_RESOURCE_URL, MONITORED_LINES, PORT, SDH_URL, VERIFICATION_FEED_URL } from "./config.js";
import { handleRequest } from "./gtfs-rt/handle-request.js";
import { useRealtimeStore } from "./gtfs-rt/use-realtime-store.js";
import { useVerificationFeed } from "./gtfs-rt/use-verification-feed.js";
import { useHubResource } from "./hub/load-resource.js";
import { useSdh, type Vehicle } from "./sdh/use-sdh.js";
import { useVehicleOccupancyStatuses } from "./utils/use-vehicle-occupancy-status.js";
import { isVehicleVerified } from "./utils/verify-vehicle.js";

console.log(` ,----.,--------.,------.,---.        ,------.,--------. ,--------.,-----.  ,---.  ,------.  
'  .-./'--.  .--'|  .---'   .-',-----.|  .--. '--.  .--' '--.  .--'  .--./ /  O  \\ |  .--. ' 
|  | .---.|  |   |  \`--,\`.  \`-.'-----'|  '--'.'  |  |       |  |  |  |    |  .-.  ||  '--'.' 
'  '--'  ||  |   |  |\`  .-'    |      |  |\\  \\   |  |       |  |  '  '--'\\|  | |  ||  |\\  \\  
 \`------' \`--'   \`--'   \`-----'       \`--' '--'  \`--'       \`--'   \`-----'\`--' \`--'\`--' '--'`);

const store = useRealtimeStore();

const hono = new Hono();
hono.get("/trip-updates", (c) => handleRequest(c, "protobuf", store.tripUpdates, null));
hono.get("/trip-updates.json", (c) => handleRequest(c, "json", store.tripUpdates, null));
hono.get("/vehicle-positions", (c) => handleRequest(c, "protobuf", null, store.vehiclePositions));
hono.get("/vehicle-positions.json", (c) => handleRequest(c, "json", null, store.vehiclePositions));
hono.get("/", (c) =>
	handleRequest(c, c.req.query("format") === "json" ? "json" : "protobuf", store.tripUpdates, store.vehiclePositions),
);
serve({ fetch: hono.fetch, port: PORT });
console.log(`➔ Listening on :${PORT}`);

// ---

const verificationFeed = await useVerificationFeed(VERIFICATION_FEED_URL);
const vehicleOccupancyStatuses = useVehicleOccupancyStatuses();
const hubResource = await useHubResource(HUB_RESOURCE_URL);
useSdh(SDH_URL, MONITORED_LINES, onVehicle);

const cache = useCache();

function onVehicle(_: string, vehicle: Vehicle) {
	const vehicleId = vehicle.VehicleRef.split(":")[3];
	const recordedAt = Temporal.PlainDateTime.from(vehicle.RecordedAtTime).toZonedDateTime("Europe/Paris");

	if (cache.isCached(vehicleId, recordedAt, vehicle)) {
		return;
	}

	if (cache.upsert(vehicleId, recordedAt, vehicle)) {
		return;
	}

	const tripId = hubResource.hub.courseOperation.get(vehicle.VJourneyId);
	if (tripId === undefined) {
		console.warn(`✘ ${vehicleId}\tUnknown operation for journey id: '${vehicle.VJourneyId}'.`);
		return;
	}

	const routeId = hubResource.hub.comCode.get(vehicle.LineId);
	if (routeId === undefined) {
		console.warn(`\t✘ ${vehicleId}\tCould not find line code for id '${vehicle.LineId}'.`);
		return;
	}

	const directionId = vehicle.Direction - 1;

	const vehicleDescriptor = {
		id: `TCAR:${vehicleId}`,
		label: vehicle.Destination,
	};

	const verifiedVehicle = verificationFeed.verifiedVehicles.get(vehicleId);
	const verificationRejection = isVehicleVerified(verifiedVehicle, routeId, directionId, vehicle.Destination);
	if (verificationRejection !== undefined) {
		const message = match(verificationRejection)
			.with(
				{ type: "ROUTE_MISMATCH" },
				({ verifiedRouteId }) =>
					`Route mismatch with verification feed! Expected '${routeId}' but received '${verifiedRouteId}'.`,
			)
			.with(
				{ type: "MISSING_ROUTE_DESTINATIONS" },
				() => `Route '${routeId}' has no registered destinations, unable to verify!`,
			)
			.with(
				{ type: "UNKNOWN_DESTINATION" },
				() => `Destination '${vehicle.Destination}' is not verified for route '${routeId}'.`,
			)
			.otherwise(() => "Unknown rejection error");

		console.warn(`\t✘ ${vehicleId}\t${message}`);

		if (verifiedVehicle !== undefined) {
			const storedVehicle = store.vehiclePositions.get(`VM:${vehicleDescriptor.id}`);
			if (storedVehicle !== undefined && verifiedVehicle.recordedAt > +storedVehicle.timestamp!) {
				storedVehicle.position = verifiedVehicle.position;
				storedVehicle.timestamp = verifiedVehicle.recordedAt;
			}
		}
		return;
	}

	const atStop =
		vehicle.VehicleAtStop ||
		vehicle.StopTimeList.length === 1 ||
		(vehicle.StopTimeList[0].StopPointOrder === 1 &&
			Temporal.Instant.compare(vehicle.StopTimeList[0].ExpectedTime, Temporal.Now.instant()) >= 0);

	const currentStop = vehicle.StopTimeList[atStop ? 0 : 1];

	const tripDescriptor = {
		tripId: tripId,
		routeId,
		directionId,
		scheduleRelationship: GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED,
	};

	const isCommercial = !["Dépôt 2 Rivières", "Dépôt Lincoln"].includes(vehicle.Destination);

	store.vehiclePositions.set(`VM:${vehicleDescriptor.id}`, {
		position: {
			latitude: vehicle.Latitude,
			longitude: vehicle.Longitude,
			bearing: vehicle.Bearing,
		},
		occupancyStatus: isCommercial
			? vehicleOccupancyStatuses.get(vehicleId)?.status
			: GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.NOT_BOARDABLE,
		timestamp: Math.floor(recordedAt.epochMilliseconds / 1000),
		vehicle: vehicleDescriptor,
		...(isCommercial
			? {
					currentStatus: atStop
						? GtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.STOPPED_AT
						: GtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO,
					stopId: hubResource.hub.idapCode.get(currentStop.StopPointId),
					trip: tripDescriptor,
				}
			: {}),
	});

	if (isCommercial) {
		store.tripUpdates.set(`ET:${tripDescriptor.tripId}`, {
			stopTimeUpdate: vehicle.StopTimeList.flatMap((StopTime) => {
				const update = {
					stopId: hubResource.hub.idapCode.get(StopTime.StopPointId),
				};

				if (StopTime.IsCancelled) {
					return {
						...update,
						scheduleRelationship: GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
					};
				}

				if (!StopTime.IsMonitored) {
					return {
						...update,
						scheduleRelationship: GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA,
					};
				}

				const expectedTime = Temporal.Instant.from(StopTime.ExpectedTime);
				const aimedTime = Temporal.PlainDateTime.from(StopTime.AimedTime).toZonedDateTime("Europe/Paris");
				const event = {
					delay: Math.floor((expectedTime.epochMilliseconds - aimedTime.epochMilliseconds) / 1000),
					time: Math.floor(expectedTime.epochMilliseconds / 1000),
				};

				return {
					...update,
					arrival: event,
					departure: event,
					scheduleRelationship: GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED,
				};
			}),
			timestamp: Math.floor(recordedAt.epochMilliseconds / 1000),
			trip: tripDescriptor,
		});
	}

	console.log(
		`\t⛛ ${vehicleId.padEnd(4, " ")}  ${recordedAt.toPlainTime()}  ${vehicle.VJourneyId}  ${(isCommercial ? vehicle.LineNumber : "").padEnd(10, " ")} ${directionId} ${vehicle.Destination}`,
	);
}
