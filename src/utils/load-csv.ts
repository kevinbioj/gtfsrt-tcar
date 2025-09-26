import { parse } from "csv-parse";
import { createReadStream } from "node:fs";

type CsvRecord<T extends string = string> = Record<T, string>;
type LoadCsvOptions = { delimiter?: string; encoding?: BufferEncoding };

export function loadCsv<T extends string>(
	path: string,
	onRecord: (item: CsvRecord<T>) => void,
	options: LoadCsvOptions = {},
) {
	const stream = createReadStream(path, { encoding: options.encoding });
	const parser = stream.pipe(
		parse({
			bom: true,
			columns: true,
			delimiter: options.delimiter,
			skipEmptyLines: true,
		}),
	);
	parser.on("data", (dataRow) => {
		onRecord(dataRow as CsvRecord<T>);
	});
	return new Promise((resolve, reject) => {
		parser.once("end", resolve);
		parser.once("error", reject);
	});
}
