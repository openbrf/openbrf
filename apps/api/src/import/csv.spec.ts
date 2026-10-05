import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decodeCsv, detectDelimiter, parseCsv, writeCsv } from "./csv";

function fixture(name: string): Buffer {
  return readFileSync(join(process.cwd(), "src", "import", "fixtures", name));
}

/**
 * The shapes a member list actually arrives in.
 *
 * Each case here comes from something Excel does rather than from the CSV
 * specification: a semicolon separator because that is the Swedish list
 * separator, a byte order mark on every UTF-8 export, CRLF line endings, and a
 * quoted field whenever a value contains one of the above.
 */

describe("choosing the delimiter", () => {
  it("reads a semicolon-separated export", () => {
    expect(detectDelimiter("Namn;Lgh;E-post\nAnna;1101;anna@exempel.se")).toBe(
      ";",
    );
  });

  it("reads a comma-separated file", () => {
    expect(detectDelimiter("Name,Apt,Email")).toBe(",");
  });

  it("reads a tab-separated file", () => {
    expect(detectDelimiter("Name\tApt\tEmail")).toBe("\t");
  });

  it("ignores a delimiter inside a quoted title", () => {
    // "Namn, efternamn" is one column title containing a comma. Counting it
    // would pick the comma and split the file down the middle of a heading.
    expect(detectDelimiter('"Namn, efternamn";Lgh;E-post')).toBe(";");
  });

  it("counts over a title with a line break typed into it", () => {
    // Alt-Enter in an Excel heading. Cut at the break, the first line holds
    // no semicolon and a comma inside the title, and the whole file became
    // one column.
    expect(detectDelimiter('"Namn,\nfullt";Lgh;E-post\nAnna;1101;a@x')).toBe(
      ";",
    );
  });
});

describe("decoding the bytes", () => {
  // Both fixtures are the same four columns and one row, saved the two ways
  // Excel on Swedish Windows saves a CSV.
  it('reads a Windows-1252 file, which is what "CSV (semikolonavgränsad)" is', () => {
    const { rows } = parseCsv(decodeCsv(fixture("medlemmar-windows-1252.csv")));

    expect(rows).toEqual([
      ["Förnamn", "Efternamn", "Lägenhetsnummer", "Roll"],
      ["Åsa", "Öberg", "1101", "Medlem"],
    ]);
  });

  it('reads a UTF-8 file with a byte order mark, which is what "CSV UTF-8" is', () => {
    const { rows } = parseCsv(decodeCsv(fixture("medlemmar-utf-8-bom.csv")));

    expect(rows).toEqual([
      ["Förnamn", "Efternamn", "Lägenhetsnummer", "Roll"],
      ["Åsa", "Öberg", "1101", "Medlem"],
    ]);
  });

  it("reads UTF-8 as UTF-8 rather than as Windows-1252", () => {
    // Read as Windows-1252, the two bytes of "Å" would become "Ã…".
    expect(decodeCsv(Buffer.from("Åsa Öberg", "utf8"))).toBe("Åsa Öberg");
  });

  it("keeps a replacement character the file itself contains", () => {
    // Valid UTF-8 that already holds U+FFFD is not guessed at: the preview
    // flags it instead.
    expect(decodeCsv(Buffer.from("Bj\uFFFDrk", "utf8"))).toBe("Bj\uFFFDrk");
  });

  it("reads a file with a byte order mark as UTF-8 even when one byte is not", () => {
    // Read as Windows-1252 the whole file would turn to mojibake nothing flags,
    // "\u00EF\u00BB\u00BF" first. As UTF-8 only the stray byte is lost, and the preview
    // refuses its row.
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("F\u00F6rnamn;Efternamn\n\u00C5sa;\u00D6berg\nBj", "utf8"),
      Buffer.from([0xf6]),
      Buffer.from("rk;Lind", "utf8"),
    ]);

    expect(decodeCsv(bytes)).toBe(
      "F\u00F6rnamn;Efternamn\n\u00C5sa;\u00D6berg\nBj\uFFFDrk;Lind",
    );
  });

  it("refuses a file without a byte order mark that is UTF-8 with one stray byte", () => {
    // Read as Windows-1252 "Åsa Öberg" would become "Ã…sa Ã–berg", which holds
    // no U+FFFD for the preview to catch, so the file is refused instead.
    const bytes = Buffer.concat([
      Buffer.from("Förnamn;Efternamn\nÅsa;Öberg\nBj", "utf8"),
      Buffer.from([0xf6]),
      Buffer.from("rk;Lind", "utf8"),
    ]);

    expect(() => decodeCsv(bytes)).toThrow();
  });

  it("reads bytes that are valid UTF-8 as UTF-8 even when Windows-1252 would read them differently", () => {
    // C5 A0 is "Å" and a no-break space in Windows-1252 and "Š" in UTF-8. The
    // bytes cannot say which, and the same rule keeps "Michał" in a UTF-8 file
    // readable. The preview shows the name before anything is applied.
    expect(decodeCsv(Buffer.from([0xc5, 0xa0]))).toBe("Š");
    expect(decodeCsv(Buffer.from("Michał", "utf8"))).toBe("Michał");
  });

  it("still reads a Windows-1252 file with capitals and lowercase Swedish letters", () => {
    // Å is C5 and ä is E4, each followed by a letter: none of it can be the
    // start of a UTF-8 sequence, so the refusal above never reaches it.
    const bytes = Buffer.from(
      "Namn;Ort\nGunnar \u00C5kerlund;V\u00E4ster\u00E5s\n",
      "latin1",
    );

    expect(decodeCsv(bytes)).toBe("Namn;Ort\nGunnar Åkerlund;Västerås\n");
  });
});

