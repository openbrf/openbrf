import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { readSheet } from "read-excel-file/node";

import {
  ImportShapeError,
  MAX_IMPORT_CELL_LENGTH,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  MAX_WORKBOOK_BYTES,
  MAX_WORKBOOK_ENTRY_BYTES,
} from "./import-limits";

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
 *
 * The library sets no limits of its own: it inflates every part of the archive
 * whatever size it turns out to be, and fills the gap up to whatever row and
 * column a cell address names. So the archive is inspected first, by
 * {@link inspectWorkbook}, and handed to the library only once it is known to
 * fit.
 */

/**
 * Bytes of the archive handed to the inflater at a time.
 *
 * Deflate expands at most about a thousandfold, so a slice this size cannot
 * inflate past a few megabytes before the count in inspectWorkbook sees it.
 * The size an archive declares for a part is not trusted for this: it is a
 * number the file states, and nothing obliges the data to agree with it.
 */
const INSPECT_SLICE_BYTES = 4096;

/** A row's or a cell's address, e.g. `<row r="12"` or `<c r="AB12"`. */
const ROW_ADDRESS = /<row\b[^>]*?\sr="(\d+)"/g;
const CELL_ADDRESS = /<c\b[^>]*?\sr="([A-Z]+)(\d+)"/g;

/**
 * Turns a cell into the text the mapping works with.
 *
 * A date cell arrives as a Date because Excel stores dates as numbers, and
 * writing it back as an ISO calendar date is what makes a column formatted as a
 * date behave the same as one typed as text. The fields are read as UTC, which
 * is correct here and nowhere else in this product: an Excel date serial counts
 * days and carries no zone, so the parser decodes it to midnight UTC, and the
 * value goes on into a `@db.Date` column that is read back the same way.
 * `workbook.spec.ts` pins that, because a library that ever decoded a serial to
 * local midnight would shift every imported date by a day in silence.
 *
 * A number keeps no formatting, so
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
    if (value.length > MAX_IMPORT_CELL_LENGTH) {
      throw new ImportShapeError(
        `A cell is longer than ${String(MAX_IMPORT_CELL_LENGTH)} characters.`,
        "cell-too-long",
      );
    }
    return value.trim();
  }
  return "";
}

/**
 * Refuses a workbook the parser could not read within the import's limits.
 *
 * Every XML part is inflated here with its size counted as it grows, and
 * refused once it passes the limit, so a part that inflates without bound is
 * stopped after a few megabytes rather than after the library has allocated
 * all of it. The worksheets are then searched for row and cell addresses past
 * the import's rows and columns: the library fills every row and cell up to the
 * address it reads, so an address a billion rows down is an allocation however
 * few bytes it takes to write. The library reads a cell only by its address,
 * so the addresses bound the rows and columns it can produce.
 */
export function inspectWorkbook(buffer: Uint8Array): void {
  let total = 0;
  const tooLarge = (): ImportShapeError =>
    new ImportShapeError(
      "The workbook inflates past its limit.",
      "workbook-too-large",
    );

  const unzip = new Unzip((file) => {
    if ((file.originalSize ?? 0) > MAX_WORKBOOK_ENTRY_BYTES) {
      throw tooLarge();
    }
    const worksheet = /^xl\/worksheets\/[^/]+\.xml$/.test(file.name);
    const chunks: Uint8Array[] = [];
    let size = 0;

    file.ondata = (error, chunk, final) => {
      if (error !== null) {
        throw error;
      }
      size += chunk.length;
      total += chunk.length;
      if (size > MAX_WORKBOOK_ENTRY_BYTES || total > MAX_WORKBOOK_BYTES) {
        throw tooLarge();
      }
      if (worksheet) {
        chunks.push(chunk);
        if (final) {
          checkAddresses(Buffer.concat(chunks).toString("utf8"));
        }
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  for (let offset = 0; offset < buffer.length; offset += INSPECT_SLICE_BYTES) {
    const end = offset + INSPECT_SLICE_BYTES;
    unzip.push(buffer.subarray(offset, end), end >= buffer.length);
  }
}

function checkAddresses(xml: string): void {
  for (const [, row] of xml.matchAll(ROW_ADDRESS)) {
    checkRow(Number(row));
  }
  for (const [, column = "", row] of xml.matchAll(CELL_ADDRESS)) {
    checkRow(Number(row));
    if (columnNumber(column) > MAX_IMPORT_COLUMNS) {
      throw new ImportShapeError(
        `A cell lies past column ${String(MAX_IMPORT_COLUMNS)}.`,
        "too-many-columns",
      );
    }
  }
}

function checkRow(row: number): void {
  // The header is the row above the data, so it is one more.
  if (row > MAX_IMPORT_ROWS + 1) {
    throw new ImportShapeError(
      `A cell lies past row ${String(MAX_IMPORT_ROWS + 1)}.`,
      "too-many-rows",
    );
  }
}

/** A column's letters as a number: A is 1, Z is 26, AA is 27. */
function columnNumber(letters: string): number {
  let number = 0;
  for (const letter of letters) {
    number = number * 26 + (letter.charCodeAt(0) - 64);
    if (number > MAX_IMPORT_COLUMNS) {
      // Stop counting: XFD is the last column Excel has, but an address is
      // whatever text the file holds.
      return number;
    }
  }
  return number;
}

/** Parses a workbook into rows of text, header row included. */
export async function parseWorkbook(buffer: Buffer): Promise<string[][]> {
  inspectWorkbook(buffer);
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
