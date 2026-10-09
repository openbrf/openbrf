import { constants, type FileHandle, open, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Fetching a catalog index or a release tarball.
 *
 * Two allow-lists, not one. https is the only source a curated instance reads
 * from; http exists for a catalog served inside a compose network and file:
 * for the end-to-end harness pointing at tarballs baked into the test image,
 * and both are refused unless the caller says the instance has opted out of
 * curation. Node's fetch does not implement file:, so it is read directly.
 *
 * The allow-list is the point of the function. A catalog entry is data fetched
 * from elsewhere: without it, that data could name a scheme the runtime
 * happens to support and have the instance read from it - `file:` being an
 * arbitrary local-file read on the machine holding the register.
 *
 * Redirects are followed here rather than by fetch, for two reasons. Every hop
 * has to be checked against the same allow-list, and the Authorization header
 * belongs to the source the operator configured rather than to wherever that
 * source points - a release host answering with a signed URL on another origin
 * must not be handed the catalog token.
 *
 * The size limit is applied while the body is read rather than after. The
 * process that answers this call is the one holding the member register, so a
 * source that replies with a multi-gigabyte body must not be able to make it
 * allocate all of it first.
 *
 * A deadline, when the caller sets one, bounds time the way the limit bounds
 * size. One deadline for the whole exchange - every hop and the body - so a
 * source that answers and then stops sending is abandoned on the same terms as
 * one that never answers at all.
 */

/** What a curated instance may read from. */
const CURATED_PROTOCOLS: ReadonlySet<string> = new Set(["https:"]);

/** Additionally allowed once the instance has opted out of curation. */
const UNCURATED_PROTOCOLS: ReadonlySet<string> = new Set([
  "https:",
  "http:",
  "file:",
]);

/** Enough for a release host's signed-URL hand-off, and not a loop. */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/**
 * The values behind a refusal, for a caller that has to say it in a language
 * other than this message's. Set where the refusal has one: the status a host
 * answered, the deadline that passed, the limit a body went over.
 */
export interface ResourceFetchDetail {
  status?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

export class ResourceFetchError extends Error {
  constructor(
    message: string,
    readonly reason: "unsupported-scheme" | "unreachable" | "too-large",
    readonly detail: ResourceFetchDetail = {},
  ) {
    super(message);
    this.name = "ResourceFetchError";
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Refuses anything larger, before it is held in memory. */
  maxBytes?: number;
  /**
   * Widens the allow-list to http: and file:.
   *
   * Set from OPENBRF_UNCURATED_PLUGINS_ENABLED, which is the same flag that
   * lets an instance read an index Apteo does not curate. Pointing an instance
   * at sources outside the curated catalog is one deliberate act, so it takes
   * one deliberate flag rather than a second.
   */
  allowUncuratedSources?: boolean;
  /**
   * Abandons the fetch once this many milliseconds have passed, wherever it
   * is: waiting for an answer, following a redirect, or reading the body.
   * Unset, the fetch takes as long as the source does. A file: read ignores
   * it: the local disk is not a host that can stall on purpose.
   */
  timeoutMs?: number;
}

/** 64 MiB. A plugin tarball an order of magnitude past this is a mistake. */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export async function fetchBytes(
  url: string,
  options: FetchOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowed =
    options.allowUncuratedSources === true
      ? UNCURATED_PROTOCOLS
      : CURATED_PROTOCOLS;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ResourceFetchError(`Not a URL: ${url}`, "unsupported-scheme");
  }

  refuseUnlessAllowed(parsed, allowed);

  const bytes =
    parsed.protocol === "file:"
      ? await readLocalFile(parsed, maxBytes)
      : await withDeadline(options.timeoutMs, url, (signal) =>
          readOverHttp(
            parsed,
            options.headers ?? {},
            maxBytes,
            allowed,
            signal,
          ),
        );

  // Kept as well as the streaming check, for the local path and for a source
  // that understated its length by less than one chunk.
  if (bytes.byteLength > maxBytes) {
    throw new ResourceFetchError(
      `${url} is ${String(bytes.byteLength)} bytes, over the ${String(maxBytes)} byte limit.`,
      "too-large",
      { maxBytes },
    );
  }

  return bytes;
}

/**
 * Runs `read` under one deadline, when there is one.
 *
 * The timer is cleared once the exchange ends, so a read that finished leaves
 * nothing pending, and reaching it is reported as an unreachable source rather
 * than as whatever the interrupted step would have thrown.
 */
async function withDeadline<T>(
  timeoutMs: number | undefined,
  url: string,
  read: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) {
    return read(undefined);
  }

  const deadline = new AbortController();
  const expiry = setTimeout(() => {
    deadline.abort(
      new ResourceFetchError(
        `${url} did not finish within ${String(timeoutMs)} ms.`,
        "unreachable",
        { timeoutMs },
      ),
    );
  }, timeoutMs);

  try {
    return await read(deadline.signal);
  } catch (cause) {
    if (deadline.signal.aborted) {
      throw deadline.signal.reason as ResourceFetchError;
    }
    throw cause;
  } finally {
    clearTimeout(expiry);
  }
}

function refuseUnlessAllowed(url: URL, allowed: ReadonlySet<string>): void {
  if (allowed.has(url.protocol)) {
    return;
  }
  throw new ResourceFetchError(
    `${url.protocol} is not an allowed source; use ` +
      `${[...allowed].join(", ")}.`,
    "unsupported-scheme",
  );
}

async function readLocalFile(url: URL, maxBytes: number): Promise<Buffer> {
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    throw new ResourceFetchError(
      `${url.href} is not a readable file URL.`,
      "unreachable",
    );
  }

  /*
   * A regular file only. A device, a FIFO or a /proc entry reports a size of
   * nothing and then reads without end, so the size it states bounds nothing.
   * Checked before the open as well as after it, on what was opened, because
   * the path can be replaced in between. Opened nonblocking for the same
   * reason: opening a FIFO otherwise waits for a writer, and the check after
   * the open would never be reached. A regular file reads the same either way.
   */
  const notRegular = (): ResourceFetchError =>
    new ResourceFetchError(
      `${url.href} could not be read as a regular file.`,
      "unreachable",
    );
  let handle: FileHandle;
  try {
    if (!(await stat(path)).isFile()) {
      throw notRegular();
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw notRegular();
  }

  try {
    let regular: boolean;
    try {
      regular = (await handle.stat()).isFile();
    } catch {
      regular = false;
    }
    if (!regular) {
      throw notRegular();
    }
    return await readBounded(handle, url, maxBytes);
  } finally {
    await handle.close();
  }
}

/**
 * Reads a file up to the limit and no further.
 *
 * Bounded by what is read rather than by what the file said its size was, so
 * a file that grows between the check and the read is refused once it passes
 * the limit instead of being held whole first.
 */
async function readBounded(
  handle: FileHandle,
  url: URL,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(chunk, 0, chunk.length, null));
    } catch {
      throw new ResourceFetchError(
        `${url.href} could not be read.`,
        "unreachable",
      );
    }
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    total += bytesRead;
    if (total > maxBytes) {
      throw new ResourceFetchError(
        `${url.href} is over the ${String(maxBytes)} byte limit.`,
        "too-large",
        { maxBytes },
      );
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
}

