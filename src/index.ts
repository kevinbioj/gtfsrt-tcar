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
	STATE_CACHE_PATH,
	STATIC_GTFS_URL,
	TRIP_UPDATES_URL,
	VEHICLE_MONITORING_INTERVAL,
	VEHICLE_MONITORING_URL,
	VEHICLE_POSITIONS_URL,
	VEHICLE_STALENESS,
	VERIFICATION_FEED_URL,
	VERIFICATION_STALENESS,
} from "./config.js";
import { handleRequest } from "./gtfs-rt/handle-request.js";
import { useMovementTracker } from "./gtfs-rt/use-movement-tracker.js";
import { useRealtimeStore } from "./gtfs-rt/use-realtime-store.js";
import { applySkippedStops, keepOnlySkippedStops, useServiceAlerts } from "./gtfs-rt/use-service-alerts.js";
import { useStaticGtfs } from "./gtfs-rt/use-static-gtfs.js";
import { useVehicleLocator, type VehicleLocation } from "./gtfs-rt/use-vehicle-locator.js";
import { useVehicleMonitoring } from "./gtfs-rt/use-vehicle-monitoring.js";
import { useVehicleRegistry } from "./gtfs-rt/use-vehicle-registry.js";
import { useVerificationFeed, type VerifiedVehicle } from "./gtfs-rt/use-verification-feed.js";
import { isDepotDestination, verifyVehicle } from "./gtfs-rt/verify-vehicle.js";
import { loadState, saveState } from "./state-cache.js";
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

// Ce que le producteur savait à son dernier arrêt : sans lui, un redémarrage se verrait dans le feed
// (cf. `loadState`). `undefined` quand il n'y a rien à relire, ou que ce qu'il y a est trop vieux.
const restored = loadState(STATE_CACHE_PATH, Math.floor(Date.now() / 1000));

const store = useRealtimeStore();
const registry = useVehicleRegistry(restored?.vehicles);
const movementTracker = useMovementTracker(restored?.movements);
const vehicleOccupancyStatuses = useVehicleOccupancyStatuses();

const verificationFeed = await useVerificationFeed(VERIFICATION_FEED_URL);

loadCache(ALERT_CACHE_PATH);
const vehicleMonitoring = await useVehicleMonitoring(VEHICLE_MONITORING_URL, VEHICLE_MONITORING_INTERVAL);
const staticGtfs = await useStaticGtfs(STATIC_GTFS_URL, GTFS_CHECK_INTERVAL);
// Le locator lit `staticGtfs.data` à chaque appel : il suit donc les rechargements du GTFS de
// lui-même, sans avoir à s'y réabonner.
const vehicleLocator = useVehicleLocator(staticGtfs, restored?.locations);
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

/** Les véhicules à émettre à cet instant : le registre écarte lui-même les relevés périmés. */
const publishedPositions = () => registry.publishable(Math.floor(Date.now() / 1000));

hono.get("/vehicle-positions", (c) => handleRequest(c, "protobuf", null, publishedPositions()));
hono.get("/vehicle-positions.json", (c) => handleRequest(c, "json", null, publishedPositions()));
hono.get("/trip-updates", (c) => handleRequest(c, "protobuf", store.tripUpdates, null));
hono.get("/trip-updates.json", (c) => handleRequest(c, "json", store.tripUpdates, null));
hono.get("/", (c) =>
	handleRequest(c, c.req.query("format") === "json" ? "json" : "protobuf", null, publishedPositions()),
);

serve({ fetch: hono.fetch, port: PORT });
console.log(`➔ Listening on :${PORT}`);

// ---

