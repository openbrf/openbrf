import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { DomainError } from "../http/domain-error";
import { Inject } from "@nestjs/common";

/**
 * Where a theme package comes from, and how it is proven to be the right one.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS A SEAM.
 *
 * The curated catalog and the download-and-verify step are shared with the
 * plugin system, which owns them. When the two land together, replace the body
 * of CatalogThemeSource with the plugin system's catalog client and package
 * verifier, and keep the ThemeSource interface: nothing above this file knows
 * how a package is fetched, only that fetchPackage returns bytes whose sha512
 * matched what the catalog stated.
 *
 * The catalog entry schema below is the subset a theme install needs (id, type,
 * version, tarball URL, sha512, contract range). If the shared schema carries
 * more, parsing more here is additive and changes nothing above.
 * ---------------------------------------------------------------------------
 *
 * Two things are deliberate and should survive the replacement:
 *
 *   A catalog URL may be a filesystem path. That is what lets CI and the
 *   integration suite run the real install path against a fixture catalog and
 *   packages built in the repository, with the same verification code and no
 *   network.
 *
 *   The download is capped and verified before anything is written to disk. A
 *   package that fails its checksum never reaches the data volume.
 */

/** Matches the archive reader's ceiling: a theme is data, not a payload. */
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;

/**
 * How long a catalog or package fetch may take before it is abandoned.
 *
 * The byte caps above bound size, not time. A host that completes the handshake
 * and then sends nothing would otherwise leave the fetch pending for as long as
 * it cared to: the install runs inline in the request, so the request handler
 * and its database connection would be held for exactly that long. A catalog is
 * data, and a fetch that stalls is a failed fetch.
 */
const FETCH_TIMEOUT_MS = 30_000;

export const catalogEntrySchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(["theme", "plugin"]),
  name: z.string().min(1).max(200),
  description: z.string().max(600).optional(),
  version: z.string().min(1).max(64),
  /** Direct tarball URL, or a path relative to the catalog file. */
  url: z.string().min(1).max(2000),
  /** Hex, or the `sha512-<base64>` form npm and pnpm write. */
  sha512: z.string().min(16).max(200),
  /** Token contract range for a theme; the API version range for a plugin. */
  contract: z.string().max(64).optional(),
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogSchema = z.object({
  entries: z.array(catalogEntrySchema).max(500),
});

export class ThemeSourceError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "catalog-not-configured"
      | "catalog-unreachable"
      | "catalog-invalid"
      | "package-unreachable"
      | "package-too-large"
      | "checksum-mismatch",
  ) {
    super(message);
    this.status =
      reason === "catalog-not-configured"
        ? HttpStatus.SERVICE_UNAVAILABLE
        : reason === "checksum-mismatch"
          ? HttpStatus.BAD_GATEWAY
          : HttpStatus.BAD_GATEWAY;
  }
}

/** What the theme installer needs from wherever packages live. */
export interface ThemeSource {
  /** Every theme in the catalog. Plugins are filtered out here. */
  listThemes(): Promise<CatalogEntry[]>;
  /** The entry's package, with its sha512 already verified. */
  fetchPackage(entry: CatalogEntry): Promise<Uint8Array>;
}

