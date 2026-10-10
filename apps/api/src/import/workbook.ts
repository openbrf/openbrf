import { Unzip, UnzipInflate, UnzipPassThrough, zipSync } from "fflate";
import { readSheet } from "read-excel-file/node";

import {
  ImportShapeError,
  MAX_IMPORT_CELL_LENGTH,
  MAX_WORKBOOK_BYTES,
  MAX_WORKBOOK_ENTRY_BYTES,
} from "./import-limits";
import { checkAddresses, UnreadableSheetError } from "./sheet-addresses";

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
 * {@link inspectWorkbook}, and the library reads only what was inspected.
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
 * Refuses a workbook the parser could not read within the import's limits, and
 * returns the archive the parser is to read instead.
 *
 * Every XML part is inflated here with its size counted as it grows, and
 * refused once it passes the limit, so a part that inflates without bound is
 * stopped after a few megabytes rather than after the library has allocated
 * all of it. Every XML part is then searched for row and cell addresses past
 * the import's limits by {@link checkAddresses}. All of them, rather than only
 * the sheets: which part is a sheet is for the workbook's own relationships to
 * say, and reading those the way the library does is one more place to
 * disagree with it.
 *
 * The archive returned is rebuilt from the parts inspected, and only from
 * them. The library has its own unzipper, which reads an archive differently
 * from the one here (it trusts the size a part declares, and the two need not
 * agree on which parts there are), so handing it the original would leave it
 * reading a file nobody inspected.
 */
export function inspectWorkbook(buffer: Uint8Array): Uint8Array {
  let total = 0;
  const tooLarge = (): ImportShapeError =>
    new ImportShapeError(
      "The workbook inflates past its limit.",
      "workbook-too-large",
    );
  const parts: Record<string, Uint8Array> = {};

  const unzip = new Unzip((file) => {
    if ((file.originalSize ?? 0) > MAX_WORKBOOK_ENTRY_BYTES) {
      throw tooLarge();
    }
    const kept = /\.(?:xml|rels)$/i.test(file.name);
    if (kept && Object.hasOwn(parts, file.name)) {
      throw new UnreadableSheetError("The workbook holds a part twice.");
    }
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
      if (kept) {
        chunks.push(chunk);
        if (final) {
          const part = Buffer.concat(chunks);
          // Decoded as the library decodes it.
          checkAddresses(new TextDecoder().decode(part));
          parts[file.name] = part;
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
  // Stored rather than compressed: the archive is read once, straight away.
  return zipSync(parts, { level: 0 });
}

/**
 * Parses a workbook into rows of text, header row included, with the sheet row
 * each one is on: blank rows are left out, and the preview names a row by the
 * number the board sees in the margin of the sheet.
 */
export async function parseWorkbook(
  buffer: Buffer,
): Promise<{ rows: string[][]; sourceRows: number[] }> {
  const inspected = inspectWorkbook(buffer);
  const sheet = (await readSheet(Buffer.from(inspected))) as unknown[][];

  const sourceRows: number[] = [];
  const rows = sheet
    .map((row) => row.map(cellText))
    .filter((row, index) => {
      const kept = row.some((value) => value !== "");
      if (kept) {
        sourceRows.push(index + 1);
      }
      return kept;
    });

  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);

  // Padded for the same reason the CSV reader pads: a mapping reads by
  // position, and a short row would shift its values into the wrong fields.
  return {
    rows: rows.map((row) => [
      ...row,
      ...Array.from({ length: width - row.length }, () => ""),
    ]),
    sourceRows,
  };
}
