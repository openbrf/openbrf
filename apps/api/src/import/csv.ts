/**
 * Reading and writing the comma-separated files a housing cooperative actually
 * has.
 *
 * Written here rather than taken from a package because the awkward parts are
 * not the ones a general CSV library solves. A Swedish board exports from Excel
 * with the system list separator, which is a semicolon; the file is either
 * UTF-8 with a byte order mark that would otherwise become part of the first
 * column title, or, saved as "CSV (semikolonavgränsad)" on Swedish Windows,
 * Windows-1252 rather than UTF-8 at all; and the rows have to survive a quoted
 * field containing the delimiter, a line break or a doubled quote. That is a
 * small, closed problem, and one fewer dependency in the path that handles a
 * whole cooperative's personal data.
 */

/** Delimiters worth guessing between. Semicolon first: Swedish Excel writes it. */
const CANDIDATE_DELIMITERS = [";", ",", "\t"] as const;

export type CsvDelimiter = (typeof CANDIDATE_DELIMITERS)[number];

const BYTE_ORDER_MARK = "﻿";

export interface ParsedCsv {
  delimiter: CsvDelimiter;
  /** Every row, header included, padded to the widest row. */
  rows: string[][];
  /**
   * The row each of `rows` is on in the spreadsheet the file came from,
   * counting from 1 at the header and counting the blank rows left out of
   * `rows`, so a row the preview names is the row the board finds.
   */
  sourceRows: number[];
}

/**
 * Picks the delimiter by counting candidates outside quotes in the first line.
 *
 * Counted rather than assumed, because the wrong guess does not fail: it
 * produces one very wide column, and a board would see their whole member list
 * in the "name" field and conclude the import is broken.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const firstLine = readFirstLine(text);

  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = countOutsideQuotes(firstLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Turns the bytes of an uploaded CSV file into text.
 *
 * UTF-8 first, strictly, and Windows-1252 when the bytes are not UTF-8. Excel
 * on Swedish Windows saves "CSV (semikolonavgränsad)" in Windows-1252, where
 * å, ä and ö are single bytes that are never valid UTF-8. Read leniently as
 * UTF-8 they become U+FFFD, and "Åsa Öberg" would be written into a member
 * register nobody can edit as "\uFFFDsa \uFFFDberg".
 *
 * The guess is safe in that direction: a file that decodes as UTF-8 without a
 * single error is, in practice, UTF-8, while a Windows-1252 file with even one
 * Swedish letter in it fails the strict decode. Windows-1252 has no invalid
 * byte sequences, so the fallback always produces text; the WHATWG decoder maps
 * its five unassigned bytes to control characters rather than to U+FFFD.
 *
 * A byte order mark settles it the other way: the file says it is UTF-8, and
 * Windows-1252 would turn every letter in it into mojibake that no check
 * catches, starting with "ï»¿" in the first title. Such a file is read
 * leniently, so a stray invalid byte becomes one U+FFFD that the preview
 * refuses on its row. The decoder drops the mark itself.
 *
 * Without a mark the same danger remains, and nothing downstream sees it: a
 * UTF-8 file with one stray byte fails the strict decode, and Windows-1252
 * would read every correctly encoded letter in it as mojibake ("Ã…sa") that
 * holds no U+FFFD. A file that fails the strict decode but still holds
 * well-formed UTF-8 for a non-ASCII character is both encodings at once, and
 * the board is asked to save it again instead of being guessed for. A real
 * Windows-1252 file rarely matches: its letters sit next to letters, and a
 * UTF-8 sequence needs a byte in 0x80-0xBF after its first. It does match when
 * Windows-1252 punctuation (’ ” – … or a no-break space) follows a capital in
 * C2-DF (Å Ä Ö É Ü), as in "RENÉ’S" or "BJÖRKÖ" plus a no-break space. Such a
 * file is refused, which is safe: saving it again as UTF-8 fixes it.
 *
 * What stays open is a file that passes the strict decode and is Windows-1252
 * all the same: the bytes C5 A0 are "Å" and a no-break space there and "Š" in
 * UTF-8, and nothing in the bytes tells them apart. It needs a Windows-1252
 * file whose only non-ASCII bytes all happen to form UTF-8, so a capital Å, Ä
 * or Ö next to a symbol and no other Swedish letter anywhere. Guessing the
 * other way would refuse every Polish or Czech name in a genuine UTF-8 file,
 * so the board's check is the preview, which shows each name as it would be
 * written before anything is applied.
 */
