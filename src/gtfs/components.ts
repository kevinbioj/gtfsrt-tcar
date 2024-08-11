import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseCsv } from "./parse-csv.js";
import type { Service, Trip } from "./types.js";

const modulusTime = (time: string) => {
  const [hours, minutes, seconds] = time.split(":") as [string, string, string];
  return `${(+hours % 24).toString().padStart(2, "0")}:${minutes}:${seconds}`;
};

export async function loadServices(path: string) {
  const services = await readFile(join(path, "calendar.txt"))
    .then(parseCsv)
    .catch(() => []);
  const serviceDates = await readFile(join(path, "calendar_dates.txt"))
    .then(parseCsv)
    .catch(() => []);
  const serviceSet = services.reduce((services, service) => {
    services.set(service.service_id, {
      id: service.service_id,
      workingDays: [
        !!+service.monday,
        !!+service.tuesday,
        !!+service.wednesday,
        !!+service.thursday,
        !!+service.friday,
        !!+service.saturday,
        !!+service.sunday,
      ],
      startDate: Temporal.PlainDate.from(service.start_date),
      endDate: Temporal.PlainDate.from(service.end_date),
      excludedDays: [],
      includedDays: [],
    });
    return services;
  }, new Map<string, Service>());
  serviceDates.forEach((serviceDate) => {
    if (!serviceSet.has(serviceDate.service_id)) {
      serviceSet.set(serviceDate.service_id, {
        id: serviceDate.service_id,
        workingDays: [false, false, false, false, false, false, false],
        startDate: Temporal.PlainDate.from("20000101"),
        endDate: Temporal.PlainDate.from("20991231"),
        excludedDays: [],
        includedDays: [],
      });
    }
    const calendar = serviceSet.get(serviceDate.service_id)!;
    switch (+serviceDate.exception_type) {
      case 1:
        calendar.includedDays.push(Temporal.PlainDate.from(serviceDate.date));
        break;
      case 2:
        calendar.excludedDays.push(Temporal.PlainDate.from(serviceDate.date));
        break;
      default:
    }
  });
  return serviceSet;
}

export async function loadTrips(path: string, services: Map<string, Service>): Promise<Trip[]> {
  const tripRecords = await readFile(join(path, "trips.txt")).then(parseCsv);
  const stopTimes = Map.groupBy(
    await readFile(join(path, "stop_times.txt")).then(parseCsv),
    (stopTime) => stopTime.trip_id
  );

  return tripRecords.map((tripRecord) => ({
    id: tripRecord.trip_id,
    service: services.get(tripRecord.service_id)!,
    routeId: tripRecord.route_id,
    directionId: +tripRecord.direction_id,
    headsign: tripRecord.trip_headsign,
    stopTimes: (stopTimes.get(tripRecord.trip_id) ?? [])
      .map((stopTime) => ({
        time: Temporal.PlainTime.from(modulusTime(stopTime.departure_time)),
        stopSequence: +stopTime.stop_sequence,
        stopId: stopTime.stop_id,
      }))
      .sort((a, b) => a.stopSequence - b.stopSequence),
  }));
}
