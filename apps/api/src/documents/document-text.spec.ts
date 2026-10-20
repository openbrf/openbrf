import { describe, expect, it, vi } from "vite-plus/test";

import {
  pdfBytes,
  textPdfBytes,
  truncatedPdfBytes,
} from "../media/testing/document-fixtures";
import {
  DOCUMENT_TEXT_LIMITS,
  type DocumentText,
  DocumentTextFailed,
  type DocumentTextLimits,
  type DocumentTextPlace,
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

/** A file the read loads once it has its place among those running. */
function loaded(bytes: Buffer): () => Promise<Buffer> {
  return () => Promise.resolve(bytes);
}

/**
 * A whole document, read the way a caller is told to: from the start, and
 * again from each answer's next until there is none. Every answer is kept, so
 * a case can hold each one to the caps.
 */
async function readThrough(
  bytes: Buffer,
  limits: DocumentTextLimits,
): Promise<{ answers: DocumentText[]; pages: Map<number, string> }> {
  const answers: DocumentText[] = [];
  const pages = new Map<number, string>();
  let next: DocumentTextPlace | null = { page: 1, character: 0 };
  while (next !== null) {
    const answer = await readDocumentText(
      loaded(bytes),
      {
        firstPage: next.page,
        firstCharacter: next.character,
        lastPage: next.page + limits.pagesPerRead - 1,
      },
      limits,
    );
    answers.push(answer);
    for (const page of answer.pages) {
      pages.set(page.number, (pages.get(page.number) ?? "") + page.text);
    }
    if (answers.length > 50) {
      throw new Error("The reads did not reach the end of the document.");
    }
    next = answer.next;
  }
  return { answers, pages };
}

describe("readDocumentText", () => {
  it("reads the pages asked for, numbered as a reader numbers them", async () => {
    const text = await readDocumentText(
      loaded(
        textPdfBytes([
          "Kallelse till föreningsstämma",
          "Dagordning",
          "Protokoll (utdrag)",
        ]),
      ),
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
      next: null,
    });
  });

  it("clips a range to the pages the file has", async () => {
    const text = await readDocumentText(loaded(textPdfBytes(["Stadgar"])), {
      firstPage: 1,
      lastPage: 10,
    });
    expect(text.pages).toEqual([{ number: 1, text: "Stadgar" }]);

    const past = await readDocumentText(loaded(textPdfBytes(["Stadgar"])), {
      firstPage: 4,
      lastPage: 5,
    });
    expect(past).toMatchObject({
      pageCount: 1,
      pages: [],
      textLayer: true,
      next: null,
    });
  });

  it("names the page after the range when the document goes on", async () => {
    const text = await readDocumentText(
      loaded(textPdfBytes(["Stadgar", "Trivselregler", "Årsredovisning"])),
      { firstPage: 1, lastPage: 2 },
    );

    expect(text).toMatchObject({
      truncated: false,
      next: { page: 3, character: 0 },
    });
  });

  it("says a scan has no text layer rather than reading the image", async () => {
    const text = await readDocumentText(loaded(textPdfBytes([null, null])), {
      firstPage: 1,
      lastPage: 2,
    });

    expect(text.textLayer).toBe(false);
    expect(text.pages.map((page) => page.text)).toEqual(["", ""]);
  });

  it("stops at the character cap, inside a page, and says where it stopped", async () => {
    const text = await readDocumentText(
      loaded(textPdfBytes(["a".repeat(40), "b".repeat(40), "c".repeat(40)])),
      { firstPage: 1, lastPage: 3 },
      { ...DOCUMENT_TEXT_LIMITS, charactersPerRead: 50 },
    );

    expect(text.truncated).toBe(true);
    expect(text.pages.map((page) => page.text.length)).toEqual([40, 10]);
    expect(text.next).toEqual({ page: 2, character: 10 });
  });

  it("starts inside a page where an earlier answer stopped", async () => {
    const text = await readDocumentText(
      loaded(textPdfBytes(["Stadgar för bostadsrättsföreningen", "§ 1"])),
      { firstPage: 1, firstCharacter: 12, lastPage: 2 },
    );

    expect(text.pages).toEqual([
      { number: 1, text: "bostadsrättsföreningen" },
      { number: 2, text: "§ 1" },
    ]);
    expect(text.next).toBeNull();
  });

  it("reads every character of pages longer than the cap, over as many reads as it takes", async () => {
    // Two pages longer than one answer holds, and pages that each fit but
    // not together: what the reads return, put back together, is the file.
    // A worker per read, one after another, which a full run of the suite on
    // a busy machine stretches past the default timeout.
    const written = [
      ["a".repeat(60), "a".repeat(60), "a".repeat(9)].join("\n"),
      "b".repeat(40),
      "c".repeat(40),
      "d".repeat(49),
      ["e".repeat(25), "e".repeat(25)].join("\n"),
    ];
    const limits = { ...DOCUMENT_TEXT_LIMITS, charactersPerRead: 50 };

    const { answers, pages } = await readThrough(textPdfBytes(written), limits);

    expect([...pages.values()]).toEqual(written);
    for (const answer of answers) {
      const characters = answer.pages.reduce(
        (sum, page) => sum + page.text.length,
        0,
      );
      expect(characters).toBeLessThanOrEqual(50);
      expect(characters).toBeGreaterThan(0);
    }
    expect(answers.at(-1)?.next).toBeNull();
  }, 30_000);

  it("reads a document past the page cap to its end, a range at a time", async () => {
    const written = Array.from(
      { length: DOCUMENT_TEXT_LIMITS.pagesPerRead * 2 + 3 },
      (_, index) => `Sida ${String(index + 1)}`,
    );

    const { answers, pages } = await readThrough(
      textPdfBytes(written),
      DOCUMENT_TEXT_LIMITS,
    );

    expect([...pages.values()]).toEqual(written);
    expect(answers).toHaveLength(3);
  }, 30_000);

  it("refuses a file over the size cap before the parser sees it", async () => {
    await expect(
      readDocumentText(
        loaded(textPdfBytes(["Årsredovisning"])),
        { firstPage: 1, lastPage: 1 },
        { ...DOCUMENT_TEXT_LIMITS, maxBytes: 10 },
      ),
    ).rejects.toMatchObject({ failure: "too-large-to-read" });
  });

  it("refuses a range over the page cap", async () => {
    await expect(
      readDocumentText(loaded(textPdfBytes(["Stadgar"])), {
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
      readDocumentText(loaded(bytes), { firstPage: 1, lastPage: 1 }),
    ).rejects.toMatchObject({ failure: "unreadable" });
  });

  it("answers a file locked with a password as such, and reads none of it", async () => {
    await expect(
      readDocumentText(
        loaded(textPdfBytes(["Styrelsens protokoll"], { locked: true })),
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
      loaded(textPdfBytes(["Stadgar"])),
      { firstPage: 1, lastPage: 1 },
      one,
    );

    // Refused before its file is loaded: the ceiling holds the decrypted
    // bytes to the reads running, not only the workers.
    const refused = vi.fn(loaded(textPdfBytes(["Trivselregler"])));
    await expect(
      readDocumentText(refused, { firstPage: 1, lastPage: 1 }, one),
    ).rejects.toMatchObject({ failure: "read-busy" });
    expect(refused).not.toHaveBeenCalled();
    await expect(first).resolves.toMatchObject({ pageCount: 1 });
    await expect(
      readDocumentText(
        loaded(textPdfBytes(["Trivselregler"])),
        { firstPage: 1, lastPage: 1 },
        one,
      ),
    ).resolves.toMatchObject({ pageCount: 1 });
  });

  it("gives its place back when loading the file fails, or the file is too large", async () => {
    const one = { ...DOCUMENT_TEXT_LIMITS, concurrentReads: 1 };

    await expect(
      readDocumentText(
        () => Promise.reject(new Error("the storage did not answer")),
        { firstPage: 1, lastPage: 1 },
        one,
      ),
    ).rejects.toThrow("the storage did not answer");
    await expect(
      readDocumentText(
        loaded(textPdfBytes(["Årsredovisning"])),
        { firstPage: 1, lastPage: 1 },
        { ...one, maxBytes: 10 },
      ),
    ).rejects.toMatchObject({ failure: "too-large-to-read" });
    await expect(
      readDocumentText(
        loaded(textPdfBytes(["Trivselregler"])),
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
      loaded(textPdfBytes(["Stadgar"])),
      { firstPage: 1, lastPage: 1 },
      { ...DOCUMENT_TEXT_LIMITS, milliseconds: 1 },
    );

    await expect(read).rejects.toBeInstanceOf(DocumentTextFailed);
    await expect(read).rejects.toMatchObject({ failure: "read-timed-out" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
