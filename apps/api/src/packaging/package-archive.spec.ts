import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * The end-to-end harness's mode.
 *
 * `file:` is a source only an instance that has opted out of the curated
 * catalog may read, which is the mode the harness runs in when it points at
 * tarballs baked into the test image. Every fixture here is a local file, so
 * every call that is meant to succeed says so explicitly.
 */
const HARNESS = { allowUncuratedSources: true } as const;

/**
 * Resolves to "closed" or to "still open", never by hanging.
 *
 * A test that waits on a socket the code under test was supposed to release
 * would otherwise fail as a timeout, which reads as an unstable suite rather
 * than as the assertion it is.
 */
async function withinTwoSeconds(settled: Promise<void>): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settled.then(() => "closed"),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => {
          resolve("still open");
        }, 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    const path = await ensureArchive(
      store,
      PLUGIN_ID,
      VERSION,
      artifact(),
      HARNESS,
    );

    expect(path).toBe(storedPath());
    expect((await readFile(path)).equals(CONTENT)).toBe(true);
  });

  it("creates the store directory when it does not exist yet", async () => {
    expect(await exists(store)).toBe(false);
    await ensureArchive(store, PLUGIN_ID, VERSION, artifact(), HARNESS);
    expect(await exists(store)).toBe(true);
  });

  it("reuses a verified archive rather than fetching again", async () => {
    // Idempotency is what lets a job that crashed after the download converge
    // on the next run. Removing the source proves the second call made no trip
    // for the bytes: if it had, there would be nothing to fetch.
    await ensureArchive(store, PLUGIN_ID, VERSION, artifact(), HARNESS);
    await rm(source);

    const path = await ensureArchive(
      store,
      PLUGIN_ID,
      VERSION,
      artifact(),
      HARNESS,
    );

    expect((await readFile(path)).equals(CONTENT)).toBe(true);
  });

  it("discards a cached archive whose digest no longer matches", async () => {
    // A truncated write from a crash mid-download, or a version republished
    // under the same name. Either way the stored bytes are not the bytes the
    // catalog named, so they are replaced rather than trusted.
    await ensureArchive(store, PLUGIN_ID, VERSION, artifact(), HARNESS);
    await writeFile(storedPath(), OTHER);

    const path = await ensureArchive(
      store,
      PLUGIN_ID,
      VERSION,
      artifact(),
      HARNESS,
    );

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
        HARNESS,
      ),
    ).rejects.toBeInstanceOf(IntegrityError);

    expect(await exists(storedPath())).toBe(false);
    expect(await readdir(store)).toEqual([]);
  });

  it("removes a cached archive it could not verify even when the fetch fails", async () => {
    // The stale file is untrusted from the moment its digest fails. Leaving it
    // in place because the replacement could not be fetched would keep exactly
    // the bytes the check rejected.
    await ensureArchive(store, PLUGIN_ID, VERSION, artifact(), HARNESS);
    await writeFile(storedPath(), OTHER);
    await rm(source);

    await expect(
      ensureArchive(store, PLUGIN_ID, VERSION, artifact(), HARNESS),
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
        HARNESS,
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
      await fetchBytes(url, { ...HARNESS, maxBytes });
    } catch (error) {
      if (error instanceof ResourceFetchError) {
        return error.reason;
      }
      throw error;
    }
    throw new Error("The fetch was expected to be refused.");
  }

  it("reads a file: URL", async () => {
    const bytes = await fetchBytes(pathToFileURL(source).href, HARNESS);
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
      ...HARNESS,
      maxBytes: CONTENT.length,
    });
    expect(bytes.byteLength).toBe(CONTENT.length);
  });

  it("applies its own limit when the caller names none", async () => {
    // The default has to be generous enough that a real plugin tarball is not
    // refused; a payload this small must pass with no maxBytes given.
    expect(CONTENT.length).toBeLessThan(DEFAULT_MAX_BYTES);
    await expect(
      fetchBytes(pathToFileURL(source).href, HARNESS),
    ).resolves.toBeInstanceOf(Buffer);
  });

  /**
   * A curated instance reads over https and nothing else.
   *
   * The URL comes from the catalog, which is data fetched from elsewhere. A
   * `file:` entry would make the instance read its own disk, and a plain-http
   * one would let the catalog name an address inside the network the instance
   * sits in - so both are refused unless the operator has opted out of
   * curation, which is the same decision that permits an uncurated index.
   */
  it.each(["file", "http"])(
    "refuses a %s source unless uncurated sources are allowed",
    async (scheme) => {
      const url =
        scheme === "file"
          ? pathToFileURL(source).href
          : "http://127.0.0.1:1/x.tgz";

      try {
        await fetchBytes(url);
      } catch (error) {
        expect(error).toBeInstanceOf(ResourceFetchError);
        expect((error as ResourceFetchError).reason).toBe("unsupported-scheme");
        return;
      }
      throw new Error("The fetch was expected to be refused.");
    },
  );
});

/**
 * Reading over HTTP.
 *
 * Served from a socket in this process rather than mocked, because what is
 * under test is the transfer itself: that the limit stops it rather than
 * measuring it afterwards, and that a redirect to another origin does not
 * carry the catalog's credential with it. A mocked fetch would assert the mock.
 */
