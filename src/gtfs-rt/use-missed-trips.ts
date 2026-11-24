import type GtfsRealtime from "gtfs-realtime-bindings";
import { FINISHED_TRIP_RETENTION, MISSED_TRIP_GRACE } from "../config.js";
import { HOME_NETWORK, networkOf } from "../utils/network.js";
import { type ServiceDay, type ServiceRun, serviceDays, tripRun } from "./scheduled-trips.js";
import type { StaticGtfs, TripStop } from "./use-static-gtfs.js";

/**
 * Pourquoi une course passe pour non honorée :
 *
 *  - `absent` : le SAE ne la publie pas — elle y a été supprimée en amont, faute de matériel ;
 *  - `ghost` : il la publie, mais sans avance ni retard, et aucun véhicule ne la porte — personne ne
 *    l'a prise.
 */
export type MissedReason = "absent" | "ghost";

/** Une course constatée non honorée : sa journée de service, le motif, et quand on l'a constaté. */
export type MissedTrip = { tripId: string; date: string; reason: MissedReason; detectedAt: number };

/**
 * Version des preuves de circulation (`served`). Celles d'une autre version sont jetées à la relecture
 * (cf. `loadState`) : la version 1 tenait pour preuve la course que le SAE prête à un véhicule avant
 * toute correction — il se trompe de ligne, et la course passait pour roulée.
 */
export const SERVED_VERSION = 2;

/** Ce que le module retient d'un relevé à l'autre, et d'un démarrage à l'autre (cf. `loadState`). */
export type MissedTripsState = {
	/** La version des preuves de circulation (cf. {@link SERVED_VERSION}). */
	servedVersion: number;
	/** Les courses qui ont fait la preuve qu'elles roulent (cf. `tripRun`). */
	served: string[];
	/** Les courses constatées non honorées. */
	missed: [string, MissedTrip][];
	/** Les courses que l'exploitant a rétablies, et quand. */
	restored: [string, number][];
};

/**
 * Écart à l'horaire théorique au-delà duquel un horaire annoncé est du temps réel, en secondes. Le SAE
 * recopie à la seconde l'horaire d'une course que personne ne tient ; la marge couvre un GTFS qui
 * n'arrondit pas comme lui — celui de l'ancien GTFS-RT n'est pas le nôtre.
 */
const DEVIATION_TOLERANCE = 60;

/**
 * Silence au-delà duquel le flux des positions SAE ne dit plus rien des véhicules, en secondes. Il se
 * relève toutes les dix secondes : une minute sans relevé exploitable, c'est une panne, et une course
 * sans véhicule n'y prouverait rien.
 */
const VEHICLE_FEED_SILENCE = 60;

/**
 * Les courses qui ne circulent pas faute de matériel, et ce qu'on en publie.
 *
 * Deux façons de manquer. La course supprimée en amont dans le SAE n'y figure plus du tout ; celle qui
 * l'est au dernier moment y reste, réduite à son horaire théorique — ni avance ni retard —, et aucun
 * véhicule ne la porte dans le flux des positions. Le flux des trip updates n'en porte jamais : c'est
 * le flux des positions qui dit quel véhicule assure quelle course — une fois corrigé de ce qu'il dit
 * de faux (cf. `poll`) : il prête volontiers à un véhicule la course d'une autre ligne.
 *
 * Rien ne se conclut à la hâte :
 *
 *  - seule une course partie depuis {@link MISSED_TRIP_GRACE} est jugée — rien sur celles à venir ;
 *  - une course qui a montré, une fois partie, qu'elle roule — un véhicule l'a portée, ou elle
 *    annonce un écart à l'horaire — n'est plus jamais tenue pour non honorée de la journée : c'est
 *    ce qui laisse en paix celle qui s'est achevée normalement, fût-ce en avance ;
 *  - rien ne se constate quand l'un des deux flux SAE est en panne : toutes les courses y
 *    passeraient pour absentes.
 *
 * Un constat tient jusqu'au bout de la journée, même quand la course sort du flux SAE à son heure
 * d'arrivée ; il tombe dès que la course fait la preuve qu'elle roule — un véhicule rattaché en
 * retard —, ou que l'exploitant la rétablit. Le rétablissement ne vaut que pour cette course-là, ce
 * jour-là : tout s'oublie avec la journée de service (cf. `prune`).
 *
 * Un redémarrage ne change rien au compte des courses supprimées. `restored` rend au module ce qu'il
 * savait au dernier arrêt du producteur — constats, preuves de circulation, rétablissements —, et le
 * premier relevé juge toutes les courses en cours, y compris celles parties pendant l'arrêt : une
 * course que le SAE a cessé de publier ne se constate pas deux fois, et une course qui manque ne
 * passe pas entre les mailles parce que le producteur redémarrait.
 */