async function readOverHttp(
  url: URL,
  headers: Record<string, string>,
  maxBytes: number,
  allowed: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  let target = url;
  let carried = headers;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetch(target, {
        headers: carried,
        redirect: "manual",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new ResourceFetchError(
        `${target.href} could not be reached.`,
        "unreachable",
      );
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      if (!response.ok) {
        await discard(response);
        throw new ResourceFetchError(
          `${target.href} answered ${String(response.status)}.`,
          "unreachable",
          { status: response.status },
        );
      }
      return await readBody(response, target, maxBytes, signal);
    }

    // Nothing below reads a redirect's body, and an unread body holds the
    // connection until the collector reaches it. This process is the one
    // holding the member register and runs this on every reconcile, so a
    // source that answers slowly must not be able to accumulate sockets in it.
    await discard(response);

    const location = response.headers.get("location");
    if (location === null || location === "") {
      throw new ResourceFetchError(
        `${target.href} answered ${String(response.status)} with no location.`,
        "unreachable",
      );
    }

    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new ResourceFetchError(
        `${target.href} redirected to something that is not a URL.`,
        "unreachable",
      );
    }
    refuseUnlessAllowed(next, allowed);

    carried =
      next.origin === target.origin ? carried : withoutAuthorization(carried);
    target = next;
  }

  throw new ResourceFetchError(
    `${url.href} redirected more than ${String(MAX_REDIRECTS)} times.`,
    "unreachable",
  );
}

/**
 * Reads the body, stopping at the limit.
 *
 * The declared length is checked first so an honest oversized source costs one
 * header exchange, and the running total is checked as well because a source
 * is free to lie about the length or omit it entirely.
 */
async function readBody(
  response: Response,
  url: URL,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    throw new ResourceFetchError(
      `${url.href} declares ${String(declared)} bytes, over the ${String(maxBytes)} byte limit.`,
      "too-large",
      { maxBytes },
    );
  }

  const body = response.body;
  if (body === null) {
    return Buffer.alloc(0);
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await untilAborted(reader, signal);
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      // Cancels the transfer rather than reading to the end and refusing it:
      // the whole point is not to hold the body.
      void reader.cancel().catch(() => {
        // The connection is being abandoned either way.
      });
      throw new ResourceFetchError(
        `${url.href} is over the ${String(maxBytes)} byte limit.`,
        "too-large",
        { maxBytes },
      );
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * The next chunk, or the deadline's reason once it passes.
 *
 * fetch ties the body it returns to the signal it was given, but that is the
 * runtime's behaviour rather than something this code can see; racing each
 * read against the signal makes the deadline hold for any body, and cancels
 * the transfer rather than leaving it to be collected.
 */
async function untilAborted<T>(
  reader: { read(): Promise<T>; cancel(): Promise<void> },
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return reader.read();
  }
  signal.throwIfAborted();

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(signal.reason);
      void reader.cancel().catch(() => {
        // The connection is being abandoned either way.
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const result = await Promise.race([reader.read(), aborted]);
    // Cancelling ends a pending read as though the body had finished, so a
    // read that won the race against the deadline is checked against it too:
    // a truncated body must never be returned as a whole one.
    signal.throwIfAborted();
    return result;
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Releases a response nothing is going to read.
 *
 * The headers stay readable afterwards, so a redirect's location can still be
 * taken from a response whose body has been cancelled.
 */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is being abandoned either way.
  }
}

/** Every header except the credential, for a hop to another origin. */
function withoutAuthorization(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== "authorization",
    ),
  );
}
