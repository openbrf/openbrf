import type { FeedPage, PostCommentView, PostView } from "@openbrf/shared";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { ASTRID, comment, post, viewer } from "../feed/feed-fixtures";
import {
  commentsSince,
  editComment,
  editPost,
  fetchPost,
  postsSince,
  readComments,
  readFeed,
  writeComment,
  writePost,
} from "./feed";
import {
  asPreviewed,
  forgetResidentPreview,
  setResidentPreview,
} from "./viewer-preview";

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

/** A seated board member who handles issues, as `/api/me` answers them. */
const BOARD_MEMBER = viewer([
  "chat:moderate",
  "issues:handle",
  "issues:report",
]);

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
  pinned: [
    inAudience("pinned-board", "BOARD"),
    inAudience("pinned-house", "ALL"),
  ],
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
    const filter = {
      audienceId: null,
      search: "",
      from: null,
      important: false,
    };

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

/*
 * The server answers the board member's seat whatever the preview: each flag
 * the board is given is true here where the server would give it, and each is
 * what the preview has to take back from a post or a comment that stays.
 */

const STRUCK_AT = "2026-09-17T11:00:00.000Z";
const EDITED_AT = "2026-09-17T10:30:00.000Z";
const IMAGE = {
  id: "file-1",
  url: "/api/feed/media/file-1",
  width: 800,
  height: 600,
};

/** A neighbour's post in Alla, as the board is shown it. */
const AS_THE_BOARD_READS_IT: PostView = post({
  id: "neighbour",
  body: "Grannen i 3B spelar för högt.",
  images: [IMAGE],
  important: true,
  pinned: true,
  editedAt: EDITED_AT,
  struckAt: STRUCK_AT,
  issue: { id: "issue-1", status: "IN_PROGRESS", reportedByReader: false },
  mayReportIssue: true,
  mayReadHistory: true,
  mayListNotRead: true,
  mayStrike: true,
});

/** The same post as a resident who did not write it is shown it. */
const AS_A_RESIDENT_READS_IT: PostView = {
  ...AS_THE_BOARD_READS_IT,
  body: null,
  images: [],
  issue: null,
  mayReportIssue: false,
  mayReadHistory: false,
  mayListNotRead: false,
  mayStrike: false,
};

/** One the board member wrote, struck and edited, with a report they made. */
const MINE: PostView = post({
  id: "mine",
  author: { kind: "person", personId: ASTRID, name: "Astrid Lindqvist" },
  body: "Min text som styrelsen strök.",
  images: [IMAGE],
  editedAt: EDITED_AT,
  struckAt: STRUCK_AT,
  issue: { id: "issue-2", status: "NEW", reportedByReader: true },
  mayReadHistory: true,
  mayReportIssue: false,
});

const NEIGHBOURS_COMMENT: PostCommentView = comment({
  id: "comment-neighbour",
  body: "Det är 3B:s cyklar.",
  editedAt: EDITED_AT,
  struckAt: STRUCK_AT,
  mayReadHistory: true,
  mayStrike: true,
});

const NEIGHBOURS_COMMENT_AS_A_RESIDENT: PostCommentView = {
  ...NEIGHBOURS_COMMENT,
  body: null,
  mayReadHistory: false,
  mayStrike: false,
};

const MY_COMMENT: PostCommentView = comment({
  id: "comment-mine",
  author: { kind: "person", personId: ASTRID, name: "Astrid Lindqvist" },
  body: "Vi tar det på mötet.",
  editedAt: EDITED_AT,
  struckAt: STRUCK_AT,
  mayReadHistory: true,
});

/** The same, by a board member whose name the thread withholds. */
const MY_PROTECTED_COMMENT: PostCommentView = {
  ...MY_COMMENT,
  id: "comment-mine-protected",
  author: { kind: "protected", personId: ASTRID },
};

