/**
 * Reading and writing the comma-separated files a housing cooperative actually
 * has.
 *
 * Written here rather than taken from a package because the awkward parts are
 * not the ones a general CSV library solves. A Swedish board exports from Excel
 * with the system list separator, which is a semicolon; the file arrives with a
 * UTF-8 byte order mark that would otherwise become part of the first column
 * title; and the rows have to survive a quoted field containing the delimiter,
 * a line break or a doubled quote. That is a small, closed problem, and one
 * fewer dependency in the path that handles a whole cooperative's personal data.
 */

/** Delimiters worth guessing between. Semicolon first: Swedish Excel writes it. */
const CANDIDATE_DELIMITERS = [";", ",", "\t"] as const;

export type CsvDelimiter = (typeof CANDIDATE_DELIMITERS)[number];

const BYTE_ORDER_MARK = "﻿";

export interface ParsedCsv {
  delimiter: CsvDelimiter;
  /** Every row, header included, padded to the widest row. */
  rows: string[][];
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

    if (character === '"' && cell === "") {
      quoted = true;
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

  const populated = rows.filter((candidate) =>
    candidate.some((value) => value.trim() !== ""),
  );
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

function quoteCell(value: string): string {
  if (!/[";\r\n]/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function readFirstLine(text: string): string {
  const end = text.search(/\r|\n/);
  return end === -1 ? text : text.slice(0, end);
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
