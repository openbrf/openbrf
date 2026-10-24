import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { newsSlide, screenContent } from "../test/fixtures.ts";
import type { ScreenContent } from "./contract.ts";
import {
  startFetchLoop,
  type CachedScreenContent,
  type FetchLoop,
  type FetchLoopOptions,
  type ScreenContentCache,
} from "./fetch-loop.ts";

const CONTENT_URL = "https://brf.example.se/api/display/content?sources=news";
const TOKEN = "obrf_dt_secret";
const NOW = new Date("2026-10-23T10:00:00Z");
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

class MemoryCache implements ScreenContentCache {
  entry: CachedScreenContent | null = null;
  read() {
    return this.entry === null ? null : structuredClone(this.entry);
  }
  write(entry: CachedScreenContent) {
    this.entry = structuredClone(entry);
  }
  clear() {
    this.entry = null;
  }
}

type Answer = Response | Error | ((signal: AbortSignal) => Promise<Response>);

interface Call {
  url: string;
  init: RequestInit;
}

/** A stand-in for the instance, answering each request with the next answer. */
function instance(...answers: Answer[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error("The instance has no answer queued.");
    }
    if (answer instanceof Error) {
      throw answer;
    }
    if (typeof answer === "function") {
      return answer(init?.signal ?? new AbortController().signal);
    }
    return answer;
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, answers };
}

function document(overrides: Partial<ScreenContent> = {}): ScreenContent {
  return screenContent([newsSlide("news.1")], overrides);
}

function ok(content: unknown = document(), etag = '"v1"'): Response {
  return new Response(JSON.stringify(content), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: etag },
  });
}

function status(
  code: number,
  headers: Record<string, string> = {},
  body?: unknown,
) {
  return new Response(
    code === 304 || body === undefined ? null : JSON.stringify(body),
    { status: code, headers },
  );
}

const revoked = () =>
  status(
    401,
    { "WWW-Authenticate": 'Bearer realm="device"' },
    { reason: "device-token-invalid" },
  );

/** An answer that waits until the test settles it, or the request is aborted. */
function pending() {
  let settle: (response: Response) => void = () => {};
  let aborted = false;
  const answer = (signal: AbortSignal) =>
    new Promise<Response>((resolve, reject) => {
      settle = resolve;
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  return {
    answer,
    settle: (response: Response) => settle(response),
    wasAborted: () => aborted,
  };
}

let loop: FetchLoop | null = null;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  loop?.stop();
  loop = null;
  vi.useRealTimers();
});

function start(
  fetch: typeof globalThis.fetch,
  overrides: Partial<FetchLoopOptions> = {},
) {
  const cache = new MemoryCache();
  const onContent = vi.fn();
  const onRevoked = vi.fn();
  const onPaused = vi.fn();
  const onDisconnected = vi.fn();
  const options: FetchLoopOptions = {
    url: CONTENT_URL,
    token: () => TOKEN,
    cache,
    onContent,
    onRevoked,
    onPaused,
    onDisconnected,
    fetch,
    ...overrides,
  };
  loop = startFetchLoop(options);
  return {
    cache: options.cache as MemoryCache,
    onContent,
    onRevoked,
    onPaused,
    onDisconnected,
    loop,
  };
}

