import { serve } from "@hono/node-server";
import { HubConnectionBuilder } from "@microsoft/signalr";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import "temporal-polyfill/global";

import type { MonitoredVehicle } from "./cityway-types.js";
import { type VehiclePositionEntity } from "./gtfs-rt/types.js";
import { wrapEntities } from "./gtfs-rt/wrap-entities.js";
import { encodePayload } from "./gtfs-rt/encode-payload.js";
import type { Trip } from "./gtfs/types.js";
import { downloadGtfsrt } from "./gtfs-rt/download-gtfsrt.js";

const GTFSRT_URL = "https://tsi.tcar.cityway.fr/ftp/gtfsrt/Astuce.VehiclePosition.pb";
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
const vehiclePositions = new Map<string, VehiclePositionEntity>();

// 1- Load GTFS & HUB resources

console.log("[MAIN] Loading GTFS & HUB resources");

let officialVp = await downloadGtfsrt<VehiclePositionEntity>(GTFSRT_URL);
setInterval(async () => {
  officialVp = await downloadGtfsrt<VehiclePositionEntity>(GTFSRT_URL);
}, 30_000);

const getFullPayload = () => [
  ...officialVp.filter((entity) => !vehiclePositions.has(`VM:${entity.vehicle.vehicle.id}`)),
  ...vehiclePositions.values(),
];
server.get("/vehicle-positions", (c) =>
  stream(c, async (stream) => {
    const payload = wrapEntities(getFullPayload());
    const serialized = encodePayload(payload);
    await stream.write(serialized);
  })
);
server.get("/vehicle-positions.json", (c) => c.json(wrapEntities(getFullPayload())));

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

    let recordedAt = Temporal.PlainDateTime.from(vehicle.RecordedAtTime).toZonedDateTime("Europe/Paris").toInstant();

    const existingRecord = vehiclePositions.get(`VM:${parcNumber}`);
    if (existingRecord) {
      const { latitude, longitude } = existingRecord.vehicle.position;
      if (vehicle.Latitude === latitude && vehicle.Longitude === longitude) {
        recordedAt = Temporal.Instant.fromEpochSeconds(existingRecord.vehicle.timestamp);
      }
    }

    if (Temporal.Now.instant().since(recordedAt).total("minutes") > 15) return;

    const lastStop = vehicle.StopTimeList.at(-1);
    if (typeof lastStop !== "undefined") {
      const lastStopAt = Temporal.Instant.from(lastStop.AimedTime);
      // 45 minutes étant le HLP le + long (F3/F4)
      if (Temporal.Now.instant().since(lastStopAt).total("minutes") > 45) return;
    }

    const trip = hlpHeadsigns.get(vehicle.Destination);
    if (typeof trip === "undefined") return;

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
  console.debug(`[SWEEPER] Sweeping outdated vehicle positions`);

  for (const [key, vehicle] of vehiclePositions) {
    const recordedAt = Temporal.Instant.fromEpochSeconds(vehicle.vehicle.timestamp);
    if (Temporal.Now.instant().since(recordedAt).total("minutes") > 45) {
      vehiclePositions.delete(key);
    }
  }
}, 120_000);

serve({ fetch: server.fetch, port: +(process.env.PORT ?? 40409) });
