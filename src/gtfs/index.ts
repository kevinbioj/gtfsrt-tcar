import { loadServices, loadTrips } from "./components.js";
import { disposeResource, downloadResource } from "./resource.js";

export async function loadResource(href: string) {
  const path = await downloadResource(href);
  const services = await loadServices(path);
  const trips = await loadTrips(path, services);
  await disposeResource(path);
  return trips;
}
