import { serve } from "@hono/node-server";
import GtfsRealtime from "gtfs-realtime-bindings";
import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { loadCache } from "./ai/analyze-alert.js";
import {
	ALERT_CACHE_PATH,
	ALERTS_POLL_INTERVAL,
	GTFS_REFRESH_INTERVAL,
	POLL_INTERVAL,
	PORT,
	REALTIME_LINES,
	SERVICE_ALERTS_URL,
	STATIC_GTFS_URL,
	TRIP_UPDATES_URL,
	VEHICLE_POSITIONS_URL,
	VERIFICATION_FEED_URL,
} from "./config.js";
import { handleRequest } from "./gtfs-rt/handle-request.js";
import { useRealtimeStore } from "./gtfs-rt/use-realtime-store.js";
import { applySkippedStops, keepOnlySkippedStops, useServiceAlerts } from "./gtfs-rt/use-service-alerts.js";
import { useStaticGtfs } from "./gtfs-rt/use-static-gtfs.js";
import { useVerificationFeed } from "./gtfs-rt/use-verification-feed.js";
import { useVehicleOccupancyStatuses } from "./utils/use-vehicle-occupancy-status.js";

// Charge un fichier .env s'il existe (clé ANTHROPIC_API_KEY notamment).
try {
	process.loadEnvFile();
} catch {
	// pas de .env → on s'appuie sur les variables d'environnement du système
}

console.log(` ,----.,--------.,------.,---.        ,------.,--------. ,--------.,-----.  ,---.  ,------.
'  .-./'--.  .--'|  .---'   .-',-----.|  .--. '--.  .--' '--.  .--'  .--./ /  O  \\ |  .--. '
|  | .---.|  |   |  \`--,\`.  \`-.'-----'|  '--'.'  |  |       |  |  |  |    |  .-.  ||  '--'.'
'  '--'  ||  |   |  |\`  .-'    |      |  |\\  \\   |  |       |  |  '  '--'\\|  | |  ||  |\\  \\
 \`------' \`--'   \`--'   \`-----'       \`--' '--'  \`--'       \`--'   \`-----'\`--' \`--'\`--' '--'`);

const store = useRealtimeStore();
const vehicleOccupancyStatuses = useVehicleOccupancyStatuses();
const verificationFeed = await useVerificationFeed(VERIFICATION_FEED_URL, (verifiedVehicles) => {
	for (const [key, storedVehicle] of store.vehiclePositions) {
		const vehicleId = key.split(":")[2]!;
		const verifiedVehicle = verifiedVehicles.get(vehicleId);
		if (!verifiedVehicle) continue;

		const entityTimestamp = +(storedVehicle.timestamp ?? 0);
		if (verifiedVehicle.recordedAt > entityTimestamp) {
			store.vehiclePositions.set(key, {
				...storedVehicle,
				position: verifiedVehicle.position,
				timestamp: verifiedVehicle.recordedAt,
			});
		}
	}
});

loadCache(ALERT_CACHE_PATH);
const staticGtfs = await useStaticGtfs(STATIC_GTFS_URL, GTFS_REFRESH_INTERVAL);
const serviceAlerts = useServiceAlerts(SERVICE_ALERTS_URL, ALERTS_POLL_INTERVAL, staticGtfs);

const hono = new Hono();
hono.use(
	rateLimiter({
		windowMs: 5_000,
		limit: 5,
		keyGenerator: (c) => `${c.req.header("CF-Connecting-IP")}_${c.req.method}_${c.req.path}`,
		handler: (c) => c.json({ code: 429, message: "Too many requests, please try again later." }, 429),
	}),
);

hono.get("/vehicle-positions", (c) => handleRequest(c, "protobuf", null, store.vehiclePositions));
hono.get("/vehicle-positions.json", (c) => handleRequest(c, "json", null, store.vehiclePositions));
hono.get("/trip-updates", (c) => handleRequest(c, "protobuf", store.tripUpdates, null));
hono.get("/trip-updates.json", (c) => handleRequest(c, "json", store.tripUpdates, null));
hono.get("/", (c) =>
	handleRequest(c, c.req.query("format") === "json" ? "json" : "protobuf", null, store.vehiclePositions),
);

serve({ fetch: hono.fetch, port: PORT });
console.log(`➔ Listening on :${PORT}`);

// ---

