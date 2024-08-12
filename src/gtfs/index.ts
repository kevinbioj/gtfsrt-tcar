import { loadTrips } from "./components.js";
import { disposeResource, downloadResource } from "./resource.js";

export async function loadGtfsResource(href: string) {
  const path = await downloadResource(href);
  const trips = await loadTrips(path);
  await disposeResource(path);
  return trips;
}