async function poll() {
	let feed: GtfsRealtime.transit_realtime.FeedMessage;

	try {
		const response = await fetch(VEHICLE_POSITIONS_URL);
		if (!response.ok || response.status === 204) {
			console.error(`✘ Vehicle positions fetch failed (HTTP ${response.status}).`);
			// Le registre n'est pas vidé : ses véhicules gardent leur dernier relevé et cessent d'être
			// émis d'eux-mêmes en vieillissant.
			return;
		}

		feed = GtfsRealtime.transit_realtime.FeedMessage.decode(Buffer.from(await response.arrayBuffer()));
	} catch (cause) {
		console.error("✘ Poll error:", cause);
		return;
	}

	const nowSeconds = Math.floor(Date.now() / 1000);
	const forgotten = registry.prune(nowSeconds);

	let published = 0;
	let refreshed = 0;
	let staleRecords = 0;
	let unprovenVehicles = 0;
	let frozenVehicles = 0;
	let untrackedLines = 0;
	let deadheads = 0;
	let unknownVehicles = 0;
	let unlocated = 0;

	/** Situe le véhicule sur la course indiquée, en comptant les échecs pour la ligne de synthèse. */
	const locateOn = (vehicleId: string, tripId: string, position: GtfsRealtime.transit_realtime.IPosition) => {
		const location = vehicleLocator.locate(vehicleId, tripId, position, nowSeconds);
		if (location === undefined) unlocated += 1;
		return location;
	};

	/**
	 * Situe le véhicule sur la course que le registre lui connaît. Rien à projeter s'il n'a jamais été
	 * publié, ou s'il l'a été sans course (haut-le-pied).
	 */
	const relocate = (vehicleId: string, position: GtfsRealtime.transit_realtime.IPosition) => {
		const tripId = registry.trip(vehicleId);
		return tripId === undefined ? undefined : locateOn(vehicleId, tripId, position);
	};

	for (const { vehicle } of feed.entity) {
		// « TCAR:Vehicle::6232:LOC » → « 6232 », le numéro de parc que publient aussi les deux flux
		// de vérification.
		const vehicleId = vehicle?.vehicle?.id?.split(":")[3];
		const position = vehicle?.position;
		if (!vehicleId || !position || !vehicle.trip?.tripId) continue;

		// Que la source cesse elle-même de réhorodater un véhicule est un aveu : elle l'a perdu.
		const sourceTimestamp = Number(vehicle.timestamp ?? 0);
		if (!sourceTimestamp || nowSeconds - sourceTimestamp > VEHICLE_STALENESS) {
			staleRecords += 1;
			continue;
		}

		// Ce qu'elle réhorodate n'en est pas fiable pour autant : seul le mouvement constaté prouve
		// qu'elle a encore le véhicule au bout du fil, et date sa position.
		const movement = movementTracker.observe(vehicleId, position, sourceTimestamp, nowSeconds);

		// Jamais vu bouger : on ne sait pas si ce véhicule roule ou dort depuis des heures. Il n'entre
		// dans le feed qu'au premier mouvement constaté, et non au relevé suivant sa découverte.
		if (movement.kind === "unproven") {
			unprovenVehicles += 1;
			continue;
		}

		// Immobile de longue date : la source parle encore de lui, mais ne le voit plus. L'entrée reste
		// telle quelle et sortira d'elle-même du feed, faute d'être rafraîchie.
		if (movement.kind === "frozen") {
			frozenVehicles += 1;
			continue;
		}

		const { position: movedPosition, timestamp } = movement;

		const occupancyStatus = vehicleOccupancyStatuses.get(vehicleId)?.status;
		const routeId = vehicle.trip.routeId ?? "";
		const lineId = routeId.split(":").at(-1) ?? "";

		// Ligne sans vrai temps réel : la source y rebadge l'horaire théorique, sa course ne vaut rien.
		// Le véhicule n'est jamais publié de ce fait — tout au plus voit-il sa position rafraîchie s'il
		// l'a déjà été depuis une ligne qui, elle, tient debout.
		if (!REALTIME_LINES.has(lineId)) {
			untrackedLines += 1;
			if (registry.refresh(vehicleId, movedPosition, timestamp, occupancyStatus, relocate(vehicleId, movedPosition)))
				refreshed += 1;
			else unknownVehicles += 1;
			continue;
		}

		const destinationName = freshDestination(vehicleId, nowSeconds);

		// Haut-le-pied : le véhicule rentre au dépôt. On le publie parce qu'il roule, mais sans course —
		// celle que le SAE continue de lui prêter ne dessert plus personne. La girouette porte alors le
		// seul renseignement utile, on la republie.
		if (isDepotDestination(destinationName)) {
			deadheads += 1;
			registry.publish(
				vehicleId,
				{
					vehicle: { id: `TCAR:${vehicleId}`, label: destinationName },
					position: movedPosition,
					timestamp,
					occupancyStatus,
				},
				timestamp,
			);
			continue;
		}

		const directionId = vehicle.trip.directionId ?? 0;
		const check = verifyVehicle(
			{ routeId, lineId, directionId },
			freshVerification(vehicleId, nowSeconds),
			destinationName,
		);

		// Ni le flux de vérification ni la girouette ne confirment la ligne annoncée : on ne relaie pas
		// la course, mais on continue de rafraîchir la position sur la dernière course connue, sinon le
		// véhicule se fige. Jamais publié, il n'a pas de course à conserver : on ne fait rien.
		if (!check.valid) {
			// La girouette est recopiée telle quelle : c'est la chaîne à reporter dans LINE_DESTINATIONS
			// pour que la ligne cesse d'être écartée.
			const verified = check.verified;
			console.warn(
				`\t✘ ${vehicleId.padEnd(4, " ")}  ${routeId.padEnd(10, " ")} ${directionId} — flux "${verified ? `${verified.routeId}/${verified.directionId}` : "?"}", girouette "${check.destinationName || "?"}".`,
			);

			if (registry.refresh(vehicleId, movedPosition, timestamp, occupancyStatus, relocate(vehicleId, movedPosition)))
				refreshed += 1;
			else unknownVehicles += 1;
			continue;
		}

		// La source annonce bien un quai et un rang, mais on ne les lit plus : ils sont recalculés ici
		// comme ils le sont pour un véhicule qu'on ne sait pas vérifier, d'après la seule position.
		const location = locateOn(vehicleId, vehicle.trip.tripId, movedPosition);

		published += 1;
		registry.publish(
			vehicleId,
			{
				trip: {
					tripId: vehicle.trip.tripId,
					routeId,
					directionId,
					scheduleRelationship: GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED,
				},
				vehicle: { id: `TCAR:${vehicleId}` },
				position: movedPosition,
				currentStopSequence: location?.currentStopSequence,
				stopId: location?.stopId,
				currentStatus: location?.currentStatus,
				timestamp,
				occupancyStatus,
			},
			timestamp,
		);

		console.log(
			`\t⛛ ${vehicleId.padEnd(4, " ")}  ${routeId.padEnd(10, " ")} ${directionId} (${check.by}${movement.kind === "still" ? ", still" : ""}) — ${describeLocation(location)}`,
		);
	}

	saveState(
		STATE_CACHE_PATH,
		{ movements: movementTracker.snapshot(), vehicles: registry.snapshot(), locations: vehicleLocator.snapshot() },
		nowSeconds,
	);

	console.log(
		`✓ ${registry.publishable(nowSeconds).size} positions (${published} verified, ${refreshed} position-only, ${deadheads} deadheading, ${staleRecords} stale records, ${unprovenVehicles} never moved, ${frozenVehicles} motionless, ${untrackedLines} on untracked lines, ${unknownVehicles} never published, ${unlocated} unlocated, ${forgotten} forgotten).`,
	);
}

