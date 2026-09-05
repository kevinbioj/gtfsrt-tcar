import type GtfsRealtime from "gtfs-realtime-bindings";

/**
 * Le store des trip updates, reconstruit intégralement à chaque relevé. Les positions véhicule ont
 * leur propre registre, persistant celui-là (cf. `useVehicleRegistry`).
 */
export function useRealtimeStore() {
	return {
		tripUpdates: new Map<string, GtfsRealtime.transit_realtime.ITripUpdate>(),
	};
}
