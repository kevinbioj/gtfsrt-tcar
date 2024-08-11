import type { GtfsRt, TripUpdateEntity, VehiclePositionEntity } from "./types.js";

export function wrapEntities<T extends TripUpdateEntity | VehiclePositionEntity>(data?: T[]): GtfsRt<T> {
  return {
    header: {
      timestamp: Temporal.Now.instant().epochSeconds,
      incrementality: "FULL_DATASET",
      gtfsRealtimeVersion: "2.0",
    },
    entity: data ?? [],
  };
}
