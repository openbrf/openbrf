import { randomUUID } from "node:crypto";

import type { APIRequestContext } from "@playwright/test";

import { stack } from "./stack";

/**
 * The document archive, as the suite uses it.
 *
 * The screen is what the criterion is about, so the spec files a document
 * through the form. What lives here is the part no screen owns: a document
 * built for one run so a rerun against a kept stack cannot read a row an
 * earlier run wrote, and the direct fetch of a file, which is the assertion
 * the archive actually exists for.
 */

export interface DocumentFixture {
  title: string;
  category: string;
  fileName: string;
  bytes: Buffer;
}

/**
 * A PDF, built by hand.
 *
 * The API identifies a file from its own bytes, so a document has to open with
 * the signature and close with the end-of-file marker to be accepted at all.
 * That is the whole of what these bytes need to be, and building them here
 * keeps the suite free of a checked-in binary.
 */
export function pdfBytes(text: string): Buffer {
  return Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${text}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
}

/** A document unique to this call, so an assertion finds the one it wrote. */
export function documentFixture(input: {
  title: string;
  category: string;
}): DocumentFixture {
  const suffix = randomUUID().slice(0, 8);
  const title = `${input.title} ${suffix}`;

  return {
    title,
    category: input.category,
    fileName: `${suffix}.pdf`,
    bytes: pdfBytes(title),
  };
}

export interface ArchivedDocument {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly audience: "BOARD" | "MEMBER" | "PUBLIC";
  readonly url: string;
}

/** The shelf this request context is shown. */
export async function readArchive(
  request: APIRequestContext,
): Promise<readonly ArchivedDocument[]> {
  const response = await request.get(`${stack.baseUrl}/api/documents`);
  if (!response.ok()) {
    throw new Error(`GET /api/documents answered ${String(response.status())}`);
  }
  return (await response.json()) as ArchivedDocument[];
}

/** The document with this title on a shelf, or undefined when it is not on it. */
export function documentNamed(
  shelf: readonly ArchivedDocument[],
  title: string,
): ArchivedDocument | undefined {
  return shelf.find((entry) => entry.title === title);
}
