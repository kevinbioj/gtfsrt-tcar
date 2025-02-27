import type { OccupancyStatus } from "../types/gtfs-rt.js";

const url = Buffer.from("aHR0cHM6Ly90Y2FyLmZsb3dseS5yZS9Qb3J0YWwvTWFwRGV2aWNlcy5hc3B4", "base64").toString("utf-8");

const levels: Record<string, OccupancyStatus> = {
  "1cc88a": "MANY_SEATS_AVAILABLE",
  f6c23e: "FEW_SEATS_AVAILABLE",
  e74a3b: "FULL",
};

let cached: string[] | undefined;
let lastFetchAt: number | undefined;

export async function getVehicleOccupancyStatus(vehicleNumber: string) {
  if (typeof lastFetchAt === "undefined" || Date.now() - lastFetchAt > 120_000) {
    cached = await fetch(url)
      .then((response) => response.text())
      .then((document) => {
        const startBoundary = document.indexOf('<script type="text/javascript">vehicles.');
        const endBoundary = document.indexOf("positions.addTo(myMap);</script>");
        return document.slice(startBoundary, endBoundary).split(/\r?\n/);
      })
      .catch((cause) => {
        const error = new Error('Failed to fetch vehicle occupancies', { cause });
        console.error(error);
        return undefined;
      });
    if (typeof cached !== "undefined") lastFetchAt = Date.now();
  }

  if (typeof cached === "undefined") return;

  const vehicleLine = cached?.find((line) => line.includes(`( ${vehicleNumber} )`));
  if (typeof vehicleLine === "undefined") return;

  const id = vehicleLine.slice(vehicleLine.indexOf("('") + 2, vehicleLine.indexOf("')"));

  const loadLine = cached?.find((line) => line.includes(`${id}_load`));
  if (typeof loadLine === "undefined") return;

  const [, backgroundColor] = /background-color:#([a-z0-9]{6});/.exec(loadLine) ?? [];
  if (typeof backgroundColor === "undefined") return;

  return backgroundColor ? levels[backgroundColor] : undefined;
}
