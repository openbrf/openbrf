import { randomUUID } from "node:crypto";

import type { APIRequestContext } from "@playwright/test";

import { pdfBytes } from "./documents";
import { stack } from "./stack";

/**
 * The apartment binder, as the suite uses it.
 *
 * The screen is what the criterion is about, so the spec files an entry through
 * the form. What lives here is the part no screen owns: an entry built for one
 * run so a rerun against a kept stack cannot read a row an earlier run wrote,
 * the direct fetch of a stored file, which is where the audience is really
 * enforced, and the household's own listing over HTTP.
 */

export interface BinderEntryFixture {
  /** Unique to this call, so an assertion finds the row it wrote. */
  title: string;
  fileName: string;
  bytes: Buffer;
}

/** One entry's title, file name and bytes, unique to this call. */
export function binderEntry(title: string): BinderEntryFixture {
  const suffix = randomUUID().slice(0, 8);

  return {
    title: `${title} ${suffix}`,
    fileName: `${suffix}.pdf`,
    bytes: pdfBytes(title),
  };
}

/** A stored file, as whoever asked for it is answered. */
export interface StoredFile {
  status: number;
  body: string;
}

/**
 * Fetches a stored file with this context's own session.
 *
 * The status and the body both, because the refusal parity is the assertion:
 * a file this account may not read and one that does not exist have to answer
 * alike, or the identifier space can be walked to learn what a household has
 * filed.
 */
export async function fetchStored(
  request: APIRequestContext,
  url: string,
): Promise<StoredFile> {
  const response = await request.get(`${stack.baseUrl}${url}`);
  return { status: response.status(), body: await response.text() };
}

/** One binder, as the household listing answers it. */
export interface BinderListing {
  readonly apartmentId: string;
  readonly apartment: string;
  readonly isTenantOwner: boolean;
  readonly entries: readonly {
    readonly id: string;
    readonly title: string;
    readonly audience: "TENANT_OWNERS" | "HOUSEHOLD";
    readonly filedAs: "BOARD" | "TENANT_OWNER";
    readonly url: string;
  }[];
}

/** Every binder this context's session reads today. */
export async function readBinders(
  request: APIRequestContext,
): Promise<readonly BinderListing[]> {
  const response = await request.get(`${stack.baseUrl}/api/apartment-binder`);
  if (!response.ok()) {
    throw new Error(
      `GET /api/apartment-binder answered ${String(response.status())}`,
    );
  }
  return (await response.json()) as BinderListing[];
}
