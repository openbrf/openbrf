/**
 * How large an uploaded member list may be, in every dimension that costs
 * memory.
 *
 * The upload limit is on the bytes as sent, and neither file format is held to
 * it once read. A CSV row is padded to the widest row in the file, so width and
 * row count multiply; an xlsx is a zip archive that inflates, and a cell address
 * can name a row a billion rows down. So both parsers check these while they
 * read, before anything is padded or allocated, rather than counting what they
 * produced afterwards.
 *
 * Every limit is far above a real member list: a cooperative of a few hundred
 * apartments, a dozen columns, values a person types into a cell.
 */

// Data rows, columns and characters in a cell: shared, because the screen
// names them when it refuses a file.
export {
  MAX_IMPORT_CELL_LENGTH,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
} from "@openbrf/shared";

/**
 * Bytes one entry of an xlsx archive may inflate to.
 *
 * A sheet of the largest file accepted - five thousand rows of a dozen short
 * columns - is around two megabytes of XML.
 */
export const MAX_WORKBOOK_ENTRY_BYTES = 8 * 1024 * 1024;

/** Bytes the whole xlsx archive may inflate to. */
export const MAX_WORKBOOK_BYTES = 16 * 1024 * 1024;

/**
 * The last row an empty row or cell of a workbook may name.
 *
 * Excel writes a cell for every formatted cell, value or not, so a short list
 * formatted far down its sheet names rows well past the data. The parser still
 * fills every row up to the last one named, at a few megabytes for this many.
 * A cell holding a value is held to {@link MAX_IMPORT_ROWS} instead.
 */
export const MAX_WORKBOOK_EMPTY_ROW = 65_536;

/** The last column an empty cell may name: XFD, Excel's own last column. */
export const MAX_WORKBOOK_EMPTY_COLUMN = 16_384;

/** Why a file was refused for its shape rather than for its content. */
export type ImportShapeReason =
  | "too-many-rows"
  | "too-many-columns"
  | "cell-too-long"
  | "unterminated-quote"
  | "workbook-too-large";

/** A file refused while it was being read, before it was held. */
export class ImportShapeError extends Error {
  constructor(
    message: string,
    readonly reason: ImportShapeReason,
  ) {
    super(message);
    this.name = "ImportShapeError";
  }
}
