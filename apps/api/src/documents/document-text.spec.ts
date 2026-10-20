import { describe, expect, it } from "vite-plus/test";

import {
  pdfBytes,
  textPdfBytes,
  truncatedPdfBytes,
} from "../media/testing/document-fixtures";
import {
  DOCUMENT_TEXT_LIMITS,
  DocumentTextFailed,
  readDocumentText,
} from "./document-text";

/**
 * Reading a PDF's text in a worker, against real files.
 *
 * Every case here runs the parser for real, in the worker the API runs it in,
 * because the caps are properties of that arrangement rather than of a
 * function: a time cap is only a cap if the thread it stops is not the one
 * that would have to notice.
 */

describe("readDocumentText", () => {
  it("reads the pages asked for, numbered as a reader numbers them", async () => {
    const text = await readDocumentText(
      textPdfBytes([
        "Kallelse till föreningsstämma",
        "Dagordning",
        "Protokoll (utdrag)",
      ]),
      { firstPage: 2, lastPage: 3 },
    );

    expect(text).toEqual({
      pageCount: 3,
      pages: [
        { number: 2, text: "Dagordning" },
        { number: 3, text: "Protokoll (utdrag)" },
      ],
      textLayer: true,
      truncated: false,
    });
  });

  it("clips a range to the pages the file has", async () => {
    const text = await readDocumentText(textPdfBytes(["Stadgar"]), {
      firstPage: 1,
      lastPage: 10,
    });
    expect(text.pages).toEqual([{ number: 1, text: "Stadgar" }]);

    const past = await readDocumentText(textPdfBytes(["Stadgar"]), {
      firstPage: 4,
      lastPage: 5,
    });
    expect(past).toMatchObject({ pageCount: 1, pages: [], textLayer: true });
  });

  it("says a scan has no text layer rather than reading the image", async () => {
    const text = await readDocumentText(textPdfBytes([null, null]), {
      firstPage: 1,
      lastPage: 2,
    });

    expect(text.textLayer).toBe(false);
    expect(text.pages.map((page) => page.text)).toEqual(["", ""]);
  });

  it("stops at the character cap and says it did", async () => {
    const text = await readDocumentText(
      textPdfBytes(["a".repeat(40), "b".repeat(40), "c".repeat(40)]),
      { firstPage: 1, lastPage: 3 },
      { ...DOCUMENT_TEXT_LIMITS, charactersPerRead: 50 },
    );

    expect(text.truncated).toBe(true);
    expect(text.pages.map((page) => page.text.length)).toEqual([40, 10]);
  });

  it("refuses a file over the size cap before the parser sees it", async () => {
    await expect(
      readDocumentText(
        textPdfBytes(["Årsredovisning"]),
        { firstPage: 1, lastPage: 1 },
        { ...DOCUMENT_TEXT_LIMITS, maxBytes: 10 },
      ),
    ).rejects.toMatchObject({ failure: "too-large-to-read" });
  });

  it("refuses a range over the page cap", async () => {
    await expect(
      readDocumentText(textPdfBytes(["Stadgar"]), {
        firstPage: 1,
        lastPage: DOCUMENT_TEXT_LIMITS.pagesPerRead + 1,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it.each([
    ["a file that only opens like a PDF", truncatedPdfBytes()],
    ["a PDF with no pages object", pdfBytes()],
    ["bytes that are no PDF at all", Buffer.from("not a pdf")],
  ])("answers %s as unreadable", async (_name, bytes) => {
    await expect(
      readDocumentText(bytes, { firstPage: 1, lastPage: 1 }),
    ).rejects.toMatchObject({ failure: "unreadable" });
  });

  it("answers a file locked with a password as such, and reads none of it", async () => {
    await expect(
      readDocumentText(
        textPdfBytes(["Styrelsens protokoll"], { locked: true }),
        {
          firstPage: 1,
          lastPage: 1,
        },
      ),
    ).rejects.toMatchObject({ failure: "password-protected" });
  });

  it("refuses a read past the number running at once, and takes one again after", async () => {
    const one = { ...DOCUMENT_TEXT_LIMITS, concurrentReads: 1 };
    const first = readDocumentText(
      textPdfBytes(["Stadgar"]),
      { firstPage: 1, lastPage: 1 },
      one,
    );

    await expect(
      readDocumentText(
        textPdfBytes(["Trivselregler"]),
        { firstPage: 1, lastPage: 1 },
        one,
      ),
    ).rejects.toMatchObject({ failure: "read-busy" });
    await expect(first).resolves.toMatchObject({ pageCount: 1 });
    await expect(
      readDocumentText(
        textPdfBytes(["Trivselregler"]),
        { firstPage: 1, lastPage: 1 },
        one,
      ),
    ).resolves.toMatchObject({ pageCount: 1 });
  });

  it("terminates a read that runs over the time cap", async () => {
    // One millisecond is less than the parser takes to load, so this is the
    // timer firing while the worker is still busy, and the worker being
    // stopped rather than left to finish.
    const started = Date.now();
    const read = readDocumentText(
      textPdfBytes(["Stadgar"]),
      { firstPage: 1, lastPage: 1 },
      { ...DOCUMENT_TEXT_LIMITS, milliseconds: 1 },
    );

    await expect(read).rejects.toBeInstanceOf(DocumentTextFailed);
    await expect(read).rejects.toMatchObject({ failure: "read-timed-out" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
