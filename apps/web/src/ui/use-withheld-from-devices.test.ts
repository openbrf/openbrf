import { MAX_WITHHELD_IDS } from "@openbrf/shared";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchWithheldFromDevices } from "../api/withheld-from-devices";
import { useWithheldFromDevices } from "./use-withheld-from-devices";

vi.mock("../api/withheld-from-devices", () => ({
  fetchWithheldFromDevices: vi.fn(),
}));

/**
 * What the editors can rely on the mark hook for (ADR 0032): an item the check
 * withheld is not shown as passing because a later read failed, and a mark is
 * never shown beside text it was not asked about.
 */

const withheld = { words: ["Anna"], unshownWords: false };
const fetchMock = vi.mocked(fetchWithheldFromDevices);

function answers(items: { id: string }[]) {
  return {
    ok: true as const,
    value: {
      items: items.map((item) => ({
        id: item.id,
        withheldFromDevices: withheld,
      })),
    },
  };
}

const failure = {
  ok: false as const,
  error: { status: 500, message: "failed" },
} as unknown as Awaited<ReturnType<typeof fetchWithheldFromDevices>>;

beforeEach(() => {
  fetchMock.mockReset();
});

describe("useWithheldFromDevices", () => {
  it("marks the items the check withholds", async () => {
    fetchMock.mockResolvedValue(answers([{ id: "a" }]));
    const { result } = renderHook(() =>
      useWithheldFromDevices("news", ["a", "b"], "1"),
    );
    await waitFor(() => {
      expect(result.current.get("a")).toEqual(withheld);
    });
    expect(result.current.has("b")).toBe(false);
  });

  it("asks in batches of the most ids the API takes", async () => {
    fetchMock.mockResolvedValue(answers([]));
    const ids = Array.from(
      { length: MAX_WITHHELD_IDS + 1 },
      (_, index) => `n${index}`,
    );
    renderHook(() => useWithheldFromDevices("news", ids, "1"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock.mock.calls.map((call) => call[1].length)).toEqual([
      MAX_WITHHELD_IDS,
      1,
    ]);
  });

  it("keeps the marks of the last answer for the same items when a re-read fails", async () => {
    fetchMock.mockResolvedValueOnce(answers([{ id: "a" }]));
    const { result, rerender } = renderHook(
      ({ version }) => useWithheldFromDevices("news", ["a"], version),
      { initialProps: { version: "1" } },
    );
    await waitFor(() => {
      expect(result.current.get("a")).toEqual(withheld);
    });

    fetchMock.mockResolvedValueOnce(failure);
    rerender({ version: "2" });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.get("a")).toEqual(withheld);
    });
  });

  it("marks nothing when the first read fails, or when the items changed", async () => {
    fetchMock.mockResolvedValueOnce(answers([{ id: "a" }]));
    const { result, rerender } = renderHook(
      ({ ids }) => useWithheldFromDevices("news", ids, "1"),
      { initialProps: { ids: ["a"] } },
    );
    await waitFor(() => {
      expect(result.current.get("a")).toEqual(withheld);
    });

    fetchMock.mockResolvedValueOnce(failure);
    rerender({ ids: ["a", "b"] });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.size).toBe(0);
    });
  });

  it("drops a mark as soon as the saved text changes, until the check answers again", async () => {
    fetchMock.mockResolvedValueOnce(answers([{ id: "a" }]));
    // The second question never answers.
    fetchMock.mockReturnValueOnce(new Promise(() => undefined));
    const { result, rerender } = renderHook(
      ({ version }) => useWithheldFromDevices("news", ["a"], version),
      { initialProps: { version: "1" } },
    );
    await waitFor(() => {
      expect(result.current.get("a")).toEqual(withheld);
    });

    rerender({ version: "2" });

    expect(result.current.has("a")).toBe(false);
  });

  it("asks nothing for an editor with no items", () => {
    renderHook(() => useWithheldFromDevices("meetings", [], ""));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
