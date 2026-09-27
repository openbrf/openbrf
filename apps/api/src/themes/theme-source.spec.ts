import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
import type { CatalogThemeEntry } from "../packaging/catalog-entry";
import {
  CatalogClient,
  CURATED_CATALOG_URL,
  INDEX_TIMEOUT_MILLISECONDS,
} from "../packaging/catalog.client";
import {
  buildThemeFixtureCatalog,
  repositoryRoot,
} from "../testing/theme-fixtures";
import {
  CatalogThemeSource,
  FETCH_TIMEOUT_MS,
  ThemeSourceError,
} from "./theme-source";

/**
 * The catalog and the checksum.
 *
 * A theme package is third-party content fetched over the network, and the
 * checksum is the only thing standing between the catalog's intent and what
 * lands on the data volume. So the tests that matter are: the index the
 * plugin screen reads is the index this screen reads, the checksum is actually
 * compared, and a package that fails it is refused rather than installed.
 *
 * The fixture catalog is a real catalog on disk pointing at real packages
 * built from the repository, which is how CI runs the install path with no
 * network at all. Every other source is a stubbed fetch.
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
let exampleTheme: CatalogThemeEntry;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openbrf-theme-catalog-"));
  const built = await buildThemeFixtureCatalog(directory);
  catalogPath = built.catalogPath;
  const found = built.entries.find((entry) => entry.id === "example-theme");
  if (found === undefined) {
    throw new Error("The fixture catalog has no example-theme entry.");
  }
  exampleTheme = found;
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A source over an index on disk, which only an uncurated instance reads. */
function sourceOverFile(path: string): CatalogThemeSource {
  return new CatalogThemeSource(
    new CatalogClient({
      ...BASE_ENV,
      OPENBRF_CATALOG_URL: pathToFileURL(path).href,
      OPENBRF_UNCURATED_PLUGINS_ENABLED: true,
    } as Env),
  );
}

/** A source on a curated instance: no index configured, https only. */
function curatedSource(): CatalogThemeSource {
  return new CatalogThemeSource(new CatalogClient(BASE_ENV));
}

/**
 * The fixture plugin's catalog entry, as the fixture builder writes it.
 *
 * Read from the fixture's own manifest rather than written out here, so the
 * entry is the real one - permissions, personal data, actions and the
 * protected resource included - without building the plugin, which needs its
 * own toolchain installed.
 */
async function fixturePluginEntry(): Promise<Record<string, unknown>> {
  const packageJson = JSON.parse(
    await readFile(
      join(repositoryRoot(), "fixtures", "example-plugin", "package.json"),
      "utf8",
    ),
  ) as {
    name: string;
    version: string;
    openbrf: Record<string, unknown> & { id: string };
  };
  const { openbrf: manifest } = packageJson;
  return {
    type: "plugin",
    id: manifest.id,
    packageName: packageJson.name,
    version: packageJson.version,
    apiVersion: manifest["apiVersion"],
    name: { sv: "Boende och lägenheter", en: "Occupancy" },
    description: { sv: "Visar antalet lägenheter.", en: "Shows occupancy." },
    permissions: manifest["permissions"],
    personalData: manifest["personalData"],
    actions: manifest["actions"],
    oauthProtectedResource: manifest["oauthProtectedResource"],
    artifact: {
      url: "https://github.com/openbrf/example-plugin/releases/download/v1.0.0/plugin.tgz",
      sha512: `sha512-${createHash("sha512").update("plugin").digest("base64")}`,
    },
  };
}

