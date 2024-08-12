import { loadCourseOperation } from "./components.js";
import { disposeResource, downloadResource } from "./resource.js";

export async function loadHubResource(href: string) {
  const path = await downloadResource(href);
  const courseOperations = await loadCourseOperation(path);
  await disposeResource(path);
  return courseOperations;
}