export function useMissedTrips(staticGtfs: { data: StaticGtfs }, restored?: MissedTripsState) {
	const served = new Set(restored?.served ?? []);
	const missed = new Map(restored?.missed ?? []);
	const restoredAt = new Map(restored?.restored ?? []);
	/** Le dernier relevé exploitable du flux des positions SAE, en secondes epoch. */
	let vehicleFeedAt: number | undefined;

	/**
	 * Oublie les journées révolues : tout ce qui date d'avant-hier, et les courses de la veille arrivées
	 * depuis plus de {@link FINISHED_TRIP_RETENTION} — elles ont quitté le feed.
	 */
	const prune = (nowSeconds: number) => {
		const gtfs = staticGtfs.data;
		const [yesterday, today] = serviceDays(gtfs, [-1, 0]) as [ServiceDay, ServiceDay];
		const keeps = (run: string) => {
			const { tripId, date } = splitRun(run);
			if (date === today.date) return true;
			if (date !== yesterday.date) return false;
			const arrival = gtfs.tripArrivals.get(tripId);
			return arrival !== undefined && yesterday.midnight + arrival + FINISHED_TRIP_RETENTION >= nowSeconds;
		};
		for (const run of served) if (!keeps(run)) served.delete(run);
		for (const run of missed.keys()) if (!keeps(run)) missed.delete(run);
		for (const run of restoredAt.keys()) if (!keeps(run)) restoredAt.delete(run);
	};

	/** La course est-elle partie, d'après l'horaire théorique ? */
	const hasDeparted = (tripId: string, midnight: number, nowSeconds: number) => {
		const departure = staticGtfs.data.tripDepartures.get(tripId);
		return departure !== undefined && midnight + departure <= nowSeconds;
	};

	const isMissedRun = (run: string) => missed.has(run) && !served.has(run);

	prune(Math.floor(Date.now() / 1000));

	return {
		/** L'état du module, tel qu'il sera réécrit sur disque. */
		snapshot(): MissedTripsState {
			return { servedVersion: SERVED_VERSION, served: [...served], missed: [...missed], restored: [...restoredAt] };
		},

		/** Le flux des positions SAE a répondu, avec des véhicules et un relevé frais. */
		vehicleFeedReceived(nowSeconds: number): void {
			vehicleFeedAt = nowSeconds;
		},

		/**
		 * Un véhicule est publié sur cette course, après correction de ce que la source en dit — exemplaire,
		 * ligne, mouvement. Une fois la course partie, c'est la preuve qu'elle roule ; avant, le véhicule
		 * peut encore la céder à une autre.
		 */
		observeVehicle(run: ServiceRun, days: readonly ServiceDay[], nowSeconds: number): void {
			const midnight = days.find(({ date }) => date === run.date)?.midnight;
			if (midnight === undefined || !hasDeparted(run.tripId, midnight, nowSeconds)) return;
			served.add(tripRun(run.tripId, run.date));
		},

		/**
		 * Constate, au relevé des trip updates, les courses qui ne circulent pas.
		 *
		 *  - `present` : les courses TCAR à vrai temps réel que publient les flux sources (cf. `tripRun`),
		 *    et si elles annoncent un écart à l'horaire (cf. {@link deviatesFromSchedule}) ;
		 *  - `tripFeedHealthy` : le flux des trip updates SAE a répondu ce tour-ci, frais et non vide ;
		 *  - `judged` : la course relève-t-elle de ce constat — ligne à vrai temps réel, course qu'aucune
		 *    modification n'annule déjà.
		 *
		 * Rend les courses nouvellement constatées, pour le journal.
		 */
		evaluate({
			present,
			tripFeedHealthy,
			judged,
			nowSeconds,
		}: {
			present: ReadonlyMap<string, boolean>;
			tripFeedHealthy: boolean;
			judged: (tripId: string, midnight: number) => boolean;
			nowSeconds: number;
		}): { detected: MissedTrip[]; paused: boolean } {
			prune(nowSeconds);
			const gtfs = staticGtfs.data;
			const days = serviceDays(gtfs, [-1, 0]);

			// Une course partie qui annonce un écart roule : la preuve vaut même passée son heure d'arrivée,
			// pour une course en retard qu'on aurait d'abord vue manquer.
			for (const [run, deviates] of present) {
				if (!deviates || served.has(run)) continue;
				const { tripId, date } = splitRun(run);
				const midnight = days.find((day) => day.date === date)?.midnight;
				if (midnight !== undefined && hasDeparted(tripId, midnight, nowSeconds)) served.add(run);
			}

			const paused =
				!tripFeedHealthy || vehicleFeedAt === undefined || nowSeconds - vehicleFeedAt > VEHICLE_FEED_SILENCE;
			if (paused) return { detected: [], paused };

			const detected: MissedTrip[] = [];
			for (const { date, midnight, services } of days) {
				for (const serviceId of services) {
					for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
						const departure = gtfs.tripDepartures.get(tripId);
						const arrival = gtfs.tripArrivals.get(tripId);
						if (departure === undefined || arrival === undefined) continue;
						if (midnight + departure + MISSED_TRIP_GRACE > nowSeconds || midnight + arrival < nowSeconds) continue;

						const run = tripRun(tripId, date);
						if (served.has(run) || missed.has(run)) continue;
						if (networkOf(tripId) !== HOME_NETWORK || !judged(tripId, midnight)) continue;

						// Publiée, elle l'est sans écart — sinon elle aurait fait la preuve qu'elle roule.
						const reason: MissedReason = present.has(run) ? "ghost" : "absent";
						const trip: MissedTrip = { tripId, date, reason, detectedAt: nowSeconds };
						missed.set(run, trip);
						detected.push(trip);
					}
				}
			}

			return { detected, paused };
		},

		/** La course est-elle à publier supprimée ? */
		isCancelled(tripId: string, date: string): boolean {
			const run = tripRun(tripId, date);
			return isMissedRun(run) && !restoredAt.has(run);
		},

		/**
		 * Rétablit la course — elle repart de ce que publie le GTFS-RT source —, ou la supprime à nouveau. `false`
		 * pour une course qui n'est pas, ou plus, constatée non honorée.
		 */
		setRestored(run: string, restored: boolean, nowSeconds: number): boolean {
			if (!isMissedRun(run)) return false;
			if (restored) restoredAt.set(run, restoredAt.get(run) ?? nowSeconds);
			else restoredAt.delete(run);
			return true;
		},

		/** Les courses non honorées de la journée, rétablies comprises. */
		list(): (MissedTrip & { run: string; restoredAt: number | null })[] {
			return [...missed]
				.filter(([run]) => !served.has(run))
				.map(([run, trip]) => ({ ...trip, run, restoredAt: restoredAt.get(run) ?? null }));
		},

		/**
		 * Combien de courses sont publiées supprimées dans la journée, combien le sont en ce moment — celles
		 * dont l'heure d'arrivée théorique n'est pas passée —, et combien ont été rétablies.
		 */
		counts(nowSeconds: number): { cancelled: number; ongoing: number; restored: number } {
			const days = serviceDays(staticGtfs.data, [-1, 0]);
			let cancelled = 0;
			let ongoing = 0;
			let restored = 0;
			for (const [run, { tripId, date }] of missed) {
				if (served.has(run)) continue;
				if (restoredAt.has(run)) {
					restored += 1;
					continue;
				}
				cancelled += 1;
				const midnight = days.find((day) => day.date === date)?.midnight;
				const arrival = staticGtfs.data.tripArrivals.get(tripId);
				if (midnight !== undefined && arrival !== undefined && midnight + arrival >= nowSeconds) ongoing += 1;
			}
			return { cancelled, ongoing, restored };
		},
	};
}

