import { decodeGtfsRt } from "../utils/gtfsrt-coding.js";

export async function fetchOldGtfsrt(href: string) {
  const response = await fetch(href, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Failed to fetch old GTFS-RT: ${response.status}.`);

  const buffer = Buffer.from(await response.arrayBuffer());
  return decodeGtfsRt(buffer);
}
