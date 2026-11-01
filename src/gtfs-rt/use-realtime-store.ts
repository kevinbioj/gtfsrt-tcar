import type GtfsRealtime from "gtfs-realtime-bindings";

import type { DetourItineraries } from "../detours/itinerary.js";

/**
 * Le store des trip updates, reconstruit intégralement à chaque relevé. Les positions véhicule ont
 * leur propre registre, persistant celui-là (cf. `useVehicleRegistry`).
 */
export function useRealtimeStore() {
	return {
		tripUpdates: new Map<string, GtfsRealtime.transit_realtime.ITripUpdate>(),
		/**
		 * Les entités des déviations déclarées, reconstruites au même rythme que les trip updates : elles
		 * dépendent des journées de service et du GTFS statique, pas de l'instant de la requête. Rangées
		 * par réseau (cf. `buildDetourEntities`).
		 */
		detourEntities: new Map<string, GtfsRealtime.transit_realtime.IFeedEntity[]>(),
		/**
		 * L'itinéraire de chaque course que ces entités déclarent modifiée, jour par jour : c'est sur lui
		 * que se situent les véhicules déviés (cf. `useVehicleLocator`).
		 */
		detourItineraries: new Map() as DetourItineraries,
		/**
		 * tripId → départ annoncé pour cette course, en secondes epoch. Il n'y figure que lorsque le
		 * flux couvre bien le premier arrêt de la course : passé le départ, il n'en parle plus, et le
		 * deuxième arrêt ne dirait pas quand elle est partie.
		 */
		tripDepartures: new Map<string, number>(),
	};
}
