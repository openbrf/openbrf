import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequest } from "./client";

/**
 * What the client promises a caller that gives a request up.
 *
 * A request that is aborted comes back as "offline" wherever it was stopped -
 * waiting for the answer or reading it - and a timeout only limits the wait for
 * the answer to start, so a slow body is still taken in.
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

/** Settles when the signal fires, the way fetch and a body read do. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

/** A response whose body takes `bodyMs` to arrive, or is cut by the signal. */
function slowResponse(
  status: number,
  body: unknown,
  bodyMs: number,
  signal: AbortSignal | undefined,
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () =>
      Promise.race([
        new Promise((resolve) => setTimeout(() => resolve(body), bodyMs)),
        untilAborted(signal),
      ]),
  } as unknown as Response;
}

const OFFLINE = { ok: false, failure: { status: 0, reason: "offline" } };

describe("a request that is given up", () => {
  it("comes back offline when the signal fires during the body of a 200", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_path: string, init: RequestInit) =>
      Promise.resolve(
        slowResponse(200, { a: 1 }, 10_000, init.signal ?? undefined),
      ),
    );

    const result = apiRequest("GET", "/api/x", undefined, {
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();

    expect(await result).toEqual(OFFLINE);
  });

  it("comes back offline, not unexpected, during the body of a refusal", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_path: string, init: RequestInit) =>
      Promise.resolve(
        slowResponse(
          409,
          { reason: "taken" },
          10_000,
          init.signal ?? undefined,
        ),
      ),
    );

    const result = apiRequest("GET", "/api/x", undefined, {
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();

    expect(await result).toEqual(OFFLINE);
  });

  it("comes back offline when no answer starts within the timeout", async () => {
    fetchMock.mockImplementation((_path: string, init: RequestInit) =>
      untilAborted(init.signal ?? undefined),
    );

    const result = apiRequest("GET", "/api/x", undefined, {
      answerTimeoutMs: 6000,
    });
    await vi.advanceTimersByTimeAsync(5999);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(OFFLINE);
  });

  it("takes in a body that outlasts the timeout once the headers are in", async () => {
    fetchMock.mockImplementation((_path: string, init: RequestInit) =>
      Promise.resolve(
        slowResponse(200, { rows: 5000 }, 20_000, init.signal ?? undefined),
      ),
    );

    const result = apiRequest("GET", "/api/x", undefined, {
      answerTimeoutMs: 6000,
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await result).toEqual({ ok: true, value: { rows: 5000 } });
  });

  it("still reads a body that is not JSON as no payload when nothing was aborted", async () => {
    fetchMock.mockResolvedValue({
      status: 502,
      ok: false,
      json: () => Promise.reject(new SyntaxError("not json")),
    });

    expect(await apiRequest("GET", "/api/x")).toEqual({
      ok: false,
      failure: { status: 502, reason: "unexpected", detail: undefined },
    });
  });

  it("sends a request with nothing to watch for without a signal", async () => {
    fetchMock.mockResolvedValue({ status: 204 });

    await apiRequest("DELETE", "/api/x");

    expect(fetchMock).toHaveBeenCalledWith("/api/x", {
      method: "DELETE",
      credentials: "same-origin",
    });
  });
});