/** Le prochain arrêt localisé, tel qu'il s'écrit au journal. */
function describeLocation(location: VehicleLocation | undefined): string {
	if (location === undefined) return "arrêt inconnu";

	const { VehicleStopStatus } = GtfsRealtime.transit_realtime.VehiclePosition;
	const status =
		location.currentStatus === VehicleStopStatus.STOPPED_AT
			? "à quai"
			: location.currentStatus === VehicleStopStatus.INCOMING_AT
				? "approche"
				: "vers";

	return `${status} ${staticGtfs.data.stopNames.get(location.stopId) ?? location.stopId} #${location.currentStopSequence}`;
}

/**
 * La girouette du véhicule selon l'instantané SAE, ou une chaîne vide lorsqu'il l'ignore ou que son
 * relevé est périmé. L'instantané n'est rechargé que toutes les cinq minutes : la fraîcheur se
 * contrôle à la lecture, pas au chargement.
 */
function freshDestination(vehicleId: string, nowSeconds: number): string {
	const monitored = vehicleMonitoring.journeys?.get(vehicleId);
	if (monitored === undefined || nowSeconds - monitored.recordedAt > VERIFICATION_STALENESS) return "";
	return monitored.destinationName;
}

/**
 * Le relevé du flux de vérification pour ce véhicule, ou `undefined` lorsqu'il l'ignore ou que son
 * relevé est périmé — les deux revenant au même, une source périmée ne confirmant rien.
 */
function freshVerification(vehicleId: string, nowSeconds: number): VerifiedVehicle | undefined {
	const verified = verificationFeed.verifiedVehicles.get(vehicleId);
	if (verified === undefined || nowSeconds - verified.recordedAt > VERIFICATION_STALENESS) return undefined;
	return verified;
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
