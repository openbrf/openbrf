import { crc32, deflateRawSync } from "node:zlib";

import { unzipSync } from "fflate";
import { readSheet } from "read-excel-file/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildWorkbook } from "../testing/xlsx-fixture";
import {
  MAX_IMPORT_CELL_LENGTH,
  MAX_IMPORT_ROWS,
  MAX_WORKBOOK_EMPTY_ROW,
  MAX_WORKBOOK_ENTRY_BYTES,
} from "./import-limits";
import { UnreadableSheetError } from "./sheet-addresses";
import { cellText, inspectWorkbook, parseWorkbook } from "./workbook";

vi.mock("read-excel-file/node", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("read-excel-file/node")>();
  return { ...original, readSheet: vi.fn(original.readSheet) };
});

beforeEach(() => {
  vi.mocked(readSheet).mockClear();
});

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

  /*
   * Every one of these is valid XML that the library reads as an address far
   * down or far right. Each is refused before the library is called.
   */
  it.each([
    [
      "a row number written as a power of ten",
      '<row r="1e9"><c r="A1"><v>1</v></c></row>',
    ],
    [
      "a cell row written as a power of ten",
      '<row><c r="A1e9"><v>1</v></c></row>',
    ],
    ["a column in lower case", '<row r="1"><c r="zzzzz1"><v>1</v></c></row>'],
    [
      "an address in single quotes",
      "<row r='20000'><c r='GR20000'><v>1</v></c></row>",
    ],
    [
      "a prefixed element",
      '<x:row r="20000"><x:c r="A20000"><x:v>1</x:v></x:c></x:row>',
    ],
    [
      "a prefixed attribute",
      '<row x:r="20000"><c x:r="A20000"><v>1</v></c></row>',
    ],
    [
      "a character reference",
      '<row r="&#50;0000"><c r="A&#50;0000"><v>1</v></c></row>',
    ],
    [
      "an address with a space in it",
      '<row r=" 20000"><c r="A1"><v>1</v></c></row>',
    ],
    [
      "a row number in hexadecimal",
      '<row r="0x3B9ACA00"><c r="A1"><v>1</v></c></row>',
    ],
    [
      "a row number its cell does not state",
      '<row r="65536"><c r="GR2" t="inlineStr"><is><t>x</t></is></c></row>',
    ],
    [
      "a row number stated on the row around a row",
      '<row r="65536"><row><c r="A2" t="inlineStr"><is><t>x</t></is></c></row></row>',
    ],
    [
      "rows that state no number below a wide row",
      '<row r="1"><c r="GR1" t="inlineStr"><is><t>x</t></is></c></row>' +
        "<row/>".repeat(70_000),
    ],
    [
      "rows that close without opening",
      '<row r="1"><c r="GR1" t="inlineStr"><is><t>x</t></is></c></row>' +
        "</row>".repeat(70_000),
    ],
    [
      "a cell outside the row its first cell names",
      '<row><c r="A2" s="0"/><c r="B3" t="inlineStr"><is><t>x</t></is></c></row>',
    ],
    [
      "a second list of rows, where the parser counts again",
      '<row r="65536"/></sheetData><sheetData>' +
        '<row r="1"><c r="GR1" t="inlineStr"><is><t>x</t></is></c></row>',
    ],
    [
      "a second list of rows under a prefix",
      '<row r="65536"/></sheetData><x:sheetData>' +
        '<row r="1"><c r="GR1" t="inlineStr"><is><t>x</t></is></c></row>',
    ],
    [
      "a second, empty list of rows",
      '<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row><sheetData/>',
    ],
  ])("refuses %s before the parser reads it", async (_, sheetData) => {
    const workbook = buildWorkbook([], "Blad1", { sheetData });

    expect(() => inspectWorkbook(workbook)).toThrow();
    await expect(parseWorkbook(workbook)).rejects.toThrow();
    expect(readSheet).not.toHaveBeenCalled();
  });

  it("refuses a cell outside the row that holds it", async () => {
    // The library would read Anna as row 3, whatever her cell says.
    const workbook = buildWorkbook([], "Blad1", {
      sheetData:
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Namn</t></is></c></row>' +
        '<row r="3"><c r="A2" t="inlineStr"><is><t>Anna</t></is></c></row>',
    });

    expect(() => inspectWorkbook(workbook)).toThrow(UnreadableSheetError);
    await expect(parseWorkbook(workbook)).rejects.toThrow(UnreadableSheetError);
    expect(readSheet).not.toHaveBeenCalled();
  });

  it("reads rows that leave their number to their cells", async () => {
    const workbook = buildWorkbook([], "Blad1", {
      sheetData:
        '<row><c r="A1" t="inlineStr"><is><t>Namn</t></is></c></row>' +
        '<row><c r="A2" t="inlineStr"><is><t>Anna</t></is></c></row>' +
        '<row r="3"/><row><c r="A4" t="inlineStr"><is><t>Bo</t></is></c></row>',
    });

    await expect(parseWorkbook(workbook)).resolves.toEqual([
      ["Namn"],
      ["Anna"],
      ["Bo"],
    ]);
  });

  it("reads rows that state no number down to the import's last row", async () => {
    const header =
      '<row><c r="A1" t="inlineStr"><is><t>Namn</t></is></c></row>';
    const anna = '<row><c r="A2" t="inlineStr"><is><t>Anna</t></is></c></row>';
    // The header and Anna, then empty rows down to the last row a file holds.
    const lastRow = header + anna + "<row/>".repeat(MAX_IMPORT_ROWS - 1);

    await expect(
      parseWorkbook(buildWorkbook([], "Blad1", { sheetData: lastRow })),
    ).resolves.toEqual([["Namn"], ["Anna"]]);
    expect(() =>
      inspectWorkbook(
        buildWorkbook([], "Blad1", { sheetData: `${lastRow}<row/>` }),
      ),
    ).toThrow(expect.objectContaining({ reason: "too-many-rows" }));
  });

  it("checks a sheet the workbook stores outside xl/worksheets", () => {
    const workbook = buildWorkbook([], "Blad1", {
      sheetTarget: "sheet1.xml",
      sheetData: '<row r="1000000"><c r="A1000000"><v>1</v></c></row>',
    });

    expect(() => inspectWorkbook(workbook)).toThrow(
      expect.objectContaining({ reason: "too-many-rows" }),
    );
  });

  it.each([
    ["an unclosed tag", "<row ".repeat(1_600_000)],
    ["one tag with every attribute", `<c ${'a="1" '.repeat(1_100_000)}>`],
    ["unmatched quotes", `<row ${"'\"".repeat(3_000_000)}`],
  ])("reads %s in time proportional to its size", (_, sheetData) => {
    const workbook = buildWorkbook([], "Blad1", { sheetData });

    const started = performance.now();
    try {
      inspectWorkbook(workbook);
    } catch {
      // Refused or accepted, it has to be quick about it.
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("reads a list formatted far below its last row", async () => {
    const workbook = buildWorkbook([], "Blad1", {
      sheetData:
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Namn</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Anna</t></is></c></row>' +
        '<row r="8000" s="1" customFormat="1"><c r="A8000" s="0"/><c r="XFD8000" s="0"/></row>',
    });

    await expect(parseWorkbook(workbook)).resolves.toEqual([
      ["Namn"],
      ["Anna"],
    ]);
  });

  it("refuses an empty row further down than any formatted list reaches", () => {
    const row = String(MAX_WORKBOOK_EMPTY_ROW + 1);
    const workbook = buildWorkbook([], "Blad1", {
      sheetData: `<row r="${row}" s="1" customFormat="1"><c r="A${row}" s="0"/></row>`,
    });

    expect(() => inspectWorkbook(workbook)).toThrow(
      expect.objectContaining({ reason: "too-many-rows" }),
    );
  });

  it("hands the parser an archive whose parts are the sizes they say", async () => {
    // The sheet says its sizes follow its data, and states one it has not.
    const workbook = withTrailingSize(
      buildWorkbook([
        ["Namn", "Lgh"],
        ["Anna", "1101"],
      ]),
      "xl/worksheets/sheet1.xml",
      0x20000000,
    );

    await expect(parseWorkbook(workbook)).resolves.toEqual([
      ["Namn", "Lgh"],
      ["Anna", "1101"],
    ]);
    const [read] = vi.mocked(readSheet).mock.calls[0] ?? [];
    expect(Buffer.isBuffer(read)).toBe(true);
    const archive = read as Buffer;
    for (const header of localHeaders(archive)) {
      expect(header.flags & 0x0008).toBe(0);
    }
    const parts = unzipSync(archive);
    for (const header of localHeaders(archive)) {
      expect(header.size).toBe(parts[header.name]?.length);
    }
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
 * Writes the archive again with one part marked as followed by a data
 * descriptor, which states its real sizes, while its local header states
 * `declared` as its uncompressed size.
 */
function withTrailingSize(
  archive: Buffer,
  name: string,
  declared: number,
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [entry, data] of Object.entries(unzipSync(archive))) {
    const trailing = entry === name;
    const encoded = Buffer.from(entry, "utf8");
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(trailing ? 0x0008 : 0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(trailing ? declared : data.length, 22);
    header.writeUInt16LE(encoded.length, 26);
    const descriptor = Buffer.alloc(trailing ? 16 : 0);
    if (trailing) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
    }
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    header.copy(record, 8, 6, 26);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(encoded.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(header, encoded, compressed, descriptor);
    central.push(record, encoded);
    offset +=
      header.length + encoded.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function localHeaders(
  archive: Buffer,
): { offset: number; name: string; flags: number; size: number }[] {
  const headers = [];
  for (let offset = 0; offset < archive.length - 30; offset++) {
    if (archive.readUInt32LE(offset) === 0x04034b50) {
      const nameLength = archive.readUInt16LE(offset + 26);
      headers.push({
        offset,
        name: archive.toString("utf8", offset + 30, offset + 30 + nameLength),
        flags: archive.readUInt16LE(offset + 6),
        size: archive.readUInt32LE(offset + 22),
      });
    }
  }
  return headers;
}

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
