import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { fetchIssuePlaceCounts, ISSUE_PLACE_COUNTS_TIMEOUT_MS } from "./issues";

/**
 * The place counts the queue reads together with the issues. The screen draws
 * neither until both are in, so the counts have a deadline over the whole read:
 * an answer whose body stalls after its headers would otherwise leave the queue
 * loading with no way to ask again.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Settles only when the signal fires, the way fetch and a body read do. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

const OFFLINE = { ok: false, failure: { status: 0, reason: "offline" } };

describe("the place counts", () => {
  it("come back as a failed read when the body stalls after the headers", async () => {
    fetchMock.mockImplementation((_path: string, init: RequestInit) =>
      Promise.resolve({
        status: 200,
        ok: true,
        json: () => untilAborted(init.signal ?? undefined),
      }),
    );

    const result = fetchIssuePlaceCounts();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(ISSUE_PLACE_COUNTS_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(OFFLINE);
  });

  it("come back as a failed read when no answer starts", async () => {
    fetchMock.mockImplementation((_path: string, init: RequestInit) =>
      untilAborted(init.signal ?? undefined),
    );

    const result = fetchIssuePlaceCounts();
    await vi.advanceTimersByTimeAsync(ISSUE_PLACE_COUNTS_TIMEOUT_MS);

    expect(await result).toEqual(OFFLINE);
  });

  it("are taken in when they arrive in time, and leave no timer behind", async () => {
    const places = [
      { id: "p-lift", name: "Hiss", active: true, issues: 2, open: 1 },
    ];
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(places),
    });

    expect(await fetchIssuePlaceCounts()).toEqual({ ok: true, value: places });
    expect(vi.getTimerCount()).toBe(0);
  });
});
