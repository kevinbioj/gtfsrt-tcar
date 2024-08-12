import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseCsv } from "./parse-csv.js";
import type { Trip } from "./types.js";

export async function loadTrips(path: string) {
  const contents = await readFile(join(path, "trips.txt"));
  const records = await parseCsv(contents);
  return records.reduce((map, record) => {
    map.set(record.trip_id, { id: record.trip_id, routeId: record.route_id, directionId: +record.direction_id });
    return map;
  }, new Map<string, Trip>());
}
