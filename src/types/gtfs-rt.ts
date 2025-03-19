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
  occupancyStatus?: OccupancyStatus;
  timestamp: number;
};

// ---

export type Incrementality = "FULL_DATASET";

export type OccupancyStatus = 'EMPTY' | 'MANY_SEATS_AVAILABLE' | 'FEW_SEATS_AVAILABLE' | 'STANDING_ROOM_ONLY' | 'CRUSHED_STANDING_ROOM_ONLY' | 'FULL' | 'NOT_ACCEPTING_PASSENGERS' | 'NO_DATA_AVAILABLE' | 'NOT_BOARDABLE';

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

export type TripScheduleRelationship = 'UNSCHEDULED' | "SCHEDULED" | "CANCELED";

export type TripDescriptor = {
  tripId: string;
  routeId: string;
  directionId: number;
  scheduleRelationship: TripScheduleRelationship;
};

export type VehicleDescriptor = {
  id: string;
  label?: string;
};

export type VehicleStopStatus = "INCOMING_AT" | "STOPPED_AT" | "IN_TRANSIT_TO";
