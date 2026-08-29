/**
 * A minimal document, built byte by byte.
 *
 * Enough structure to be identified and no more: what the upload path reads is
 * the signature, the version and the end-of-file marker, so a document written
 * by a real producer would add pages of object definitions that no assertion
 * here looks at. Building it by hand is also what makes the negative cases
 * possible, since a truncated or unterminated file has to be constructible.
 */

/** A PDF: a versioned header, one trivial body, and the end-of-file marker. */
export function pdfBytes(version = "1.7"): Buffer {
  return Buffer.from(
    `%PDF-${version}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
}

/** A PDF header with nothing closing it: opens as one, is not one. */
export function truncatedPdfBytes(): Buffer {
  return Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n", "latin1");
}
