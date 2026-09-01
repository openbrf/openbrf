import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SUPPLY_COLUMNS,
  type SupplyRow,
  supplyFileName,
  writeSupplyFile,
} from "./initial-supply-file";

/**
 * The file the initial supply is made from.
 *
 * What is worth asserting is not that a serialiser joins strings. It is that
 * every row lines up with the header, because a file leaving this process is read
 * by position and a row one cell short would put a personal identity number in
 * the column before it; that the byte order mark is there, because without it
 * the Swedish titles arrive in a spreadsheet as pairs of symbols; and that the
 * columns and the document that describes them do not drift apart, which is
 * checked by reading the document rather than by restating it.
 */

const ROWS: readonly SupplyRow[] = [
  {
    recordType: "ASSOCIATION",
    associationName: "Brf Talgoxen",
    associationOrganizationNumber: "769600-1234",
    associationPropertyDesignation: "Talgoxen 4",
  },
  {
    recordType: "APARTMENT",
    apartmentKey: "Bokgatan 3 1101",
    apartmentNumber: "1101",
    apartmentAddressStreet: "Bokgatan",
    apartmentAddressNumber: "3",
    apartmentPostalCode: "11122",
    apartmentPostalCity: "Stockholm",
  },
  {
    recordType: "HOLDER",
    apartmentKey: "Bokgatan 3 1101",
    holderName: "Mira Berg",
    holderPersonalIdentityNumber: "199001011234",
    holderPostalStreet: "Bokgatan 3",
    holderPostalCode: "11122",
    holderPostalCity: "Stockholm",
    holderProtectedPersonalData: "no",
    holderHeldFrom: "2019-06-01",
    holderMembershipDecidedOn: "2019-05-20",
  },
  {
    recordType: "LIEN",
    apartmentKey: "Bokgatan 3 1101",
    lienCreditor: "Bokbanken",
    lienNotedOn: "2019-06-15",
  },
];

function lines(file: string): string[] {
  return file.replace(/^﻿/, "").trimEnd().split("\r\n");
}

describe("writeSupplyFile", () => {
  it("gives every row exactly as many cells as the header has columns", () => {
    /*
     * The assertion the file's correctness rests on. Once it has left this
     * process the cells are read by position, so a row one short does not fail:
     * it shifts every value after the gap one column to the left, and the column
     * after the address is the one that carries a personal identity number.
     */
    const [header, ...body] = lines(writeSupplyFile(ROWS));

    expect(header?.split(";")).toHaveLength(SUPPLY_COLUMNS.length);
    for (const row of body) {
      expect(row.split(";")).toHaveLength(SUPPLY_COLUMNS.length);
    }
  });

  it("writes the header as the column list, in order", () => {
    const [header] = lines(writeSupplyFile([]));

    expect(header).toBe(SUPPLY_COLUMNS.join(";"));
  });

  it("puts each value under its own column", () => {
    const [header, , , holder] = lines(writeSupplyFile(ROWS));
    const columns = header?.split(";") ?? [];
    const cells = holder?.split(";") ?? [];

    // Read out by column name rather than by index, so the assertion still means
    // something when a column is inserted ahead of these.
    const cell = (name: string): string => cells[columns.indexOf(name)] ?? "";

    expect(cell("recordType")).toBe("HOLDER");
    expect(cell("holderName")).toBe("Mira Berg");
    expect(cell("holderPersonalIdentityNumber")).toBe("199001011234");
    expect(cell("holderMembershipDecidedOn")).toBe("2019-05-20");
    // A holder row fills none of the association's or the lien note's columns.
    expect(cell("associationName")).toBe("");
    expect(cell("lienCreditor")).toBe("");
  });

  it("starts with the byte order mark that makes a spreadsheet read UTF-8", () => {
    // Without it Excel reads the file as the local code page, and every Swedish
    // vowel in a creditor's name or a street becomes a pair of symbols.
    expect(writeSupplyFile(ROWS).startsWith("﻿")).toBe(true);
  });

  it("quotes a value carrying the delimiter", () => {
    // A creditor with a semicolon in its name is unlikely and a street with a
    // line break is not: an address typed with a return in it reaches the
    // register and would otherwise end the row early.
    const file = writeSupplyFile([
      { recordType: "LIEN", lienCreditor: 'Bank; & "Co"' },
    ]);

    expect(file).toContain('"Bank; & ""Co"""');
    expect(lines(file)).toHaveLength(2);
  });

  it("writes only the header when the association holds nothing yet", () => {
    // An instance set up but not filled in supplies a file that says so, rather
    // than an empty one a receiving system cannot tell from a failed export.
    expect(lines(writeSupplyFile([]))).toHaveLength(1);
  });
});

describe("supplyFileName", () => {
  it("carries the day it was produced", () => {
    expect(supplyFileName("2027-11-30")).toBe(
      "bostadsrattsregister-uppgifter-2027-11-30.csv",
    );
  });
});

describe("the documented contract", () => {
  it("describes every column the file has, and no column it does not", () => {
    /*
     * The document is the contract a reader finds, and the columns are the
     * contract the code writes; a column added to one alone is the failure this
     * catches. Read out of the document rather than restated here, on the
     * reading report-deadline.spec.ts takes of the two-week CHECK: a column
     * dropped from the document has no row to find.
     *
     * The document names each column in the leading cell of a table row of its
     * own, which is what this matches, allowing for the padding the formatter
     * puts inside an aligned cell. The pattern requires a lower-case first
     * letter, so the record-type table beside it - whose leading cells are
     * ASSOCIATION, APARTMENT, HOLDER and LIEN - is not read as a column list,
     * and prose mentioning a column elsewhere in the file is not a row at all.
     */
    const document = readFileSync(
      join(process.cwd(), "..", "..", "docs", "register-supply-contract.md"),
      "utf8",
    );

    const documented = [...document.matchAll(/^\|\s*`([a-z][a-zA-Z]*)`\s*\|/gm)]
      .map((match) => match[1])
      .filter((column): column is string => column !== undefined);

    const alphabetical = (first: string, second: string): number =>
      first.localeCompare(second);
    expect([...documented].sort(alphabetical)).toEqual(
      [...SUPPLY_COLUMNS].sort(alphabetical),
    );
  });
});
