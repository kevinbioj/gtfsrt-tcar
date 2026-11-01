import GtfsRealtime from "gtfs-realtime-bindings";

import {
	INCOMING_AT_RADIUS,
	MAX_SHAPE_OFFSET,
	MAX_VEHICLE_SPEED,
	MIN_PROJECTION_REACH,
	PROJECTION_BACKTRACK,
	STOPPED_AT_RADIUS,
} from "../config.js";
import { type DetourItineraries, detouredRun, type ItineraryStop } from "../detours/itinerary.js";
import { projectOnShape, type ShapePoint } from "../utils/geometry.js";
import type { StaticGtfs } from "./use-static-gtfs.js";

const { VehicleStopStatus } = GtfsRealtime.transit_realtime.VehiclePosition;

/** Où en est un véhicule sur sa course, tel que le feed l'annoncera. */
export type VehicleLocation = {
	/** `undefined` sur un arrêt de substitution : il n'a pas de rang dans la course d'origine. */
	currentStopSequence: number | undefined;
	stopId: string;
	currentStatus: GtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus;
};

/** Ce que le locator retient d'un véhicule d'un relevé à l'autre. */
export type LocatedVehicle = {
	/** Course sur laquelle la localisation a été faite : elle ne vaut sur aucune autre. */
	tripId: string;
	/** Abscisse curviligne du dernier projeté retenu, en kilomètres. */
	distance: number;
	/**
	 * Le trajet sur lequel `distance` se mesure : le `shape_id` de la course, ou l'itinéraire dévié
	 * qu'elle suivait (cf. `DetourItinerary.key`). Absent des états d'avant les déviations, où c'était
	 * toujours la shape de la course.
	 */
	shapeKey?: string;
	location: VehicleLocation;
	/** Instant de ce relevé, en secondes epoch. */
	at: number;
};

/**
 * Situe un véhicule sur sa course à partir de sa seule position, en la projetant sur la shape du
 * GTFS statique.
 *
 * Le flux source annonce bien un `currentStopSequence` et un `stopId`, mais on ne s'en sert plus :
 * il les tait ou les fausse à sa guise, et surtout, un véhicule qu'on ne sait pas vérifier ne voit
 * plus que sa position rafraîchie (cf. `useVehicleRegistry`) — son prochain arrêt resterait figé sur
 * celui du dernier relevé vérifié, parfois pendant des dizaines de minutes. Le calculer nous-mêmes,
 * toujours, met les deux cas sur le même pied.
 *
 * Le tracé du GTFS porte l'abscisse curviligne de chacun de ses points, et l'horaire théorique celle
 * de chacun de ses arrêts : situer le véhicule revient donc à projeter sa position sur la polyligne,
 * puis à chercher le premier arrêt qu'il n'a pas encore dépassé.
 *
 * Rien n'y périme : c'est le registre qui décide de ce qui reste diffusé.
 *
 * Une course que le feed déclare déviée (cf. `buildDetourEntities`) se suit sur son itinéraire
 * dévié : le trajet recousu, et ses arrêts modifications appliquées — les arrêts supprimés n'y sont
 * plus, les arrêts de substitution y sont. Sans quoi le véhicule, sorti de l'itinéraire d'origine,
 * resterait accroché à l'arrêt d'avant la déviation jusqu'à le rejoindre.
 *
 * `restored` reprend les projetés du dernier arrêt du producteur (cf. `loadState`) : sans eux, la
 * fenêtre de plausibilité repartirait grande ouverte et une shape qui repasse au même endroit
 * pourrait situer le véhicule à l'autre bout de sa course.
 */
export function useVehicleLocator(
	staticGtfs: { data: StaticGtfs },
	itineraries: () => DetourItineraries,
	restored: Iterable<readonly [string, LocatedVehicle]> = [],
) {
	const located = new Map<string, LocatedVehicle>(restored);

	return {
		/** L'état du locator, tel qu'il sera réécrit sur disque. */
		snapshot(): [string, LocatedVehicle][] {
			return [...located];
		},

		/**
		 * Le prochain arrêt du véhicule sur `tripId`, ou `undefined` quand on ne sait pas le situer et
		 * qu'on n'a rien de plus ancien à proposer. `position` est celle qui sera publiée, c'est-à-dire
		 * celle du dernier mouvement constaté (cf. `useMovementTracker`).
		 */
		locate(
			vehicleId: string,
			tripId: string,
			position: GtfsRealtime.transit_realtime.IPosition,
			nowSeconds: number,
		): VehicleLocation | undefined {
			const previous = located.get(vehicleId);
			// Le dernier calcul ne vaut que sur la course où il a été fait : sur une autre, il désignerait
			// un arrêt d'un tout autre itinéraire.
			const remembered = previous?.tripId === tripId ? previous.location : undefined;

			const { latitude, longitude } = position;
			if (typeof latitude !== "number" || typeof longitude !== "number") return remembered;

			const route = routeOf(staticGtfs.data, itineraries(), tripId, nowSeconds);
			// Course absente du GTFS statique, ou tracé introuvable : rien sur quoi projeter.
			if (route === undefined || route.stops.length === 0) return remembered;
			const { shape, stops, shapeKey } = route;

			const projection = projectOnShape(
				shape,
				{ latitude, longitude },
				plausibleWindow(previous, tripId, shapeKey, nowSeconds),
			);

			// Loin de son tracé : le véhicule est dévié, son relevé est aberrant, ou la course qu'on lui
			// prête n'est pas la sienne. Le prochain arrêt qu'on en tirerait ne voudrait rien dire.
			if (projection === undefined || projection.offset > MAX_SHAPE_OFFSET) return remembered;

			const location = nextStop(stops, projection.distance);
			if (location === undefined) return remembered;

			located.set(vehicleId, { tripId, distance: projection.distance, shapeKey, location, at: nowSeconds });
			return location;
		},
	};
}

