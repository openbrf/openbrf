import { scanForPersonalIdentityNumberCandidates } from "@openbrf/shared";

import { decodeCsv, MixedEncodingError, parseCsv } from "./csv";
import type { ImportMapping } from "./import-columns";
import { ImportError } from "./import-errors";
import {
  ImportShapeError,
  MAX_IMPORT_CELL_LENGTH,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  MAX_IMPORT_UPLOAD_BYTES,
} from "./import-limits";
import { parseWorkbook } from "./workbook";

/**
 * Reading a member list file, however it arrived.
 *
 * A board member's upload and a plugin's import proposal (ADR 0043) are read
 * here and nowhere else, so one file is read one way: the same parsers, the
 * same limits, and the same reason codes when it is refused. The bytes are
 * not kept by anything here.
 */

/** Rows shown on the mapping screen so a column can be recognised by content. */
export const SAMPLE_ROWS = 5;

export interface ImportFile {
  format: "CSV" | "XLSX";
  /** Every row read, the column titles first. */
  rows: string[][];
  header: string[];
  /** The rows below the column titles. */
  data: string[][];
  /** The sheet row each data row was read from. */
  sourceRows: number[];
}

/** Reads the file, or refuses it with the reason the board is told. */
export async function readImportFile(
  bytes: Buffer,
  fileName: string,
): Promise<ImportFile> {
  if (bytes.byteLength === 0) {
    throw new ImportError("The uploaded file is empty.", "file-empty");
  }
  if (bytes.byteLength > MAX_IMPORT_UPLOAD_BYTES) {
    throw new ImportError("That file is too large.", "file-too-large");
  }

  const format = detectFormat(bytes, fileName);
  const { rows, sourceRows } = await parse(bytes, format);

  const header = rows[0];
  if (header === undefined || rows.length < 2) {
    throw new ImportError(
      "The file has no rows below its column titles.",
      "file-empty",
    );
  }
  const data = rows.slice(1);
  if (data.length > MAX_IMPORT_ROWS) {
    throw new ImportError(
      `That file has more than ${String(MAX_IMPORT_ROWS)} rows below its column titles.`,
      "too-many-rows",
    );
  }
  return { format, rows, header, data, sourceRows: sourceRows.slice(1) };
}

async function parse(
  bytes: Buffer,
  format: "CSV" | "XLSX",
): Promise<{ rows: string[][]; sourceRows: number[] }> {
  try {
    if (format === "CSV") {
      return parseCsv(decodeCsv(bytes), undefined, {
        maxDataRows: MAX_IMPORT_ROWS,
        maxColumns: MAX_IMPORT_COLUMNS,
        maxCellLength: MAX_IMPORT_CELL_LENGTH,
      });
    }
    return await parseWorkbook(bytes);
  } catch (error) {
    if (error instanceof ImportShapeError) {
      throw new ImportError(error.message, error.reason);
    }
    if (error instanceof MixedEncodingError) {
      throw new ImportError(
        "That file mixes UTF-8 and another encoding. Save it again as UTF-8 or as CSV (semikolonavgränsad).",
        "file-mixed-encoding",
      );
    }
    throw new ImportError(
      "That file could not be read as a spreadsheet.",
      "file-unreadable",
    );
  }
}

/**
 * The sample rows the mapping screen shows, with every personal identity
 * number's digits hidden.
 *
 * The rule the preview keeps - a number is reported as present or absent and
 * never sent - holds here too: the mapping screen is not a screen that shows
 * identity numbers, and the sample is the first rows of the file exactly as
 * uploaded. A column the titles say holds the numbers is hidden whole, so a
 * mistyped number that fails its check digit is hidden as well; a number
 * anywhere else is hidden by its shape, valid or not, for the same reason.
 * The shape stays, so the board can still see which column holds them.
 *
 * Both mappings the screen may start from are asked: the guess, and the one
 * saved for the file's source, where a column the titles did not give away may
 * have been mapped to the numbers by hand.
 */
export function maskedSample(
  rows: readonly string[][],
  mapping: ImportMapping,
  saved: ImportMapping,
): string[][] {
  const hide = (text: string): string => text.replace(/\d/g, "•");
  return rows.map((row) =>
    row.map((cell, column) => {
      if (
        mapping[column] === "personalIdentityNumber" ||
        saved[column] === "personalIdentityNumber"
      ) {
        return hide(cell);
      }
      let masked = cell;
      for (const found of scanForPersonalIdentityNumberCandidates(cell)) {
        masked =
          masked.slice(0, found.index) +
          hide(found.value) +
          masked.slice(found.index + found.value.length);
      }
      return masked;
    }),
  );
}

/**
 * Which parser reads the bytes.
 *
 * The content decides, not the file name: an xlsx renamed to .csv is still a
 * zip archive, and reading it as text would produce one column of mojibake
 * rather than an error the board can act on.
 */
function detectFormat(bytes: Buffer, fileName: string): "CSV" | "XLSX" {
  // Every xlsx is a zip archive, and every zip starts "PK".
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    return "XLSX";
  }
  return fileName.toLowerCase().endsWith(".xlsx") ? "XLSX" : "CSV";
}
