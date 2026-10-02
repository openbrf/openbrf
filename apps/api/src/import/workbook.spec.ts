import { describe, expect, it } from "vitest";

import { buildWorkbook } from "../testing/xlsx-fixture";
import {
  MAX_IMPORT_CELL_LENGTH,
  MAX_WORKBOOK_ENTRY_BYTES,
} from "./import-limits";
import { cellText, inspectWorkbook, parseWorkbook } from "./workbook";

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

describe("a workbook past the import's limits", () => {
  it("refuses a row address a billion rows down before the parser fills the gap", () => {
    const workbook = buildWorkbook([], "Blad1", {
      sheetData:
        '<row r="1000000000"><c r="A1000000000" t="inlineStr"><is><t>x</t></is></c></row>',
    });

    const started = performance.now();
    expect(() => {
      inspectWorkbook(workbook);
    }).toThrow(expect.objectContaining({ reason: "too-many-rows" }));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses a cell past the last column the import maps", () => {
    const workbook = buildWorkbook([], "Blad1", {
      sheetData:
        '<row r="1"><c r="XFE1" t="inlineStr"><is><t>x</t></is></c></row>',
    });

    expect(() => {
      inspectWorkbook(workbook);
    }).toThrow(expect.objectContaining({ reason: "too-many-columns" }));
  });

  it("refuses a part that inflates past its limit", () => {
    // A few kilobytes compressed, megabytes inflated.
    const workbook = buildWorkbook([["Namn"]], "Blad1", {
      sharedStrings: `<si><t>${"a".repeat(MAX_WORKBOOK_ENTRY_BYTES)}</t></si>`,
    });
    expect(workbook.byteLength).toBeLessThan(64 * 1024);

    expect(() => {
      inspectWorkbook(workbook);
    }).toThrow(expect.objectContaining({ reason: "workbook-too-large" }));
  });

  it("counts what a part inflates to rather than the size it declares", () => {
    const workbook = buildWorkbook([["Namn"]], "Blad1", {
      sharedStrings: `<si><t>${"a".repeat(MAX_WORKBOOK_ENTRY_BYTES)}</t></si>`,
    });
    declareSize(workbook, "xl/sharedStrings.xml", 100);

    expect(() => {
      inspectWorkbook(workbook);
    }).toThrow(expect.objectContaining({ reason: "workbook-too-large" }));
  });

  it("refuses a cell longer than the import takes", () => {
    expect(() => cellText("x".repeat(MAX_IMPORT_CELL_LENGTH + 1))).toThrow(
      expect.objectContaining({ reason: "cell-too-long" }),
    );
  });

  it("reads a workbook inside every limit", async () => {
    const workbook = buildWorkbook([
      ["Namn", "Lgh"],
      ["Anna", "1101"],
    ]);

    await expect(parseWorkbook(workbook)).resolves.toEqual([
      ["Namn", "Lgh"],
      ["Anna", "1101"],
    ]);
  });
});

/**
 * Rewrites the uncompressed size an archive states for one part, in its local
 * header and in the central directory, leaving the data as it was.
 */
function declareSize(archive: Buffer, name: string, size: number): void {
  const encoded = Buffer.from(name, "utf8");
  for (let offset = 0; offset < archive.length - 4; offset++) {
    const signature = archive.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      const nameLength = archive.readUInt16LE(offset + 26);
      if (
        archive.subarray(offset + 30, offset + 30 + nameLength).equals(encoded)
      ) {
        archive.writeUInt32LE(size, offset + 22);
      }
    } else if (signature === 0x02014b50) {
      const nameLength = archive.readUInt16LE(offset + 28);
      if (
        archive.subarray(offset + 46, offset + 46 + nameLength).equals(encoded)
      ) {
        archive.writeUInt32LE(size, offset + 24);
      }
    }
  }
}
