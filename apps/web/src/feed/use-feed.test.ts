import { act, renderHook, waitFor } from "@testing-library/react";
import type { FeedPage, PostView } from "@openbrf/shared";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BOARD, GARDEN, ok, post, refused } from "./feed-fixtures";
import { useFeed } from "./use-feed";

/**
 * The poll's queue, below the screen.
 *
 * An ask for what has arrived, made while a poll is in flight, is queued and run
 * once that poll is done. These are the cases the screen cannot set up on its
 * own: the filter changing between the ask in flight and the one queued, and the
 * screen going while both wait. The screen's own behaviour is
 * `FeedScreen.test.tsx`.
 */

const readFeed = vi.fn();
const postsSince = vi.fn();

vi.mock("../api/feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/feed")>()),
  readFeed: (input: unknown) => readFeed(input),
  postsSince: (input: unknown) => postsSince(input),
  fetchPost: vi.fn(),
}));

const IN_BOARD = post({ id: "post-board-1", body: "Styrelsemöte på tisdag." });
const LATER_IN_BOARD = post({
  id: "post-board-2",
  body: "Protokollet är ute.",
});
const IN_GARDEN = post({ id: "post-garden-1", body: "Vi sår på lördag." });
const LATER_IN_GARDEN = post({
  id: "post-garden-2",
  body: "Fröerna har kommit.",
});

function filterOf(audienceId: string) {
  return { audienceId, search: "", from: null, important: false };
}

function page(posts: readonly PostView[], latest: string): FeedPage {
  return {
    pinned: [],
    scheduled: [],
    posts: [...posts],
    earlier: null,
    latest,
  };
}

/** A promise the test answers when it chooses. */
function held<T>(): { promise: Promise<T>; answer: (value: T) => void } {
  let answer: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
}

beforeEach(() => {
  vi.clearAllMocks();
  readFeed.mockImplementation(
    ({ filter }: { filter: { audienceId: string } }) =>
      Promise.resolve(
        filter.audienceId === BOARD.id
          ? ok(page([IN_BOARD], "cursor-board"))
          : ok(page([IN_GARDEN], "cursor-garden")),
      ),
  );
  postsSince.mockResolvedValue(
    ok({ posts: [], cursor: "unchanged", more: false }),
  );
});

function renderFeed(audienceId: string) {
  return renderHook(
    ({ audience }: { audience: string }) =>
      useFeed(audience, "", null, false, true),
    { initialProps: { audience: audienceId } },
  );
}

describe("an ask queued behind a poll", () => {
  it("is run under the filter it was asked under, from that filter's cursor", async () => {
    const boardAnswer = held<unknown>();
    postsSince.mockReturnValueOnce(boardAnswer.promise).mockResolvedValueOnce(
      ok({
        // The cursor should make a repeat impossible; it is shown once if not.
        posts: [IN_GARDEN, LATER_IN_GARDEN],
        cursor: "cursor-garden-2",
        more: false,
      }),
    );
    const { result, rerender } = renderFeed(BOARD.id);
    await waitFor(() => {
      expect(result.current.feed?.posts).toEqual([IN_BOARD]);
    });

    act(() => {
      result.current.readNew();
    });
    expect(postsSince).toHaveBeenCalledTimes(1);
    expect(postsSince).toHaveBeenLastCalledWith({
      filter: filterOf(BOARD.id),
      after: "cursor-board",
    });

    rerender({ audience: GARDEN.id });
    await waitFor(() => {
      expect(result.current.feed?.posts).toEqual([IN_GARDEN]);
    });
    act(() => {
      result.current.readNew();
    });
    // Behind the board's poll, which is still waiting.
    expect(postsSince).toHaveBeenCalledTimes(1);

    await act(async () => {
      boardAnswer.answer(
        ok({ posts: [LATER_IN_BOARD], cursor: "cursor-board-2", more: false }),
      );
    });

    await waitFor(() => {
      expect(postsSince).toHaveBeenCalledTimes(2);
    });
    expect(postsSince).toHaveBeenLastCalledWith({
      filter: filterOf(GARDEN.id),
      after: "cursor-garden",
    });
    await waitFor(() => {
      expect(result.current.feed?.cursor).toBe("cursor-garden-2");
    });
    expect(result.current.feed?.key).toBe(
      JSON.stringify([GARDEN.id, "", null, false]),
    );
    expect(result.current.feed?.posts).toEqual([LATER_IN_GARDEN, IN_GARDEN]);

    // The board's answer left no cursor behind for the garden to ask from.
    act(() => {
      result.current.readNew();
    });
    await waitFor(() => {
      expect(postsSince).toHaveBeenCalledTimes(3);
    });
    expect(postsSince).toHaveBeenLastCalledWith({
      filter: filterOf(GARDEN.id),
      after: "cursor-garden-2",
    });
    expect(readFeed).toHaveBeenCalledTimes(2);
  });

  it("is still run when the poll ahead of it is refused", async () => {
    const refusal = held<unknown>();
    postsSince
      .mockReturnValueOnce(refusal.promise)
      .mockResolvedValueOnce(
        ok({ posts: [LATER_IN_BOARD], cursor: "cursor-board-2", more: false }),
      );
    const { result } = renderFeed(BOARD.id);
    await waitFor(() => {
      expect(result.current.feed).not.toBeNull();
    });

    act(() => {
      result.current.readNew();
      result.current.readNew();
    });
    expect(postsSince).toHaveBeenCalledTimes(1);

    await act(async () => {
      refusal.answer(refused(503, "unavailable"));
    });

    await waitFor(() => {
      expect(result.current.feed?.posts).toEqual([LATER_IN_BOARD, IN_BOARD]);
    });
    expect(postsSince).toHaveBeenLastCalledWith({
      filter: filterOf(BOARD.id),
      after: "cursor-board",
    });
    expect(result.current.feed?.failure).toBeNull();
  });

  it("asks nothing once the screen has gone", async () => {
    const inFlight = held<unknown>();
    postsSince.mockReturnValueOnce(inFlight.promise);
    const { result, unmount } = renderFeed(BOARD.id);
    await waitFor(() => {
      expect(result.current.feed).not.toBeNull();
    });

    act(() => {
      result.current.readNew();
      result.current.readNew();
    });
    unmount();

    await act(async () => {
      inFlight.answer(
        ok({ posts: [LATER_IN_BOARD], cursor: "cursor-board-2", more: true }),
      );
    });

    expect(postsSince).toHaveBeenCalledTimes(1);
    expect(readFeed).toHaveBeenCalledTimes(1);
  });
});