/** Normalises both checksum spellings to lowercase hex for comparison. */
export function normalizeSha512(value: string): string | null {
  const trimmed = value.trim();
  if (/^[0-9a-f]{128}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const sri = /^sha512-([A-Za-z0-9+/=]+)$/.exec(trimmed);
  if (sri?.[1] !== undefined) {
    const decoded = Buffer.from(sri[1], "base64");
    return decoded.length === 64 ? decoded.toString("hex") : null;
  }
  return null;
}

/** True when the bytes hash to the stated checksum. */
export function checksumMatches(bytes: Uint8Array, stated: string): boolean {
  const expected = normalizeSha512(stated);
  if (expected === null) {
    return false;
  }
  const actual = createHash("sha512").update(bytes).digest("hex");
  // Length is fixed and both sides are hex, so a plain comparison leaks
  // nothing an attacker does not already know: the checksum is public catalog
  // content, not a secret.
  return actual === expected;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Resolves a catalog location to a URL.
 *
 * A bare filesystem path is accepted and turned into a file: URL, so an
 * operator or a test can point OPENBRF_CATALOG_URL at a file without knowing
 * the URL spelling.
 */
export function catalogLocation(value: string): URL {
  if (isHttpUrl(value) || value.startsWith("file:")) {
    return new URL(value);
  }
  return pathToFileURL(isAbsolute(value) ? value : resolve(value));
}

@Injectable()
export class CatalogThemeSource implements ThemeSource {
  private readonly logger = new Logger(CatalogThemeSource.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  async listThemes(): Promise<CatalogEntry[]> {
    const configured = this.env.OPENBRF_CATALOG_URL;
    if (configured === undefined || configured === "") {
      throw new ThemeSourceError(
        "No catalog is configured. Set OPENBRF_CATALOG_URL.",
        "catalog-not-configured",
      );
    }

    const location = catalogLocation(configured);
    const body = await this.read(location, MAX_CATALOG_BYTES, "catalog");

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf8").decode(body));
    } catch (cause) {
      throw new ThemeSourceError(
        `The catalog at ${location.href} is not valid JSON: ${(cause as Error).message}`,
        "catalog-invalid",
      );
    }

    const result = catalogSchema.safeParse(parsed);
    if (!result.success) {
      throw new ThemeSourceError(
        `The catalog at ${location.href} does not match the expected shape.`,
        "catalog-invalid",
      );
    }

    return result.data.entries.filter((entry) => entry.type === "theme");
  }

  async fetchPackage(entry: CatalogEntry): Promise<Uint8Array> {
    const location = this.packageLocation(entry);
    const bytes = await this.read(location, MAX_PACKAGE_BYTES, "package");

    if (!checksumMatches(bytes, entry.sha512)) {
      // Nothing has been written anywhere yet: verification happens on the
      // downloaded bytes, before the installer is allowed to see them.
      throw new ThemeSourceError(
        `The package for ${entry.id} does not match the checksum the catalog states.`,
        "checksum-mismatch",
      );
    }

    this.logger.log(
      `Verified ${entry.id}@${entry.version} from ${location.href}`,
    );
    return bytes;
  }

  /** A package URL, resolved against the catalog when it is relative. */
  private packageLocation(entry: CatalogEntry): URL {
    if (isHttpUrl(entry.url) || entry.url.startsWith("file:")) {
      return new URL(entry.url);
    }

    const configured = this.env.OPENBRF_CATALOG_URL ?? "";
    const catalog = catalogLocation(configured);
    if (catalog.protocol === "file:") {
      // A fixture catalog names its packages next to itself, so the whole
      // arrangement can be built into a directory and copied around.
      return pathToFileURL(resolve(dirname(fileURLToPath(catalog)), entry.url));
    }
    return new URL(entry.url, catalog);
  }

  private async read(
    location: URL,
    limit: number,
    what: "catalog" | "package",
  ): Promise<Uint8Array> {
    if (location.protocol === "file:") {
      try {
        const contents = await readFile(fileURLToPath(location));
        if (contents.length > limit) {
          throw new ThemeSourceError(
            `The ${what} at ${location.href} is larger than ${String(limit)} bytes.`,
            what === "catalog" ? "catalog-invalid" : "package-too-large",
          );
        }
        return new Uint8Array(contents);
      } catch (cause) {
        if (cause instanceof ThemeSourceError) {
          throw cause;
        }
        throw new ThemeSourceError(
          `Could not read the ${what} at ${location.href}: ${(cause as Error).message}`,
          what === "catalog" ? "catalog-unreachable" : "package-unreachable",
        );
      }
    }

    const token = this.env.OPENBRF_CATALOG_TOKEN;
    const unreachable = (cause: unknown): ThemeSourceError =>
      new ThemeSourceError(
        `Could not reach the ${what} at ${location.href}: ${(cause as Error).message}`,
        what === "catalog" ? "catalog-unreachable" : "package-unreachable",
      );

    // One deadline for the whole exchange: the signal covers the response body
    // as well, so a server that answers and then stops sending is abandoned on
    // the same terms as one that never answers at all.
    const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(location, {
        headers:
          token === undefined ? {} : { authorization: `Bearer ${token}` },
        redirect: "follow",
        signal: deadline,
      });
    } catch (cause) {
      throw unreachable(cause);
    }

    if (!response.ok) {
      throw new ThemeSourceError(
        `The ${what} at ${location.href} answered ${String(response.status)}.`,
        what === "catalog" ? "catalog-unreachable" : "package-unreachable",
      );
    }

    try {
      return await readCapped(response, limit, what);
    } catch (cause) {
      if (cause instanceof ThemeSourceError) {
        throw cause;
      }
      // A body that stalls or breaks part way through arrives here, including
      // the abort the deadline raises.
      throw unreachable(cause);
    }
  }
}

/**
 * Reads a response body, stopping at the cap.
 *
 * Streamed rather than buffered whole, so a server that answers with a
 * gigabyte cannot make the instance hold a gigabyte before the size is
 * noticed. A stated Content-Length past the cap is refused without reading at
 * all.
 */
async function readCapped(
  response: Response,
  limit: number,
  what: "catalog" | "package",
): Promise<Uint8Array> {
  const tooLarge = (): ThemeSourceError =>
    new ThemeSourceError(
      `The ${what} is larger than ${String(limit)} bytes.`,
      what === "catalog" ? "catalog-invalid" : "package-too-large",
    );

  const stated = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(stated) && stated > limit) {
    throw tooLarge();
  }

  const body = response.body;
  if (body === null) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > limit) {
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
