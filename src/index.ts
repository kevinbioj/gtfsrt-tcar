import { serve } from "@hono/node-server";
import { HubConnectionBuilder, HubConnectionState } from "@microsoft/signalr";
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
import { downloadGtfsrt } from "./gtfs-rt/download-gtfsrt.js";

const GTFS_URL = "https://api.mrn.cityway.fr/dataflow/offre-tc/download?provider=TCAR&dataFormat=GTFS";
const HUB_URL = "https://api.mrn.cityway.fr/dataflow/offre-tc/download?provider=TCAR&dataFormat=HUB";
const GTFSRT_URL = "https://www.reseau-astuce.fr/ftp/gtfsrt/Astuce.VehiclePosition.pb";
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

let currentGtfsrt = await downloadGtfsrt<VehiclePositionEntity>(GTFSRT_URL);
setInterval(async () => {
  try {
    currentGtfsrt = await downloadGtfsrt<VehiclePositionEntity>(GTFSRT_URL);
  } catch {
    // C'est pas grave, on réessaye 30 secondes plus tard.
  }
}, 30_000);

const server = new Hono();
const tripUpdates = new Map<string, TripUpdateEntity>();
const vehiclePositions = new Map<string, VehiclePositionEntity>();
const currentVersions = new Map<string, MonitoredVehicle>();
const lastPositions = new Map<string, { latitude: number; longitude: number; timestamp: Temporal.Instant }>();

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
server.get("/current-versions", (c) => c.json([...currentVersions.values()]));
server.get("/current-versions/:id", (c) => c.json(currentVersions.get(c.req.param("id"))));

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
  .withStatefulReconnect()
  .withKeepAliveInterval(15_000)
  .build();

await connection.start();

const subscribeMonitoredLines = async () => {
  for (const line of TRACKED_LINES) {
    await connection.invoke("Join", `#lineId:${line}:1`);
    await connection.invoke("Join", `#lineId:${line}:2`);
  }
};

setInterval(async () => {
  if (connection.state === HubConnectionState.Disconnected) {
    try {
      await connection.start();
      await subscribeMonitoredLines();
    } catch (e) {
      console.error(e);
    }
  }
}, 15_000);

connection.onclose((error) => {
  if (error) {
    console.error("Closed the connection to the vehicle monitoring service due to error:", error);
    process.exit(1);
  }
});

// 3- Subscribe to lines

console.log("[MAIN] Subscribing to monitored lines");