describe("the board's scheduled posts", () => {
  it("are held beside the feed, and leave it when a poll delivers them", async () => {
    const waiting = post({
      id: "post-scheduled",
      byBoard: true,
      scheduledAt: "2026-09-18T07:00:00.000Z",
    });
    readFeed.mockResolvedValue(
      ok({ ...page([IN_BOARD], "cursor-board"), scheduled: [waiting] }),
    );
    const { result } = renderFeed(BOARD.id);
    await waitFor(() => {
      expect(result.current.feed?.scheduled).toEqual([waiting]);
    });

    postsSince.mockResolvedValueOnce(
      ok({ posts: [waiting], cursor: "cursor-scheduled", more: false }),
    );
    act(() => {
      result.current.readNew();
    });

    await waitFor(() => {
      expect(result.current.feed?.posts[0]?.id).toBe("post-scheduled");
    });
    expect(result.current.feed?.scheduled).toEqual([]);
  });
});

describe("a pin that changes", () => {
  const older = post({
    id: "post-older",
    createdAt: "2026-09-16T09:00:00.000Z",
  });
  const newer = post({
    id: "post-newer",
    createdAt: "2026-09-17T09:00:00.000Z",
  });

  it("moves the post on top, and back to its place by its instant", async () => {
    readFeed.mockResolvedValue(ok(page([newer, older], "cursor-board")));
    const { result } = renderFeed(BOARD.id);
    await waitFor(() => {
      expect(result.current.feed?.posts).toHaveLength(2);
    });

    act(() => {
      result.current.patchPost("post-older", { pinned: true });
    });
    expect(result.current.feed?.pinned.map((each) => each.id)).toEqual([
      "post-older",
    ]);
    expect(result.current.feed?.posts.map((each) => each.id)).toEqual([
      "post-newer",
    ]);

    act(() => {
      result.current.patchPost("post-older", { pinned: false });
    });
    expect(result.current.feed?.pinned).toEqual([]);
    expect(result.current.feed?.posts.map((each) => each.id)).toEqual([
      "post-newer",
      "post-older",
    ]);
  });

  it("leaves a post unpinned past the pages read for the page that holds it", async () => {
    const pinnedLongAgo = post({
      id: "post-pinned",
      pinned: true,
      createdAt: "2026-01-01T09:00:00.000Z",
    });
    readFeed.mockResolvedValue(
      ok({
        ...page([newer, older], "cursor-board"),
        pinned: [pinnedLongAgo],
        earlier: "cursor-earlier",
      }),
    );
    const { result } = renderFeed(BOARD.id);
    await waitFor(() => {
      expect(result.current.feed?.pinned).toHaveLength(1);
    });

    act(() => {
      result.current.patchPost("post-pinned", { pinned: false });
    });
    expect(result.current.feed?.pinned).toEqual([]);
    expect(result.current.feed?.posts.map((each) => each.id)).toEqual([
      "post-newer",
      "post-older",
    ]);
  });
});

describe("a post the board has just scheduled", () => {
  it("is put among the scheduled ones, soonest first, and only once", async () => {
    const later = post({
      id: "post-later",
      scheduledAt: "2030-06-01T08:00:00.000Z",
      createdAt: "2030-06-01T08:00:00.000Z",
    });
    const sooner = post({
      id: "post-sooner",
      scheduledAt: "2030-05-01T08:00:00.000Z",
      createdAt: "2030-05-01T08:00:00.000Z",
    });
    readFeed.mockResolvedValue(
      ok({ ...page([IN_BOARD], "cursor-board"), scheduled: [later] }),
    );
    const { result } = renderFeed(BOARD.id);
    await waitFor(() => {
      expect(result.current.feed?.scheduled).toEqual([later]);
    });

    act(() => {
      result.current.putScheduled(sooner);
      result.current.putScheduled(sooner);
    });
    expect(result.current.feed?.scheduled.map((each) => each.id)).toEqual([
      "post-sooner",
      "post-later",
    ]);
  });
});
