import type GtfsRealtime from "gtfs-realtime-bindings";

/**
 * Le store des trip updates, reconstruit intégralement à chaque relevé. Les positions véhicule ont
 * leur propre registre, persistant celui-là (cf. `useVehicleRegistry`).
 */
export function useRealtimeStore() {
	return {
		tripUpdates: new Map<string, GtfsRealtime.transit_realtime.ITripUpdate>(),
		/**
		 * tripId → départ annoncé pour cette course, en secondes epoch. Il n'y figure que lorsque le
		 * flux couvre bien le premier arrêt de la course : passé le départ, il n'en parle plus, et le
		 * deuxième arrêt ne dirait pas quand elle est partie.
		 */
		tripDepartures: new Map<string, number>(),
	};
}