describe("fetchBytes over HTTP", () => {
  let server: Server;
  let origin: string;
  let handle: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void = () => undefined;

  beforeEach(async () => {
    server = createServer((request, response) => {
      handle(request, response);
    });
    await new Promise<void>((ready) => {
      server.listen(0, "127.0.0.1", ready);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${String(address.port)}`;
  });

  afterEach(async () => {
    await new Promise<void>((closed) => {
      server.closeAllConnections();
      server.close(() => {
        closed();
      });
    });
  });

  it("stops an oversized body instead of buffering it", async () => {
    /*
     * The decisive assertion is `written`, not the refusal. This process holds
     * the member register: a source answering with a multi-gigabyte body must
     * not be able to make it allocate all of it and only then object. The
     * server offers far more than the limit and the count says how much of it
     * was actually accepted.
     */
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const offered = 512;
    let written = 0;

    handle = (_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      let sent = 0;
      const pump = (): void => {
        while (sent < offered) {
          sent += 1;
          written += chunk.byteLength;
          if (!response.write(chunk)) {
            response.once("drain", pump);
            return;
          }
        }
        response.end();
      };
      pump();
    };

    await expect(
      fetchBytes(`${origin}/big.tgz`, { ...HARNESS, maxBytes: 128 * 1024 }),
    ).rejects.toMatchObject({ reason: "too-large" });

    expect(written).toBeLessThan(offered * chunk.byteLength);
  });

  it("refuses an oversized declared length even when the body is tiny", async () => {
    // One byte reaches the wire, so the running total can never cross the
    // limit: the declared length is the only thing that can produce this
    // refusal, which is what makes the assertion below discriminating.
    handle = (_request, response) => {
      response.writeHead(200, { "content-length": String(10 * 1024 * 1024) });
      response.end(Buffer.alloc(1));
    };

    await expect(
      fetchBytes(`${origin}/declared.tgz`, { ...HARNESS, maxBytes: 1024 }),
    ).rejects.toMatchObject({ reason: "too-large" });
  });

  it("releases the connection when it refuses a response", async () => {
    /*
     * The peer sends headers and a body it never finishes. Nothing reads that
     * body, and an unread one holds the socket until the collector reaches it.
     * The refusal has to cancel it: this process is long-lived and reads the
     * catalog on every reconcile, so one held connection per refusal
     * accumulates against a source that has started failing.
     */
    let released!: () => void;
    const closed = new Promise<void>((resolve) => {
      released = resolve;
    });

    handle = (_request, response) => {
      response.on("close", released);
      response.writeHead(404, { "content-type": "application/octet-stream" });
      response.write(Buffer.alloc(32));
    };

    await expect(
      fetchBytes(`${origin}/refused.tgz`, HARNESS),
    ).rejects.toMatchObject({ reason: "unreachable" });

    // Waited for here rather than left to the suite's teardown, which closes
    // every connection itself and would report a leak as a pass.
    await expect(withinTwoSeconds(closed)).resolves.toBe("closed");
  });

  it("does not carry the catalog credential across a redirect to another origin", async () => {
    /*
     * A release host answering with a signed URL on a storage origin is the
     * normal case for a private repository's assets. Handing that origin the
     * instance's catalog token would disclose a credential to a host the
     * operator never configured.
     */
    const seen: (string | undefined)[] = [];

    handle = (request, response) => {
      seen.push(request.headers.authorization);
      if (request.url === "/start.tgz") {
        // A different origin: same host, another port is a different origin.
        response.writeHead(302, {
          location: `http://localhost:${String((server.address() as AddressInfo).port)}/moved.tgz`,
        });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(CONTENT);
    };

    const bytes = await fetchBytes(`${origin}/start.tgz`, {
      ...HARNESS,
      headers: { authorization: "Bearer catalog-token" },
    });

    expect(bytes.equals(CONTENT)).toBe(true);
    expect(seen[0]).toBe("Bearer catalog-token");
    expect(seen[1]).toBeUndefined();
  });

  it("keeps the credential on a redirect that stays on the same origin", async () => {
    const seen: (string | undefined)[] = [];

    handle = (request, response) => {
      seen.push(request.headers.authorization);
      if (request.url === "/start.tgz") {
        response.writeHead(302, { location: "/same.tgz" });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(CONTENT);
    };

    await fetchBytes(`${origin}/start.tgz`, {
      ...HARNESS,
      headers: { authorization: "Bearer catalog-token" },
    });

    expect(seen).toEqual(["Bearer catalog-token", "Bearer catalog-token"]);
  });

  it("refuses a redirect to a scheme that is not allowed", async () => {
    handle = (_request, response) => {
      response.writeHead(302, { location: "ftp://example.test/x.tgz" });
      response.end();
    };

    await expect(
      fetchBytes(`${origin}/start.tgz`, HARNESS),
    ).rejects.toMatchObject({ reason: "unsupported-scheme" });
  });

  it("gives up on a redirect loop rather than following it forever", async () => {
    handle = (_request, response) => {
      response.writeHead(302, { location: "/round.tgz" });
      response.end();
    };

    await expect(
      fetchBytes(`${origin}/round.tgz`, HARNESS),
    ).rejects.toMatchObject({ reason: "unreachable" });
  });
});
