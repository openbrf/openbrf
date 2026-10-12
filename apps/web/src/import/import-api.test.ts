import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_IMPORT_TIMEOUT_MS, fetchActiveImport } from "./import-api";

/**
 * The screen holds back its upload form until it knows whether an import is
 * running, so the question has to come back one way or the other.
 */
describe("asking which import is running", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gives up on a request that never answers", async () => {
    // A fetch that settles only when it is abandoned, like the browser's.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    );

    const answer = fetchActiveImport();
    await vi.advanceTimersByTimeAsync(ACTIVE_IMPORT_TIMEOUT_MS);

    expect(await answer).toEqual({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });
  });

  it("hands over an answer that comes in time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(null))),
    );

    expect(await fetchActiveImport()).toEqual({ ok: true, value: null });
    expect(vi.getTimerCount()).toBe(0);
  });
});
