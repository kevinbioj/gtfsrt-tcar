import type GtfsRealtime from "gtfs-realtime-bindings";

export function useRealtimeStore() {
	return {
		tripUpdates: new Map<string, GtfsRealtime.transit_realtime.ITripUpdate>(),
		vehiclePositions: new Map<string, GtfsRealtime.transit_realtime.IVehiclePosition>(),
	};
}
