import { describe, expect, it } from "vitest";

import { cellText } from "./workbook";

/**
 * The one date conversion in the import path, pinned.
 *
 * `read-excel-file` turns an Excel date serial into a `Date` at midnight UTC,
 * because an Excel serial is a count of days and carries no zone at all. That
 * is what makes reading its UTC fields here correct, and it is the only reason:
 * every other instant in this product is stated as the day it falls on in the
 * association's own zone. The value goes on to `parseImportDate` and then into
 * a `@db.Date` column, so UTC in and UTC out is a closed round trip.
 *
 * The risk this pins is a library change. If a future version ever decoded a
 * date cell to local midnight instead, every imported move-in date would shift
 * by a day wherever the process runs east of Greenwich, silently, and no other
 * test in the repository would say so.
 */
describe("reading a date cell", () => {
  it("states the calendar date the cell holds", () => {
    expect(cellText(new Date(Date.UTC(2026, 2, 5)))).toBe("2026-03-05");
  });

  it("reads UTC fields, which is what an Excel date serial carries", () => {
    /*
     * A serial decoded to local midnight in Stockholm would arrive as the
     * evening before in UTC. Asserting the whole instant rather than the text
     * is what makes this a statement about the library's contract: the day the
     * cell holds opens at midnight UTC and nowhere else.
     */
    const decoded = new Date(Date.UTC(2026, 5, 22));

    expect(decoded.toISOString()).toBe("2026-06-22T00:00:00.000Z");
    expect(cellText(decoded)).toBe("2026-06-22");
  });

  it("pads a single-digit month and day", () => {
    expect(cellText(new Date(Date.UTC(2026, 0, 9)))).toBe("2026-01-09");
  });
});

describe("reading every other kind of cell", () => {
  it("keeps an apartment number Excel stored as a number", () => {
    expect(cellText(1101)).toBe("1101");
  });

  it("keeps a phone number Excel ate the leading zero from", () => {
    expect(cellText(701234567)).toBe("701234567");
  });

  it("trims text and answers empty for a blank cell", () => {
    expect(cellText("  Siv Andersson  ")).toBe("Siv Andersson");
    expect(cellText(null)).toBe("");
    expect(cellText(undefined)).toBe("");
  });
});
