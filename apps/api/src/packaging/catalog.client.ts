import { Inject, Injectable, Logger } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import {
  type Catalog,
  type CatalogEntry,
  CatalogError,
  parseCatalog,
} from "./catalog-entry";
import { fetchBytes } from "./fetch-resource";

/**
 * The curated index (decision 36). An instance reads this unless it has been
 * deliberately pointed elsewhere, which is what the uncurated flag opts out of.
 */
export const CURATED_CATALOG_URL =
  "https://raw.githubusercontent.com/openbrf/catalog/main/catalog.json";

/** How long a fetched index is reused before it is read again. */
const CACHE_MILLISECONDS = 60_000;

/** 4 MiB. An index of a few hundred entries is orders of magnitude smaller. */
const MAX_INDEX_BYTES = 4 * 1024 * 1024;

/**
 * Reads the catalog.
 *
 * Shared by the plugin and theme install screens: one index lists both, so
 * one client fetches it. The optional bearer token is applied to the index and
 * to the release assets alike, because before public launch both live in
 * private repositories (plan section 5); after launch the token is simply
 * unset and nothing in this code changes.
 *
 * The result is cached briefly. Browsing the catalog is a screen with tabs and
 * a search box, and re-fetching a static index on every keystroke would be an
 * unkind thing to do to the host that serves it. The window is short enough
 * that a delisting reaches an instance the next time a board opens the screen.
 */
@Injectable()
export class CatalogClient {
  private readonly logger = new Logger(CatalogClient.name);
  private cached: { at: number; catalog: Catalog } | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * The index URL this instance reads, after the curation check.
   *
   * Pointing an instance at an index Apteo does not curate is a deliberate
   * act with real consequences - catalog curation is what stands between the
   * instance and a backend plugin running at full process privilege
   * (ADR 0003) - so it takes an explicit second flag rather than one
   * environment variable.
   */
  resolveUrl(): string {
    const configured = this.env.OPENBRF_CATALOG_URL?.trim();
    if (configured === undefined || configured === "") {
      return CURATED_CATALOG_URL;
    }
    if (
      configured !== CURATED_CATALOG_URL &&
      !this.env.OPENBRF_UNCURATED_PLUGINS_ENABLED
    ) {
      throw new CatalogError(
        "OPENBRF_CATALOG_URL points at an index outside the curated catalog. " +
          "Set OPENBRF_UNCURATED_PLUGINS_ENABLED=true to allow that.",
        "catalog-source-not-permitted",
      );
    }
    return configured;
  }

  /** The Authorization header for the index and for its release assets. */
  authorization(): Record<string, string> {
    const token = this.env.OPENBRF_CATALOG_TOKEN;
    return token === undefined ? {} : { authorization: `Bearer ${token}` };
  }

  /**
   * Whether http: and file: sources are readable on this instance.
   *
   * The same flag that permits an uncurated index, because they are the same
   * decision: an instance reading only the curated catalog has no reason to
   * fetch a plugin over plain http or out of its own filesystem, and both are
   * addresses a catalog entry - data fetched from elsewhere - would otherwise
   * be free to name.
   */
  allowsUncuratedSources(): boolean {
    return this.env.OPENBRF_UNCURATED_PLUGINS_ENABLED;
  }

  async read(options: { refresh?: boolean } = {}): Promise<Catalog> {
    const cached = this.cached;
    if (
      options.refresh !== true &&
      cached !== null &&
      Date.now() - cached.at < CACHE_MILLISECONDS
    ) {
      return cached.catalog;
    }

    const url = this.resolveUrl();
    const catalog = parseCatalog(await this.fetchIndex(url));
    this.cached = { at: Date.now(), catalog };
    return catalog;
  }

  async entry(id: string): Promise<CatalogEntry | null> {
    const catalog = await this.read();
    return catalog.entries.find((candidate) => candidate.id === id) ?? null;
  }

  /** Drops the cache, so the next read goes back to the source. */
  forget(): void {
    this.cached = null;
  }

  private async fetchIndex(url: string): Promise<unknown> {
    let bytes: Buffer;
    try {
      bytes = await fetchBytes(url, {
        headers: { accept: "application/json", ...this.authorization() },
        maxBytes: MAX_INDEX_BYTES,
        allowUncuratedSources: this.allowsUncuratedSources(),
      });
    } catch (cause) {
      this.logger.warn(
        `The catalog at ${url} could not be read: ${String(cause)}`,
      );
      throw new CatalogError(
        `The catalog at ${url} could not be reached.`,
        "catalog-unreachable",
      );
    }

    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new CatalogError(
        `The catalog at ${url} did not return JSON.`,
        "catalog-malformed",
      );
    }
  }
}
