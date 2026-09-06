import GtfsRealtime from "gtfs-realtime-bindings";

import { applySkippedStops, declareNoRealtime, hasSkippedStops, type SkipIndex } from "./use-service-alerts.js";
import { SERVICE_ADDED, SERVICE_REMOVED, type StaticGtfs } from "./use-static-gtfs.js";

const TIME_ZONE = "Europe/Paris";

const SCHEDULED = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED;

/**
 * Journées de service susceptibles de porter une course qui n'a pas fini de circuler. La veille en
 * fait partie : une course partie à « 25:10:00 » appartient à la journée d'hier et roule ce matin.
 */
const CANDIDATE_DAYS = [-1, 0];

/**
 * Les trip updates des courses dont le flux source ne parle pas, reconstruits depuis le seul horaire
 * théorique. Le flux du SAEIV ne porte que ses propres lignes — les scolaires, les Filo'r et
 * quelques lignes régulières lui échappent — et une suppression d'arrêt qui les touche n'aurait
 * sinon aucune course où s'annoncer.
 *
 * Est retenue toute course de la journée de service en cours qui n'a pas fini de circuler : le reste
 * de la journée est publié d'un bloc — une suppression d'arrêt de ce soir se lit dès ce matin — et
 * ce qui s'est déjà achevé est écarté, n'ayant plus rien à annoncer. `covered` porte les courses que
 * le flux source a déjà servies : ce qu'il annonce l'emporte toujours sur ce qu'on déduit du
 * théorique.
 *
 * Chaque course en ressort réduite à ce qu'on en sait de sûr (cf. {@link declareNoRealtime}) : son
 * premier arrêt en NO_DATA, puis ses arrêts supprimés — la forme même que prennent les courses du
 * flux source sur les lignes sans vrai temps réel. Encore faut-il qu'elle en supprime un : une
 * course reconstruite n'a par définition aucun temps réel, et sans suppression il ne resterait d'elle
 * que ce NO_DATA, qui n'apprend rien de plus que l'horaire théorique.
 */
export function scheduledTripUpdates(
	gtfs: StaticGtfs,
	skipIndex: SkipIndex,
	covered: ReadonlySet<string>,
	nowSeconds: number,
): Map<string, GtfsRealtime.transit_realtime.ITripUpdate> {
	const tripUpdates = new Map<string, GtfsRealtime.transit_realtime.ITripUpdate>();

	// Bornes calculées par `startOfDay` et non par tranches de 86 400 s : les jours de changement
	// d'heure ne durent pas vingt-quatre heures, et toutes leurs courses seraient décalées d'une heure.
	const today = Temporal.Now.zonedDateTimeISO(TIME_ZONE).startOfDay();

	for (const days of CANDIDATE_DAYS) {
		const day = today.add({ days });
		const midnight = Math.floor(day.epochMilliseconds / 1000);
		const date = day.toPlainDate().toString().replaceAll("-", "");

		// La journée de service n'est déclarée que lorsqu'elle n'est pas celle du jour : à défaut de
		// `start_date`, un consommateur rapporte la course au jour courant, et c'est précisément ce qu'il
		// faut pour les courses d'aujourd'hui — le flux source relaie les siennes sans la déclarer non
		// plus, et la course garde ainsi la même identité en passant du théorique au temps réel. Seule
		// celle d'hier qui roule encore après minuit a besoin qu'on la nomme.
		const startDate = days === 0 ? undefined : date;

		for (const serviceId of activeServices(gtfs, day.dayOfWeek, date)) {
			for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
				if (covered.has(tripId)) continue;

				// La dernière arrivée, et non le départ : une course commencée il y a vingt minutes dessert
				// encore des arrêts. Seule celle qui est arrivée à son terminus est passée pour de bon.
				const arrival = gtfs.tripArrivals.get(tripId);
				if (arrival === undefined || midnight + arrival < nowSeconds) continue;

				const tripUpdate = buildTripUpdate(gtfs, skipIndex, tripId, startDate, nowSeconds);
				if (tripUpdate === undefined) continue;

				// L'identifiant porte la journée de service dans les mêmes cas que le descripteur, et pour la
				// même raison : deux occurrences d'une même course peuvent circuler ensemble — celle d'hier
				// qui s'achève après minuit et celle d'aujourd'hui qui part à « 25:10 » — et sous un
				// identifiant nu, la seconde écraserait la première. Nu, il est celui-là même que le relais du
				// flux source donne à la course, qui garde donc son identité en passant au temps réel.
				const suffix = startDate === undefined ? "" : `:${startDate}`;
				tripUpdates.set(`ET:TCAR:${tripId.split(":").at(-1)}${suffix}`, tripUpdate);
			}
		}
	}

	return tripUpdates;
}

