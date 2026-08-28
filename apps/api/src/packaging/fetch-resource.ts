import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Fetching a catalog index or a release tarball.
 *
 * Three schemes are allowed and nothing else. https is the production case;
 * http exists for a catalog served inside a compose network; file: is what
 * lets the end-to-end harness point at tarballs baked into the test image and
 * exercise the real verification path with no network at all (plan section 6,
 * S8). Node's fetch does not implement file:, so it is read directly.
 *
 * The allow-list is the point of the function. Without it a catalog entry -
 * which is data fetched from elsewhere - could name a scheme the runtime
 * happens to support and have the instance read from it.
 */

const ALLOWED_PROTOCOLS = new Set(["https:", "http:", "file:"]);

export class ResourceFetchError extends Error {
  constructor(
    message: string,
    readonly reason: "unsupported-scheme" | "unreachable" | "too-large",
  ) {
    super(message);
    this.name = "ResourceFetchError";
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Refuses anything larger, before it is held in memory. */
  maxBytes?: number;
}

/** 64 MiB. A plugin tarball an order of magnitude past this is a mistake. */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export async function fetchBytes(
  url: string,
  options: FetchOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ResourceFetchError(`Not a URL: ${url}`, "unsupported-scheme");
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new ResourceFetchError(
      `${parsed.protocol} is not an allowed source; use https, http or file.`,
      "unsupported-scheme",
    );
  }

  const bytes =
    parsed.protocol === "file:"
      ? await readLocalFile(parsed)
      : await readOverHttp(parsed, options.headers ?? {});

  if (bytes.byteLength > maxBytes) {
    throw new ResourceFetchError(
      `${url} is ${String(bytes.byteLength)} bytes, over the ${String(maxBytes)} byte limit.`,
      "too-large",
    );
  }

  return bytes;
}

async function readLocalFile(url: URL): Promise<Buffer> {
  try {
    return await readFile(fileURLToPath(url));
  } catch {
    throw new ResourceFetchError(
      `${url.href} could not be read.`,
      "unreachable",
    );
  }
}

async function readOverHttp(
  url: URL,
  headers: Record<string, string>,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "follow" });
  } catch {
    throw new ResourceFetchError(
      `${url.href} could not be reached.`,
      "unreachable",
    );
  }

  if (!response.ok) {
    throw new ResourceFetchError(
      `${url.href} answered ${String(response.status)}.`,
      "unreachable",
    );
  }

  return Buffer.from(await response.arrayBuffer());
}
