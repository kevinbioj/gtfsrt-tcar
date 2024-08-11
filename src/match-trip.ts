import type { MonitoredVehicle } from "./cityway-types.js";
import { checkService } from "./gtfs/check-service.js";
import { matchRoute } from "./gtfs/match-route.js";
import type { Trip } from "./gtfs/types.js";

export function matchTrip(trips: Trip[], vehicle: MonitoredVehicle) {
  const date = Temporal.Now.zonedDateTimeISO("Europe/Paris").subtract({ hours: 4, minutes: 30 }).toPlainDate();

  const routeId = matchRoute(vehicle.LineNumber);
  const possibleTrips = trips.filter(
    (trip) => trip.routeId === routeId && trip.directionId === vehicle.Direction - 1 && checkService(trip.service, date)
  );

  const [monitoredStopTime] = vehicle.StopTimeList;
  return possibleTrips.find((trip) => {
    const stopTime = trip.stopTimes.find(
      (stopTime) =>
        stopTime.stopId === monitoredStopTime.StopPointId.toString() &&
        stopTime.time.equals(monitoredStopTime.AimedDisplayTime)
    );
    return stopTime;
  });
}
