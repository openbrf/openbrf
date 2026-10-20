import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Env } from "../config/env";
import {
  CatalogClient,
  CURATED_CATALOG_URL,
  CURATED_CATALOG_V1_URL,
} from "./catalog.client";
import { CatalogError } from "./catalog-entry";

/**
 * What the client keeps between reads.
 *
 * The install gates in front of a deprecated entry read it with
 * `{ refresh: true }`, so a deprecation made after the screen browsed the
 * catalog is seen at the confirmation. That only holds if `entry` hands the
 * option on to `read`; a service test with a stand-in client cannot tell.
 */

const DIGEST = `sha512-${"A".repeat(86)}==`;

function index(deprecated: boolean): unknown {
  return {
    version: 1,
    entries: [
      {
        type: "theme",
        id: "nordic",
        version: "1.0.0",
        name: { sv: "Nordisk", en: "Nordic" },
        description: { sv: "Ljust tema", en: "A light theme" },
        deprecated,
        artifact: {
          url: "https://catalog.example.test/nordic.tgz",
          sha512: DIGEST,
        },
      },
    ],
  };
}

/** A client whose source answers with each index in turn, and counts reads. */
function clientOver(...answers: unknown[]) {
  const client = new CatalogClient({ NODE_ENV: "test" } as unknown as Env);
  const fetchIndex = vi.fn();
  for (const answer of answers) {
    fetchIndex.mockResolvedValueOnce(answer);
  }
  (client as unknown as { fetchIndex: unknown }).fetchIndex = fetchIndex;
  return { client, fetchIndex };
}

describe("reading one entry", () => {
  it("serves a second read from the cached index", async () => {
    const { client, fetchIndex } = clientOver(index(false), index(true));

    await client.entry("nordic");
    const second = await client.entry("nordic");

    expect(fetchIndex).toHaveBeenCalledOnce();
    expect(second?.deprecated).toBe(false);
  });

  it("goes back to the source when asked to refresh, past a warm cache", async () => {
    const { client, fetchIndex } = clientOver(index(false), index(true));

    const browsed = await client.entry("nordic");
    const confirmed = await client.entry("nordic", { refresh: true });

    expect(fetchIndex).toHaveBeenCalledTimes(2);
    expect(browsed?.deprecated).toBe(false);
    expect(confirmed?.deprecated).toBe(true);
  });
});

describe("the curated address", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function curated(env: Partial<Env> = {}): CatalogClient {
    return new CatalogClient({
      NODE_ENV: "test",
      OPENBRF_UNCURATED_PLUGINS_ENABLED: false,
      ...env,
    } as Env);
  }

  /** A fetch that answers each address from the map, and 404 otherwise. */
  function serving(indexes: Record<string, unknown>): string[] {
    const requested: string[] = [];
    vi.stubGlobal("fetch", (input: URL) => {
      requested.push(input.href);
      const body = indexes[input.href];
      return Promise.resolve(
        body === undefined
          ? new Response("Not Found", { status: 404 })
          : Response.json(body),
      );
    });
    return requested;
  }

  it("is version 2 of the index when none is configured", () => {
    expect(curated().resolveUrl()).toBe(CURATED_CATALOG_URL);
    expect(CURATED_CATALOG_URL).toBe(
      "https://raw.githubusercontent.com/openbrf/catalog/main/catalog-v2.json",
    );
  });

  it("accepts either curated version without the opt-out", () => {
    expect(
      curated({ OPENBRF_CATALOG_URL: CURATED_CATALOG_V1_URL }).resolveUrl(),
    ).toBe(CURATED_CATALOG_V1_URL);
    expect(
      curated({ OPENBRF_CATALOG_URL: CURATED_CATALOG_URL }).resolveUrl(),
    ).toBe(CURATED_CATALOG_URL);
  });

  it("refuses any other address without the opt-out", () => {
    expect(() =>
      curated({
        OPENBRF_CATALOG_URL:
          "https://raw.githubusercontent.com/openbrf/catalog/main/catalog-v3.json",
      }).resolveUrl(),
    ).toThrow(CatalogError);
  });

  it("reads version 2, with the entries only version 2 can list", async () => {
    const requested = serving({
      [CURATED_CATALOG_URL]: { ...(index(false) as object), version: 2 },
      [CURATED_CATALOG_V1_URL]: { version: 1, entries: [] },
    });

    const catalog = await curated().read();

    expect(requested).toEqual([CURATED_CATALOG_URL]);
    expect(catalog.version).toBe(2);
    expect(catalog.entries.map((entry) => entry.id)).toEqual(["nordic"]);
  });

  it("reads version 1 while the catalog does not serve version 2", async () => {
    const requested = serving({ [CURATED_CATALOG_V1_URL]: index(false) });

    const catalog = await curated().read();

    expect(requested).toEqual([CURATED_CATALOG_URL, CURATED_CATALOG_V1_URL]);
    expect(catalog.version).toBe(1);
  });

  it("does not fall back from an address that answers anything but 404", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", (input: URL) => {
      requested.push(input.href);
      return Promise.resolve(new Response("", { status: 503 }));
    });

    await expect(curated().read()).rejects.toMatchObject({
      reason: "catalog-unreachable",
    });
    expect(requested).toEqual([CURATED_CATALOG_URL]);
  });

  it("does not fall back from a configured version 1 address", async () => {
    const requested = serving({});

    await expect(
      curated({ OPENBRF_CATALOG_URL: CURATED_CATALOG_V1_URL }).read(),
    ).rejects.toMatchObject({ reason: "catalog-unreachable" });
    expect(requested).toEqual([CURATED_CATALOG_V1_URL]);
  });
});
