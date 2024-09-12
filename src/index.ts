import { serve } from "@hono/node-server";
import { Hono } from "hono";
import "temporal-polyfill/global";

import { GTFS_FEED, HUB_FEED, LINES_DATASET, MONITORED_LINES, OLD_GTFSRT_VP_FEED, VEHICLE_WS } from "./config.js";
import { createVehicleProvider, type Vehicle } from "./providers/vehicle-provider.js";
import { importGtfs } from "./resources/import-gtfs.js";
import { importHub } from "./resources/import-hub.js";
import { createRealtimeStore } from "./stores/realtime-store.js";
import {
  type Position,
  type StopTimeEvent,
  type TripDescriptor,
  type VehicleDescriptor,
  type VehiclePositionEntity,
} from "./types/gtfs-rt.js";
import { isArchiveStale } from "./utils/download-archive.js";
import { buildGtfsRtFeed } from "./utils/build-gtfsrt-feed.js";
import { fetchOldGtfsrt } from "./resources/fetch-old-gtfsrt.js";
import { stream } from "hono/streaming";
import { encodeGtfsRt } from "./utils/gtfsrt-coding.js";

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
    const mustUpdate =
      (await isArchiveStale(HUB_FEED, hubResource.version)) || Date.now() - hubResource.loadedAt > RESOURCE_STALE_TIME;
    if (mustUpdate) {
      console.log("|> Updating HUB resource.");
      hubResource = await importHub(HUB_FEED);
    }
  },
  5 * 60 * 1_000,
);

console.log("|> Loading GTFS resource.");
let gtfsResource = await importGtfs(GTFS_FEED);
setInterval(
  async () => {
    const mustUpdate =
      (await isArchiveStale(GTFS_FEED, gtfsResource.version)) ||
      Date.now() - gtfsResource.loadedAt > RESOURCE_STALE_TIME;
    if (mustUpdate) {
      console.log("|> Updating GTFS resource.");
      gtfsResource = await importGtfs(GTFS_FEED);
    }
  },
  5 * 60 * 1_000,
);

