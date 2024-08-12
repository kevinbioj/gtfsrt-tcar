import { serve } from "@hono/node-server";
import { HubConnectionBuilder } from "@microsoft/signalr";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import "temporal-polyfill/global";

import type { MonitoredVehicle } from "./cityway-types.js";
import { StopTimeScheduleRelationship, type TripUpdateEntity, type VehiclePositionEntity } from "./gtfs-rt/types.js";
import { loadGtfsResource } from "./gtfs/index.js";
import { loadHubResource } from "./hub/index.js";
import { wrapEntities } from "./gtfs-rt/wrap-entities.js";
import { encodePayload } from "./gtfs-rt/encode-payload.js";
import type { Trip } from "./gtfs/types.js";

const GTFS_URL = "https://api.mrn.cityway.fr/dataflow/offre-tc/download?provider=TCAR&dataFormat=GTFS";
const HUB_URL = "https://api.mrn.cityway.fr/dataflow/offre-tc/download?provider=TCAR&dataFormat=HUB";
const TRACKED_LINES = [
  "24211", // M
  "24210", // N
  "24212", // T1
  "24213", // T2
  "24214", // T3
  "24215", // T4
  "24099", // F1
  "24100", // F2
  "24101", // F3
  "24102", // F4
  "24103", // F5
  "24104", // F6
  "24105", // F7
  "24106", // F8
  "24108", // 10
  "24115", // 11
  "24116", // 13
  "24117", // 14
  "24118", // 15
  "24119", // 20
  "24133", // 22
  "24144", // 27
  "24145", // 28
  "24157", // 33
  "24169", // 35
  "24186", // 41
  "24192", // 42
  "24193", // 43
  "40874", // NOCT
];

const server = new Hono();
const tripUpdates = new Map<string, TripUpdateEntity>();
const vehiclePositions = new Map<string, VehiclePositionEntity>();

server.get("/trip-updates", (c) =>
  stream(c, async (stream) => {
    const payload = wrapEntities([...tripUpdates.values()]);
    const serialized = encodePayload(payload);
    await stream.write(serialized);
  })
);
server.get("/trip-updates.json", (c) => c.json(wrapEntities([...tripUpdates.values()])));
server.get("/vehicle-positions", (c) =>
  stream(c, async (stream) => {
    const payload = wrapEntities([...vehiclePositions.values()]);
    const serialized = encodePayload(payload);
    await stream.write(serialized);
  })
);
server.get("/vehicle-positions.json", (c) => c.json(wrapEntities([...vehiclePositions.values()])));

// 1- Load GTFS & HUB resources

console.log("[MAIN] Loading GTFS & HUB resources");
const loadResources = async () => ({
  courseOperations: await loadHubResource(HUB_URL),
  trips: await loadGtfsResource(GTFS_URL),
});
let resource = await loadResources();
setInterval(async () => {
  resource = await loadResources();
}, 60_000 * 3600);

// 2- Connect to web service

console.log("[MAIN] Establishing connection to the service");

const connection = new HubConnectionBuilder()
  .withUrl("https://api.mrn.cityway.fr/sdh/vehicles")
  .withAutomaticReconnect()
  .withKeepAliveInterval(15_000)
  .build();

await connection.start();

// 3- Subscribe to lines

console.log("[MAIN] Subscribing to monitored lines");

for (const line of TRACKED_LINES) {
  await connection.invoke("Join", `#lineId:${line}:1`);
  await connection.invoke("Join", `#lineId:${line}:2`);
}

// 4- Listen to incoming vehicles
console.log("[MAIN] Creating vehicles handler");

const hlpHeadsigns = new Map<string, Trip>([
  ["Dépôt 2 Rivières", { id: "DEP_2RIV" }],
  ["ROUEN DEPOT", { id: "DEP_ROUD" }],
  ["Dépôt St-Julien", { id: "DEP_STJU" }],
  ["Dépôt TNI Carnot", { id: "DEP_TNIC" }],
]);

