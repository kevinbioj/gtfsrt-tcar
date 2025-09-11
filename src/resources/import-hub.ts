import { join } from "node:path";

import { downloadArchive } from "../utils/download-archive.js";
import { loadCsv } from "../utils/load-csv.js";

export async function importHub(href: string) {
	const { directory, version } = await downloadArchive(href);
	return {
		courseOperation: await loadCourseOperation(directory),
		loadedAt: Date.now(),
		version,
	};
}

// ---

async function loadCourseOperation(directory: string) {
	const courseOperation = new Map<number, string>();
	await loadCsv<"Numero de course" | "Code opération">(
		join(directory, "COURSE_OPERATION.TXT"),
		(record) => {
			courseOperation.set(
				+record["Numero de course"],
				record["Code opération"],
			);
		},
		{
			encoding: "latin1",
			delimiter: ";",
		},
	);
	return courseOperation;
}