export type MissedTrips = ReturnType<typeof useMissedTrips>;

/**
 * Le trip update annonce-t-il un écart à l'horaire théorique ? Un retard ou une avance, ou à défaut
 * un horaire qui s'en écarte de plus de {@link DEVIATION_TOLERANCE} : c'est du temps réel, quelqu'un
 * tient la course. Une course que personne ne tient ressort au contraire sans retard, à l'horaire
 * théorique exact.
 *
 * L'arrivée se compare à l'arrivée théorique — le GTFS n'en porte pas d'autre —, et le départ
 * seulement à défaut d'arrivée : au premier arrêt, les deux se confondent.
 */
export function deviatesFromSchedule(
	tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate,
	schedule: readonly TripStop[] | undefined,
	midnight: number,
): boolean {
	const scheduled = new Map(schedule?.map(({ stopSequence, arrival }) => [stopSequence, midnight + arrival]));

	for (const { stopSequence, arrival, departure } of tripUpdate.stopTimeUpdate ?? []) {
		if (Number(arrival?.delay ?? 0) !== 0 || Number(departure?.delay ?? 0) !== 0) return true;

		const expected = typeof stopSequence === "number" ? scheduled.get(stopSequence) : undefined;
		const announced = Number(arrival?.time ?? 0) || Number(departure?.time ?? 0);
		if (expected !== undefined && announced !== 0 && Math.abs(announced - expected) > DEVIATION_TOLERANCE) return true;
	}

	return false;
}

/** La course et la journée de service d'une clé `tripRun` — l'identifiant de course porte lui-même des « : ». */
export function splitRun(run: string): { tripId: string; date: string } {
	const separator = run.lastIndexOf(":");
	return { tripId: run.slice(0, separator), date: run.slice(separator + 1) };
}
