import {
  ImportShapeError,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  MAX_WORKBOOK_EMPTY_COLUMN,
  MAX_WORKBOOK_EMPTY_ROW,
} from "./import-limits";

/**
 * Checking the row and cell addresses in one XML part of a workbook.
 *
 * `read-excel-file` fills every row and cell up to the address it reads, so an
 * address is an allocation however few bytes it takes to write. This reads
 * every `<row>` and `<c>` the library's XML parser (saxen) would see, and holds
 * each `r` attribute to the plain form Excel writes, `12` or `AB12`, before the
 * number in it is trusted. Any other spelling is refused rather than
 * interpreted: the library reads an address with `Number()`, which takes
 * `1e9`, and decodes character references first, so guessing at what it would
 * make of an unusual address is how a check and a parser come to disagree.
 *
 * The scan follows saxen's own tokenizing: text runs to the next `<`, a comment,
 * a CDATA section and a processing instruction run to their closing marks, and
 * a tag runs to the first `>` outside a quoted value. Every element name and
 * attribute name is compared after the namespace prefix the library drops.
 * Where the two could still differ, this side reads more, never less: an `r`
 * that saxen would skip as malformed is still checked here. Each character is
 * visited a bounded number of times, so the check costs time in proportion to
 * the part and nothing more.
 */

/** Thrown for a part the check cannot read the way the library would. */
export class UnreadableSheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableSheetError";
  }
}

// Disjoint character classes, so neither can backtrack.
const ROW = /^[1-9][0-9]*$/;
const CELL = /^([A-Z]+)([1-9][0-9]*)$/;

/** Throws when an address in this XML part lies past the import's limits. */
export function checkAddresses(xml: string): void {
  let at = 0;
  for (;;) {
    const open = xml.indexOf("<", at);
    if (open === -1) {
      return;
    }
    const marker = xml.charAt(open + 1);
    if (marker === "!" && xml.startsWith("![CDATA[", open + 1)) {
      at = pastMark(xml, "]]>", open);
      continue;
    }
    if (marker === "!" && xml.startsWith("!--", open + 1)) {
      at = pastMark(xml, "-->", open);
      continue;
    }
    if (marker === "?") {
      at = pastMark(xml, "?>", open);
      continue;
    }
    const close = tagEnd(xml, open);
    if (marker !== "!" && marker !== "/") {
      checkStartTag(xml.slice(open + 1, close));
    }
    at = close + 1;
  }
}

function pastMark(xml: string, mark: string, from: number): number {
  const end = xml.indexOf(mark, from);
  if (end === -1) {
    throw new UnreadableSheetError(`A sheet part never closes a "${mark}".`);
  }
  return end + mark.length;
}

/** The `>` that closes the tag opened at `open`, skipping quoted values. */
function tagEnd(xml: string, open: number): number {
  for (let at = open + 1; at < xml.length; at++) {
    const char = xml.charAt(at);
    if (char === '"' || char === "'") {
      // An unmatched quote is read as an ordinary character, as saxen does.
      // Once a quote has no match nothing after it has one either, so this
      // search runs to the end of the part at most once for each kind.
      const match = xml.indexOf(char, at + 1);
      at = match === -1 ? at : match;
    } else if (char === ">") {
      return at;
    }
  }
  throw new UnreadableSheetError("A sheet part never closes a tag.");
}

/** `body` is everything between `<` and `>`. */
function checkStartTag(body: string): void {
  const selfClosing = body.endsWith("/");
  const tag = selfClosing ? body.slice(0, -1) : body;
  let nameEnd = 0;
  while (nameEnd < tag.length && !isWhitespace(tag.charCodeAt(nameEnd))) {
    nameEnd++;
  }
  const element = localName(tag.slice(0, nameEnd));
  if (element !== "row" && element !== "c") {
    return;
  }

  const attributes = tag.slice(nameEnd);
  for (
    let equals = attributes.indexOf("=");
    equals !== -1;
    equals = attributes.indexOf("=", equals + 1)
  ) {
    if (!namesR(attributes, equals)) {
      continue;
    }
    const quote = attributes.charAt(equals + 1);
    const end =
      quote === '"' || quote === "'"
        ? attributes.indexOf(quote, equals + 2)
        : -1;
    if (end === -1) {
      throw new UnreadableSheetError("An address is not a quoted value.");
    }
    const address = attributes.slice(equals + 2, end);
    if (element === "row") {
      checkRowAddress(address);
    } else {
      checkCellAddress(address, selfClosing);
    }
  }
}

/**
 * Whether the attribute name ending just before `equals` may be read as `r`.
 *
 * True for `r` and for any prefixed `…:r`, which the library reads as `r`.
 * Only a name character other than `:` in front of the `r` rules it out, so a
 * name saxen would skip as malformed is still caught.
 */
function namesR(attributes: string, equals: number): boolean {
  if (attributes.charAt(equals - 1) !== "r") {
    return false;
  }
  const before = attributes.charAt(equals - 2);
  return before === ":" || !isNameCharacter(before);
}

function checkRowAddress(address: string): void {
  if (!ROW.test(address)) {
    throw new UnreadableSheetError("A row address is not a row number.");
  }
  // A row of its own holds no value: its cells are checked as cells.
  checkRow(Number(address), MAX_WORKBOOK_EMPTY_ROW);
}

/**
 * A self-closing cell has no value, only a format, so it is held to the
 * empty-cell limits. Any other cell is held to the import's.
 */
function checkCellAddress(address: string, empty: boolean): void {
  const parts = CELL.exec(address);
  if (parts === null) {
    throw new UnreadableSheetError("A cell address is not a cell address.");
  }
  const [, letters = "", row = ""] = parts;
  // The header is the row above the data, so it is one more.
  checkRow(Number(row), empty ? MAX_WORKBOOK_EMPTY_ROW : MAX_IMPORT_ROWS + 1);
  const column = columnNumber(letters);
  const lastColumn = empty ? MAX_WORKBOOK_EMPTY_COLUMN : MAX_IMPORT_COLUMNS;
  if (column > lastColumn) {
    throw new ImportShapeError(
      `A cell lies past column ${String(lastColumn)}.`,
      "too-many-columns",
    );
  }
}

function checkRow(row: number, lastRow: number): void {
  if (row > lastRow) {
    throw new ImportShapeError(
      `A cell lies past row ${String(lastRow)}.`,
      "too-many-rows",
    );
  }
}

/** A column's letters as a number: A is 1, Z is 26, AA is 27. */
function columnNumber(letters: string): number {
  let number = 0;
  for (const letter of letters) {
    number = number * 26 + (letter.charCodeAt(0) - 64);
  }
  return number;
}

/** A name without its namespace prefix, the way the library compares it. */
function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function isWhitespace(code: number): boolean {
  return code === 32 || (code > 8 && code < 14);
}

function isNameCharacter(char: string): boolean {
  return /^[A-Za-z0-9:._-]$/.test(char);
}
