import { serve } from "@hono/node-server";
import { Hono } from "hono";
import "temporal-polyfill/global";

import { GTFS_FEED, HUB_FEED, MONITORED_LINES, OLD_GTFSRT_TU_FEED, OLD_GTFSRT_VP_FEED, VEHICLE_WS } from "./config.js";
import { createVehicleProvider, type Vehicle } from "./providers/vehicle-provider.js";
import { importGtfs } from "./resources/import-gtfs.js";
import { importHub } from "./resources/import-hub.js";
import { createRealtimeStore } from "./stores/realtime-store.js";
import {
  type Position,
  type StopTimeEvent,
  type TripDescriptor,
  type TripUpdateEntity,
  type VehicleDescriptor,
  type VehiclePositionEntity,
} from "./types/gtfs-rt.js";
import { isArchiveStale } from "./utils/download-archive.js";
import { buildGtfsRtFeed } from "./utils/build-gtfsrt-feed.js";
import { fetchOldGtfsrt } from "./resources/fetch-old-gtfsrt.js";
import { stream } from "hono/streaming";
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
  for (const vehicle of data) vehicle.vehicle.timestamp += 3600;
  return data;
}

console.log("|> Initiating backup GTFS-RT.");
let oldVehiclePositions = patchOldVehiclePositions((await fetchOldGtfsrt(OLD_GTFSRT_VP_FEED)).entity as VehiclePositionEntity[]);
let oldTripUpdates = (await fetchOldGtfsrt(OLD_GTFSRT_TU_FEED)).entity as TripUpdateEntity[];
setInterval(async () => {
  try {
    oldVehiclePositions = patchOldVehiclePositions((await fetchOldGtfsrt(OLD_GTFSRT_VP_FEED)).entity as VehiclePositionEntity[]);
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
      console.log(`[OLD RT INJECTOR] ${vehiclePosition.vehicle.id} Updated position for existing WS vehicle using old GTFS-RT (${oldVehiclePosition.vehicle.timestamp - vehiclePosition.timestamp}s newer)`);
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
    // > 65 because they seem to not know about time zones
    if (now.since(Temporal.Instant.fromEpochSeconds(vehiclePosition.vehicle.timestamp)).total("minutes") > 65) continue;

    const lastPosition = lastPositionCache.get(parcNumber);
    if (
      typeof lastPosition === "undefined" ||
      now.since(Temporal.Instant.fromEpochSeconds(lastPosition.recordedAt)).total("minutes") > 10
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
            stopTimeUpdate: tripUpdate.tripUpdate.stopTimeUpdate?.map((stu) => ({
              arrival: stu.arrival ? { delay: stu.arrival.delay ?? undefined, time: stu.arrival.time } : undefined,
              departure: stu.departure ? { delay: stu.departure.delay ?? undefined, time: stu.departure.time } : undefined,
              stopId: stu.stopId,
              stopSequence: stu.stopSequence,
              scheduleRelationship: stu.scheduleRelationship,
            })),
            timestamp: tripUpdate.tripUpdate.timestamp,
            trip: {
              tripId: tripUpdate.tripUpdate.trip.tripId,
              routeId: tripUpdate.tripUpdate.trip.routeId,
              directionId: tripUpdate.tripUpdate.trip.directionId ?? 0,
              scheduleRelationship: tripUpdate.tripUpdate.trip.scheduleRelationship ?? 'SCHEDULED',
            },
            vehicle: {
              id: vehiclePosition.vehicle.vehicle.id,
            }
          });
        }
      }

      vehiclePositions.set(parcNumber, {
        ...(trip ? { currentStatus: vehiclePosition.vehicle.currentStatus } : {}),
        occupancyStatus: await getVehicleOccupancyStatus(parcNumber),
        position: {
          latitude: vehiclePosition.vehicle.position.latitude,
          longitude: vehiclePosition.vehicle.position.longitude,
          bearing: vehiclePosition.vehicle.position.bearing,
        },
        ...(trip ? { stopId: vehiclePosition.vehicle.stopId } : {}),
        timestamp: vehiclePosition.vehicle.timestamp, // see comment near if now.since...
        vehicle: { id: parcNumber },
        ...(trip
          ? { trip: { ...trip, scheduleRelationship: "SCHEDULED" } }
          : { trip: {
            tripId: `${parcNumber}_OLDTRIP`,
            routeId: vehicleTrip.routeId,
            directionId: vehicleTrip.directionId,
            scheduleRelationship: 'UNSCHEDULED',
          }
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
  let recordedAt = Temporal.PlainDateTime.from(vehicle.RecordedAtTime).toZonedDateTime("Europe/Paris").epochSeconds;

  const lastPosition = lastPositionCache.get(vehicleId);
  if (typeof lastPosition !== "undefined") {
    if (recordedAt < lastPosition.recordedAt || recordedAt < (existingVehicle?.timestamp ?? 0)) {
      console.warn("\t\t  The position of this entry is older than the cached position, ignoring.");
      return;
    }
    if (vehicle.Latitude === lastPosition.position.latitude && vehicle.Longitude === lastPosition.position.longitude) {
      recordedAt = lastPosition.recordedAt;
    }
    if (Temporal.Now.instant().since(Temporal.Instant.fromEpochSeconds(recordedAt)).total("minutes") > 10) {
      return;
    }
  }

  lastPositionCache.set(vehicleId, { position, recordedAt });

  if (isCommercialTrip(vehicle.Destination) && isSus(vehicle, trip, oldVehiclePosition)) {
    if (existingVehicle) {
      existingVehicle.position = position;
      existingVehicle.timestamp = recordedAt;
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

        const expectedTime = Temporal.Instant.from(
          stopTime.ExpectedTime.endsWith("+01:00") ? stopTime.ExpectedTime : `${stopTime.ExpectedTime}+01:00`,
        ).epochSeconds;
        const aimedTime = Temporal.Instant.from(
          stopTime.AimedTime.endsWith("+01:00") ? stopTime.AimedTime : `${stopTime.AimedTime}+01:00`,
        ).epochSeconds;
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
    occupancyStatus: isCommercialTrip(vehicle.Destination)
      ? await getVehicleOccupancyStatus(vehicleId)
      : "NOT_BOARDABLE",
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
