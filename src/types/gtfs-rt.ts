export type Feed = {
  header: Header;
  entity: (TripUpdateEntity | VehiclePositionEntity)[];
};

export type Header = {
  gtfsRealtimeVersion: string;
  incrementality: Incrementality;
  timestamp: number;
};

export type TripUpdateEntity = {
  id: string;
  tripUpdate: TripUpdate;
};

export type TripUpdate = {
  trip: TripDescriptor;
  vehicle: VehicleDescriptor;
  stopTimeUpdate: StopTimeUpdate[];
  timestamp: number;
};

export type VehiclePositionEntity = {
  id: string;
  vehicle: VehiclePosition;
};

export type VehiclePosition = {
  trip?: TripDescriptor;
  vehicle: VehicleDescriptor;
  position: Position;
  currentStopSequence?: number;
  stopId?: string;
  currentStatus?: VehicleStopStatus;
  timestamp: number;
};

// ---

export type Incrementality = "FULL_DATASET";

export type Position = {
  latitude: number;
  longitude: number;
  bearing: number;
};

export type StopTimeEvent = {
  delay: number;
  time: number;
};

export type StopTimeScheduleRelationship = "SCHEDULED" | "SKIPPED" | "NO_DATA";

export type StopTimeUpdate = {
  arrival?: StopTimeEvent;
  departure?: StopTimeEvent;
  stopSequence?: number;
  stopId: string;
  scheduleRelationship: StopTimeScheduleRelationship;
};

export type TripScheduleRelationship = "SCHEDULED" | "CANCELED";

export type TripDescriptor = {
  tripId: string;
  routeId: string;
  directionId: number;
  scheduleRelationship: TripScheduleRelationship;
};

export type VehicleDescriptor = {
  id: string;
  label: string;
};

export type VehicleStopStatus = "INCOMING_AT" | "STOPPED_AT" | "IN_TRANSIT_TO";
