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

/** Une journée de service : sa date au format GTFS, son minuit, et les services qui y circulent. */
export type ServiceDay = { date: string; midnight: number; services: Set<string> };

/**
 * Les journées de service voisines d'aujourd'hui, aux décalages demandés.
 *
 * Bornes calculées par `startOfDay` et non par tranches de 86 400 s : les jours de changement d'heure
 * ne durent pas vingt-quatre heures, et toutes leurs courses seraient décalées d'une heure.
 */
export function serviceDays(gtfs: StaticGtfs, offsets: readonly number[]): ServiceDay[] {
	const today = Temporal.Now.zonedDateTimeISO(TIME_ZONE).startOfDay();

	return offsets.map((offset) => {
		const day = today.add({ days: offset });
		const date = day.toPlainDate().toString().replaceAll("-", "");
		return {
			date,
			midnight: Math.floor(day.epochMilliseconds / 1000),
			services: activeServices(gtfs, day.dayOfWeek, date),
		};
	});
}

/**
 * La journée de service dont relève une course que le flux source annonce sans la nommer, ou
 * `undefined` pour une course que le GTFS ne décrit plus — elle n'a alors aucun horaire à quoi la
 * rapporter.
 *
 * Le GTFS écrit l'horaire d'une course en secondes depuis le minuit de sa journée de service, jamais
 * en instants : posé sur deux journées différentes, le même horaire donne deux créneaux distants de
 * vingt-quatre heures. Il suffit donc de regarder lequel encadre `reference` — l'instant que le flux
 * annonce pour la course. Le retard d'un véhicule se compte en minutes, l'écart entre deux journées
 * candidates en heures : aucune confusion possible, y compris pour une course écrite « 25:10 » que le
 * GTFS range la veille du soir où elle roule.
 *
 * Ne sont mises en balance que les journées où le service de la course circule réellement : le
 * calendrier écarte à lui seul la plupart des ambiguïtés, l'horaire tranche le reste.
 */
export function resolveServiceDate(
	gtfs: StaticGtfs,
	days: readonly ServiceDay[],
	tripId: string,
	reference: number,
): string | undefined {
	const serviceId = gtfs.trips.get(tripId)?.serviceId;
	const departure = gtfs.tripDepartures.get(tripId);
	const arrival = gtfs.tripArrivals.get(tripId);
	if (serviceId === undefined || departure === undefined || arrival === undefined) return undefined;

	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;

	for (const { date, midnight, services } of days) {
		if (!services.has(serviceId)) continue;

		// Distance de `reference` au créneau de la course ce jour-là : nulle pendant qu'elle roule, et
		// c'est de combien elle le manque sinon.
		const distance = Math.max(0, midnight + departure - reference, reference - (midnight + arrival));
		if (distance < bestDistance) {
			bestDistance = distance;
			best = date;
		}
	}

	return best;
}

/** La clé sous laquelle une course est dite servie par le flux source (cf. `covered`). */
export function tripRun(tripId: string, date: string): string {
	return `${tripId}:${date}`;
}

/**
 * Les trip updates des courses dont le flux source ne parle pas, reconstruits depuis le seul horaire
 * théorique. Le flux du SAEIV ne porte que ses propres lignes — les scolaires, les Filo'r et
 * quelques lignes régulières lui échappent — et une suppression d'arrêt qui les touche n'aurait
 * sinon aucune course où s'annoncer.
 *
 * Est retenue toute course de la journée de service en cours qui n'a pas fini de circuler : le reste
 * de la journée est publié d'un bloc — une suppression d'arrêt de ce soir se lit dès ce matin — et
 * ce qui s'est déjà achevé est écarté, n'ayant plus rien à annoncer. `covered` porte les courses que
 * le flux source a déjà servies, journée de service comprise (cf. {@link tripRun}) : ce qu'il annonce
 * l'emporte toujours sur ce qu'on déduit du théorique, mais seulement pour la journée qu'il sert —
 * celle d'hier qui roule encore après minuit n'est pas couverte par son homonyme d'aujourd'hui.
 *
 * Chaque course déclare la journée de service dont elle relève. Sans elle, le consommateur doit la
 * deviner, et à minuit passé la journée d'hier est encore ouverte — une course reconstruite pour ce
 * soir passerait alors pour avoir roulé la veille au soir, tout le reste de la journée étant publié
 * d'un bloc dès sa première seconde.
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

	for (const { date, midnight, services } of serviceDays(gtfs, CANDIDATE_DAYS)) {
		for (const serviceId of services) {
			for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
				if (covered.has(tripRun(tripId, date))) continue;

				// La dernière arrivée, et non le départ : une course commencée il y a vingt minutes dessert
				// encore des arrêts. Seule celle qui est arrivée à son terminus est passée pour de bon.
				const arrival = gtfs.tripArrivals.get(tripId);
				if (arrival === undefined || midnight + arrival < nowSeconds) continue;

				const tripUpdate = buildTripUpdate(gtfs, skipIndex, tripId, date, nowSeconds);
				if (tripUpdate === undefined) continue;

				// L'identifiant porte la journée de service comme le descripteur, et pour la même raison :
				// deux occurrences d'une même course peuvent circuler ensemble — celle d'hier qui s'achève
				// après minuit et celle d'aujourd'hui qui part à « 25:10 » — et sous un identifiant nu, la
				// seconde écraserait la première.
				tripUpdates.set(`ET:TCAR:${tripId.split(":").at(-1)}:${date}`, tripUpdate);
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
	startDate: string,
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