function cached(fetchedAgo: number, etag: string | null = '"v0"'): MemoryCache {
  const cache = new MemoryCache();
  cache.write({
    content: document({ screenId: "cached" }),
    etag,
    fetchedAt: new Date(NOW.getTime() - fetchedAgo).toISOString(),
  });
  return cache;
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("the fetch loop", () => {
  it("asks with the token in Authorization only, no cookie and no HTTP cache", async () => {
    const server = instance(ok());
    start(server.fetch);
    await settle();

    expect(server.calls).toHaveLength(1);
    const [call] = server.calls;
    expect(call?.url).toBe(CONTENT_URL);
    expect(call?.url).not.toContain(TOKEN);
    expect(call?.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
    });
    expect(call?.init.headers).toEqual({
      Accept: "application/json",
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it("shows a 200 and replaces the cache whole with it and its ETag", async () => {
    const server = instance(ok(document(), '"v7"'));
    const { cache, onContent } = start(server.fetch);
    await settle();

    expect(onContent).toHaveBeenCalledWith(document(), {
      fetchedAt: NOW,
      stale: false,
    });
    expect(cache.entry).toEqual({
      content: document(),
      etag: '"v7"',
      fetchedAt: NOW.toISOString(),
    });
  });

  it("sends the cached ETag, and shows the cached content on a 304", async () => {
    const cache = cached(10 * SECOND, '"v0"');
    const server = instance(status(304));
    const { onContent } = start(server.fetch, { cache });
    await settle();

    const headers = server.calls[0]?.init.headers as
      Record<string, string> | undefined;
    expect(headers?.["If-None-Match"]).toBe('"v0"');
    expect(onContent).toHaveBeenLastCalledWith(
      document({ screenId: "cached" }),
      { fetchedAt: NOW, stale: false },
    );
    expect(cache.entry?.fetchedAt).toBe(NOW.toISOString());
  });

  it("shows a cache younger than 24 hours at once, as stale, before the first answer", () => {
    const answer = pending();
    const { onContent } = start(instance(answer.answer).fetch, {
      cache: cached(HOUR),
    });

    expect(onContent).toHaveBeenCalledWith(document({ screenId: "cached" }), {
      fetchedAt: new Date(NOW.getTime() - HOUR),
      stale: true,
    });
  });

  it("asks again refreshSeconds after a 200, and never later than 60 seconds", async () => {
    const server = instance(
      ok(document({ refreshSeconds: 30 })),
      ok({ ...document(), refreshSeconds: 3600 }),
      ok(),
    );
    start(server.fetch);
    await settle();

    await vi.advanceTimersByTimeAsync(29 * SECOND);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(server.calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60 * SECOND);
    expect(server.calls).toHaveLength(3);
  });

  describe("on a 401", () => {
    it("with realm device and device-token-invalid, wipes the cache and stops", async () => {
      const server = instance(revoked());
      const { cache, onRevoked, onContent } = start(server.fetch, {
        cache: cached(HOUR),
      });
      await settle();

      expect(onRevoked).toHaveBeenCalledTimes(1);
      expect(cache.entry).toBeNull();
      await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
      expect(server.calls).toHaveLength(1);
      expect(onContent).toHaveBeenCalledTimes(1);
    });

    it("takes device-token-invalid from the challenge's error as well", async () => {
      const server = instance(
        status(401, {
          "WWW-Authenticate":
            'Bearer realm="device", error="device-token-invalid"',
        }),
      );
      const { onRevoked } = start(server.fetch);
      await settle();

      expect(onRevoked).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        "another realm",
        { "WWW-Authenticate": 'Bearer realm="api"' },
        {
          reason: "device-token-invalid",
        },
      ],
      ["no challenge", {}, { reason: "device-token-invalid" }],
      [
        "another reason",
        { "WWW-Authenticate": 'Bearer realm="device"' },
        {
          reason: "session-expired",
        },
      ],
    ])(
      "with %s, keeps the token and the cached content",
      async (_, headers: Record<string, string>, body) => {
        const server = instance(status(401, headers, body), ok());
        const { cache, onRevoked, onContent } = start(server.fetch, {
          cache: cached(HOUR),
        });
        await settle();

        expect(onRevoked).not.toHaveBeenCalled();
        expect(cache.entry).not.toBeNull();
        expect(onContent).toHaveBeenLastCalledWith(
          document({ screenId: "cached" }),
          { fetchedAt: new Date(NOW.getTime() - HOUR), stale: true },
        );
        await vi.advanceTimersByTimeAsync(60 * SECOND);
        expect(server.calls).toHaveLength(2);
      },
    );
  });

  it("on a 404, clears the cache, pauses, and asks again every 60 seconds", async () => {
    const server = instance(status(404), status(404), ok());
    const { cache, onPaused, onContent } = start(server.fetch, {
      cache: cached(HOUR),
    });
    await settle();

    expect(cache.entry).toBeNull();
    expect(onPaused).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * SECOND);
    expect(onPaused).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * SECOND);
    expect(onContent).toHaveBeenLastCalledWith(document(), {
      fetchedAt: new Date(NOW.getTime() + 120 * SECOND),
      stale: false,
    });
  });

  it("on a 404 without onPaused, says it is disconnected", async () => {
    const { onDisconnected } = start(instance(status(404)).fetch, {
      onPaused: undefined,
    });
    await settle();

    expect(onDisconnected).toHaveBeenCalledWith(null);
  });

  it.each([
    ["5", 5],
    ["600", 60],
    ["0", 1],
    [undefined, 60],
    ["soon", 60],
  ])(
    "on a 429 with Retry-After %s, keeps what it shows and asks again after %i seconds",
    async (header, seconds) => {
      const server = instance(
        status(429, header === undefined ? {} : { "Retry-After": header }),
        ok(),
      );
      const { onContent, onDisconnected } = start(server.fetch);
      await settle();

      expect(onContent).not.toHaveBeenCalled();
      expect(onDisconnected).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(seconds * SECOND - 1);
      expect(server.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(server.calls).toHaveLength(2);
    },
  );

  describe("on any other answer", () => {
    it.each([
      ["a 500", () => status(500)],
      ["a 401 from a proxy", () => status(401)],
      ["a network failure", () => new TypeError("Failed to fetch")],
      [
        "a document of another version",
        () => ok({ ...document(), version: 2 }),
      ],
      [
        "a body that is not JSON",
        () => new Response("<html>", { status: 200 }),
      ],
    ])("after %s, shows the cache as stale for 24 hours", async (_, answer) => {
      const server = instance(answer());
      const { onContent, onDisconnected } = start(server.fetch, {
        cache: cached(23 * HOUR),
      });
      await settle();

      expect(onContent).toHaveBeenLastCalledWith(
        document({ screenId: "cached" }),
        { fetchedAt: new Date(NOW.getTime() - 23 * HOUR), stale: true },
      );
      expect(onDisconnected).not.toHaveBeenCalled();
    });

    it("says it is disconnected once the cache is 24 hours old, and clears it", async () => {
      const fetchedAt = new Date(NOW.getTime() - 24 * HOUR + 30 * SECOND);
      const server = instance(status(503), status(503), status(503));
      const cache = cached(24 * HOUR - 30 * SECOND);
      const { onContent, onDisconnected } = start(server.fetch, { cache });
      await settle();
      expect(onContent).toHaveBeenLastCalledWith(expect.anything(), {
        fetchedAt,
        stale: true,
      });

      await vi.advanceTimersByTimeAsync(60 * SECOND);

      expect(onDisconnected).toHaveBeenCalledWith(fetchedAt);
      expect(cache.entry).toBeNull();
      await vi.advanceTimersByTimeAsync(60 * SECOND);
      expect(onDisconnected).toHaveBeenLastCalledWith(fetchedAt);
      expect(server.calls).toHaveLength(3);
    });

    it("says it is disconnected with nothing cached", async () => {
      const { onDisconnected } = start(instance(status(502)).fetch);
      await settle();

      expect(onDisconnected).toHaveBeenCalledWith(null);
    });

    it("does not show a cache older than 24 hours at start", async () => {
      const cache = cached(25 * HOUR);
      const { onContent } = start(instance(status(500)).fetch, { cache });
      await settle();

      expect(onContent).not.toHaveBeenCalled();
      expect(cache.entry).toBeNull();
    });

    it("gives up on a request after 30 seconds", async () => {
      const answer = pending();
      const { onDisconnected } = start(instance(answer.answer).fetch);

      await vi.advanceTimersByTimeAsync(30 * SECOND);

      expect(answer.wasAborted()).toBe(true);
      expect(onDisconnected).toHaveBeenCalledWith(null);
    });
  });

  it("without a token, says it is revoked and asks nothing", async () => {
    const server = instance(ok());
    const { onRevoked, cache } = start(server.fetch, {
      token: () => null,
      cache: cached(HOUR),
    });
    await settle();

    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(server.calls).toHaveLength(0);
    expect(cache.entry).toBeNull();
  });

  it("has one request in flight at most", async () => {
    const answer = pending();
    const server = instance(answer.answer, ok());
    const { loop: running, onContent } = start(server.fetch);

    running.refreshNow();
    running.refreshNow();
    expect(server.calls).toHaveLength(1);

    answer.settle(ok());
    await settle();
    expect(onContent).toHaveBeenCalledTimes(1);

    running.refreshNow();
    await settle();
    expect(server.calls).toHaveLength(2);
  });

  it("aborts the request in flight when stopped, and ignores its answer", async () => {
    const answer = pending();
    const {
      loop: running,
      onContent,
      onDisconnected,
    } = start(instance(answer.answer).fetch);

    running.stop();
    answer.settle(ok());
    await vi.advanceTimersByTimeAsync(120 * SECOND);

    expect(answer.wasAborted()).toBe(true);
    expect(onContent).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
  });
});