/**
 * Services actifs une journée donnée : le calendrier hebdomadaire d'abord, que les exceptions datées
 * viennent ensuite amender. Le GTFS du réseau ne publie pas `calendar.txt` et énumère chaque journée
 * de chaque service en ajout : tout y vient alors des seules exceptions.
 */
function activeServices(gtfs: StaticGtfs, dayOfWeek: number, date: string): Set<string> {
	const services = new Set<string>();

	for (const [serviceId, calendar] of gtfs.calendars) {
		// `dayOfWeek` numérote la semaine à partir de 1 pour le lundi, comme les colonnes du GTFS.
		if (calendar.weekdays[dayOfWeek - 1] !== true) continue;
		if (calendar.startDate && date < calendar.startDate) continue;
		if (calendar.endDate && date > calendar.endDate) continue;
		services.add(serviceId);
	}

	for (const [serviceId, exceptions] of gtfs.calendarExceptions) {
		const exceptionType = exceptions.get(date);
		if (exceptionType === SERVICE_ADDED) services.add(serviceId);
		else if (exceptionType === SERVICE_REMOVED) services.delete(serviceId);
	}

	return services;
}

/**
 * Le trip update d'une course absente du flux source. Il part de l'horaire théorique tout entier
 * pour que les suppressions d'arrêt s'y appliquent comme sur une course relayée — avec le garde-fou
 * des terminus effectifs et les exceptions de desserte — avant d'être réduit à sa forme finale.
 *
 * `undefined` pour une course que le GTFS ne décrit plus, ou qui ne supprime aucun arrêt : n'ayant
 * aucun temps réel non plus, elle n'a rien à annoncer.
 */
function buildTripUpdate(
	gtfs: StaticGtfs,
	skipIndex: SkipIndex,
	tripId: string,
	startDate: string | undefined,
	nowSeconds: number,
): GtfsRealtime.transit_realtime.ITripUpdate | undefined {
	const meta = gtfs.trips.get(tripId);
	const schedule = gtfs.tripStopSequences.get(tripId);
	if (meta === undefined || schedule === undefined) return undefined;

	const tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate = {
		trip: {
			tripId,
			routeId: meta.routeId,
			directionId: meta.directionId,
			startDate,
			scheduleRelationship: GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED,
		},
		stopTimeUpdate: schedule.map(({ stopSequence, stopId }) => ({
			stopSequence,
			stopId,
			scheduleRelationship: SCHEDULED,
		})),
		// Le relevé date de ce poll-ci : les suppressions sont réévaluées à chaque tour, et une course
		// sans horodatage passe pour périmée chez qui écarte ce qu'il ne peut pas dater. Le flux source
		// horodate les siennes, qu'on relaie telles quelles.
		timestamp: nowSeconds,
	};

	applySkippedStops(tripUpdate, meta.routeId, skipIndex, gtfs);
	if (!hasSkippedStops(tripUpdate)) return undefined;

	declareNoRealtime(tripUpdate, schedule);

	return tripUpdate;
}
