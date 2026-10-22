import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { useWithheldFromDevices } from "./use-withheld-from-devices";
import { WithheldFromDevicesNotice } from "./WithheldFromDevicesNotice";

/**
 * The editors' mark on an item the register check keeps off every device
 * (ADR 0032): what it says, what it never says, and that a mark is never
 * shown beside text it was not asked about.
 */

const fetchWithheld = vi.fn();

vi.mock("../api/withheld-from-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/withheld-from-devices")>()),
  fetchWithheldFromDevices: (...args: unknown[]) => fetchWithheld(...args),
}));

beforeEach(() => {
  fetchWithheld.mockReset();
});

describe("WithheldFromDevicesNotice", () => {
  it("shows nothing for an item the check lets through", () => {
    const { container } = render(
      <WithheldFromDevicesNotice mark={undefined} />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("names the words in the register's face, so the board can rephrase them", () => {
    render(
      <WithheldFromDevicesNotice
        mark={{ words: ["Svensson", "1101"], unshownWords: false }}
      />,
    );

    expect(screen.queryByText(/Visas inte på skärmar/)).not.toBeNull();
    expect(screen.getByText("Svensson").className).toBe("font-data");
    expect(screen.getByText("1101").className).toBe("font-data");
    expect(screen.queryByText(/också någon annan/)).toBeNull();
  });

  it("says only that the text names somebody when no word may be shown", () => {
    render(
      <WithheldFromDevicesNotice mark={{ words: [], unshownWords: true }} />,
    );

    expect(
      screen.queryByText("Texten nämner någon i registret."),
    ).not.toBeNull();
    expect(screen.queryByText(/eller en lägenhet/)).toBeNull();
  });
});

describe("useWithheldFromDevices", () => {
  const mark = { words: ["Svensson"], unshownWords: false };

  it("asks about the items on screen and marks the withheld ones", async () => {
    fetchWithheld.mockResolvedValue({
      ok: true,
      value: { items: [{ id: "b", withheldFromDevices: mark }] },
    });

    const { result } = renderHook(() =>
      useWithheldFromDevices("news", ["a", "b"], "1,1"),
    );

    await waitFor(() => {
      expect(result.current.get("b")).toEqual(mark);
    });
    expect(result.current.has("a")).toBe(false);
    expect(fetchWithheld).toHaveBeenCalledWith(
      "news",
      ["a", "b"],
      expect.any(AbortSignal),
    );
  });

  it("drops a mark as soon as the saved text changes, until the check answers again", async () => {
    fetchWithheld.mockResolvedValueOnce({
      ok: true,
      value: { items: [{ id: "a", withheldFromDevices: mark }] },
    });
    // The second question never answers.
    fetchWithheld.mockReturnValueOnce(new Promise(() => undefined));

    const { result, rerender } = renderHook(
      ({ version }) => useWithheldFromDevices("news", ["a"], version),
      { initialProps: { version: "1" } },
    );
    await waitFor(() => {
      expect(result.current.get("a")).toEqual(mark);
    });

    rerender({ version: "2" });

    expect(result.current.has("a")).toBe(false);
  });

  it("marks nothing when the question fails", async () => {
    fetchWithheld.mockResolvedValue({
      ok: false,
      failure: { kind: "forbidden" },
    });

    const { result } = renderHook(() =>
      useWithheldFromDevices("events", ["a"], "1"),
    );

    await waitFor(() => {
      expect(fetchWithheld).toHaveBeenCalled();
    });
    expect(result.current.size).toBe(0);
  });

  it("asks nothing for an editor with no items", () => {
    renderHook(() => useWithheldFromDevices("meetings", [], ""));

    expect(fetchWithheld).not.toHaveBeenCalled();
  });
});
