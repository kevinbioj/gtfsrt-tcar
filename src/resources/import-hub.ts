import { join } from "node:path";

import { downloadArchive } from "../utils/download-archive.js";
import { loadCsv } from "../utils/load-csv.js";

export async function importHub(href: string) {
	const { directory, version } = await downloadArchive(href);
	return {
		arretIdapToCode: await loadArretIdapToCode(directory),
		courseOperation: await loadCourseOperation(directory),
		courseVersion: await loadCourseVersion(directory),
		loadedAt: Date.now(),
		version,
	};
}

export type HubResource = Awaited<ReturnType<typeof importHub>>;

// ---

async function loadArretIdapToCode(directory: string) {
	const arretIdapToCode = new Map<number, string>();
	await loadCsv<"Code" | "IDAP">(
		join(directory, "ARRET.TXT"),
		(record) => {
			const idap = +record.IDAP;
			if (Number.isNaN(idap)) return;
			arretIdapToCode.set(idap, record.Code);
		},
		{
			encoding: "latin1",
			delimiter: ";",
		},
	);
	return arretIdapToCode;
}

async function loadCourseOperation(directory: string) {
	const courseOperation = new Map<string, string>();
	await loadCsv<"Numero de course" | "Code opération">(
		join(directory, "COURSE_OPERATION.TXT"),
		(record) => {
			courseOperation.set(record["Numero de course"], record["Code opération"]);
			courseOperation.set(record["Code opération"], record["Numero de course"]);
		},
		{
			encoding: "latin1",
			delimiter: ";",
		},
	);
	return courseOperation;
}

async function loadCourseVersion(directory: string) {
	const courseVersion = new Map<string, string>();
	await loadCsv<"Numero" | "CodeLigneVersion">(
		join(directory, "COURSE.TXT"),
		(record) => {
			courseVersion.set(record.Numero, record.CodeLigneVersion);
		},
		{
			encoding: "latin1",
			delimiter: ";",
		},
	);
	return courseVersion;
}