// ---

/**
 * Le trajet que suit la course en ce moment, et ses arrêts : son itinéraire dévié si le feed la
 * déclare modifiée, sinon sa shape et son horaire théoriques.
 */
function routeOf(
	gtfs: StaticGtfs,
	itineraries: DetourItineraries,
	tripId: string,
	nowSeconds: number,
): { shape: ShapePoint[]; stops: readonly ItineraryStop[]; shapeKey: string } | undefined {
	const detoured = detouredRun(itineraries, tripId, nowSeconds);
	if (detoured !== undefined) {
		const { shape, stops, key } = detoured.itinerary;
		return { shape, stops, shapeKey: key };
	}

	const meta = gtfs.trips.get(tripId);
	const shape = meta === undefined ? undefined : gtfs.shapes.get(meta.shapeId);
	const stops = gtfs.tripStopSequences.get(tripId);
	if (meta === undefined || shape === undefined || stops === undefined) return undefined;
	return { shape, stops, shapeKey: meta.shapeId };
}

/**
 * La plage d'abscisses où le véhicule peut raisonnablement se trouver, compte tenu d'où on l'a laissé
 * et du temps écoulé depuis. Elle départage les projetés d'une shape qui repasse au même endroit, que
 * la seule position laisse également plausibles.
 *
 * `undefined` sans point de départ — premier relevé, course changée, ou déviation qui commence ou
 * s'achève en cours de route : la dernière abscisse se mesurait sur un autre trajet. Toute la shape
 * est alors ouverte, faute de mieux.
 */
function plausibleWindow(
	previous: LocatedVehicle | undefined,
	tripId: string,
	shapeKey: string,
	nowSeconds: number,
): { from: number; to: number } | undefined {
	if (previous === undefined || previous.tripId !== tripId) return undefined;
	// Un état d'avant les déviations ne disait pas son trajet : c'était celui de la course.
	if ((previous.shapeKey ?? shapeKey) !== shapeKey) return undefined;

	const elapsed = Math.max(0, nowSeconds - previous.at);
	const reach = Math.max(MIN_PROJECTION_REACH, elapsed * MAX_VEHICLE_SPEED);

	return { from: previous.distance - PROJECTION_BACKTRACK, to: previous.distance + reach };
}

/**
 * Le premier arrêt de la course que le véhicule n'a pas encore dépassé, et ce qu'il y fait.
 *
 * Il reste « à quai » jusqu'à {@link STOPPED_AT_RADIUS} au-delà du point d'arrêt : la dérive GPS l'y
 * pousse volontiers de quelques mètres, et sans cette marge il annoncerait l'arrêt suivant portes
 * encore ouvertes. Passé le dernier arrêt, il y reste accroché — c'est son terminus, il n'ira pas
 * plus loin.
 */
function nextStop(
	stops: readonly Pick<ItineraryStop, "stopId" | "distance" | "stopSequence">[],
	distance: number,
): VehicleLocation | undefined {
	const stop = stops.find(({ distance: at }) => at >= distance - STOPPED_AT_RADIUS) ?? stops.at(-1);
	if (stop === undefined || !Number.isFinite(stop.distance)) return undefined;

	const remaining = stop.distance - distance;

	return {
		currentStopSequence: stop.stopSequence ?? undefined,
		stopId: stop.stopId,
		currentStatus:
			remaining <= STOPPED_AT_RADIUS
				? VehicleStopStatus.STOPPED_AT
				: remaining <= INCOMING_AT_RADIUS
					? VehicleStopStatus.INCOMING_AT
					: VehicleStopStatus.IN_TRANSIT_TO,
	};
}