describe("parsing", () => {
  it("drops the byte order mark rather than putting it in the first title", () => {
    const { rows } = parseCsv("﻿Namn;Lgh\nAnna;1101");

    expect(rows[0]).toEqual(["Namn", "Lgh"]);
  });

  it("reads a quoted field containing the delimiter", () => {
    const { rows } = parseCsv('Namn;Adress\nAnna;"Storgatan 12, lgh 3"');

    expect(rows[1]).toEqual(["Anna", "Storgatan 12, lgh 3"]);
  });

  it("reads a quoted field with a space before its opening quote", () => {
    const { rows } = parseCsv('Namn;Adress\nAnna; "Storgatan 12; lgh 3"', ";");

    expect(rows[1]).toEqual(["Anna", "Storgatan 12; lgh 3"]);
  });

  it("reads a doubled quote as one literal quote", () => {
    const { rows } = parseCsv('Namn\n"Anna ""Nisse"" Lind"');

    expect(rows[1]).toEqual(['Anna "Nisse" Lind']);
  });

  it("reads a line break inside a quoted field", () => {
    const { rows } = parseCsv('Namn;Notering\nAnna;"Rad ett\nRad tva"');

    expect(rows).toHaveLength(2);
    expect(rows[1]?.[1]).toBe("Rad ett\nRad tva");
  });

  it("reads CRLF line endings", () => {
    const { rows } = parseCsv("Namn;Lgh\r\nAnna;1101\r\n");

    expect(rows).toEqual([
      ["Namn", "Lgh"],
      ["Anna", "1101"],
    ]);
  });

  it("skips a blank line rather than importing an empty person", () => {
    const { rows, sourceRows } = parseCsv("Namn;Lgh\nAnna;1101\n\nBo;1102\n");

    expect(rows).toHaveLength(3);
    // Bo is still on the fourth row of the sheet, which is the number the
    // preview names him by.
    expect(sourceRows).toEqual([1, 2, 4]);
  });

  it("pads a short row so the mapping cannot read the wrong field", () => {
    // A mapping reads by position. A row that stops early would otherwise leave
    // the following fields undefined by accident rather than by absence.
    const { rows } = parseCsv("Namn;Lgh;E-post\nAnna;1101");

    expect(rows[1]).toEqual(["Anna", "1101", ""]);
  });

  it("trims the padding around a value", () => {
    const { rows } = parseCsv("Namn;Lgh\n Anna ; 1101 ");

    expect(rows[1]).toEqual(["Anna", "1101"]);
  });
});

