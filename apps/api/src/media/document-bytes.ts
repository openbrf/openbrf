/**
 * Whether a file is a document, read from its bytes.
 *
 * The same rule image-bytes.ts states, applied to the other half of what an
 * association uploads: the type is decided here and the declared one is only
 * ever compared against this answer. A file stored as application/pdf because
 * the request said so is served back with that type, and a browser will do
 * whatever the real bytes tell it to.
 *
 * One format. The bylaws, the minutes, the house rules and the annual report
 * are published as PDF, and a format the platform cannot identify from its own
 * bytes is a format it cannot promise to serve back as what it received. An
 * office document is a ZIP container whose type is a string inside the
 * archive, which is a different kind of evidence and a decision for the change
 * that needs it.
 */

export interface DocumentHeader {
  contentType: "application/pdf";
}

/** "%PDF-", which every PDF opens with. */
const PDF_SIGNATURE = "%PDF-";

/**
 * How far back the end-of-file marker is looked for.
 *
 * The marker is the last thing in the file, but a writer may leave a newline
 * or two after it, and some producers append a short comment. A kilobyte is
 * far more slack than any of that needs and bounds the scan.
 */
const TRAILER_SCAN_BYTES = 1024;

/** Identifies the bytes, or null when they are not a document this accepts. */
export function readDocumentHeader(bytes: Buffer): DocumentHeader | null {
  return readPdf(bytes) ? { contentType: "application/pdf" } : null;
}

/**
 * Whether these bytes are a PDF.
 *
 * Three checks rather than one. The signature and a version that exists say
 * the file opens as a PDF; the end-of-file marker says it also closes as one,
 * which is the evidence that this is a document rather than a few magic bytes
 * glued to the front of something else. That is the same standard the image
 * reader holds itself to when it reads the dimensions out of the header.
 */
function readPdf(bytes: Buffer): boolean {
  if (bytes.length < PDF_SIGNATURE.length + 3) {
    return false;
  }
  if (bytes.toString("latin1", 0, PDF_SIGNATURE.length) !== PDF_SIGNATURE) {
    return false;
  }

  // "1.0" through "2.0" is every version ISO 32000 has defined; anything else
  // is a file whose header was not written by a PDF producer.
  const major = bytes[5];
  const separator = bytes[6];
  const minor = bytes[7];
  if (
    major === undefined ||
    separator !== 0x2e ||
    minor === undefined ||
    (major !== 0x31 && major !== 0x32) ||
    minor < 0x30 ||
    minor > 0x39
  ) {
    return false;
  }

  const from = Math.max(0, bytes.length - TRAILER_SCAN_BYTES);
  return bytes.toString("latin1", from).includes("%%EOF");
}
