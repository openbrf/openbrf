import { describe, expect, it } from "vitest";

import { detectDelimiter, parseCsv, writeCsv } from "./csv";

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
    const { rows } = parseCsv("Namn;Lgh\nAnna;1101\n\nBo;1102\n");

    expect(rows).toHaveLength(3);
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

  it("round-trips through the parser", () => {
    const rows = [
      ["Namn", "Adress"],
      ['Anna "Nisse" Lind', "Storgatan 12; port B"],
    ];

    expect(parseCsv(writeCsv(rows)).rows).toEqual(rows);
  });
});
