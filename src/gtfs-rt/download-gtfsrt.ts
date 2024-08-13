import { decodePayload } from "./encode-payload.js";
import type { TripUpdateEntity, VehiclePositionEntity } from "./types.js";

export async function downloadGtfsrt<T extends VehiclePositionEntity | TripUpdateEntity>(href: string) {
  const response = await fetch(href, { signal: AbortSignal.timeout(30_000) });
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return decodePayload<T>(buffer).entity ?? [];
}
