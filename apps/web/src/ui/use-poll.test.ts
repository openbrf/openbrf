import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePoll } from "./use-poll";

/**
 * What the poll hook promises, and every one of them is a defect if it is not
 * kept.
 *
 * It waits before the first attempt, because whatever mounted it has just read
 * for itself. It stops the moment the tab is hidden, or a forgotten tab on a
 * phone polls for days. It asks once immediately when the tab comes back, which
 * is what somebody returning to the screen is actually waiting for. It stops
 * dead on unmount and tells a response still in flight that nobody wants it. And
 * a new callback on every render does not restart the interval, or a busy screen
 * would never wait out its own interval at all.
 */

/** The visibility the document reports, which jsdom has no control for. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePoll", () => {
  it("waits out the interval before the first attempt", () => {
    const poll = vi.fn();

    renderHook(() => {
      usePoll(poll, { intervalMs: 4000, enabled: true });
    });

    // Nothing on mount: the screen that mounted this has just read, and an
    // attempt firing into that read would be a second answer to one question.
    expect(poll).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(poll).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("asks for nothing while it is disabled", () => {
    const poll = vi.fn();

    renderHook(() => {
      usePoll(poll, { intervalMs: 4000, enabled: false });
    });

    act(() => {
      vi.advanceTimersByTime(40_000);
    });

    expect(poll).not.toHaveBeenCalled();
  });

  it("stops while the tab is hidden and asks once when it comes back", () => {
    const poll = vi.fn();

    renderHook(() => {
      usePoll(poll, { intervalMs: 4000, enabled: true });
    });

    act(() => {
      setVisibility("hidden");
      vi.advanceTimersByTime(60_000);
    });
    // A forgotten tab polls for nothing. This is the whole of what stops a
    // screen left open on a phone asking for days.
    expect(poll).not.toHaveBeenCalled();

    act(() => {
      setVisibility("visible");
    });
    // At once, without waiting out an interval: what somebody came back to look
    // at is whatever arrived while they were away.
    expect(poll).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("does not stack a second timer when the tab is already visible", () => {
    const poll = vi.fn();

    renderHook(() => {
      usePoll(poll, { intervalMs: 4000, enabled: true });
    });

    act(() => {
      // Some browsers fire this on a focus change without the state moving.
      setVisibility("visible");
      setVisibility("visible");
    });
    poll.mockClear();

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    // One attempt per interval, not one per event that ever arrived.
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("keeps its interval when the callback is rebuilt by a render", () => {
    /*
     * A caller composes its callback from state, so a new function arrives on
     * every render. If the interval were torn down and rebuilt each time, a busy
     * screen would never wait out its own interval and the poll would fire at
     * whatever rate the screen happened to re-render.
     */
    const attempts: number[] = [];
    const { rerender } = renderHook(
      ({ tick }: { tick: number }) => {
        usePoll(
          () => {
            attempts.push(tick);
          },
          { intervalMs: 4000, enabled: true },
        );
      },
      { initialProps: { tick: 1 } },
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    rerender({ tick: 2 });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    // Fired once, at the four-second mark the first render started, and with
    // the newest callback rather than the one the timer was built with.
    expect(attempts).toEqual([2]);
  });

  it("tells an answer still in flight that nobody wants it", () => {
    const held: { asked: (() => boolean) | null } = { asked: null };
    const { unmount } = renderHook(() => {
      usePoll(
        (stillWanted) => {
          held.asked = stillWanted;
        },
        { intervalMs: 4000, enabled: true },
      );
    });

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(held.asked).not.toBeNull();
    expect(held.asked?.()).toBe(true);

    unmount();

    // The same flag both hand-rolled polls in this client carry as a closure
    // variable: a response landing after the screen has gone sets no state.
    expect(held.asked?.()).toBe(false);
  });

  it("stops asking once it is unmounted", () => {
    const poll = vi.fn();
    const { unmount } = renderHook(() => {
      usePoll(poll, { intervalMs: 4000, enabled: true });
    });

    unmount();
    act(() => {
      vi.advanceTimersByTime(40_000);
    });

    expect(poll).not.toHaveBeenCalled();
  });
});
