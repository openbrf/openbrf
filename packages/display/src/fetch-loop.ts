/**
 * The fetch loop: the request for screen content, and what is done with each
 * answer, as the table under "Pairing" in ADR 0034 says it.
 *
 * | Answer                                                        | What the loop does                                                         |
 * | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
 * | 200                                                           | Replaces the cache whole and shows the document.                           |
 * | 304                                                           | Shows the cached document, now confirmed.                                  |
 * | 401, `realm="device"` and `device-token-invalid`              | Clears the cache, stops, and says so: the caller forgets the token.        |
 * | 404                                                           | Clears the cache and says the screen is paused; asks again every minute.   |
 * | 429                                                           | Keeps what is shown and asks again after `Retry-After`, within a minute.   |
 * | Anything else, a body that is not a document, a network error | Shows the cache for 24 hours since it was fetched, then says disconnected. |
 *
 * Where the content is cached, and what a revocation wipes besides it, is the
 * caller's, because a shell holds more than the display page does.
 */
import type { ScreenContent } from "./contract.ts";
import { SCREEN_CONTENT_LIMITS } from "./contract.ts";
import { parseScreenContent } from "./parse.ts";

/** What the loop keeps between fetches. */
export interface CachedScreenContent {
  content: ScreenContent;
  /** The strong ETag the document came with, or null. */
  etag: string | null;
  /** ISO 8601 instant of the last 200 or 304. */
  fetchedAt: string;
}

/** Where the content is kept, such as `localStorage`. The caller's to choose. */
export interface ScreenContentCache {
  read(): CachedScreenContent | null;
  write(entry: CachedScreenContent): void;
  clear(): void;
}

/** How fresh the content handed to `onContent` is. */
export interface FetchedStatus {
  fetchedAt: Date;
  /** True when the instance could not be reached and this is the last good content. */
  stale: boolean;
}

