import { zipSync, strToU8 } from "fflate";

/**
 * Builds a real .xlsx workbook from rows of text.
 *
 * An import that claims to read Excel has to be tested against an actual
 * workbook rather than against a stub of the parser, and the alternative to
 * this is a binary fixture committed to the repository that nobody can read in
 * a diff. An xlsx is a zip of XML parts, so building one is a page of code and
 * the test stays inspectable.
 *
 * A cell is written as a shared string, which is enough for an import that
 * reads dates as ISO text, or - given as `{ date: "YYYY-MM-DD" }` - as the date
 * serial and date format Excel itself writes, for the test that pins how the
 * library decodes one.
 */

/** A date cell, written as Excel writes one: a day serial with a date format. */
export interface WorkbookDate {
  date: string;
}

/** Days from Excel's day zero, 1899-12-30, to a calendar date. */
function dateSerial(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) / 86_400_000 + 25_569;
}

const NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIPS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS =
  "http://schemas.openxmlformats.org/package/2006/relationships";

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Spreadsheet column name: 0 is A, 26 is AA. */
function columnName(index: number): string {
  let name = "";
  let remaining = index;
  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return name;
}

export interface WorkbookOverrides {
  /** Written as the sheet's `<sheetData>` in place of the rows. */
  sheetData?: string;
  /** Written as the shared strings table in place of the rows' own. */
  sharedStrings?: string;
  /**
   * Where in the archive the sheet is stored, relative to `xl/` as the
   * workbook's relationships name it. `worksheets/sheet1.xml` by default.
   */
  sheetTarget?: string;
}

export function buildWorkbook(
  rows: readonly (readonly (string | WorkbookDate)[])[],
  sheetName = "Blad1",
  overrides: WorkbookOverrides = {},
): Buffer {
  const strings: string[] = [];
  const indexOf = new Map<string, number>();
  const indexFor = (value: string): number => {
    const existing = indexOf.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const index = strings.length;
    strings.push(value);
    indexOf.set(value, index);
    return index;
  };

  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${columnName(columnIndex)}${String(rowIndex + 1)}`;
          if (typeof value !== "string") {
            // Style 1 is the built-in short date format, numFmtId 14.
            return `<c r="${reference}" s="1"><v>${String(dateSerial(value.date))}</v></c>`;
          }
          return value === ""
            ? ""
            : `<c r="${reference}" t="s"><v>${String(indexFor(value))}</v></c>`;
        })
        .join("");
      return `<row r="${String(rowIndex + 1)}">${cells}</row>`;
    })
    .join("");

  const sheetTarget = overrides.sheetTarget ?? "worksheets/sheet1.xml";
  const sharedStrings =
    overrides.sharedStrings ??
    strings
      .map(
        (value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`,
      )
      .join("");

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        `<Override PartName="/xl/${sheetTarget}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        "</Types>",
    ),
    "_rels/.rels": strToU8(
      `${DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
        `<Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/>` +
        "</Relationships>",
    ),
    "xl/workbook.xml": strToU8(
      `${DECLARATION}<workbook xmlns="${NAMESPACE}" xmlns:r="${RELATIONSHIPS}">` +
        `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
        "</workbook>",
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `${DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
        `<Relationship Id="rId1" Type="${RELATIONSHIPS}/worksheet" Target="${sheetTarget}"/>` +
        `<Relationship Id="rId2" Type="${RELATIONSHIPS}/sharedStrings" Target="sharedStrings.xml"/>` +
        `<Relationship Id="rId3" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/>` +
        "</Relationships>",
    ),
    "xl/sharedStrings.xml": strToU8(
      `${DECLARATION}<sst xmlns="${NAMESPACE}" count="${String(strings.length)}" uniqueCount="${String(
        strings.length,
      )}">${sharedStrings}</sst>`,
    ),
    "xl/styles.xml": strToU8(
      `${DECLARATION}<styleSheet xmlns="${NAMESPACE}">` +
        '<numFmts count="0"/>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
        "</styleSheet>",
    ),
    [`xl/${sheetTarget}`]: strToU8(
      `${DECLARATION}<worksheet xmlns="${NAMESPACE}"><sheetData>${overrides.sheetData ?? sheetRows}</sheetData></worksheet>`,
    ),
  };

  return Buffer.from(zipSync(files));
}
