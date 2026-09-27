import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchBytes, ResourceFetchError } from "./fetch-resource";

/**
 * The deadline.
 *
 * The byte limit bounds how much a source may send, not how long it may take
 * to send it. A caller that runs inside a request - the theme install does -
 * would otherwise hold the request handler and its database connection for as
 * long as a source that went quiet cared to hold them. So a caller may set one
 * deadline for the whole exchange, and a caller that sets none gets exactly
 * the fetch it had before.
 */

const URL_OF_SOURCE = "https://catalog.example.test/theme-1.0.0.tgz";

/** A response whose headers arrive and whose body never sends a byte. */
function stalledResponse(): { response: Response; reading: () => boolean } {
  let reading = false;
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          // Nothing enqueued and nothing closed: nothing settles this read
          // except the read being abandoned.
          reading = true;
          return new Promise<void>(() => undefined);
        },
      }),
    ),
    reading: () => reading,
  };
}

/** Whether a promise has settled, without waiting for it to. */
function track(promise: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { settled: () => settled };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchBytes with a deadline", () => {
  it("abandons a response whose body never ends", async () => {
    vi.useFakeTimers();
    const { response, reading } = stalledResponse();
    vi.stubGlobal("fetch", () => Promise.resolve(response));

    const fetching = fetchBytes(URL_OF_SOURCE, { timeoutMs: 30_000 });
    const refused = expect(fetching).rejects.toMatchObject({
      name: "ResourceFetchError",
      reason: "unreachable",
    });

    // A moment short of the deadline the body is being read and nothing has
    // been decided: the limit bounds size, not time.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(reading()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await refused;
    await expect(fetching).rejects.toBeInstanceOf(ResourceFetchError);
  });

  it("abandons a source that never answers", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_input: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      });
    });

    const fetching = fetchBytes(URL_OF_SOURCE, { timeoutMs: 1_000 });
    const refused = expect(fetching).rejects.toMatchObject({
      reason: "unreachable",
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await refused;
  });

  it("covers the hop a redirect leads to as well", async () => {
    // One deadline for the whole exchange rather than one per request, so a
    // chain of slow hops cannot add up to more than the caller allowed.
    vi.useFakeTimers();
    const { response } = stalledResponse();
    vi.stubGlobal("fetch", (input: URL) =>
      Promise.resolve(
        input.hostname === "catalog.example.test"
          ? new Response(null, {
              status: 302,
              headers: { location: "https://assets.example.test/theme.tgz" },
            })
          : response,
      ),
    );

    const fetching = fetchBytes(URL_OF_SOURCE, { timeoutMs: 5_000 });
    const refused = expect(fetching).rejects.toMatchObject({
      reason: "unreachable",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await refused;
  });

  it("returns a body that arrives in time and leaves no timer behind", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]))),
    );

    const bytes = await fetchBytes(URL_OF_SOURCE, { timeoutMs: 30_000 });

    expect([...bytes]).toEqual([1, 2, 3]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fetchBytes without a deadline", () => {
  it("hands fetch no signal and keeps reading a slow body", async () => {
    vi.useFakeTimers();
    const { response, reading } = stalledResponse();
    let init: RequestInit | undefined;
    vi.stubGlobal("fetch", (_input: unknown, given: RequestInit) => {
      init = given;
      return Promise.resolve(response);
    });

    const fetching = fetchBytes(URL_OF_SOURCE);
    const { settled } = track(fetching);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(init?.signal).toBeUndefined();
    expect(reading()).toBe(true);
    expect(settled()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
