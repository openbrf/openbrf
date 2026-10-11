/**
 * How large an uploaded member list may be, in the dimensions a board member
 * can do something about.
 *
 * Here rather than beside the parsers that enforce them, because the import
 * screen names the same numbers when it refuses a file: a refusal that says
 * "too many rows" without saying how many is one the board cannot act on. The
 * limits only the parsers care about stay with them.
 */

/** Data rows, header excluded. */
export const MAX_IMPORT_ROWS = 5000;

/** Columns. The mapping step accepts no more than this either. */
export const MAX_IMPORT_COLUMNS = 200;

/** Characters in one cell. A name, an address or a date is far shorter. */
export const MAX_IMPORT_CELL_LENGTH = 1000;
