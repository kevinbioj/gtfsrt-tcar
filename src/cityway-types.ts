export type MonitoredVehicle = {
  OperatorRef: string;
  OperatorId: number;
  VehicleRef: string;
  VJourneyId: number;
  VJourneyMode: string;
  LineName: string;
  LineNumber: string;
  LineId: number;
  Direction: number;
  Latitude: number;
  Longitude: number;
  VehicleAtStop: boolean;
  Bearing: number;
  Destination: string;
  RecordedAtTime: string;
  RecordedDisplayTime: string;
  PushedDisplayTime: string;
  IsDisrupted: boolean;
  StopTimeList: MonitoredStopTime[];
};

export type MonitoredStopTime = {
  IsMonitored: boolean;
  IsCancelled: boolean;
  IsDisrupted: boolean;
  StopPointId: number;
  StopPointName: string;
  StopPointOrder: number;
  AimedTime: string;
  AimedDisplayTime: string;
  ExpectedTime: string;
  ExpectedDisplayTime: string;
  WaitingTime: number;
};
