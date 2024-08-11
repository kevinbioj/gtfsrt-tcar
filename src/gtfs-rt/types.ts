//- GTFS Real-Time

export enum StopTimeScheduleRelationship {
  SCHEDULED,
  SKIPPED,
  NO_DATA,
}

export type StopTimeEvent = {
  delay: number;
  time: number;
};

export type VehicleDescriptor = {
  id: string;
  label: string;
};

export type TripUpdateEntity = {
  id: string;
  tripUpdate: {
    stopTimeUpdate: Array<{
      arrival?: StopTimeEvent;
      departure?: StopTimeEvent;
      stopId: string;
      stopSequence: number;
      scheduleRelationship?: StopTimeScheduleRelationship;
    }>;
    timestamp: string;
    trip: {
      tripId: string;
      routeId: string;
      directionId: number;
      scheduleRelationship: "SCHEDULED" | "CANCELED";
    };
    vehicle: VehicleDescriptor;
  };
};

export type VehiclePositionEntity = {
  id: string;
  vehicle: {
    currentStatus?: "STOPPED_AT" | "IN_TRANSIT_TO";
    currentStopSequence?: number;
    position: {
      latitude: number;
      longitude: number;
      bearing: number;
    };
    stopId?: string;
    timestamp: number;
    trip: {
      tripId: string;
      routeId: string;
      directionId: number;
      scheduleRelationship: "SCHEDULED";
    };
    vehicle: VehicleDescriptor;
  };
};

export type GtfsRt<T extends TripUpdateEntity | VehiclePositionEntity> = {
  header: {
    timestamp: number;
    incrementality: "FULL_DATASET";
    gtfsRealtimeVersion: string;
  };
  entity: T[];
};
