import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CatalogArtifact } from "./catalog-entry";
import {
  DEFAULT_MAX_BYTES,
  fetchBytes,
  ResourceFetchError,
} from "./fetch-resource";
import { formatSha512, IntegrityError, sha512 } from "./integrity";
import { archiveFileName, ensureArchive } from "./package-archive";

/**
 * The store is exercised against a real directory and real files. The
 * behaviour under test is entirely about what is on disk afterwards - a
 * partial write, a stale file left under a trusted name, a second network trip
 * that was not needed - and a mocked filesystem would only assert the mock.
 *
 * `file:` URLs are not a shortcut here: they are a supported scheme precisely
 * so this verification path can run with no network, which is what the
 * end-to-end harness relies on too.
 */

const PLUGIN_ID = "occupancy";
const VERSION = "1.4.0";

const CONTENT = Buffer.from("a tarball, as far as this store is concerned");
const CONTENT_DIGEST = formatSha512(sha512(CONTENT));

const OTHER = Buffer.from("different bytes entirely");
const OTHER_DIGEST = formatSha512(sha512(OTHER));

let workspace: string;
let store: string;
let source: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "openbrf-archive-"));
  store = join(workspace, "archives");
  source = join(workspace, "source.tgz");
  await writeFile(source, CONTENT);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function artifact(overrides: Partial<CatalogArtifact> = {}): CatalogArtifact {
  return {
    url: pathToFileURL(source).href,
    sha512: CONTENT_DIGEST,
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function storedPath(): string {
  return join(store, archiveFileName(PLUGIN_ID, VERSION));
}

describe("archiveFileName", () => {
  it("names the file from the id and version", () => {
    expect(archiveFileName(PLUGIN_ID, VERSION)).toBe("occupancy-1.4.0.tgz");
  });

  it("keeps the characters a real version needs", () => {
    expect(archiveFileName(PLUGIN_ID, "1.0.0-rc.1+build.7")).toBe(
      "occupancy-1.0.0-rc.1+build.7.tgz",
    );
  });

  // The version comes from the catalog, which is data fetched from elsewhere.
  // It must not be able to decide where the file lands.
  it.each([
    "../../etc/boot",
    "1.0/../../x",
    "..\\..\\x",
    "1.0 0",
    "a\nb",
    "\0",
  ])("cannot introduce a separator from the version %j", (version) => {
    const name = archiveFileName(PLUGIN_ID, version);

    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).not.toContain("\0");
    // One path segment, so joining it onto the store cannot leave the store.
    expect(dirname(resolve("/data/plugins/archives", name))).toBe(
      resolve("/data/plugins/archives"),
    );
  });
});

describe("ensureArchive", () => {
  it("downloads, verifies and writes the tarball", async () => {
    const path = await ensureArchive(store, PLUGIN_ID, VERSION, artifact());

    expect(path).toBe(storedPath());
    expect((await readFile(path)).equals(CONTENT)).toBe(true);
  });

  it("creates the store directory when it does not exist yet", async () => {
    expect(await exists(store)).toBe(false);
    await ensureArchive(store, PLUGIN_ID, VERSION, artifact());
    expect(await exists(store)).toBe(true);
  });

  it("reuses a verified archive rather than fetching again", async () => {
    // Idempotency is what lets a job that crashed after the download converge
    // on the next run. Removing the source proves the second call made no trip
    // for the bytes: if it had, there would be nothing to fetch.
    await ensureArchive(store, PLUGIN_ID, VERSION, artifact());
    await rm(source);

    const path = await ensureArchive(store, PLUGIN_ID, VERSION, artifact());

    expect((await readFile(path)).equals(CONTENT)).toBe(true);
  });

  it("discards a cached archive whose digest no longer matches", async () => {
    // A truncated write from a crash mid-download, or a version republished
    // under the same name. Either way the stored bytes are not the bytes the
    // catalog named, so they are replaced rather than trusted.
    await ensureArchive(store, PLUGIN_ID, VERSION, artifact());
    await writeFile(storedPath(), OTHER);

    const path = await ensureArchive(store, PLUGIN_ID, VERSION, artifact());

    expect((await readFile(path)).equals(CONTENT)).toBe(true);
  });

  it("leaves no file behind when the digest does not match", async () => {
    // The load-bearing one: a bad archive must never exist under a name a
    // later run could mistake for a verified download.
    await expect(
      ensureArchive(
        store,
        PLUGIN_ID,
        VERSION,
        artifact({ sha512: OTHER_DIGEST }),
      ),
    ).rejects.toBeInstanceOf(IntegrityError);

    expect(await exists(storedPath())).toBe(false);
    expect(await readdir(store)).toEqual([]);
  });

  it("removes a cached archive it could not verify even when the fetch fails", async () => {
    // The stale file is untrusted from the moment its digest fails. Leaving it
    // in place because the replacement could not be fetched would keep exactly
    // the bytes the check rejected.
    await ensureArchive(store, PLUGIN_ID, VERSION, artifact());
    await writeFile(storedPath(), OTHER);
    await rm(source);

    await expect(
      ensureArchive(store, PLUGIN_ID, VERSION, artifact()),
    ).rejects.toBeInstanceOf(ResourceFetchError);

    expect(await exists(storedPath())).toBe(false);
  });

  it("refuses an artifact URL whose scheme is not allowed", async () => {
    await expect(
      ensureArchive(
        store,
        PLUGIN_ID,
        VERSION,
        artifact({
          url: `data:application/gzip;base64,${CONTENT.toString("base64")}`,
        }),
      ),
    ).rejects.toBeInstanceOf(ResourceFetchError);
  });
});

describe("fetchBytes", () => {
  /** The reason of the ResourceFetchError a call raises. */
  async function refusalReason(
    url: string,
    maxBytes?: number,
  ): Promise<string> {
    try {
      await fetchBytes(url, maxBytes === undefined ? {} : { maxBytes });
    } catch (error) {
      if (error instanceof ResourceFetchError) {
        return error.reason;
      }
      throw error;
    }
    throw new Error("The fetch was expected to be refused.");
  }

  it("reads a file: URL", async () => {
    const bytes = await fetchBytes(pathToFileURL(source).href);
    expect(bytes.equals(CONTENT)).toBe(true);
  });

  // The allow-list is the point of the function: a catalog entry is data
  // fetched from elsewhere, and without it that data could name any scheme the
  // runtime happens to support and have the instance read from it.
  it.each([
    "data:text/plain,hello",
    "blob:https://example.test/1234",
    "ftp://example.test/x.tgz",
    "javascript:1",
  ])("refuses the scheme in %j", async (url) => {
    expect(await refusalReason(url)).toBe("unsupported-scheme");
  });

  it("refuses a string that is not a URL at all", async () => {
    expect(await refusalReason("/data/plugins/archives/x.tgz")).toBe(
      "unsupported-scheme",
    );
    expect(await refusalReason("")).toBe("unsupported-scheme");
  });

  it("reports an unreadable file as unreachable rather than as a bad scheme", async () => {
    // The two are shown differently: one is a broken catalog entry, the other
    // is a source that is temporarily gone.
    const missing = pathToFileURL(join(workspace, "absent.tgz")).href;
    expect(await refusalReason(missing)).toBe("unreachable");
  });

  it("enforces maxBytes", async () => {
    expect(
      await refusalReason(pathToFileURL(source).href, CONTENT.length - 1),
    ).toBe("too-large");
  });

  it("accepts a payload exactly at the limit", async () => {
    const bytes = await fetchBytes(pathToFileURL(source).href, {
      maxBytes: CONTENT.length,
    });
    expect(bytes.byteLength).toBe(CONTENT.length);
  });

  it("applies its own limit when the caller names none", async () => {
    // The default has to be generous enough that a real plugin tarball is not
    // refused; a payload this small must pass with no maxBytes given.
    expect(CONTENT.length).toBeLessThan(DEFAULT_MAX_BYTES);
    await expect(
      fetchBytes(pathToFileURL(source).href),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
