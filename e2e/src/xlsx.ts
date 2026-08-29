import { strToU8, zipSync } from "fflate";

/**
 * A real .xlsx workbook, built in memory.
 *
 * The import screen accepts a spreadsheet as well as a CSV, and the only honest
 * way to check that the upload control takes one is to hand it a workbook a
 * spreadsheet program would have written. An xlsx is a zip of XML parts, so
 * building one is a page of code and needs no binary fixture in the repository
 * that nobody can read in a diff.
 *
 * A near-copy of `apps/api/src/testing/xlsx-fixture.ts`. This package is not in
 * the workspace graph of the API - it drives the built image over HTTP and
 * imports nothing from it - so the two cannot share one module. Should the
 * workbook shape ever change, it changes because the parser changed, and the
 * parser has its own tests; what this copy is for is the upload control.
 *
 * Every cell is written as a shared string. That is enough for an import, which
 * reads dates as ISO text, and it keeps the workbook free of the style table
 * that date-formatted cells would otherwise need.
 */

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

export function buildWorkbook(
  rows: readonly (readonly string[])[],
  sheetName = "Blad1",
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
        .map((value, columnIndex) =>
          value === ""
            ? ""
            : `<c r="${columnName(columnIndex)}${String(rowIndex + 1)}" t="s"><v>${String(
                indexFor(value),
              )}</v></c>`,
        )
        .join("");
      return `<row r="${String(rowIndex + 1)}">${cells}</row>`;
    })
    .join("");

  const sharedStrings = strings
    .map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`)
    .join("");

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
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
        `<Relationship Id="rId1" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/>` +
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
        '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
        "</styleSheet>",
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `${DECLARATION}<worksheet xmlns="${NAMESPACE}"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  };

  return Buffer.from(zipSync(files));
}
