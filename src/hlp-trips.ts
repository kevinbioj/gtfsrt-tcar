import type { Service, Trip } from "./gtfs/types.js";

const service: Service = {
  id: "HLP_SERVICE",
  workingDays: [true, true, true, true, true, true, true],
  startDate: Temporal.PlainDate.from("20230901"),
  endDate: Temporal.PlainDate.from("20340831"),
  excludedDays: [],
  includedDays: [],
};

export const hlpTrips: Record<string, Trip> = {
  "Dépôt 2 Rivières": {
    id: "HLP_2RIV",
    routeId: "HLP",
    directionId: 0,
    headsign: "Dépôt 2 Rivières",
    stopTimes: [],
    service,
  },
  "ROUEN DEPOT": {
    id: "HLP_RDEP",
    routeId: "HLP",
    directionId: 0,
    headsign: "ROUEN DEPOT",
    stopTimes: [],
    service,
  },
  "Dépôt TNI Carnot": {
    id: "HLP_TNIC",
    routeId: "HLP",
    directionId: 0,
    headsign: "Dépôt TNI Carnot",
    stopTimes: [],
    service,
  },
  "Dépôt St-Julien": {
    id: "HLP_STJU",
    routeId: "HLP",
    directionId: 0,
    headsign: "Dépôt St-Julien",
    stopTimes: [],
    service,
  },
};
