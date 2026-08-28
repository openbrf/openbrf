import { readSheet } from "read-excel-file/node";

/**
 * Reading the first sheet of an Excel workbook.
 *
 * `read-excel-file` reads and cannot write, which is the whole reason it is the
 * dependency here: an import needs to parse a spreadsheet and nothing else, and
 * a read-only parser is a much smaller thing to trust with the file a board
 * uploads. It is actively maintained and its own dependency tree is four small
 * pure-JavaScript packages.
 *
 * Only the first sheet is read. A member list with several sheets is a
 * different feature, and quietly concatenating them would import a "notes" tab
 * as if it were people.
 */

/** Rows beyond this are refused rather than parsed. */
export const MAX_IMPORT_ROWS = 5000;

/**
 * Turns a cell into the text the mapping works with.
 *
 * A date cell arrives as a Date because Excel stores dates as numbers, and
 * writing it back as an ISO calendar date is what makes a column formatted as a
 * date behave the same as one typed as text. A number keeps no formatting, so
 * an apartment number reaches us as 1101 rather than "1101" and a phone number
 * that Excel ate the leading zero from reaches us as 701234567 - which the
 * phone normalizer turns back into +46701234567.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

/** Parses a workbook into rows of text, header row included. */
export async function parseWorkbook(buffer: Buffer): Promise<string[][]> {
  const sheet = (await readSheet(buffer)) as unknown[][];

  const rows = sheet
    .map((row) => row.map(cellText))
    .filter((row) => row.some((value) => value !== ""));

  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);

  // Padded for the same reason the CSV reader pads: a mapping reads by
  // position, and a short row would shift its values into the wrong fields.
  return rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ]);
}
