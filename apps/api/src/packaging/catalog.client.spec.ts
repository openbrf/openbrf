import { describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import { CatalogClient } from "./catalog.client";

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
