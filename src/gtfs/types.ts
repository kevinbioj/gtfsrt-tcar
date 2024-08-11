export type Service = {
  id: string;
  workingDays: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  startDate: Temporal.PlainDate;
  endDate: Temporal.PlainDate;
  excludedDays: Temporal.PlainDate[];
  includedDays: Temporal.PlainDate[];
};

export type StopTime = {
  time: Temporal.PlainTime;
  stopId: string;
  stopSequence: number;
};

export type Trip = {
  id: string;
  service: Service;
  routeId: string;
  directionId: number;
  headsign: string | null;
  stopTimes: StopTime[];
};