export function decodeCsv(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    if (holdsUtf8Sequence(bytes)) {
      throw new Error("The file mixes UTF-8 and another encoding.");
    }
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** A two-, three- or four-byte UTF-8 sequence, read off the bytes as latin1. */
const UTF_8_SEQUENCE =
  /[\xC2-\xDF][\x80-\xBF]|[\xE0-\xEF][\x80-\xBF]{2}|[\xF0-\xF4][\x80-\xBF]{3}/;

function holdsUtf8Sequence(bytes: Uint8Array): boolean {
  return UTF_8_SEQUENCE.test(Buffer.from(bytes).toString("latin1"));
}

/** Parses a CSV document into rows of cells. */
export function parseCsv(input: string, delimiter?: CsvDelimiter): ParsedCsv {
  const text = input.startsWith(BYTE_ORDER_MARK) ? input.slice(1) : input;
  const separator = delimiter ?? detectDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (quoted) {
      if (character !== '"') {
        cell += character;
        continue;
      }
      if (text[index + 1] === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        cell += '"';
        index++;
        continue;
      }
      quoted = false;
      continue;
    }

    // A quote opens a field where nothing but blanks precede it, so a space
    // after the delimiter - `1; "x;y"` - does not turn the quote into text and
    // split the field at the delimiter inside it. The blanks are dropped, as
    // every cell is trimmed below.
    if (character === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
      continue;
    }
    if (character === separator) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (character === "\n" || character === "\r") {
      // Consume the second half of a CRLF so it does not open an empty row.
      if (character === "\r" && text[index + 1] === "\n") {
        index++;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += character;
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const sourceRows: number[] = [];
  const populated = rows.filter((candidate, index) => {
    const kept = candidate.some((value) => value.trim() !== "");
    if (kept) {
      sourceRows.push(index + 1);
    }
    return kept;
  });
  const width = populated.reduce(
    (widest, candidate) => Math.max(widest, candidate.length),
    0,
  );

  return {
    delimiter: separator,
    // Padded so every row has a cell for every column: a short row would
    // otherwise silently shift its values into the wrong fields when a mapping
    // reads by position.
    rows: populated.map((candidate) => [
      ...candidate.map((value) => value.trim()),
      ...Array.from({ length: width - candidate.length }, () => ""),
    ]),
    sourceRows,
  };
}

/**
 * Writes a CSV document.
 *
 * Semicolons and a byte order mark, because the file exists to be opened in
 * Excel: without the mark Excel reads UTF-8 as the local code page and turns
 * every Swedish vowel into a pair of symbols.
 *
 * Every file this product hands out is written here - the debiting list, the
 * fee notices, the accounting basis, the cooperative housing register's initial
 * supply and the import template - so the neutralisation below is done once,
 * for all of them, rather than per caller.
 */
export function writeCsv(rows: readonly (readonly string[])[]): string {
  const body = rows
    .map((row) => row.map((cell) => quoteCell(neutralise(cell))).join(";"))
    .join("\r\n");
  return `${BYTE_ORDER_MARK}${body}\r\n`;
}

/**
 * What a spreadsheet reads as the start of a formula rather than as text.
 *
 * `=` and `@` open one outright; `+` and `-` open one in Excel, which is why
 * `+46 70...` becomes an error rather than a telephone number in a cell a
 * board has pasted. A leading tab or carriage return is here because a
 * spreadsheet skips it and reads what follows, so it is a way of hiding any of
 * the four in front of a formula.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * A cell that is a number, and therefore not a formula however it starts.
 *
 * The sign is the whole reason this exists. `-450.00` is an ordinary amount in
 * a file whoever keeps the books reconciles against, and prefixing it would
 * turn a figure into text that no longer adds up - a worse fault than the one
 * the neutralisation is for. A comma is allowed beside the full stop because a
 * Swedish spreadsheet writes the decimal that way and a cell can reach this
 * writer having been read from one.
 *
 * A date needs no exemption of its own: this product writes "YYYY-MM-DD", which
 * begins with a digit and is never a candidate above. The same is true of a
 * personal identity number, an organisation number and a payment reference.
 */
const PLAIN_NUMBER = /^[+-]?\d+(?:[.,]\d+)?$/;

/**
 * Text a spreadsheet would execute, made into text it displays.
 *
 * The files this writer produces leave the association: the debiting list and
 * the accounting basis go to whoever keeps the books, the initial supply goes
 * to Lantmateriet. Several of their columns are free text a board typed - a
 * charge's reason, a creditor's name - and a cell beginning `=` would run as a
 * formula the moment the recipient opened the file, with that recipient's
 * authority rather than the board's (CWE-1236).
 *
 * The cure is the conventional one: a leading apostrophe, which every
 * spreadsheet reads as "what follows is text" and shows in the formula bar
 * rather than in the cell. It is applied before the quoting below, so a cell
 * that needs both gets the apostrophe inside the quotes.
 *
 * What it deliberately leaves alone is a number. Nothing else is exempt: a cell
 * that is neither a number nor free of the leading characters is prefixed, even
 * where the value looks harmless, because deciding a cell is safe on its
 * content is how this class of defect comes back.
 */
function neutralise(value: string): string {
  if (!FORMULA_LEAD.test(value) || PLAIN_NUMBER.test(value)) {
    return value;
  }
  return `'${value}`;
}

/**
 * Quotes a cell that holds a character some reader splits or ends a field on.
 *
 * The semicolon this writer delimits with, and also a comma and a tab: a
 * spreadsheet set up for another list separator, or an import dialog someone
 * picked the wrong one in, splits on those instead. Quoted, the cell stays one
 * field whichever separator the reader chose, so what the neutralisation above
 * decided about the cell's first character holds for all of it.
 */
function quoteCell(value: string): string {
  if (!/[";,\t\r\n]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * The first record, which may span lines: a header title with a line break
 * typed into it (Alt-Enter in Excel) is quoted, and cutting at the break would
 * leave the delimiters after it uncounted.
 */
function readFirstLine(text: string): string {
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      return text.slice(0, index);
    }
  }
  return text;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        index++;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === delimiter) {
      count++;
    }
  }
  return count;
}
