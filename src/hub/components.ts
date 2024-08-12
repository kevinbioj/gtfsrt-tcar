import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadCourseOperation(path: string) {
  const contents = (await readFile(join(path, "COURSE_OPERATION.TXT"))).toString();
  const records = contents.split("\r\n").slice(0, -1);
  return records.reduce((map, record) => {
    const [course, operation] = record.split(";");
    map.set(+course, operation);
    return map;
  }, new Map<number, string>());
}