describe("the theme screen reads the plugin screen's index", () => {
  it("lists exactly the themes of an index that lists the fixture plugin too", async () => {
    /*
     * The regression. One index lists both kinds, and before the theme screen
     * read it through the plugin system's client it parsed every entry in a
     * shape of its own - so the plugin entry made it refuse the whole index as
     * invalid, and the example theme could not be installed from the catalog
     * that lists it.
     */
    const themes = JSON.parse(await readFile(catalogPath, "utf8")) as {
      version: number;
      entries: unknown[];
    };
    const combined = join(directory, "combined.json");
    await writeFile(
      combined,
      JSON.stringify({
        version: 1,
        entries: [await fixturePluginEntry(), ...themes.entries],
      }),
      "utf8",
    );

    const listed = await sourceOverFile(combined).listThemes();

    expect(listed.map((entry) => entry.id).sort()).toEqual([
      "example-theme",
      "illegible-theme",
    ]);
    expect(listed.every((entry) => entry.type === "theme")).toBe(true);
  });

  it("carries the catalog's own text in both languages", async () => {
    const [entry] = (await sourceOverFile(catalogPath).listThemes()).filter(
      (candidate) => candidate.id === "example-theme",
    );

    expect(entry?.name).toEqual({ sv: "Exempeltema", en: "Example theme" });
  });

  it("finds a theme by id and nothing that is not a theme", async () => {
    const themes = JSON.parse(await readFile(catalogPath, "utf8")) as {
      entries: unknown[];
    };
    const combined = join(directory, "combined-lookup.json");
    await writeFile(
      combined,
      JSON.stringify({
        version: 1,
        entries: [await fixturePluginEntry(), ...themes.entries],
      }),
      "utf8",
    );
    const source = sourceOverFile(combined);

    expect((await source.theme("example-theme"))?.version).toBe("1.0.0");
    expect(await source.theme("occupancy")).toBeNull();
    expect(await source.theme("no-such-theme")).toBeNull();
  });

  it("refuses an index in the earlier theme-only shape", async () => {
    const earlier = join(directory, "earlier.json");
    await writeFile(
      earlier,
      JSON.stringify({
        entries: [
          {
            id: "example-theme",
            type: "theme",
            name: "Example",
            version: "1.0.0",
            url: "example-theme-1.0.0.tgz",
            sha512: "a".repeat(128),
          },
        ],
      }),
      "utf8",
    );

    await expect(sourceOverFile(earlier).listThemes()).rejects.toMatchObject({
      reason: "catalog-invalid",
    });
  });

  it("reads the curated catalog when none is configured", async () => {
    let requested: string | undefined;
    vi.stubGlobal("fetch", (input: URL) => {
      requested = input.href;
      return Promise.resolve(
        Response.json({
          version: 1,
          entries: [
            {
              ...exampleTheme,
              artifact: {
                ...exampleTheme.artifact,
                url: "https://example.test/t.tgz",
              },
            },
          ],
        }),
      );
    });

    const listed = await curatedSource().listThemes();

    expect(requested).toBe(CURATED_CATALOG_URL);
    expect(listed.map((entry) => entry.id)).toEqual(["example-theme"]);
  });

  it("refuses an index outside the curated catalog without the opt-out", async () => {
    const source = new CatalogThemeSource(
      new CatalogClient({
        ...BASE_ENV,
        OPENBRF_CATALOG_URL: pathToFileURL(catalogPath).href,
      } as Env),
    );

    const refused = source.listThemes();

    await expect(refused).rejects.toBeInstanceOf(ThemeSourceError);
    await expect(refused).rejects.toMatchObject({
      reason: "catalog-source-not-permitted",
      status: 503,
    });
  });
});

describe("fetching a package", () => {
  it("fetches a package and verifies it", async () => {
    const bytes = await sourceOverFile(catalogPath).fetchPackage(exampleTheme);

    expect(bytes.length).toBe(exampleTheme.artifact.bytes);
  });

  it("refuses a package whose bytes do not match the catalog", async () => {
    await expect(
      sourceOverFile(catalogPath).fetchPackage({
        ...exampleTheme,
        artifact: { ...exampleTheme.artifact, sha512: "b".repeat(128) },
      }),
    ).rejects.toMatchObject({ reason: "checksum-mismatch" });
  });

  it("reads only https on a curated instance, whatever the entry names", async () => {
    // An entry is data fetched from elsewhere. Without this refusal it could
    // name a file: path and have the instance read its own disk.
    await expect(
      curatedSource().fetchPackage(exampleTheme),
    ).rejects.toMatchObject({
      reason: "package-unreachable",
      message: expect.stringMatching(/file: is not an allowed source/),
    });
  });

  it("abandons a package whose body stalls, at the deadline", async () => {
    vi.useFakeTimers();
    let reading = false;
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              reading = true;
              return new Promise<void>(() => undefined);
            },
          }),
        ),
      ),
    );

    const fetching = curatedSource().fetchPackage({
      ...exampleTheme,
      artifact: {
        ...exampleTheme.artifact,
        url: "https://github.com/openbrf/example-theme/releases/download/v1.0.0/t.tgz",
      },
    });
    const refused = expect(fetching).rejects.toMatchObject({
      reason: "package-unreachable",
    });

    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1);
    expect(reading).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await refused;
  });
});

/**
 * An index host that goes quiet.
 *
 * The byte caps bound how much a catalog may send, not how long it may take to
 * send it. The listing runs inline in the request, so a host that completes the
 * handshake and then goes quiet would hold the request handler and its database
 * connection for as long as it liked. Both halves of the exchange therefore run
 * under one deadline, and reaching it is an unreachable catalog rather than a
 * server fault. Each half is tested: a handshake that never completes and a
 * body that never arrives fail on the same terms.
 */
describe("an index over HTTP", () => {
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

    const listing = curatedSource().listThemes();
    const refused = expect(listing).rejects.toMatchObject({
      reason: "catalog-unreachable",
    });

    await vi.advanceTimersByTimeAsync(INDEX_TIMEOUT_MILLISECONDS - 1);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await refused;
  });

  it("abandons a host that answers and then sends nothing", async () => {
    vi.useFakeTimers();

    let reading = false;
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              // Nothing enqueued and nothing closed: the headers landed, so a
              // deadline that stopped mattering once the response arrived
              // would leave this read pending for as long as the host liked.
              reading = true;
              return new Promise<void>(() => undefined);
            },
          }),
        ),
      ),
    );

    const listing = curatedSource().listThemes();
    const refused = expect(listing).rejects.toMatchObject({
      reason: "catalog-unreachable",
    });

    await vi.advanceTimersByTimeAsync(INDEX_TIMEOUT_MILLISECONDS - 1);
    expect(reading).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
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

    await expect(curatedSource().listThemes()).rejects.toMatchObject({
      reason: "catalog-unreachable",
    });
  });
});