async function poll() {
	try {
		const response = await fetch(VEHICLE_POSITIONS_URL);
		if (!response.ok || response.status === 204) {
			console.error(`✘ Vehicle positions fetch failed (HTTP ${response.status}).`);
			return;
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const feed = GtfsRealtime.transit_realtime.FeedMessage.decode(buffer);

		store.vehiclePositions.clear();

		for (const entity of feed.entity) {
			if (!entity.vehicle?.vehicle?.id) continue;

			const id = entity.vehicle.vehicle.id;
			const vehicleId = id.split(":")[3]!;
			const routeId = entity.vehicle.trip?.routeId ?? "";
			const directionId = entity.vehicle.trip?.directionId ?? 0;

			const lineId = routeId.split(":").at(-1) ?? "";
			if (!REALTIME_LINES.has(lineId)) continue;

			const verifiedVehicle = verificationFeed.verifiedVehicles?.get(vehicleId);

			if (verifiedVehicle === undefined) {
				continue;
			}

			const now = Temporal.Now.instant();
			if (now.since(Temporal.Instant.fromEpochMilliseconds(verifiedVehicle.recordedAt * 1000)).total("minutes") >= 30) {
				console.warn(`\t✘ ${vehicleId}\tExcluded: last verified position is stale (> 30 min).`);
				continue;
			}

			const entityTimestamp = +(entity.vehicle.timestamp ?? 0);

			if (verifiedVehicle.routeId !== routeId) {
				console.warn(`\t✘ ${vehicleId}\tRoute mismatch! New: '${routeId}' vs. Old: '${verifiedVehicle.routeId}'.`);

				const storedVehicle = store.vehiclePositions.get(`VM:TCAR:${vehicleId}`);
				if (storedVehicle !== undefined) {
					store.vehiclePositions.set(`VM:TCAR:${vehicleId}`, {
						...storedVehicle,
						vehicle: { id: `TCAR:${vehicleId}` },
						position: verifiedVehicle.recordedAt > entityTimestamp ? verifiedVehicle.position : entity.vehicle.position,
						occupancyStatus: vehicleOccupancyStatuses.get(vehicleId)?.status,
					});
				}

				continue;
			}

			const useVerifiedPosition = verifiedVehicle.recordedAt > entityTimestamp;
			store.vehiclePositions.set(`VM:TCAR:${vehicleId}`, {
				...entity.vehicle,
				vehicle: { id: `TCAR:${vehicleId}` },
				position: useVerifiedPosition ? verifiedVehicle.position : entity.vehicle.position,
				timestamp: useVerifiedPosition ? verifiedVehicle.recordedAt : entity.vehicle.timestamp,
				occupancyStatus: vehicleOccupancyStatuses.get(vehicleId)?.status,
			});

			console.log(`\t⛛ ${vehicleId.padEnd(4, " ")}  ${routeId.padEnd(10, " ")} ${directionId}`);
		}

		console.log(`✓ ${store.vehiclePositions.size} positions.`);
	} catch (cause) {
		console.error("✘ Poll error:", cause);
	}
}

async function pollTripUpdates() {
	try {
		const response = await fetch(TRIP_UPDATES_URL);
		if (!response.ok || response.status === 204) {
			console.error(`✘ Trip updates fetch failed (HTTP ${response.status}).`);
			return;
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const feed = GtfsRealtime.transit_realtime.FeedMessage.decode(buffer);

		store.tripUpdates.clear();

		let skipsOnly = 0;

		for (const entity of feed.entity) {
			if (!entity.tripUpdate) continue;
			const tripRouteId = entity.tripUpdate.trip?.routeId ?? "";
			const tripLineId = tripRouteId.split(":").at(-1) ?? "";

			applySkippedStops(entity.tripUpdate, tripRouteId, serviceAlerts.skipIndex, staticGtfs.data);

			// Ligne sans vrai temps réel : on ne relaie pas ses horaires, mais on garde ses
			// suppressions d'arrêt. Sans suppression, le trip n'apporte rien → on l'écarte.
			if (!REALTIME_LINES.has(tripLineId)) {
				keepOnlySkippedStops(entity.tripUpdate);
				if (!entity.tripUpdate.stopTimeUpdate?.length) continue;
				skipsOnly += 1;
			}

			const tripEntityId = entity.id.split(":").at(-1) ?? entity.id;
			store.tripUpdates.set(`ET:TCAR:${tripEntityId}`, entity.tripUpdate);
		}

		console.log(`✓ ${store.tripUpdates.size} trip updates (${skipsOnly} skipped-stops only).`);
	} catch (cause) {
		console.error("✘ Trip updates poll error:", cause);
	}
}

setInterval(poll, POLL_INTERVAL);
setInterval(pollTripUpdates, POLL_INTERVAL);
await poll();
await pollTripUpdates();
