import { serve } from "@hono/node-server";
import { HubConnectionBuilder } from "@microsoft/signalr";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import "temporal-polyfill/global";

import type { MonitoredVehicle } from "./cityway-types.js";
import { loadResource } from "./gtfs/index.js";
import { encodePayload } from "./gtfs/encode-payload.js";
import { StopTimeScheduleRelationship, type TripUpdateEntity, type VehiclePositionEntity } from "./gtfs-rt/types.js";
import { wrapEntities } from "./gtfs-rt/wrap-entities.js";
import { matchTrip } from "./match-trip.js";
import { hlpTrips } from "./hlp-trips.js";

const GTFS_URL = "https://api.mrn.cityway.fr/dataflow/offre-tc/download?provider=TCAR&dataFormat=GTFS";

console.log("[MAIN] Loading current GTFS resource");
let trips = await loadResource(GTFS_URL);
setInterval(async () => {
  trips = await loadResource(GTFS_URL);
}, 60_000 * 3600);

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
server.get("/vehicle-positions", (c) =>
  stream(c, async (stream) => {
    const payload = wrapEntities([...vehiclePositions.values()]);
    const serialized = encodePayload(payload);
    await stream.write(serialized);
  })
);
server.get("/trip-updates.json", (c) => c.json(wrapEntities([...tripUpdates.values()])));
server.get("/vehicle-positions.json", (c) => c.json(wrapEntities([...vehiclePositions.values()])));

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

// 1- Connect to web service
console.log("[MAIN] Establishing connection to the service");

const connection = new HubConnectionBuilder()
  .withUrl("https://api.mrn.cityway.fr/sdh/vehicles")
  .withAutomaticReconnect()
  .withKeepAliveInterval(15_000)
  .build();

await connection.start();

// 2- Subscribe to lines
console.log("[MAIN] Subscribing to monitored lines");

for (const line of TRACKED_LINES) {
  await connection.invoke("Join", `#lineId:${line}:1`);
  await connection.invoke("Join", `#lineId:${line}:2`);
}

// 3- Listen to incoming vehicles
console.log("[MAIN] Creating vehicles handler");

connection.on("dataReceived", (_, payload) => {
  const vehicle = JSON.parse(payload) as MonitoredVehicle;
  const parcNumber = vehicle.VehicleRef.split(":")[3];
  try {
    if (vehicle.StopTimeList.length === 0) {
      console.warn(`[${parcNumber}] No stops remaining, skipping.`);
      return;
    }

    const guessedTrip = hlpTrips[vehicle.Destination] ?? matchTrip(trips, vehicle);
    if (!guessedTrip) {
      console.warn(`[${parcNumber}] Failed to guess trip from GTFS resource, skipping.`);
      return;
    }

    const lastStopTime = vehicle.StopTimeList.at(-1)!;
    const timeSince = Temporal.Now.instant().since(Temporal.Instant.from(lastStopTime.AimedTime)).total("minutes");
    if (guessedTrip.routeId === "HLP" ? timeSince > 40 : timeSince > 10) return;

    const recordedAt = Temporal.PlainDateTime.from(vehicle.RecordedAtTime).toZonedDateTime("Europe/Paris");

    const tripDescriptor = {
      tripId: guessedTrip.id,
      routeId: guessedTrip.routeId,
      directionId: guessedTrip.directionId,
      scheduleRelationship: "SCHEDULED",
    } as const;

    const vehicleDescriptor = {
      id: parcNumber,
      label: parcNumber,
    } as const;

    tripUpdates.set(`SM:${guessedTrip.id}`, {
      id: `SM:${guessedTrip.id}`,
      tripUpdate: {
        stopTimeUpdate:
          tripDescriptor.routeId === "HLP"
            ? []
            : vehicle.StopTimeList.map((stl) => {
                const stopTime = guessedTrip.stopTimes.find((st) => st.stopId === stl.StopPointId.toString());
                const base = {
                  stopId: stl.StopPointId.toString(),
                  stopSequence: stopTime!.stopSequence,
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
        trip: tripDescriptor,
        vehicle: vehicleDescriptor,
      },
    });

    vehiclePositions.set(`VM:${vehicleDescriptor.id}`, {
      id: `VM:${vehicleDescriptor.id}`,
      vehicle: {
        currentStatus:
          tripDescriptor.routeId === "HLP" ? undefined : vehicle.VehicleAtStop ? "STOPPED_AT" : "IN_TRANSIT_TO",
        currentStopSequence:
          tripDescriptor.routeId === "HLP"
            ? undefined
            : guessedTrip.stopTimes.find((st) => st.stopId === vehicle.StopTimeList[0]?.StopPointId.toString())
                ?.stopSequence,
        position: {
          latitude: vehicle.Latitude,
          longitude: vehicle.Longitude,
          bearing: vehicle.Bearing,
        },
        stopId: tripDescriptor.routeId === "HLP" ? undefined : vehicle.StopTimeList[0]?.StopPointId.toString(),
        timestamp: recordedAt.epochSeconds,
        trip: tripDescriptor,
        vehicle: vehicleDescriptor,
      },
    });

    console.debug(`[${parcNumber}] ${vehicle.LineNumber} -> ${vehicle.Destination}`);
  } catch (error: unknown) {
    console.error(`[${parcNumber}] An error occurred while processing the vehicle:`, error);
  }
});

const SWEEP_THRESHOLD = 15;

function sweepEntries() {
  console.log("Sweeping old entries from trip updates and vehicle positions.");
  [...tripUpdates.values()]
    .filter((tripUpdate) => {
      const lastStop = tripUpdate.tripUpdate.stopTimeUpdate.at(-1);
      if (typeof lastStop === "undefined") {
        return (
          Temporal.Now.instant()
            .since(Temporal.Instant.fromEpochSeconds(tripUpdate.tripUpdate.timestamp))
            .total("minutes") > SWEEP_THRESHOLD
        );
        // return dayjs().diff(dayjs.unix(tripUpdate.tripUpdate.timestamp), "seconds") > sweepThreshold;
      }
      return (
        Temporal.Now.instant().since(Temporal.Instant.fromEpochSeconds(lastStop.arrival!.time)).total("minutes") >
        SWEEP_THRESHOLD
      );
    })
    .forEach((tripUpdate) => tripUpdates.delete(tripUpdate.id));
  [...vehiclePositions.values()]
    .filter((vehiclePosition) => {
      const associatedTrip = tripUpdates.get(vehiclePosition.vehicle.trip.tripId);
      const lastStopTime = associatedTrip?.tripUpdate.stopTimeUpdate.at(-1);
      if (lastStopTime) {
        const lastStopTimestamp = Temporal.Instant.fromEpochSeconds(lastStopTime.arrival!.time);
        if (Temporal.Instant.compare(Temporal.Now.instant(), lastStopTimestamp) < 0) return false;
      }
      return (
        Temporal.Now.instant()
          .since(Temporal.Instant.fromEpochSeconds(vehiclePosition.vehicle.timestamp))
          .total("minutes") > SWEEP_THRESHOLD
      );
    })
    .forEach((vehiclePosition) => vehiclePositions.delete(vehiclePosition.id));
  setTimeout(sweepEntries, 60_000);
}

sweepEntries();

serve({ fetch: server.fetch, port: +(process.env.PORT ?? 40409) });