await subscribeMonitoredLines();
connection.onreconnected(subscribeMonitoredLines);

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
  currentVersions.set(parcNumber, vehicle);

  try {
    if (vehicle.StopTimeList.length === 0) {
      console.warn(`[${parcNumber}] No stops remaining, skipping.`);
      return;
    }

    let recordedAt = Temporal.PlainDateTime.from(vehicle.RecordedAtTime).toZonedDateTime("Europe/Paris").toInstant();

    const lastPosition = lastPositions.get(parcNumber);
    if (lastPosition) {
      if (vehicle.Latitude === lastPosition.latitude && vehicle.Longitude === lastPosition.longitude) {
        recordedAt = lastPosition.timestamp;
      }
    }

    lastPositions.set(parcNumber, {
      latitude: vehicle.Latitude,
      longitude: vehicle.Longitude,
      timestamp: recordedAt,
    });

    if (Temporal.Now.instant().since(recordedAt).total("minutes") > 15) return;

    const lastStop = vehicle.StopTimeList.at(-1);
    if (typeof lastStop !== "undefined") {
      const lastStopAt = Temporal.Instant.from(lastStop.AimedTime);
      // 45 minutes étant le HLP le + long (F3/F4)
      if (Temporal.Now.instant().since(lastStopAt).total("minutes") > 45) return;
    }

    let trip =
      hlpHeadsigns.get(vehicle.Destination) ?? resource.trips.get(resource.courseOperations.get(vehicle.VJourneyId)!);
    let handleTripUpdate = true;

    const oldRtEntryTrip = currentGtfsrt.find((vehicle) => vehicle.vehicle.vehicle.id === parcNumber)?.vehicle.trip;
    if (oldRtEntryTrip && trip?.routeId && oldRtEntryTrip.routeId !== trip?.routeId) {
      console.warn(`[${parcNumber}] ${line} ${vehicle.VJourneyId} - ${vehicle.LineNumber} -> ${vehicle.Destination}`);
      console.warn(
        `[${parcNumber}] Old GTFS-RT returned route ${oldRtEntryTrip?.routeId} while new GTFS-RT returned route ${trip?.routeId}.`
      );
      const matchableTrip = resource.trips.get(oldRtEntryTrip!.tripId);
      if (
        matchableTrip?.routeId !== oldRtEntryTrip.routeId ||
        matchableTrip?.directionId !== (oldRtEntryTrip.directionId ?? 0)
      ) {
        console.warn(
          `[${parcNumber}] Failed to match old GTFS-RT trip information with current GTFS information, ignoring vehicle.`
        );
        return;
      }
      trip = matchableTrip;
      handleTripUpdate = false;
      console.warn(
        `[${parcNumber}] Using old GTFS-RT data to process this vehicle – trip update entity will not be updated.`
      );
    }

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

    if (handleTripUpdate && typeof trip !== "undefined" && !["HLP", "DEP"].some((d) => trip.id.startsWith(d))) {
      tripUpdates.set(`SM:${trip.id}`, {
        id: `SM:${trip.id}`,
        tripUpdate: {
          stopTimeUpdate: vehicle.StopTimeList.map((stl) => {
            const base = {
              stopId: stl.StopPointId.toString(),
              // stopSequence: stopTime!.stopSequence,
            };
            const timeTo = Temporal.Instant.from(stl.AimedTime).since(Temporal.Now.instant()).total("minutes");
            if (!stl.IsMonitored)
              return {
                ...base,
                scheduleRelationship:
                  timeTo >= 60 ? StopTimeScheduleRelationship.NO_DATA : StopTimeScheduleRelationship.SKIPPED,
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

    const nextStop = handleTripUpdate ? vehicle.StopTimeList.at(0) : undefined;
    // : vehicle.StopTimeList.at(1) ?? vehicle.StopTimeList.at(0);

    vehiclePositions.set(`VM:${vehicleDescriptor.id}`, {
      id: `VM:${vehicleDescriptor.id}`,
      vehicle: {
        currentStatus: tripDescriptor ? (vehicle.VehicleAtStop ? "STOPPED_AT" : "IN_TRANSIT_TO") : undefined,
        position: {
          latitude: vehicle.Latitude,
          longitude: vehicle.Longitude,
          bearing: vehicle.Bearing,
        },
        stopId: tripDescriptor ? nextStop?.StopPointId.toString() : undefined,
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
    if (Temporal.Now.instant().since(recordedAt).total("minutes") > 45) {
      tripUpdates.delete(key);
    }
  }

  for (const [key, vehicle] of vehiclePositions) {
    const recordedAt = Temporal.Instant.fromEpochSeconds(vehicle.vehicle.timestamp);
    if (Temporal.Now.instant().since(recordedAt).total("minutes") > 45) {
      vehiclePositions.delete(key);
    }
  }
}, 120_000);

setInterval(() => {
  // Lorsque un véhicule se situe dans une zone non-monitorée, sa position n'est plus
  // mise à jour contrairement à l'ancienne infrastructure temps-réel. Alors toutes les
  // 30 secondes, on regarde laquelle des positions entre le nouveau et l'ancien est la
  // plus récente et on l'applique.
  for (const vehicle of vehiclePositions.values()) {
    const parcNumber = vehicle.vehicle.vehicle.id;
    const oldRtEntry = currentGtfsrt.find((vehicle) => vehicle.vehicle.vehicle.id === parcNumber);
    if (oldRtEntry && oldRtEntry.vehicle.timestamp > vehicle.vehicle.timestamp) {
      vehicle.vehicle.position = oldRtEntry.vehicle.position;
      vehicle.vehicle.timestamp = oldRtEntry.vehicle.timestamp;
    }
  }
}, 30_000);

serve({ fetch: server.fetch, port: +(process.env.PORT ?? 40409) });
