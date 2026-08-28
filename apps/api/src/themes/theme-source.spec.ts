import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Env } from "../config/env";
import { buildThemeFixtureCatalog } from "../testing/theme-fixtures";
import {
  catalogLocation,
  CatalogThemeSource,
  checksumMatches,
  FETCH_TIMEOUT_MS,
  normalizeSha512,
  ThemeSourceError,
} from "./theme-source";

/**
 * The catalog and the checksum.
 *
 * A theme package is third-party content fetched over the network, and the
 * checksum is the only thing standing between the catalog's intent and what
 * lands on the data volume. So the tests that matter are: the checksum is
 * actually compared, both spellings of it are understood, and a package that
 * fails it is refused rather than installed.
 *
 * The fixture catalog is a real catalog on disk pointing at real packages
 * built from the repository, which is how CI runs the install path with no
 * network at all.
 */

const BASE_ENV = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "postgresql://unused",
  APP_URL: "https://brf.example.se",
  OPENBRF_DATA_DIR: "./.data",
  BETTER_AUTH_SECRET: "test-secret-at-least-16-chars",
  OPENBRF_PLUGINS_ENABLED: false,
  OPENBRF_UNCURATED_PLUGINS_ENABLED: false,
} as Env;

let directory: string;
let catalogPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openbrf-theme-catalog-"));
  const built = await buildThemeFixtureCatalog(directory);
  catalogPath = built.catalogPath;
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function sourceOver(catalogUrl: string | undefined): CatalogThemeSource {
  return new CatalogThemeSource({
    ...BASE_ENV,
    ...(catalogUrl === undefined ? {} : { OPENBRF_CATALOG_URL: catalogUrl }),
  } as Env);
}

describe("normalizeSha512", () => {
  it("reads hex", () => {
    const hex = "a".repeat(128);
    expect(normalizeSha512(hex.toUpperCase())).toBe(hex);
  });

  it("reads the sha512-<base64> form npm and pnpm write", () => {
    const digest = createHash("sha512").update("payload").digest();
    expect(normalizeSha512(`sha512-${digest.toString("base64")}`)).toBe(
      digest.toString("hex"),
    );
  });

  it("refuses anything else rather than guessing", () => {
    expect(normalizeSha512("not-a-checksum")).toBeNull();
    expect(normalizeSha512("a".repeat(64))).toBeNull();
    expect(normalizeSha512("sha512-abc")).toBeNull();
  });
});

describe("checksumMatches", () => {
  const bytes = new TextEncoder().encode("theme package");
  const digest = createHash("sha512").update(bytes).digest("hex");

  it("accepts the right bytes", () => {
    expect(checksumMatches(bytes, digest)).toBe(true);
    expect(
      checksumMatches(
        bytes,
        `sha512-${Buffer.from(digest, "hex").toString("base64")}`,
      ),
    ).toBe(true);
  });

  it("refuses one changed byte", () => {
    const altered = new Uint8Array(bytes);
    altered[0] = (altered[0] ?? 0) ^ 0x01;
    expect(checksumMatches(altered, digest)).toBe(false);
  });

  it("refuses a checksum it cannot read, rather than skipping the check", () => {
    expect(checksumMatches(bytes, "trust-me")).toBe(false);
  });
});

describe("catalogLocation", () => {
  it("takes an http URL as written", () => {
    expect(catalogLocation("https://example.com/catalog.json").protocol).toBe(
      "https:",
    );
  });

  it("turns a filesystem path into a file URL", () => {
    expect(catalogLocation("/srv/catalog.json").protocol).toBe("file:");
  });
});

