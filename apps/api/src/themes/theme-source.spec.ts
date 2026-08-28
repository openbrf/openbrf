import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import { buildThemeFixtureCatalog } from "../testing/theme-fixtures";
import {
  catalogLocation,
  CatalogThemeSource,
  checksumMatches,
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
