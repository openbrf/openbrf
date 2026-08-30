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

/**
 * Files a document over HTTP, on the shelf it is meant for.
 *
 * The archive screen has its own coverage in 21-documents, where filing one is
 * the criterion. Here it is the arrangement a spec about the website needs -
 * there has to be something on each shelf before a page can be asked which of
 * them it lists - so it is done the cheap way, without a browser sign-in the
 * spec does not otherwise need.
 *
 * The caller's context has to be signed in as somebody holding
 * documents:manage.
 */
export async function fileDocument(
  request: APIRequestContext,
  input: DocumentFixture & { audience: "BOARD" | "MEMBER" | "PUBLIC" },
): Promise<ArchivedDocument> {
  const response = await request.post(`${stack.baseUrl}/api/documents`, {
    multipart: {
      title: input.title,
      category: input.category,
      audience: input.audience,
      file: {
        name: input.fileName,
        mimeType: "application/pdf",
        buffer: input.bytes,
      },
    },
  });
  if (!response.ok()) {
    throw new Error(
      `POST /api/documents answered ${String(response.status())}: ${await response.text()}`,
    );
  }
  return (await response.json()) as ArchivedDocument;
}

/** Takes a document this suite filed back out of the archive. */
export async function removeDocument(
  request: APIRequestContext,
  id: string,
): Promise<void> {
  const response = await request.delete(`${stack.baseUrl}/api/documents/${id}`);
  // One a spec already removed is not a failure of the cleanup after it.
  if (!response.ok() && response.status() !== 404) {
    throw new Error(
      `DELETE /api/documents/:id answered ${String(response.status())}`,
    );
  }
}
