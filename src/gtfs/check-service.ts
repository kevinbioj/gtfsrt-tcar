import type { Service } from "./types.js";

export function checkService(service: Service, date: Temporal.PlainDate) {
  if (service.includedDays.some((id) => id.equals(date))) return true;
  if (service.excludedDays.some((ed) => ed.equals(date))) return false;
  if (Temporal.PlainDate.compare(date, service.startDate) < 0 || Temporal.PlainDate.compare(date, service.endDate) > 0)
    return false;
  return service.workingDays[date.dayOfWeek - 1];
}
