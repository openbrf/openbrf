import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { Viewer } from "./instance";
import {
  fetchNewsComments,
  hideNewsComment,
  writeNewsComment,
  type NewsComment,
} from "./news-reader";
import {
  asPreviewed,
  forgetResidentPreview,
  setResidentPreview,
} from "./viewer-preview";

/**
 * What the thread under a news item hands a screen while the resident preview
 * is on (ADR 0049). The server answers the board's `site:manage` with a struck
 * comment's text whoever wrote it (`news-comment.service.ts`); a resident is
 * answered with it only for what they wrote, so the preview takes the rest
 * back.
 */

const request = vi.fn();

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  apiRequest: (method: string, path: string) => request(method, path),
}));

const ASTRID = "person-astrid";
const STRUCK_AT = "2026-08-21T11:00:00.000Z";

/** Seated and publishing in the cooperative's name, as `/api/me` answers. */
const BOARD_MEMBER: Viewer = {
  personId: ASTRID,
  firstName: "Astrid",
  lastName: "Holm",
  preferredLocale: "sv",
  capabilities: ["news:comment", "site:manage"],
  housingCooperative: null,
};

/** A neighbour's struck comment, as the board is shown it. */
const NEIGHBOURS_STRUCK: NewsComment = {
  id: "comment-neighbour",
  author: { kind: "resident", personId: "person-nils", name: "Nils Holm" },
  byBoard: false,
  body: "Det jag skrev om grannens bil.",
  hiddenAt: STRUCK_AT,
  createdAt: "2026-08-20T10:00:00.000Z",
};

const NEIGHBOURS_STRUCK_AS_A_RESIDENT: NewsComment = {
  ...NEIGHBOURS_STRUCK,
  body: null,
};

/** Struck, by an author the register no longer holds. */
const UNKNOWNS_STRUCK: NewsComment = {
  ...NEIGHBOURS_STRUCK,
  id: "comment-unknown",
  author: { kind: "unknown" },
};

/** One the board member wrote, struck. */
const MINE_STRUCK: NewsComment = {
  id: "comment-mine",
  author: { kind: "resident", personId: ASTRID, name: "Astrid Holm" },
  byBoard: false,
  body: "Min kommentar som styrelsen strök.",
  hiddenAt: STRUCK_AT,
  createdAt: "2026-08-20T11:00:00.000Z",
};

/** The same, by a board member whose name the thread withholds. */
const MINE_PROTECTED_STRUCK: NewsComment = {
  ...MINE_STRUCK,
  id: "comment-mine-protected",
  author: { kind: "protected", personId: ASTRID },
};

/** A neighbour's comment that stands, text and all. */
const STANDING: NewsComment = {
  id: "comment-standing",
  author: { kind: "resident", personId: "person-bo", name: "Bo Ek" },
  byBoard: false,
  body: "Tack för beskedet.",
  hiddenAt: null,
  createdAt: "2026-08-20T09:00:00.000Z",
};

const THREAD = {
  comments: [
    STANDING,
    NEIGHBOURS_STRUCK,
    UNKNOWNS_STRUCK,
    MINE_STRUCK,
    MINE_PROTECTED_STRUCK,
  ],
  earlier: "cursor-earlier",
};

beforeEach(() => {
  request.mockReset();
  asPreviewed(BOARD_MEMBER);
});

afterEach(() => {
  forgetResidentPreview();
  sessionStorage.clear();
});

describe("a page of the thread under a news item", () => {
  it("is the server's own while the preview is off", async () => {
    request.mockResolvedValue({ ok: true, value: THREAD });

    expect(await fetchNewsComments({ newsId: "news-1", before: null })).toEqual(
      { ok: true, value: THREAD },
    );
  });

  it("withholds the text of somebody else's struck comment while it is on, and keeps the board member's own", async () => {
    request.mockResolvedValue({ ok: true, value: THREAD });
    setResidentPreview(true);

    expect(
      await fetchNewsComments({ newsId: "news-1", before: "cursor-page" }),
    ).toEqual({
      ok: true,
      value: {
        comments: [
          STANDING,
          NEIGHBOURS_STRUCK_AS_A_RESIDENT,
          { ...UNKNOWNS_STRUCK, body: null },
          MINE_STRUCK,
          MINE_PROTECTED_STRUCK,
        ],
        // Where the page before starts is the server's.
        earlier: "cursor-earlier",
      },
    });
  });

  it("counts nothing as the reader's own before the viewer has been read", async () => {
    forgetResidentPreview();
    setResidentPreview(true);
    request.mockResolvedValue({
      ok: true,
      value: { comments: [MINE_STRUCK], earlier: null },
    });

    expect(await fetchNewsComments({ newsId: "news-1", before: null })).toEqual(
      {
        ok: true,
        value: { comments: [{ ...MINE_STRUCK, body: null }], earlier: null },
      },
    );
  });

  it("passes a refusal on as it came", async () => {
    const refusal = {
      ok: false,
      failure: { status: 404, reason: "news-not-found" },
    };
    request.mockResolvedValue(refusal);
    setResidentPreview(true);

    expect(await fetchNewsComments({ newsId: "news-1", before: null })).toEqual(
      refusal,
    );
  });

  it("is the server's own again once the preview is stopped", async () => {
    request.mockResolvedValue({ ok: true, value: THREAD });
    setResidentPreview(true);
    setResidentPreview(false);

    expect(await fetchNewsComments({ newsId: "news-1", before: null })).toEqual(
      { ok: true, value: THREAD },
    );
  });
});

describe("what a write under a news item answers with", () => {
  it("is narrowed as the thread is while the preview is on", async () => {
    setResidentPreview(true);

    request.mockResolvedValue({ ok: true, value: NEIGHBOURS_STRUCK });
    expect(await hideNewsComment({ commentId: NEIGHBOURS_STRUCK.id })).toEqual({
      ok: true,
      value: NEIGHBOURS_STRUCK_AS_A_RESIDENT,
    });

    request.mockResolvedValue({ ok: true, value: MINE_STRUCK });
    expect(await writeNewsComment({ newsId: "news-1", body: "Hej" })).toEqual({
      ok: true,
      value: MINE_STRUCK,
    });
  });

  it("is the server's own while the preview is off", async () => {
    request.mockResolvedValue({ ok: true, value: NEIGHBOURS_STRUCK });

    expect(await hideNewsComment({ commentId: NEIGHBOURS_STRUCK.id })).toEqual({
      ok: true,
      value: NEIGHBOURS_STRUCK,
    });
  });
});
