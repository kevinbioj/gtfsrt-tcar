import { serve } from "@hono/node-server";
import GtfsRealtime from "gtfs-realtime-bindings";
import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { loadCache } from "./ai/analyze-alert.js";
import {
	ADMIN_PASSWORD,
	ADMIN_USERNAME,
	ALERT_CACHE_PATH,
	ALERTS_POLL_INTERVAL,
	DETOURS_DB_PATH,
	GTFS_CHECK_INTERVAL,
	POLL_INTERVAL,
	PORT,
	PREFERRED_POSITION_STALENESS,
	REALTIME_LINES,
	ROAD_GRAPH_PATH,
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
import { adminRoutes } from "./detours/admin.js";
import { buildDetourEntities } from "./detours/build-entities.js";
import { useModificationIndex } from "./detours/modifications.js";
import { useDetourStore } from "./detours/store.js";
import { handleRequest } from "./gtfs-rt/handle-request.js";
import { resolveServiceRun, scheduledTripUpdates, serviceDays, tripRun } from "./gtfs-rt/scheduled-trips.js";
import { type Movement, useMovementTracker } from "./gtfs-rt/use-movement-tracker.js";
import { useRealtimeStore } from "./gtfs-rt/use-realtime-store.js";
import {
	applySkippedStops,
	declareNoRealtime,
	hasSkippedStops,
	useServiceAlerts,
} from "./gtfs-rt/use-service-alerts.js";
import { departureEpoch, useStaticGtfs } from "./gtfs-rt/use-static-gtfs.js";
import { useVehicleLocator, type VehicleLocation } from "./gtfs-rt/use-vehicle-locator.js";
import { useVehicleMonitoring } from "./gtfs-rt/use-vehicle-monitoring.js";
import { awaitsDeparture, useVehicleRegistry } from "./gtfs-rt/use-vehicle-registry.js";
import { useVerificationFeed, type VerifiedVehicle } from "./gtfs-rt/use-verification-feed.js";
import { isDepotDestination, verifyVehicle } from "./gtfs-rt/verify-vehicle.js";
import { useRoadGraph } from "./routing/road-graph.js";
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
// (cf. `loadState`). Il est relu quel que soit son âge — un véhicule peut reparaître des heures après
// son dernier relevé, et c'est sa dernière position connue qui dit alors d'où il repart.
// `undefined` quand il n'y a rien à relire.
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
const detourStore = useDetourStore(DETOURS_DB_PATH);
// Les modifications se rebâtissent à chaque relevé d'infos trafic, et après chaque saisie : c'est
// ce qui crée celles que l'IA propose sans ambiguïté, et qui tient à jour les arrêts à sauter. Le
// premier relevé attend le réseau, l'index est donc là avant lui — celles saisies à la main ne
// dépendent pas du flux, et n'ont pas à disparaître de l'interface tant qu'il n'a pas répondu.
const serviceAlerts = useServiceAlerts(SERVICE_ALERTS_URL, ALERTS_POLL_INTERVAL, staticGtfs, () =>
	modificationIndex.reindex(),
);
const modificationIndex = useModificationIndex(detourStore, staticGtfs, () => serviceAlerts.alerts);
// Sa présence est constatée ici, ses octets ne seront lus qu'au premier accrochage.
const roadGraph = useRoadGraph(ROAD_GRAPH_PATH);

const hono = new Hono();

const limiter = rateLimiter({
	windowMs: 5_000,
	limit: 5,
	keyGenerator: (c) => `${c.req.header("CF-Connecting-IP")}_${c.req.method}_${c.req.path}`,
	handler: (c) => c.json({ code: 429, message: "Too many requests, please try again later." }, 429),
});

// Le limiteur ne couvre que les endpoints publics. L'interface d'administration est protégée par son
// authentification, et son usage normal — la page, deux appels d'API, un enregistrement — dépasserait
// d'emblée un quota taillé pour des consommateurs de feed. Sa clé est de surcroît l'en-tête que pose
// Cloudflare : en accès direct, tous les clients la partageraient.
hono.use(async (c, next) => (c.req.path.startsWith("/admin") ? next() : limiter(c, next)));

if (ADMIN_USERNAME && ADMIN_PASSWORD) {
	hono.route(
		"/admin",
		adminRoutes({
			username: ADMIN_USERNAME,
			password: ADMIN_PASSWORD,
			store: detourStore,
			gtfs: staticGtfs,
			serviceAlerts,
			modificationIndex,
			roadGraph,
			rebuild: () => rebuildDetourEntities(),
		}),
	);
	console.log("➔ Detour administration mounted on /admin.");
} else {
	console.warn("✘ ADMIN_USERNAME/ADMIN_PASSWORD missing — detour administration not mounted.");
}

/** Les véhicules à émettre à cet instant : le registre écarte lui-même les relevés périmés. */
const publishedPositions = () => registry.publishable(Math.floor(Date.now() / 1000));

hono.get("/vehicle-positions", (c) => handleRequest(c, "protobuf", null, publishedPositions()));
hono.get("/vehicle-positions.json", (c) => handleRequest(c, "json", null, publishedPositions()));
hono.get("/trip-updates", (c) => handleRequest(c, "protobuf", store.tripUpdates, null, store.detourEntities));
hono.get("/trip-updates.json", (c) => handleRequest(c, "json", store.tripUpdates, null, store.detourEntities));
hono.get("/", (c) =>
	handleRequest(
		c,
		c.req.query("format") === "json" ? "json" : "protobuf",
		store.tripUpdates,
		publishedPositions(),
		store.detourEntities,
	),
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

	// Journées de service auxquelles une course annoncée peut appartenir, calculées une fois pour tout
	// le relevé : le calendrier ne change pas d'un véhicule à l'autre.
	const candidateDays = serviceDays(staticGtfs.data, [-1, 0, 1]);

	let published = 0;
	let preferredPositions = 0;
	let unresolvedTrips = 0;
	let refreshed = 0;
	let staleRecords = 0;
	let unprovenVehicles = 0;
	let frozenVehicles = 0;
	let awaitedVehicles = 0;
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

		// D'où vient la position qu'on publiera. Le flux SAE sort par moments des coordonnées
		// aberrantes ; l'ancien GTFS-RT, lui, reste juste. On le préfère donc chaque fois qu'il a
		// quelque chose d'assez frais à dire, et le SAE n'est plus qu'un repli. Tout ce qui suit ne
		// connaît que ce relevé-là — position, date, péremption, mouvement.
		const preferred = verificationFeed.verifiedVehicles.get(vehicleId);
		const reading =
			preferred !== undefined && nowSeconds - preferred.recordedAt <= PREFERRED_POSITION_STALENESS
				? ({ source: "astuce", position: preferred.position, timestamp: preferred.recordedAt } as const)
				: ({ source: "cityway", position, timestamp: Number(vehicle.timestamp ?? 0) } as const);

		if (reading.source === "astuce") preferredPositions += 1;

		// Qu'une source cesse elle-même de réhorodater un véhicule est un aveu : elle l'a perdu. Le
		// contrôle porte sur le relevé retenu — un véhicule que le SAE a lâché mais qu'Astuce voit frais
		// reste donc publié, et c'est bien ce qu'on veut.
		if (!reading.timestamp || nowSeconds - reading.timestamp > VEHICLE_STALENESS) {
			staleRecords += 1;
			continue;
		}

		// La course que la source annonce n'est pas toujours celle qui circule : le GTFS décrit une même
		// course une fois par service, et le SAE se trompe d'exemplaire — il sort le samedi un vendredi.
		// On rattache donc l'annonce à la version du jour. Le flux ne parle que de courses en train de
		// rouler : l'instant du relevé suffit à les situer.
		const run = resolveServiceRun(staticGtfs.data, candidateDays, vehicle.trip.tripId, nowSeconds);
		if (run === undefined) unresolvedTrips += 1;
		const tripId = run?.tripId ?? vehicle.trip.tripId;

		// Le départ de la course. Tant qu'il n'est pas passé, l'immobilité du véhicule s'explique
		// d'elle-même — il patiente à son terminus — et aucune des durées ne court contre lui : ni le gel
		// du suivi, ni la sortie du feed, ni l'oubli (cf. `awaitsDeparture`).
		const departsAt = departureOf(tripId, nowSeconds);
		const awaitingDeparture = awaitsDeparture(departsAt, nowSeconds);

		// Ce qu'une source réhorodate n'est pas fiable pour autant : seul le mouvement constaté prouve
		// qu'elle a encore le véhicule au bout du fil, et date sa position. L'empreinte se tient par flux,
		// deux sources ne donnant jamais tout à fait la même coordonnée.
		const movement = movementTracker.observe(
			vehicleId,
			reading.source,
			reading.position,
			reading.timestamp,
			nowSeconds,
			awaitingDeparture,
		);

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
		if (movement.kind === "still" && awaitingDeparture) awaitedVehicles += 1;

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
				// Sans course, il n'attend aucun départ : rentré au dépôt, son immobilité est définitive.
				undefined,
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
		const location = locateOn(vehicleId, tripId, movedPosition);

		published += 1;
		registry.publish(
			vehicleId,
			{
				trip: {
					tripId,
					routeId,
					directionId,
					startDate: run?.date,
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
			departsAt,
		);

		console.log(
			`\t⛛ ${vehicleId.padEnd(4, " ")}  ${routeId.padEnd(10, " ")} ${directionId} (${check.by}${describeStillness(movement, departsAt, nowSeconds)}) — ${describeLocation(location)}`,
		);
	}

	saveState(
		STATE_CACHE_PATH,
		{ movements: movementTracker.snapshot(), vehicles: registry.snapshot(), locations: vehicleLocator.snapshot() },
		nowSeconds,
	);

	console.log(
		`✓ ${registry.publishable(nowSeconds).size} positions (${published} verified, ${refreshed} position-only, ${deadheads} deadheading, ${preferredPositions} located by the legacy feed, ${unresolvedTrips} unresolved trips, ${staleRecords} stale records, ${unprovenVehicles} never moved, ${frozenVehicles} motionless, ${awaitedVehicles} awaiting departure, ${untrackedLines} on untracked lines, ${unknownVehicles} never published, ${unlocated} unlocated, ${forgotten} forgotten).`,
	);
}

/**
 * L'immobilité du véhicule, telle qu'elle s'écrit au journal : rien lorsqu'il vient de bouger, et le
 * temps qu'il lui reste à patienter lorsqu'une course l'attend encore.
 */
function describeStillness(movement: Movement, departsAt: number | undefined, nowSeconds: number): string {
	if (movement.kind !== "still") return "";
	if (departsAt === undefined || !awaitsDeparture(departsAt, nowSeconds)) return ", still";

	const minutes = Math.round((departsAt - nowSeconds) / 60);
	return minutes > 0 ? `, departs in ${minutes} min` : ", departing";
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
 * Le départ de la course, en secondes epoch : celui qu'annoncent les trip updates dès qu'ils en
 * parlent, faute de quoi celui qu'inscrit le GTFS statique. Un véhicule mis à quai en avance sur une
 * course déjà retardée n'est pas en retard pour autant, et le seul horaire théorique le sortirait du
 * feed avant même son départ.
 *
 * `undefined` pour une course qu'aucune des deux sources ne connaît — le GTFS statique peut dater
 * d'avant le service en cours.
 */
function departureOf(tripId: string, nowSeconds: number): number | undefined {
	const realtime = store.tripDepartures.get(tripId);
	if (realtime !== undefined) return realtime;

	const scheduled = staticGtfs.data.tripDepartures.get(tripId);
	return scheduled === undefined ? undefined : departureEpoch(scheduled, nowSeconds);
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

		const nowSeconds = Math.floor(Date.now() / 1000);

		store.tripUpdates.clear();
		store.tripDepartures.clear();

		// Journées de service auxquelles une course annoncée peut appartenir. Le lendemain en fait partie :
		// une course de « 00:20 » annoncée dix minutes plus tôt relève déjà de la journée suivante, quand
		// le GTFS ne l'écrit pas « 24:20 » sur celle qui s'achève.
		const candidateDays = serviceDays(staticGtfs.data, [-1, 0, 1]);

		// Les courses dont le flux source parle : celles-là n'ont pas à être reconstruites depuis
		// l'horaire théorique, ce qu'il en annonce l'emportant toujours.
		const covered = new Set<string>();
		let realtimeTrips = 0;
		let scheduleOnly = 0;
		let unresolvedTrips = 0;

		for (const entity of feed.entity) {
			if (!entity.tripUpdate) continue;

			const tripId = entity.tripUpdate.trip?.tripId;

			// La course qui circule vraiment, et la journée de service dont elle relève — deux choses que le
			// flux dit mal. Il ne nomme pas la journée, quand les journées de service se chevauchent : après
			// minuit, celle d'hier est encore ouverte. Et il se trompe d'exemplaire de la course, le GTFS en
			// décrivant un par service qui l'assure. On tranche les deux sur l'horaire annoncé, et à défaut
			// d'horaire sur l'instant du relevé : le flux ne parle que de courses en train de rouler ou sur
			// le point de partir.
			//
			// Le `start_date` que le producteur déclare parfois lui-même n'est plus retenu : une source qui
			// se trompe de version de la course se trompe de journée par la même occasion.
			const run = tripId
				? resolveServiceRun(staticGtfs.data, candidateDays, tripId, announcedTime(entity.tripUpdate) ?? nowSeconds)
				: undefined;

			if (tripId && run === undefined) {
				unresolvedTrips += 1;
				console.warn(`\t✘ ${tripId} — aucune version rattachable à une journée de service, relayée telle quelle.`);
			}

			// Faute de rattachement, la course est relayée comme la source l'annonce : l'horaire théorique
			// peut être en retard sur le service en cours, et l'écarter ferait disparaître du feed une course
			// qui roule bel et bien.
			const resolvedTripId = run?.tripId ?? tripId;
			const startDate = run?.date;

			if (entity.tripUpdate?.trip) {
				entity.tripUpdate.trip.scheduleRelationship =
					GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED;
				entity.tripUpdate.trip.tripId = resolvedTripId;
				entity.tripUpdate.trip.startDate = startDate;
				// Le flux ne renseigne jamais le sens : sans le GTFS statique, toute course passerait pour un
				// aller et les suppressions déclarées au retour ne s'appliqueraient à rien.
				entity.tripUpdate.trip.directionId =
					(resolvedTripId ? staticGtfs.data.trips.get(resolvedTripId)?.directionId : undefined) ?? 0;
			}

			entity.tripUpdate.stopTimeUpdate?.forEach((stopTimeUpdate) => {
				stopTimeUpdate.scheduleRelationship =
					GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED;
			});

			const tripRouteId = entity.tripUpdate.trip?.routeId ?? "";
			const tripLineId = tripRouteId.split(":").at(-1) ?? "";

			// Le départ annoncé pour la course, avant que les suppressions d'arrêt ne remanient l'horaire.
			// Les lignes sans vrai temps réel n'y ont pas droit : la source y rebadge l'horaire théorique,
			// son « départ » n'en dirait pas plus que le GTFS statique.
			if (resolvedTripId && REALTIME_LINES.has(tripLineId)) {
				const departure = announcedDeparture(entity.tripUpdate, resolvedTripId);
				if (departure !== undefined) store.tripDepartures.set(resolvedTripId, departure);
			}

			applySkippedStops(entity.tripUpdate, tripRouteId, modificationIndex.skipIndex, staticGtfs.data);

			if (resolvedTripId && startDate) covered.add(tripRun(resolvedTripId, startDate));

			// Ligne sans vrai temps réel : on ne relaie pas ses horaires, seulement l'existence de la course
			// et ses suppressions d'arrêt — la forme même que prennent les courses reconstruites.
			if (REALTIME_LINES.has(tripLineId)) {
				realtimeTrips += 1;
			} else {
				// Ni temps réel ni suppression : la course se réduirait au NO_DATA de son premier arrêt, qui
				// n'apprend rien de plus que l'horaire théorique.
				if (!hasSkippedStops(entity.tripUpdate)) continue;
				declareNoRealtime(
					entity.tripUpdate,
					resolvedTripId ? staticGtfs.data.tripStopSequences.get(resolvedTripId) : undefined,
				);
				scheduleOnly += 1;
			}

			// L'identifiant est celui de la course retenue, et non celui qu'annonce l'entité : la course a pu
			// être réappariée, et il désignerait alors l'exemplaire d'une autre journée. C'est le moule des
			// courses reconstruites depuis le théorique, pour que les deux ne puissent pas se dédoubler.
			//
			// Il porte la journée de service pour la même raison qu'elles : deux occurrences d'une même
			// course peuvent circuler ensemble — celle d'hier qui s'achève après minuit et celle
			// d'aujourd'hui qui part à « 25:10 » — et sous un identifiant nu, la seconde écraserait la
			// première.
			const tripEntityId = (resolvedTripId ?? entity.id).split(":").at(-1) ?? entity.id;
			store.tripUpdates.set(`ET:TCAR:${tripEntityId}${startDate ? `:${startDate}` : ""}`, entity.tripUpdate);
		}

		// Toutes les autres courses de la journée de service qui n'ont pas fini de circuler : le flux
		// source les ignore, l'horaire théorique les connaît (cf. `scheduledTripUpdates`).
		const scheduled = scheduledTripUpdates(staticGtfs.data, modificationIndex.skipIndex, covered, nowSeconds);
		for (const [id, tripUpdate] of scheduled) store.tripUpdates.set(id, tripUpdate);

		console.log(
			`✓ ${store.tripUpdates.size} trip updates (${realtimeTrips} realtime, ${scheduleOnly} source without realtime, ${scheduled.size} rebuilt from schedule, ${store.tripDepartures.size} departures announced, ${unresolvedTrips} unresolved trips).`,
		);

		rebuildDetourEntities();
	} catch (cause) {
		console.error("✘ Trip updates poll error:", cause);
	}
}

/**
 * Réassemble les entités des déviations déclarées. Appelée à chaque relevé — les journées de service
 * tournent, les courses finissent de circuler — et juste après un enregistrement depuis l'interface,
 * pour que ce qu'on vient de saisir soit dans le feed suivant et non vingt secondes plus tard.
 *
 * Elle ne touche à rien d'autre que `store.detourEntities` : une déclaration incomplète ou une shape
 * qui ne se recoud pas se traduit par des entités en moins, jamais par un feed en échec.
 */
function rebuildDetourEntities() {
	try {
		store.detourEntities = buildDetourEntities(
			staticGtfs.data,
			modificationIndex.modifications,
			detourStore.provisionalStops,
			Math.floor(Date.now() / 1000),
		);
	} catch (cause) {
		console.error("✘ Failed to build detour entities:", cause);
	}
}

/**
 * Le premier horaire que le flux annonce pour cette course, en secondes epoch, ou `undefined` s'il
 * n'en annonce aucun. N'importe lequel de ses arrêts fait l'affaire pour la rapporter à sa journée de
 * service : tous tombent dans le même créneau de quelques dizaines de minutes, et les journées
 * candidates sont distantes de vingt-quatre heures.
 */
function announcedTime(tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate): number | undefined {
	for (const stopTimeUpdate of tripUpdate.stopTimeUpdate ?? []) {
		const time = Number(stopTimeUpdate.departure?.time ?? stopTimeUpdate.arrival?.time ?? 0);
		if (time > 0) return time;
	}

	return undefined;
}

/**
 * Le départ annoncé pour cette course, en secondes epoch, ou `undefined` lorsque le flux n'en parle
 * pas : une course déjà partie perd ses premiers arrêts, et l'horaire du suivant ne dit pas quand
 * elle a démarré. C'est sans conséquence — un véhicule en course n'attend plus rien.
 */
function announcedDeparture(tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate, tripId: string): number | undefined {
	const first = tripUpdate.stopTimeUpdate?.[0];
	if (first === undefined) return undefined;

	// Le rang du premier arrêt selon l'horaire théorique, et à défaut celui que le GTFS impose.
	const origin = staticGtfs.data.tripStopSequences.get(tripId)?.[0]?.stopSequence ?? 1;
	if (first.stopSequence !== origin) return undefined;

	const departure = Number(first.departure?.time ?? first.arrival?.time ?? 0);
	return departure === 0 ? undefined : departure;
}

setInterval(poll, POLL_INTERVAL);
setInterval(pollTripUpdates, POLL_INTERVAL);
await poll();
await pollTripUpdates();
