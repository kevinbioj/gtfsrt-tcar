import { parse } from "csv-parse";

export async function parseCsv<T = Record<string, string>>(
  input: string | Buffer
) {
  const [header, ...records] = await new Promise<string[][]>(
    (resolve, reject) =>
      parse(input, { bom: true, skipEmptyLines: true }, (error, records) => {
        if (error) reject(error);
        else resolve(records);
      })
  );
  return records.map((values) => {
    const record = {} as Record<string | number, unknown>;
    values.forEach((value, index) => {
      const key = header[index];
      record[key] = value;
    });
    return record as T;
  });
}