connection.on("dataReceived", (line, payload) => {
  const vehicle = JSON.parse(payload) as MonitoredVehicle;
  const parcNumber = vehicle.VehicleRef.split(":")[3];

  try {
    if (vehicle.StopTimeList.length === 0) {
      console.warn(`[${parcNumber}] No stops remaining, skipping.`);
      return;
    }

    const recordedAt = Temporal.PlainDateTime.from(vehicle.RecordedAtTime).toZonedDateTime("Europe/Paris").toInstant();
    if (Temporal.Now.instant().since(recordedAt).total("minutes") > 15) return;

    const trip =
      hlpHeadsigns.get(vehicle.Destination) ?? resource.trips.get(resource.courseOperations.get(vehicle.VJourneyId)!);

    const tripDescriptor = trip
      ? ({
          tripId: trip.id,
          routeId: trip.routeId,
          directionId: trip.directionId,
          scheduleRelationship: "SCHEDULED",
        } as const)
      : undefined;

    const vehicleDescriptor = {
      id: parcNumber,
      label: parcNumber,
    } as const;

    if (typeof trip !== "undefined" && !["HLP", "DEP"].some((d) => trip.id.startsWith(d))) {
      tripUpdates.set(`SM:${trip.id}`, {
        id: `SM:${trip.id}`,
        tripUpdate: {
          stopTimeUpdate: vehicle.StopTimeList.map((stl) => {
            const base = {
              stopId: stl.StopPointId.toString(),
              // stopSequence: stopTime!.stopSequence,
            };
            if (!stl.IsMonitored)
              return {
                ...base,
                scheduleRelationship: StopTimeScheduleRelationship.NO_DATA,
              };
            if (stl.IsCancelled)
              return {
                ...base,
                scheduleRelationship: StopTimeScheduleRelationship.SKIPPED,
              };
            const aimedTime = Temporal.Instant.from(stl.AimedTime);
            const expectedTime = Temporal.Instant.from(stl.ExpectedTime);
            const ste = {
              delay: expectedTime.epochSeconds - aimedTime.epochSeconds,
              time: expectedTime.epochSeconds,
            };
            return {
              arrival: ste,
              departure: ste,
              ...base,
              scheduleRelationship: StopTimeScheduleRelationship.SCHEDULED,
            };
          }),
          timestamp: recordedAt.epochSeconds,
          trip: tripDescriptor!,
          vehicle: vehicleDescriptor,
        },
      });
    }

    vehiclePositions.set(`VM:${vehicleDescriptor.id}`, {
      id: `VM:${vehicleDescriptor.id}`,
      vehicle: {
        position: {
          latitude: vehicle.Latitude,
          longitude: vehicle.Longitude,
          bearing: vehicle.Bearing,
        },
        timestamp: recordedAt.epochSeconds,
        trip: tripDescriptor,
        vehicle: vehicleDescriptor,
      },
    });

    console.debug(`[${parcNumber}] ${line} ${vehicle.VJourneyId} - ${vehicle.LineNumber} -> ${vehicle.Destination}`);
  } catch (error: unknown) {
    console.error(`[${parcNumber}] An error occurred while processing the vehicle:`, error);
  }
});

setInterval(() => {
  console.debug(`[SWEEPER] Sweeping outdated trip updates and vehicle positions`);
  for (const [key, tripUpdate] of tripUpdates) {
    const recordedAt = Temporal.Instant.fromEpochSeconds(tripUpdate.tripUpdate.timestamp);
    if (Temporal.Now.instant().since(recordedAt).total("minutes") > 10) {
      let shouldDelete = true;
      const lastStopTime = tripUpdate.tripUpdate.stopTimeUpdate?.at(-1);
      if (typeof lastStopTime !== "undefined") {
        const arrivalScheduledTime = Temporal.Instant.fromEpochSeconds(lastStopTime.arrival!.time).subtract({
          seconds: lastStopTime.arrival!.delay ?? 0,
        });
        if (Temporal.Now.instant().since(arrivalScheduledTime).total("minutes") < 10) {
          shouldDelete = false;
        }
      }
      tripUpdates.delete(key);
    }
  }

  for (const [key, vehicle] of vehiclePositions) {
    const recordedAt = Temporal.Instant.fromEpochSeconds(vehicle.vehicle.timestamp);
    if (Temporal.Now.instant().since(recordedAt).total("minutes") > 10) {
      let shouldDelete = true;
      if (typeof vehicle.vehicle.trip !== "undefined") {
        const tripUpdate = tripUpdates.get(`SM:${vehicle.vehicle.trip.tripId}`);
        if (typeof tripUpdate !== "undefined") {
          const lastStopTime = tripUpdate.tripUpdate.stopTimeUpdate?.at(-1);
          if (typeof lastStopTime !== "undefined") {
            const arrivalTime = Temporal.Instant.fromEpochSeconds(lastStopTime.arrival!.time);
            if (Temporal.Now.instant().since(arrivalTime).total("minutes") < 10) {
              shouldDelete = false;
            }
          }
        }
      }
      if (shouldDelete) vehiclePositions.delete(key);
    }
  }
}, 120_000);

serve({ fetch: server.fetch, port: +(process.env.PORT ?? 40409) });