describe("CatalogThemeSource", () => {
  it("lists the catalog's themes", async () => {
    const themes = await sourceOver(catalogPath).listThemes();
    const ids = themes.map((entry) => entry.id).sort();
    expect(ids).toEqual(["example-theme", "illegible-theme"]);
    expect(themes.every((entry) => entry.type === "theme")).toBe(true);
  });

  it("fetches a package and verifies it", async () => {
    const source = sourceOver(catalogPath);
    const [entry] = (await source.listThemes()).filter(
      (candidate) => candidate.id === "example-theme",
    );
    if (entry === undefined) {
      throw new Error("The fixture catalog has no example-theme entry.");
    }

    const bytes = await source.fetchPackage(entry);
    expect(bytes.length).toBeGreaterThan(0);
    expect(checksumMatches(bytes, entry.sha512)).toBe(true);
  });

  it("refuses a package whose bytes do not match the catalog", async () => {
    const source = sourceOver(catalogPath);
    const [entry] = (await source.listThemes()).filter(
      (candidate) => candidate.id === "example-theme",
    );
    if (entry === undefined) {
      throw new Error("The fixture catalog has no example-theme entry.");
    }

    await expect(
      source.fetchPackage({ ...entry, sha512: "b".repeat(128) }),
    ).rejects.toThrow(ThemeSourceError);
  });

  it("says so when no catalog is configured", async () => {
    await expect(sourceOver(undefined).listThemes()).rejects.toThrow(
      /No catalog is configured/,
    );
  });

  it("refuses a catalog that is not the shape it expects", async () => {
    const broken = join(directory, "broken.json");
    await writeFile(broken, JSON.stringify({ entries: [{ id: 1 }] }), "utf8");
    await expect(sourceOver(broken).listThemes()).rejects.toThrow(
      /does not match the expected shape/,
    );
  });
});

/**
 * A host that goes quiet.
 *
 * The byte caps bound how much a catalog may send, not how long it may take to
 * send it. The install runs inline in the request, so a host that completes the
 * handshake and then goes quiet would hold the request handler and its database
 * connection for as long as it liked. Both halves of the exchange therefore run
 * under one deadline, and reaching it is an unreachable catalog rather than a
 * server fault. Each half is tested: a handshake that never completes and a
 * body that never arrives fail on the same terms.
 */
describe("a catalog over HTTP", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("abandons a host that never answers", async () => {
    vi.useFakeTimers();

    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_input: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      // A host that accepts the connection and never completes the handshake:
      // this request settles only if something abandons it.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      });
    });

    const listing = sourceOver(
      "https://catalog.example.com/catalog.json",
    ).listThemes();
    const refused = expect(listing).rejects.toMatchObject({
      reason: "catalog-unreachable",
    });

    // A moment short of the deadline the request is still open: the byte caps
    // bound how much a host may send, not how long it may take.
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await refused;
  });

  it("abandons a host that answers and then sends nothing", async () => {
    vi.useFakeTimers();

    let signal: AbortSignal | undefined;
    let reading = false;
    vi.stubGlobal("fetch", (_input: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      // The other half of the exchange. The headers land, so a deadline that
      // stopped mattering once the response arrived would leave this body read
      // pending for as long as the host cared to hold it - and with it the
      // request handler and its database connection.
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener(
                "abort",
                () => {
                  controller.error(init.signal?.reason);
                },
                { once: true },
              );
            },
            pull() {
              // Nothing enqueued and nothing closed: the read settles only when
              // the deadline errors the stream.
              reading = true;
            },
          }),
        ),
      );
    });

    const listing = sourceOver(
      "https://catalog.example.com/catalog.json",
    ).listThemes();
    const refused = expect(listing).rejects.toMatchObject({
      reason: "catalog-unreachable",
    });

    // The body is being read, which is the half of the exchange a deadline
    // cleared at the response would already have stopped covering.
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1);
    expect(reading).toBe(true);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await refused;
  });

  it("reports a body that stops part way through as unreachable", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"entries":'));
              controller.error(new Error("The connection went away."));
            },
          }),
        ),
      ),
    );

    await expect(
      sourceOver("https://catalog.example.com/catalog.json").listThemes(),
    ).rejects.toMatchObject({ reason: "catalog-unreachable" });
  });
});
