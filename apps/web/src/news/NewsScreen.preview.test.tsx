import { act, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { NewsArticle, NewsComment } from "../api/news-reader";
import {
  asPreviewed,
  forgetResidentPreview,
  setResidentPreview,
} from "../api/viewer-preview";
import { NewsScreen } from "./NewsScreen";

/**
 * The news under the resident preview (ADR 0049), for a board member who lives
 * here and holds `site:manage`.
 *
 * Written against the API's own answers rather than against the news reader's
 * functions, so what the screen shows is what the whole chain makes of them:
 * the thread is the server's answer to the account's own seat, which opens a
 * struck comment's text to the board, and the preview narrows it in the browser
 * only. The feed's thread is held to the same in `FeedScreen.preview.test.tsx`.
 */

const request = vi.fn();

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
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

const NOTICE: NewsArticle = {
  id: "news-1",
  slug: "portkoden-byts",
  title: "Portkoden byts",
  content: {
    version: 1,
    blocks: [
      {
        type: "paragraph",
        runs: [{ text: "Vi byter portkod på lördag klockan tio." }],
      },
    ],
  },
  publishedAt: "2026-08-20T08:00:00.000Z",
  commentsAllowed: true,
};

/*
 * The thread as the server answers the board: a neighbour's struck comment
 * with its text, because `site:manage` opens it, and the board member's own
 * struck comment with its text, because they wrote it.
 */

const STANDING: NewsComment = {
  id: "comment-standing",
  author: { kind: "resident", personId: "person-bo", name: "Bo Ek" },
  byBoard: false,
  body: "Tack för beskedet.",
  hiddenAt: null,
  createdAt: "2026-08-20T09:00:00.000Z",
};

const NEIGHBOURS_STRUCK: NewsComment = {
  id: "comment-neighbour",
  author: { kind: "resident", personId: "person-nils", name: "Nils Holm" },
  byBoard: false,
  body: "Det jag skrev om grannens bil.",
  hiddenAt: STRUCK_AT,
  createdAt: "2026-08-20T10:00:00.000Z",
};

const MINE_STRUCK: NewsComment = {
  id: "comment-mine",
  author: { kind: "resident", personId: ASTRID, name: "Astrid Holm" },
  byBoard: false,
  body: "Min kommentar som styrelsen strök.",
  hiddenAt: STRUCK_AT,
  createdAt: "2026-08-20T11:00:00.000Z",
};

function answerAsTheBoard(): void {
  request.mockImplementation((_method: string, path: string) => {
    if (path === "/api/news-reader") {
      return Promise.resolve({ ok: true, value: [NOTICE] });
    }
    if (path === `/api/news-comments/${NOTICE.id}`) {
      return Promise.resolve({
        ok: true,
        value: {
          comments: [STANDING, NEIGHBOURS_STRUCK, MINE_STRUCK],
          earlier: null,
        },
      });
    }
    return Promise.resolve({
      ok: false,
      failure: { status: 404, reason: "unexpected" },
    });
  });
}

/** The row a comment's author is named on. */
function row(author: string): HTMLElement {
  const found = screen.getByText(author).closest("li");
  if (found === null) {
    throw new Error(`No comment is from ${author}.`);
  }
  return found;
}

/** Renders the news as the frame does: with the viewer `/api/me` gave it. */
function renderAsTheFrameDoes(): ReturnType<typeof render> {
  return render(<NewsScreen viewer={asPreviewed(BOARD_MEMBER)} />);
}

beforeEach(() => {
  request.mockReset();
  answerAsTheBoard();
  act(() => {
    setResidentPreview(true);
  });
});

afterEach(() => {
  forgetResidentPreview();
  sessionStorage.clear();
});

describe("the thread under a notice while the preview is on", () => {
  it("withholds a neighbour's struck comment and offers no strike-through", async () => {
    renderAsTheFrameDoes();

    await screen.findByText("Tack för beskedet.");
    expect(screen.queryByText("Det jag skrev om grannens bil.")).toBeNull();
    expect(row("Nils Holm").textContent).toContain(
      "Styrelsen har dolt texten.",
    );
    expect(
      screen.queryAllByRole("button", { name: /^Stryk kommentaren/ }),
    ).toEqual([]);
  });

  it("keeps the text of the board member's own struck comment", async () => {
    renderAsTheFrameDoes();

    await screen.findByText("Min kommentar som styrelsen strök.");
    expect(row("Astrid Holm").textContent).toContain(
      "Struken. Texten visas för styrelsen och för den som skrev den.",
    );
  });

  it("gives the board its answer back once it is stopped", async () => {
    const { unmount } = renderAsTheFrameDoes();
    await screen.findByText("Tack för beskedet.");
    unmount();

    act(() => {
      setResidentPreview(false);
    });
    renderAsTheFrameDoes();

    await screen.findByText("Det jag skrev om grannens bil.");
    expect(screen.getByText("Min kommentar som styrelsen strök.")).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Stryk kommentaren från Bo Ek" }),
      ).toBeTruthy();
    });
  });
});