describe("writing", () => {
  it("writes a byte order mark so Excel reads it as UTF-8", () => {
    // Without it Excel reads the file as the local code page and every Swedish
    // vowel becomes a pair of symbols.
    expect(writeCsv([["Förnamn"]]).startsWith("﻿")).toBe(true);
  });

  it("quotes a value containing the delimiter", () => {
    expect(writeCsv([["Storgatan 12; port B"]])).toContain(
      '"Storgatan 12; port B"',
    );
  });

  it.each([["Lind, Anna"], ["Lind\tAnna"]])(
    "quotes %j, which a reader using another separator would split",
    (cell) => {
      expect(writeCsv([[cell]])).toBe(`\ufeff"${cell}"\r\n`);
    },
  );

  it("round-trips through the parser", () => {
    const rows = [
      ["Namn", "Adress"],
      ['Anna "Nisse" Lind', "Storgatan 12; port B"],
    ];

    expect(parseCsv(writeCsv(rows)).rows).toEqual(rows);
  });
});

/**
 * Formula injection, and the figure that must survive it.
 *
 * Every file this product hands out is written here, and their free-text
 * columns are what a board typed: a charge's reason, a creditor's name. A cell
 * beginning `=` would run as a formula in the recipient's spreadsheet
 * (CWE-1236), so it is prefixed with an apostrophe and shown as text.
 *
 * The other half is what makes this more than a one-line rule. `-` opens a
 * formula and also opens a negative amount, and an amount is the thing whoever
 * keeps the books reconciles against. Prefixing one would leave a column that
 * no longer adds up, so a cell that is a number is left exactly as it was.
 */
describe("formula injection", () => {
  const cellsOf = (written: string): string[][] => parseCsv(written, ";").rows;

  it.each([
    ["=1+1", "'=1+1"],
    ['=HYPERLINK("http://x","click")', '\'=HYPERLINK("http://x","click")'],
    ["+1+1", "'+1+1"],
    ["-1+1", "'-1+1"],
    ["@SUM(A1:A9)", "'@SUM(A1:A9)"],
    ["\tBetalning", "'\tBetalning"],
    ["\r=1+1", "'\r=1+1"],
    ["- extra stadning i trapphuset", "'- extra stadning i trapphuset"],
  ])("neutralises %j", (cell, expected) => {
    expect(cellsOf(writeCsv([[cell]]))[0]?.[0]).toBe(expected);
  });

  it.each([
    ["-450.00"],
    ["+450.00"],
    ["450.00"],
    ["-450,00"],
    ["0"],
    ["2026-01-01"],
    ["19850101-1234"],
    ["769600-1234"],
    ["260100078"],
    ["Nyckel till cykelrummet"],
  ])("leaves %j exactly as it was", (cell) => {
    expect(cellsOf(writeCsv([[cell]]))[0]?.[0]).toBe(cell);
  });

  it("leaves an empty cell empty", () => {
    // Asserted on the bytes rather than through the parser, which drops a row
    // with nothing in it at all.
    expect(writeCsv([["", "Nyckel"]])).toBe("\ufeff;Nyckel\r\n");
  });

  it.each([",", "\t"])(
    "keeps a cell whole for a reader splitting on %j",
    (separator) => {
      // Neutralisation looks at the cell's first character, so a cell split
      // at a separator inside it must not hand a reader a second field that
      // starts a formula.
      const written = writeCsv([[`Anna${separator}=1+1`]]);
      const fields = parseCsv(written, separator === "," ? "," : "\t").rows;

      expect(fields[0]?.[0]).toBe(`Anna${separator}=1+1`);
      expect(fields.flat().some((field) => field.startsWith("="))).toBe(false);
    },
  );

  it("puts the apostrophe inside the quotes where a cell needs both", () => {
    // The order matters: quoting first would put the apostrophe outside the
    // field, where it is a stray character rather than a marker.
    expect(writeCsv([["=1; DROP"]])).toContain('"\'=1; DROP"');
  });
});