describe("what the board is shown of a post that stays in the preview", () => {
  const FILTER = { audienceId: null, search: "", from: null, important: false };

  beforeEach(() => {
    asPreviewed(BOARD_MEMBER);
    setResidentPreview(true);
  });

  it("is taken back on a page, pinned or not, and the board member's own stays theirs", async () => {
    request.mockResolvedValue({
      ok: true,
      value: {
        pinned: [AS_THE_BOARD_READS_IT],
        scheduled: [],
        posts: [AS_THE_BOARD_READS_IT, MINE],
        earlier: null,
        latest: "cursor-latest",
      },
    });

    const result = await readFeed({ filter: FILTER, before: null });
    expect(result.ok && result.value.pinned).toEqual([AS_A_RESIDENT_READS_IT]);
    expect(result.ok && result.value.posts).toEqual([
      AS_A_RESIDENT_READS_IT,
      MINE,
    ]);
  });

  it("is taken back on the poll", async () => {
    request.mockResolvedValue({
      ok: true,
      value: { posts: [AS_THE_BOARD_READS_IT], cursor: "next", more: false },
    });

    const result = await postsSince({ filter: FILTER, after: "cursor-0" });
    expect(result.ok && result.value.posts).toEqual([AS_A_RESIDENT_READS_IT]);
  });

  it("is taken back when one post is read on its own", async () => {
    request.mockResolvedValue({ ok: true, value: AS_THE_BOARD_READS_IT });

    expect(await fetchPost({ postId: "neighbour" })).toEqual({
      ok: true,
      value: AS_A_RESIDENT_READS_IT,
    });
  });

  it("is taken back from what a write answers with", async () => {
    const written = post({
      id: "written",
      author: { kind: "person", personId: ASTRID, name: "Astrid Lindqvist" },
      important: true,
      mayEdit: true,
      mayListNotRead: true,
    });
    request.mockResolvedValue({ ok: true, value: written });

    const answer = { ok: true, value: { ...written, mayListNotRead: false } };
    expect(
      await writePost({
        audienceId: "audience-all",
        body: "Hej",
        imageIds: [],
      }),
    ).toEqual(answer);
    expect(await editPost({ postId: "written", body: "Hej igen" })).toEqual(
      answer,
    );
  });

  it("counts nothing as the reader's own before the viewer has been read", async () => {
    forgetResidentPreview();
    setResidentPreview(true);
    request.mockResolvedValue({ ok: true, value: MINE });

    const result = await fetchPost({ postId: "mine" });
    expect(result.ok && result.value.body).toBeNull();
    expect(result.ok && result.value.mayReadHistory).toBe(false);
  });

  it("is the server's own again once the preview is stopped", async () => {
    request.mockResolvedValue({ ok: true, value: AS_THE_BOARD_READS_IT });
    setResidentPreview(false);

    expect(await fetchPost({ postId: "neighbour" })).toEqual({
      ok: true,
      value: AS_THE_BOARD_READS_IT,
    });
  });
});

describe("what the board is shown of a comment in the preview", () => {
  beforeEach(() => {
    asPreviewed(BOARD_MEMBER);
    setResidentPreview(true);
  });

  it("is taken back on a page of the thread and on its poll, and the board member's own stays theirs", async () => {
    request.mockResolvedValue({
      ok: true,
      value: {
        comments: [NEIGHBOURS_COMMENT, MY_COMMENT, MY_PROTECTED_COMMENT],
        earlier: "cursor-earlier",
        latest: "cursor-latest",
      },
    });
    expect(await readComments({ postId: "post-1", before: null })).toEqual({
      ok: true,
      value: {
        comments: [
          NEIGHBOURS_COMMENT_AS_A_RESIDENT,
          MY_COMMENT,
          MY_PROTECTED_COMMENT,
        ],
        earlier: "cursor-earlier",
        latest: "cursor-latest",
      },
    });

    request.mockResolvedValue({
      ok: true,
      value: { comments: [NEIGHBOURS_COMMENT], cursor: "next", more: true },
    });
    expect(await commentsSince({ postId: "post-1", after: "c-0" })).toEqual({
      ok: true,
      value: {
        comments: [NEIGHBOURS_COMMENT_AS_A_RESIDENT],
        cursor: "next",
        more: true,
      },
    });
  });

  it("is taken back from what a write answers with", async () => {
    request.mockResolvedValue({ ok: true, value: NEIGHBOURS_COMMENT });

    expect(await writeComment({ postId: "post-1", body: "Hej" })).toEqual({
      ok: true,
      value: NEIGHBOURS_COMMENT_AS_A_RESIDENT,
    });
    expect(
      await editComment({ commentId: "comment-neighbour", body: "Hej" }),
    ).toEqual({ ok: true, value: NEIGHBOURS_COMMENT_AS_A_RESIDENT });
  });

  it("is the server's own again once the preview is stopped", async () => {
    request.mockResolvedValue({
      ok: true,
      value: { comments: [NEIGHBOURS_COMMENT], earlier: null, latest: null },
    });
    setResidentPreview(false);

    expect(await readComments({ postId: "post-1", before: null })).toEqual({
      ok: true,
      value: { comments: [NEIGHBOURS_COMMENT], earlier: null, latest: null },
    });
  });
});