console.log("|> Initiating backup GTFS-RT.");
let oldVehiclePositions = (await fetchOldGtfsrt(OLD_GTFSRT_VP_FEED)).entity as VehiclePositionEntity[];
setInterval(async () => {
  oldVehiclePositions = (await fetchOldGtfsrt(OLD_GTFSRT_VP_FEED)).entity as VehiclePositionEntity[];
  const now = Temporal.Now.instant();

  // For every active vehicle, we check if old GTFS-RT has a newer position.
  for (const vehiclePosition of vehiclePositions.values()) {
    const oldVehiclePosition = oldVehiclePositions.find((vp) => vp.vehicle.vehicle.id === vehiclePosition.vehicle.id);
    if (typeof oldVehiclePosition !== "undefined" && oldVehiclePosition.vehicle.timestamp > vehiclePosition.timestamp) {
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
    if (now.since(Temporal.Instant.fromEpochSeconds(vehiclePosition.vehicle.timestamp)).minutes > 5) continue;

    const lastPosition = lastPositionCache.get(parcNumber);
    if (
      typeof lastPosition === "undefined" ||
      now.since(Temporal.Instant.fromEpochSeconds(lastPosition.recordedAt)).minutes > 10
    ) {
      const trip = gtfsResource.trips.get(vehicleTrip.tripId);
      if (
        typeof trip === "undefined" ||
        trip.routeId !== vehicleTrip.routeId ||
        trip.directionId !== vehicleTrip.directionId
      ) {
        console.warn(`[OLD RT INJECTOR] ${parcNumber}\tUnable to match with current GTFS resource, skipping.`);
        continue;
      }

      vehiclePositions.set(parcNumber, {
        currentStatus: vehiclePosition.vehicle.currentStatus,
        position: {
          latitude: vehiclePosition.vehicle.position.latitude,
          longitude: vehiclePosition.vehicle.position.longitude,
          bearing: vehiclePosition.vehicle.position.bearing,
        },
        stopId: vehiclePosition.vehicle.stopId,
        timestamp: vehiclePosition.vehicle.timestamp,
        vehicle: { id: parcNumber, label: parcNumber },
        trip: { ...trip, scheduleRelationship: "SCHEDULED" },
      });

      console.warn(
        `[OLD RT INJECTOR] ${parcNumber}\tLacking in new real-time source, injecting (route ${trip.routeId}).`,
      );
    }
  }
}, 30 * 1_000);

// II - Connecting to the vehicle service

console.log("|> Connecting to the vehicle provider.");
const vehicleProvider = await createVehicleProvider(VEHICLE_WS, MONITORED_LINES, handleVehicle);
vehicleProvider.onclose((error) => {
  if (error) {
    console.error("|> Closing GTFS-RT producer down due to vehicle provider error.", error);
    process.exit(1);
  }
});

// III - Handle vehicle provisioning

const lastPositionCache = new Map<string, { position: Position; recordedAt: number }>();

const isCommercialTrip = (destination: string) =>
  !["Dépôt 2 Rivières", "Dépôt St-Julien", "ROUEN DEPOT", "Dépôt TNI Carnot"].includes(destination);

function handleVehicle(line: string, vehicle: Vehicle) {
  const vehicleId = vehicle.VehicleRef.split(":")[3]!;
  console.debug(`[${line}] ${vehicleId}\t${vehicle.VJourneyId}\t${vehicle.LineNumber} -> ${vehicle.Destination}`);

  const operationCode = hubResource.courseOperation.get(vehicle.VJourneyId);
  if (typeof operationCode === "undefined")
    return console.warn(`Unknown operation code for journey id '${vehicle.VJourneyId}'.`);

  const trip = gtfsResource.trips.get(operationCode);
  if (typeof trip === "undefined") return console.warn(`Unknown trip for operation code '${operationCode}'.`);

  const oldVehiclePosition = oldVehiclePositions.find((vp) => vp.vehicle.vehicle.id === vehicleId);
  const lineData = LINES_DATASET.get(vehicle.LineNumber);
  if (typeof lineData !== "undefined") {
    if (!lineData.destinations.includes(vehicle.Destination) && isCommercialTrip(vehicle.Destination)) {
      if (typeof oldVehiclePosition !== "undefined") {
        const oldTrip = oldVehiclePosition.vehicle.trip!;
        if (trip.routeId !== oldTrip.routeId || trip.directionId !== (oldTrip.directionId ?? 0)) {
          return console.warn(
            `Mismatching data: old [${oldTrip.routeId}:${oldTrip.directionId ?? 0}] ; new [${trip.routeId}:${trip.directionId}], skipping.`,
          );
        } else {
          console.warn(`Matching route with old GTFS-RT - unknown destination: ${vehicle.Destination}, allowing.`);
        }
      } else {
        console.warn(`Missing vehicle from old GTFS-RT with unknown destination (${vehicle.Destination}), allowing.`);
      }
    }
    if (trip.routeId !== lineData.code || trip.directionId !== vehicle.Direction - 1)
      return console.warn(`Inconsistency with the GTFS resource, waiting for next refresh.`);
  } else if (typeof oldVehiclePosition !== "undefined") {
    const oldTrip = oldVehiclePosition.vehicle.trip!;
    if (trip.routeId !== oldTrip.routeId || trip.directionId !== (oldTrip.directionId ?? 0)) {
      return console.warn(
        `Mismatching data: old [${oldTrip.routeId}:${oldTrip.directionId ?? 0}] ; new [${trip.routeId}:${trip.directionId}], skipping.`,
      );
    }
  }

  const position: Position = {
    latitude: vehicle.Latitude,
    longitude: vehicle.Longitude,
    bearing: vehicle.Bearing,
  };

  let recordedAt = Temporal.PlainDateTime.from(vehicle.RecordedAtTime).toZonedDateTime("Europe/Paris").epochSeconds;

  const lastPosition = lastPositionCache.get(vehicleId);
  if (typeof lastPosition !== "undefined") {
    if (recordedAt < lastPosition.recordedAt) {
      console.warn("The position of this entry is older than the cached position, ignoring.");
      return;
    }
    if (vehicle.Latitude === lastPosition.position.latitude && vehicle.Longitude === lastPosition.position.longitude) {
      recordedAt = lastPosition.recordedAt;
    }
    if (Temporal.Now.instant().since(Temporal.Instant.fromEpochSeconds(recordedAt)).minutes > 10) {
      return;
    }
  }

  lastPositionCache.set(vehicleId, { position, recordedAt });

  const monitoredStop = vehicle.StopTimeList.at(0);
  if (typeof monitoredStop === "undefined") return console.warn("No monitored stop for this vehicle, ignoring.");

  const vehicleDescriptor: VehicleDescriptor = {
    id: vehicleId,
    label: vehicleId,
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
      stopTimeUpdate: vehicle.StopTimeList.map((stopTime) => {
        const partialStopTimeUpdate = {
          // Stop sequences are broken af
          // stopSequence: stopTime.StopPointOrder,
          stopId: stopTime.StopPointId.toString(),
        };

        if (stopTime.IsCancelled) {
          return { ...partialStopTimeUpdate, scheduleRelationship: "SKIPPED" };
        }

        if (!stopTime.IsMonitored) {
          return { ...partialStopTimeUpdate, scheduleRelationship: "NO_DATA" };
        }

        const expectedTime = Temporal.Instant.from(stopTime.ExpectedTime).epochSeconds;
        const aimedTime = Temporal.Instant.from(stopTime.AimedTime).epochSeconds;
        const event: StopTimeEvent = {
          delay: expectedTime - aimedTime,
          time: expectedTime,
        };

        return {
          arrival: event,
          departure: event,
          ...partialStopTimeUpdate,
          scheduleRelationship: "SCHEDULED",
        };
      }),
      timestamp: recordedAt,
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
    position,
    timestamp: recordedAt,
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
