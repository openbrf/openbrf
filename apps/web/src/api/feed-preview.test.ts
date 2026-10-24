import type { FeedPage, PostView } from "@openbrf/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { post } from "../feed/feed-fixtures";
import { fetchPost, postsSince, readFeed } from "./feed";
import { forgetResidentPreview, setResidentPreview } from "./viewer-preview";

/**
 * What the feed's reads hand a screen while the resident preview is on
 * (ADR 0049): the posts of Alla and of a group, and none of Styrelsen's or
 * Administratörers. The server answers for the account's own seat either way.
 */

const request = vi.fn();

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  apiRequest: (method: string, path: string) => request(method, path),
}));

const inAudience = (
  id: string,
  kind: "ALL" | "BOARD" | "GROUP" | "ADMIN",
): PostView =>
  post({ id, audience: { id: `audience-${id}`, kind, name: null } });

const HOUSE = inAudience("house", "ALL");
const GROUP = inAudience("group", "GROUP");
const BOARD = inAudience("board", "BOARD");
const ADMIN = inAudience("admin", "ADMIN");

const PAGE: FeedPage = {
  pinned: [inAudience("pinned-board", "BOARD"), inAudience("pinned-house", "ALL")],
  scheduled: [inAudience("scheduled", "ALL")],
  posts: [BOARD, HOUSE, ADMIN, GROUP],
  earlier: "cursor-earlier",
  latest: "cursor-latest",
};

const ids = (posts: readonly PostView[]): string[] =>
  posts.map((each) => each.id);

beforeEach(() => {
  request.mockReset();
});

afterEach(() => {
  forgetResidentPreview();
  sessionStorage.clear();
});

describe("a page of the feed", () => {
  const FILTER = { audienceId: null, search: "", from: null, important: false };

  it("is the server's own while the preview is off", async () => {
    request.mockResolvedValue({ ok: true, value: PAGE });

    expect(await readFeed({ filter: FILTER, before: null })).toEqual({
      ok: true,
      value: PAGE,
    });
  });

  it("holds no post of Styrelsen or Administratörer, pinned or not, and nothing scheduled, while it is on", async () => {
    request.mockResolvedValue({ ok: true, value: PAGE });
    setResidentPreview(true);

    const result = await readFeed({ filter: FILTER, before: null });
    expect(result.ok && ids(result.value.posts)).toEqual(["house", "group"]);
    expect(result.ok && ids(result.value.pinned)).toEqual(["pinned-house"]);
    expect(result.ok && result.value.scheduled).toEqual([]);
    // Where the next page starts is the server's, however many were left out.
    expect(result.ok && result.value.earlier).toBe("cursor-earlier");
    expect(result.ok && result.value.latest).toBe("cursor-latest");
  });

  it("passes a refusal on as it came", async () => {
    const refusal = {
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    };
    request.mockResolvedValue(refusal);
    setResidentPreview(true);

    expect(await readFeed({ filter: FILTER, before: null })).toEqual(refusal);
  });
});

describe("what the poll brings", () => {
  const UPDATE = {
    posts: [BOARD, HOUSE, ADMIN],
    cursor: "cursor-next",
    more: true,
  };

  it("is without the board's posts while the preview is on, and the cursor is the server's", async () => {
    request.mockResolvedValue({ ok: true, value: UPDATE });
    const filter = { audienceId: null, search: "", from: null, important: false };

    expect(await postsSince({ filter, after: "cursor-0" })).toEqual({
      ok: true,
      value: UPDATE,
    });
    setResidentPreview(true);
    expect(await postsSince({ filter, after: "cursor-0" })).toEqual({
      ok: true,
      value: { ...UPDATE, posts: [HOUSE] },
    });
  });
});

describe("one post", () => {
  it("is refused as a post that does not exist when it is the board's, while the preview is on", async () => {
    request.mockResolvedValue({ ok: true, value: BOARD });
    expect(await fetchPost({ postId: "board" })).toEqual({
      ok: true,
      value: BOARD,
    });

    setResidentPreview(true);
    expect(await fetchPost({ postId: "board" })).toEqual({
      ok: false,
      failure: { status: 404, reason: "post-not-found" },
    });

    request.mockResolvedValue({ ok: true, value: GROUP });
    expect(await fetchPost({ postId: "group" })).toEqual({
      ok: true,
      value: GROUP,
    });
  });
});
