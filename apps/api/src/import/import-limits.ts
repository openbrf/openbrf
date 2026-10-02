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

/** Data rows, header excluded. */
export const MAX_IMPORT_ROWS = 5000;

/** Columns. The mapping step accepts no more than this either. */
export const MAX_IMPORT_COLUMNS = 200;

/** Characters in one cell. A name, an address or a date is far shorter. */
export const MAX_IMPORT_CELL_LENGTH = 1000;

/**
 * Bytes one entry of an xlsx archive may inflate to.
 *
 * A sheet of the largest file accepted - five thousand rows of a dozen short
 * columns - is around two megabytes of XML.
 */
export const MAX_WORKBOOK_ENTRY_BYTES = 8 * 1024 * 1024;

/** Bytes the whole xlsx archive may inflate to. */
export const MAX_WORKBOOK_BYTES = 16 * 1024 * 1024;

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
