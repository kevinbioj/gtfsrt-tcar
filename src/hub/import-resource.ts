import { join } from "node:path";

import { parseCsv } from "../utils/parse-csv.js";

export async function importResource(directory: string) {
	const courseOperation = await importCourseOperation(directory);
	const idapCode = await importIdapCode(directory);
	const comCode = await importComCode(directory);
	return { courseOperation, idapCode, comCode };
}

export type HubResource = Awaited<ReturnType<typeof importResource>>;

// --- importCourseOperation

type CourseOperationRecord = {
	"Numero de course": string;
	"Code opération": string;
};

async function importCourseOperation(directory: string) {
	const courseOperation = new Map<number, string>();

	const courseOperationPath = join(directory, "COURSE_OPERATION.TXT");

	await parseCsv<CourseOperationRecord>(
		courseOperationPath,
		(courseOperationRecord) => {
			courseOperation.set(
				+courseOperationRecord["Numero de course"],
				`TCAR:${courseOperationRecord["Code opération"]}`,
			);
		},
		{ delimiter: ";", encoding: "latin1" },
	);

	return courseOperation;
}

// --- importIdapCode

type ArretRecord = { Code: string; IDAP: string };

async function importIdapCode(directory: string) {
	const idapCode = new Map<number, string>();

	const arretPath = join(directory, "ARRET.TXT");
	await parseCsv<ArretRecord>(
		arretPath,
		(arretRecord) => {
			if (arretRecord.IDAP === "") {
				return;
			}

			idapCode.set(+arretRecord.IDAP, `TCAR:${arretRecord.Code}`);
		},
		{ delimiter: ";", encoding: "latin1" },
	);

	return idapCode;
}

// --- importIdapCode

type LigneRecord = { CodeLigne: string; CodeCom2: string };

async function importComCode(directory: string) {
	const comCode = new Map<number, string>();

	const lignePath = join(directory, "LIGNE.TXT");
	await parseCsv<LigneRecord>(
		lignePath,
		(ligneRecord) => {
			comCode.set(+ligneRecord.CodeCom2, `TCAR:${ligneRecord.CodeLigne}`);
		},
		{ delimiter: ";", encoding: "latin1" },
	);

	return comCode;
}
