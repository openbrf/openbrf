import { describe, expect, it } from "vitest";

import { readDocumentHeader } from "./document-bytes";
import { pdfBytes, truncatedPdfBytes } from "./testing/document-fixtures";
import { pngBytes } from "./testing/image-fixtures";

/**
 * What the archive will accept, decided from the bytes.
 *
 * The cases that matter are the near misses. A file whose first five bytes
 * were copied off a PDF is exactly the upload this reader exists to refuse:
 * accepting it would have the platform serve arbitrary bytes back under a type
 * it declared itself, which is the one thing identifying a file from its own
 * content is for.
 */

describe("identifying a document", () => {
  it("accepts a PDF", () => {
    expect(readDocumentHeader(pdfBytes())).toEqual({
      contentType: "application/pdf",
    });
  });

  it("accepts every version the format has defined", () => {
    for (const version of ["1.0", "1.4", "1.7", "2.0"]) {
      expect(readDocumentHeader(pdfBytes(version)), version).not.toBeNull();
    }
  });

  it("refuses a signature with no end-of-file marker behind it", () => {
    // The shape an attempt takes: the header of a document, then whatever the
    // uploader actually wanted served under application/pdf.
    expect(readDocumentHeader(truncatedPdfBytes())).toBeNull();
  });

  it("refuses a version that no PDF producer writes", () => {
    const bytes = Buffer.from("%PDF-9.9\ntrailer\n%%EOF\n", "latin1");
    expect(readDocumentHeader(bytes)).toBeNull();
  });

  it("refuses a header without the version separator", () => {
    const bytes = Buffer.from("%PDF-17x\ntrailer\n%%EOF\n", "latin1");
    expect(readDocumentHeader(bytes)).toBeNull();
  });

  it("refuses a file that only mentions the marker", () => {
    const bytes = Buffer.from("<html>%%EOF</html>", "utf8");
    expect(readDocumentHeader(bytes)).toBeNull();
  });

  it("refuses an image, which the image reader owns", () => {
    expect(readDocumentHeader(pngBytes(10, 10))).toBeNull();
  });

  it("refuses an empty file", () => {
    expect(readDocumentHeader(Buffer.alloc(0))).toBeNull();
  });

  it("finds the marker behind trailing whitespace a producer left", () => {
    const bytes = Buffer.concat([pdfBytes(), Buffer.from("\n\n\n", "latin1")]);
    expect(readDocumentHeader(bytes)).not.toBeNull();
  });
});