export interface FetchLoopOptions {
  /** The absolute content URL, query included. The token is never put in it. */
  url: string;
  /** The device token, read before each request; null when there is none. */
  token: () => string | null;
  cache: ScreenContentCache;
  /** Content to show: fresh, or the last good content while the instance cannot be reached. */
  onContent(content: ScreenContent, status: FetchedStatus): void;
  /**
   * The instance refused the token (401 with `realm="device"` and
   * `device-token-invalid`), or there is no token. The loop has cleared the
   * cache and stopped; the caller forgets whatever else it holds, the token
   * first.
   */
  onRevoked(): void;
  /**
   * 404: the route is switched off. The loop has cleared the cache, and asks
   * again every 60 seconds. Without it, a 404 is told as `onDisconnected(null)`.
   */
  onPaused?(): void;
  /**
   * Nothing to show: no content was ever fetched, or the last was fetched 24
   * hours ago or more. The loop asks again every 60 seconds.
   */
  onDisconnected(lastFetchedAt: Date | null): void;
  fetch?: typeof fetch;
  now?: () => Date;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** A running fetch loop. */
export interface FetchLoop {
  /** Stops the loop; a request in flight is aborted and its answer ignored. */
  stop(): void;
  /** Fetches now, unless a request is already in flight. */
  refreshNow(): void;
}

const SECOND = 1000;
/** How long the last good content may be shown, from when it was fetched. */
export const STALE_CONTENT_LIMIT_MS = 24 * 60 * 60 * SECOND;
/** How long one request may take before it counts as a network failure. */
const REQUEST_TIMEOUT_MS = 30 * SECOND;
const RETRY_SECONDS = 60;
/** A cache entry stamped this far in the future is a clock gone wrong, not fresh content. */
const CLOCK_SKEW_MS = 5 * 60 * SECOND;

/**
 * Starts fetching screen content: at once, then `refreshSeconds` after each
 * 200 or 304, held to 30 to 60, and 60 seconds after anything else.
 *
 * Each request is `GET url` with the token in `Authorization: Bearer`, the
 * cached ETag in `If-None-Match`, no cookie (`credentials: "omit"`) and no
 * HTTP cache (`cache: "no-store"`). Only one is ever in flight. A cache entry
 * younger than 24 hours is shown at once, as stale, before the first answer.
 */
export function startFetchLoop(options: FetchLoopOptions): FetchLoop {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = (): number => (options.now ?? (() => new Date()))().getTime();
  const schedule =
    options.setTimeout ??
    ((callback: () => void, ms: number): unknown => setTimeout(callback, ms));
  const unschedule =
    options.clearTimeout ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  let stopped = false;
  let timer: unknown = null;
  let inFlight: AbortController | null = null;
  /** After a 304 with nothing cached, the next request asks unconditionally. */
  let unconditional = false;
  /** The last successful fetch, remembered after the cache is cleared. */
  let lastFetchedAt: number | null = null;

  /** The cache entry, when it is still a document this package reads. */
  function readCache(): {
    entry: CachedScreenContent;
    fetchedAt: number;
  } | null {
    let entry: CachedScreenContent | null;
    try {
      entry = options.cache.read();
    } catch {
      return null;
    }
    if (entry === null) {
      return null;
    }
    const fetchedAt = Date.parse(entry.fetchedAt);
    try {
      if (!Number.isFinite(fetchedAt)) {
        throw new Error("fetchedAt is not an instant.");
      }
      const content = parseScreenContent(entry.content);
      return {
        entry: {
          content,
          etag: typeof entry.etag === "string" ? entry.etag : null,
          fetchedAt: entry.fetchedAt,
        },
        fetchedAt,
      };
    } catch {
      options.cache.clear();
      return null;
    }
  }

  function fresh(fetchedAt: number): boolean {
    const age = now() - fetchedAt;
    return age > -CLOCK_SKEW_MS && age < STALE_CONTENT_LIMIT_MS;
  }

  function stop(): void {
    stopped = true;
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
    inFlight?.abort();
    inFlight = null;
  }

  function revoke(): void {
    stop();
    options.cache.clear();
    options.onRevoked();
  }

  function next(seconds: number): void {
    if (stopped) {
      return;
    }
    if (timer !== null) {
      unschedule(timer);
    }
    timer = schedule(() => {
      timer = null;
      void request();
    }, seconds * SECOND);
  }

  function remember(fetchedAt: number): void {
    lastFetchedAt = Math.max(lastFetchedAt ?? fetchedAt, fetchedAt);
  }

  /** Any answer but 200, 304, a revoking 401, 404 and 429. */
  function unreachable(): void {
    const cached = readCache();
    if (cached !== null) {
      remember(cached.fetchedAt);
    }
    if (cached !== null && fresh(cached.fetchedAt)) {
      options.onContent(cached.entry.content, {
        fetchedAt: new Date(cached.fetchedAt),
        stale: true,
      });
    } else {
      options.cache.clear();
      options.onDisconnected(
        lastFetchedAt === null ? null : new Date(lastFetchedAt),
      );
    }
    next(RETRY_SECONDS);
  }

  function shown(content: ScreenContent, fetchedAt: number): void {
    remember(fetchedAt);
    options.onContent(content, {
      fetchedAt: new Date(fetchedAt),
      stale: false,
    });
    next(
      Math.min(
        SCREEN_CONTENT_LIMITS.refreshSecondsMax,
        Math.max(
          SCREEN_CONTENT_LIMITS.refreshSecondsMin,
          content.refreshSeconds,
        ),
      ),
    );
  }

  async function request(): Promise<void> {
    if (stopped || inFlight !== null) {
      return;
    }
    const token = options.token();
    if (token === null || token === "") {
      revoke();
      return;
    }
    const cached = readCache();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (cached !== null && cached.entry.etag !== null && !unconditional) {
      headers["If-None-Match"] = cached.entry.etag;
    }
    const controller = new AbortController();
    inFlight = controller;
    const timeout = schedule(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let answer: Answer;
    try {
      const response = await fetchImpl(options.url, {
        method: "GET",
        headers,
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        redirect: "error",
        signal: controller.signal,
      });
      answer = await read(response, now());
    } catch {
      answer = { kind: "other" };
    } finally {
      unschedule(timeout);
    }
    if (stopped || inFlight !== controller) {
      return;
    }
    inFlight = null;
    handle(answer, cached);
  }

  function handle(
    answer: Answer,
    cached: { entry: CachedScreenContent; fetchedAt: number } | null,
  ): void {
    switch (answer.kind) {
      case "content": {
        const fetchedAt = now();
        unconditional = false;
        options.cache.write({
          content: answer.content,
          etag: answer.etag,
          fetchedAt: new Date(fetchedAt).toISOString(),
        });
        shown(answer.content, fetchedAt);
        return;
      }
      case "not-modified": {
        if (cached === null) {
          unconditional = true;
          unreachable();
          return;
        }
        const fetchedAt = now();
        options.cache.write({
          ...cached.entry,
          fetchedAt: new Date(fetchedAt).toISOString(),
        });
        shown(cached.entry.content, fetchedAt);
        return;
      }
      case "revoked":
        revoke();
        return;
      case "paused":
        options.cache.clear();
        if (options.onPaused === undefined) {
          options.onDisconnected(null);
        } else {
          options.onPaused();
        }
        next(RETRY_SECONDS);
        return;
      case "slow-down": {
        const current = readCache();
        if (current !== null && !fresh(current.fetchedAt)) {
          // Slowing down does not stretch the 24 hours.
          unreachable();
          return;
        }
        next(answer.retryAfter);
        return;
      }
      case "other":
        unreachable();
        return;
    }
  }

  const cachedAtStart = readCache();
  if (cachedAtStart !== null) {
    remember(cachedAtStart.fetchedAt);
    if (fresh(cachedAtStart.fetchedAt)) {
      options.onContent(cachedAtStart.entry.content, {
        fetchedAt: new Date(cachedAtStart.fetchedAt),
        stale: true,
      });
    } else {
      options.cache.clear();
    }
  }
  void request();

  return {
    stop,
    refreshNow() {
      if (stopped || inFlight !== null) {
        return;
      }
      if (timer !== null) {
        unschedule(timer);
        timer = null;
      }
      void request();
    },
  };
}

type Answer =
  | { kind: "content"; content: ScreenContent; etag: string | null }
  | { kind: "not-modified" }
  | { kind: "revoked" }
  | { kind: "paused" }
  | { kind: "slow-down"; retryAfter: number }
  | { kind: "other" };

async function read(response: Response, now: number): Promise<Answer> {
  switch (response.status) {
    case 200: {
      const text = await response.text();
      if (
        new TextEncoder().encode(text).byteLength >
        SCREEN_CONTENT_LIMITS.documentBytes
      ) {
        return { kind: "other" };
      }
      try {
        return {
          kind: "content",
          content: parseScreenContent(JSON.parse(text)),
          etag: response.headers.get("ETag"),
        };
      } catch {
        return { kind: "other" };
      }
    }
    case 304:
      return { kind: "not-modified" };
    case 401:
      return (await revokes(response))
        ? { kind: "revoked" }
        : { kind: "other" };
    case 404:
      return { kind: "paused" };
    case 429:
      return {
        kind: "slow-down",
        retryAfter: retryAfter(response.headers.get("Retry-After"), now),
      };
    default:
      return { kind: "other" };
  }
}

/**
 * Whether a 401 is the instance refusing the token: the challenge names
 * `realm="device"`, and the body's `reason` (or the challenge's `error`) is
 * `device-token-invalid`. Any other 401, such as one from a proxy in between,
 * is not a reason to forget the token.
 */
async function revokes(response: Response): Promise<boolean> {
  const challenge = parseChallenge(response.headers.get("WWW-Authenticate"));
  if (challenge === null || challenge.get("realm") !== "device") {
    return false;
  }
  if (challenge.get("error") === "device-token-invalid") {
    return true;
  }
  try {
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      (body as { reason?: unknown }).reason === "device-token-invalid"
    );
  } catch {
    return false;
  }
}

/** The parameters of a `Bearer` challenge, or null when there is none. */
function parseChallenge(header: string | null): Map<string, string> | null {
  if (header === null) {
    return null;
  }
  const match = /^\s*Bearer(?:\s+(.*))?$/i.exec(header);
  if (match === null) {
    return null;
  }
  const parameters = new Map<string, string>();
  const pattern = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (const parameter of (match[1] ?? "").matchAll(pattern)) {
    const name = parameter[1];
    if (name !== undefined) {
      parameters.set(
        name.toLowerCase(),
        parameter[2]?.replace(/\\(.)/g, "$1") ?? parameter[3] ?? "",
      );
    }
  }
  return parameters;
}

/** `Retry-After` in seconds, held to 1 to 60; 60 when absent or unreadable. */
function retryAfter(header: string | null, now: number): number {
  if (header === null) {
    return RETRY_SECONDS;
  }
  const value = header.trim();
  let seconds: number;
  if (/^\d+$/.test(value)) {
    seconds = Number(value);
  } else {
    const date = Date.parse(value);
    if (!Number.isFinite(date)) {
      return RETRY_SECONDS;
    }
    seconds = Math.ceil((date - now) / SECOND);
  }
  return Math.min(RETRY_SECONDS, Math.max(1, seconds));
}
