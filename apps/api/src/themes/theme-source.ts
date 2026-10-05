import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { IntegrityError } from "@openbrf/plugin-sdk";

import { DomainError } from "../http/domain-error";
import {
  CatalogError,
  type CatalogThemeEntry,
} from "../packaging/catalog-entry";
import { CatalogClient } from "../packaging/catalog.client";
import { ResourceFetchError } from "../packaging/fetch-resource";
import { fetchVerified } from "../packaging/package-archive";

/**
 * Where a theme package comes from, and how it is proven to be the right one.
 *
 * The plugin system's pieces, used as they are: one catalog index lists
 * plugins and themes alike and is read by the one client, so the theme screen
 * is held to the plugin screen's rules - the curated catalog when none is
 * configured, the refusal of any other index unless the instance has opted
 * out of curation, https only for a curated instance, and the digest checked
 * before anything is unpacked. Nothing above this file knows how a package is
 * fetched, only that fetchPackage returns bytes whose sha512 matched what the
 * catalog stated.
 *
 * The download is capped and verified before anything is written to disk. A
 * package that fails its checksum never reaches the data volume.
 */

/** Matches the archive reader's ceiling: a theme is data, not a payload. */
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;

/**
 * How long a package download may take before it is abandoned.
 *
 * The byte cap above bounds size, not time. A host that completes the
 * handshake and then sends nothing would otherwise leave the download pending
 * for as long as it cared to: the install runs inline in the request, so the
 * request handler and its database connection would be held for exactly that
 * long. One deadline covers the whole exchange, redirects and body included.
 * The index is read under a deadline of its own by the catalog client.
 */
export const FETCH_TIMEOUT_MS = 30_000;

export class ThemeSourceError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "catalog-source-not-permitted"
      | "catalog-unreachable"
      | "catalog-invalid"
      | "package-unreachable"
      | "package-too-large"
      | "checksum-mismatch",
  ) {
    super(message);
    // Refusing an index the configuration names is the instance's own
    // setting, not a fault upstream, and nothing a retry would change.
    this.status =
      reason === "catalog-source-not-permitted"
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.BAD_GATEWAY;
  }
}

/** What the theme installer needs from wherever packages live. */
export interface ThemeSource {
  /** Every theme in the catalog, read afresh. Plugins are filtered out here. */
  listThemes(): Promise<CatalogThemeEntry[]>;
  /** The theme listed under this id, from the cached index; null if none. */
  theme(id: string): Promise<CatalogThemeEntry | null>;
  /** The entry's package, with its sha512 already verified. */
  fetchPackage(entry: CatalogThemeEntry): Promise<Uint8Array>;
}

@Injectable()
export class CatalogThemeSource implements ThemeSource {
  private readonly logger = new Logger(CatalogThemeSource.name);

  constructor(private readonly catalog: CatalogClient) {}

  /**
   * Refreshed on every call, as the plugin screen lists: delisting is a change
   * to the index, and a screen that kept offering a delisted theme would have
   * defeated the point of curation.
   */
  async listThemes(): Promise<CatalogThemeEntry[]> {
    const catalog = await this.read(() => this.catalog.read({ refresh: true }));
    return catalog.entries.filter(
      (entry): entry is CatalogThemeEntry => entry.type === "theme",
    );
  }

  /**
   * The cached index, as the plugin install reads it: the board chose the
   * entry from a listing a moment ago, and the digest pins the bytes whatever
   * the index says by now.
   */
  async theme(id: string): Promise<CatalogThemeEntry | null> {
    const entry = await this.read(() => this.catalog.entry(id));
    return entry?.type === "theme" ? entry : null;
  }

  async fetchPackage(entry: CatalogThemeEntry): Promise<Uint8Array> {
    let bytes: Buffer;
    try {
      bytes = await fetchVerified(entry.artifact, {
        headers: this.catalog.authorizationFor(entry.artifact.url),
        allowUncuratedSources: this.catalog.allowsUncuratedSources(),
        maxBytes: MAX_PACKAGE_BYTES,
        timeoutMs: FETCH_TIMEOUT_MS,
      });
    } catch (cause) {
      if (cause instanceof ResourceFetchError) {
        throw new ThemeSourceError(
          `The package for ${entry.id} could not be downloaded: ${cause.message}`,
          cause.reason === "too-large"
            ? "package-too-large"
            : "package-unreachable",
        );
      }
      if (cause instanceof IntegrityError) {
        // Nothing has been written anywhere yet: verification happens on the
        // downloaded bytes, before the installer is allowed to see them.
        throw new ThemeSourceError(
          `The package for ${entry.id} does not match the checksum the catalog states.`,
          "checksum-mismatch",
        );
      }
      throw cause;
    }

    this.logger.log(
      `Verified ${entry.id}@${entry.version} from ${entry.artifact.url}`,
    );
    return bytes;
  }

  /** Reads the index, answering its refusals in the theme screen's reasons. */
  private async read<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (cause) {
      if (cause instanceof CatalogError) {
        throw new ThemeSourceError(
          cause.message,
          cause.reason === "catalog-malformed"
            ? "catalog-invalid"
            : cause.reason === "catalog-source-not-permitted"
              ? "catalog-source-not-permitted"
              : "catalog-unreachable",
        );
      }
      throw cause;
    }
  }
}
