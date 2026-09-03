import { serve } from "@hono/node-server";
import GtfsRealtime from "gtfs-realtime-bindings";
import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { loadCache } from "./ai/analyze-alert.js";
import {
	ALERT_CACHE_PATH,
	ALERTS_POLL_INTERVAL,
	GTFS_CHECK_INTERVAL,
	POLL_INTERVAL,
	PORT,
	REALTIME_LINES,
	SERVICE_ALERTS_URL,
	STATIC_GTFS_URL,
	TRIP_RETENTION_DURATION,
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

/**
 * Dernière course cohérente annoncée par la source principale, par véhicule. Sert à conserver la
 * course lorsqu'un véhicule disparaît de la source principale et retombe sur la seule source de
 * vérité (cf. `restoreRecentTrips`).
 */
const lastStandardTrips = new Map<string, { trip: GtfsRealtime.transit_realtime.ITripDescriptor; seenAt: number }>();
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
const staticGtfs = await useStaticGtfs(STATIC_GTFS_URL, GTFS_CHECK_INTERVAL);
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
			// Le store n'a pas été vidé : il garde l'état du poll précédent, que l'on complète tout
			// de même des véhicules vus par la seule source de vérité.
			console.log(`✓ ${fallbackFromVerificationFeed()} positions from verification feed only.`);
			restoreRecentTrips();
			return;
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const feed = GtfsRealtime.transit_realtime.FeedMessage.decode(buffer);

		// Le store est vidé à chaque poll : on garde l'état précédent sous la main pour
		// pouvoir continuer à publier un véhicule dont la ligne est incohérente.
		const previousPositions = new Map(store.vehiclePositions);
		store.vehiclePositions.clear();

		// La source de vérité pose le socle : tout véhicule qu'elle voit rouler est publié, ligne et
		// position seulement. La boucle qui suit ne fait qu'enrichir ce socle avec la course annoncée
		// par la source principale, et uniquement lorsque celle-ci s'avère cohérente.
		fallbackFromVerificationFeed();

		for (const entity of feed.entity) {
			if (!entity.vehicle?.vehicle?.id) continue;

			if (entity.vehicle?.trip) {
				entity.vehicle.trip.scheduleRelationship =
					GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED;
				if (entity.vehicle.trip.directionId !== 1) {
					entity.vehicle.trip.directionId = 0;
				}
			}

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

				// On ne relaie pas la course incohérente, mais on continue de rafraîchir la
				// position sur la dernière course connue, sinon le véhicule se fige.
				const storedVehicle = previousPositions.get(`VM:TCAR:${vehicleId}`);
				if (storedVehicle !== undefined) {
					const useVerifiedPosition = verifiedVehicle.recordedAt > entityTimestamp;
					store.vehiclePositions.set(`VM:TCAR:${vehicleId}`, {
						...storedVehicle,
						vehicle: { id: `TCAR:${vehicleId}` },
						position: useVerifiedPosition ? verifiedVehicle.position : entity.vehicle.position,
						timestamp: useVerifiedPosition ? verifiedVehicle.recordedAt : entity.vehicle.timestamp,
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

			if (entity.vehicle.trip?.tripId) {
				lastStandardTrips.set(vehicleId, { trip: entity.vehicle.trip, seenAt: now.epochMilliseconds });
			}

			console.log(`\t⛛ ${vehicleId.padEnd(4, " ")}  ${routeId.padEnd(10, " ")} ${directionId}`);
		}

		// Un véhicule qui vient de disparaître de la source principale conserve sa dernière course
		// tant qu'elle est récente et que la ligne n'a pas changé.
		const retainedTrips = restoreRecentTrips();

		// Ce que la source principale n'a pas enrichi reste tel que la source de vérité l'a posé :
		// une ligne, un sens, une position, sans course. C'est le cas d'un véhicule sur une ligne
		// hors REALTIME_LINES, d'une course absente du flux principal, ou d'un véhicule qu'il ignore.
		let fallbackVehicles = 0;
		for (const [key, vehicle] of store.vehiclePositions) {
			if (vehicle.trip?.tripId) continue;
			fallbackVehicles += 1;
			const vehicleId = key.split(":")[2]!;
			console.log(
				`\t⛝ ${vehicleId.padEnd(4, " ")}  ${(vehicle.trip?.routeId ?? "").padEnd(10, " ")} ${vehicle.trip?.directionId ?? 0}`,
			);
		}

		console.log(
			`✓ ${store.vehiclePositions.size} positions (${fallbackVehicles} from verification feed only, ${retainedTrips} with retained trip).`,
		);
	} catch (cause) {
		console.error("✘ Poll error:", cause);
		// L'erreur peut survenir en plein remplissage du store : on le complète malgré tout, pour ne
		// pas publier un feed amputé des véhicules que la source de vérité connaît.
		console.log(`✓ ${fallbackFromVerificationFeed()} positions from verification feed only.`);
		restoreRecentTrips();
	}
}

/**
 * Peuple le store avec les véhicules connus de la source de vérité, sans écraser une entrée déjà
 * présente. Aucune course n'est annoncée : uniquement la ligne, le sens et la position — le tripId
 * de la source de vérité relève d'un autre référentiel que les trips du GTFS statique publié.
 * Renvoie le nombre de véhicules ajoutés.
 */
function fallbackFromVerificationFeed() {
	const verifiedVehicles = verificationFeed.verifiedVehicles;
	if (verifiedVehicles === undefined) return 0;

	const now = Temporal.Now.instant();
	let added = 0;

	for (const [vehicleId, verifiedVehicle] of verifiedVehicles) {
		const key = `VM:TCAR:${vehicleId}`;
		if (store.vehiclePositions.has(key)) continue;

		// Même seuil de péremption que pour les véhicules de la source principale : le snapshot de
		// la source de vérité n'est rechargé qu'une fois par minute et vieillit entre deux polls.
		if (now.since(Temporal.Instant.fromEpochMilliseconds(verifiedVehicle.recordedAt * 1000)).total("minutes") >= 30) {
			continue;
		}

		store.vehiclePositions.set(key, {
			vehicle: { id: `TCAR:${vehicleId}` },
			trip: { routeId: verifiedVehicle.routeId, directionId: verifiedVehicle.directionId },
			position: verifiedVehicle.position,
			timestamp: verifiedVehicle.recordedAt,
			occupancyStatus: vehicleOccupancyStatuses.get(vehicleId)?.status,
		});
		added += 1;
	}

	return added;
}

/**
 * Réapplique la dernière course annoncée par la source principale aux véhicules que la source de
 * vérité a posés sans course. La course reste publiée tant qu'elle a été vue il y a moins de
 * `TRIP_RETENTION_DURATION` et que la ligne et le sens de la source de vérité concordent toujours ;
 * un changement de ligne ou de sens invalide définitivement la mémoire. Renvoie le nombre de
 * courses conservées.
 */
function restoreRecentTrips() {
	const nowMs = Temporal.Now.instant().epochMilliseconds;
	let restored = 0;

	for (const [vehicleId, remembered] of lastStandardTrips) {
		if (nowMs - remembered.seenAt >= TRIP_RETENTION_DURATION) {
			lastStandardTrips.delete(vehicleId);
		}
	}

	for (const [key, vehicle] of store.vehiclePositions) {
		if (vehicle.trip?.tripId) continue;

		const vehicleId = key.split(":")[2]!;
		const remembered = lastStandardTrips.get(vehicleId);
		if (remembered === undefined) continue;

		if (
			remembered.trip.routeId !== vehicle.trip?.routeId ||
			(remembered.trip.directionId ?? 0) !== (vehicle.trip?.directionId ?? 0)
		) {
			// Le véhicule a changé de ligne ou de sens : la course mémorisée est définitivement obsolète.
			lastStandardTrips.delete(vehicleId);
			continue;
		}

		store.vehiclePositions.set(key, { ...vehicle, trip: remembered.trip });
		restored += 1;
		console.log(
			`\t↻ ${vehicleId.padEnd(4, " ")}  ${(remembered.trip.routeId ?? "").padEnd(10, " ")} ${remembered.trip.directionId ?? 0}`,
		);
	}

	return restored;
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

			if (entity.tripUpdate?.trip) {
				entity.tripUpdate.trip.scheduleRelationship =
					GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED;
				if (entity.tripUpdate.trip.directionId !== 1) {
					entity.tripUpdate.trip.directionId = 0;
				}
			}

			entity.tripUpdate.stopTimeUpdate?.forEach((stopTimeUpdate) => {
				stopTimeUpdate.scheduleRelationship =
					GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED;
			});

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
