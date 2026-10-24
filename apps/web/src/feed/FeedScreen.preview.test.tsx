import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import type { AudienceView, FeedPage } from "@openbrf/shared";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import "../i18n";
import {
  asPreviewed,
  forgetResidentPreview,
  setResidentPreview,
} from "../api/viewer-preview";
import {
  ALL,
  ASTRID,
  BOARD,
  GARDEN,
  comment,
  ok,
  post,
  viewer,
} from "./feed-fixtures";
import { FeedScreen } from "./FeedScreen";

/**
 * The feed under the resident preview (ADR 0049), for a board member who lives
 * here and holds a seat.
 *
 * Written against the API's own answers rather than against the feed's
 * functions, so what the screen shows is what the whole chain makes of them: the
 * list of audiences, the combined feed and the poll are each the server's answer
 * to the account's own seat, and the preview narrows them in the browser only.
 */

const request = vi.fn();

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  apiRequest: (method: string, path: string) => request(method, path),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const ADMIN: AudienceView = {
  id: "audience-admin",
  kind: "ADMIN",
  name: null,
  unread: 2,
  lastPostAt: "2026-09-17T09:00:00.000Z",
  readAt: null,
};

const FROM_BOARD_ROOM = post({
  id: "post-board",
  audience: { id: BOARD.id, kind: "BOARD", name: null },
  body: "Budgeten är för hög, vi tar den på måndag.",
  createdAt: "2026-09-17T09:10:00.000Z",
});

const FROM_ADMIN = post({
  id: "post-admin",
  audience: { id: ADMIN.id, kind: "ADMIN", name: null },
  body: "Nyckeln till serverrummet är bortlagd.",
  createdAt: "2026-09-17T09:05:00.000Z",
});

const FROM_THE_HOUSE = post({
  id: "post-house",
  body: "Tvättstugan är stängd på torsdag.",
  createdAt: "2026-09-17T09:00:00.000Z",
});

const PINNED_IN_BOARD = post({
  id: "post-pinned",
  audience: { id: BOARD.id, kind: "BOARD", name: null },
  body: "Fäst: styrelsens arbetsordning.",
  pinned: true,
  createdAt: "2026-08-01T09:00:00.000Z",
});

const SCHEDULED_FROM_BOARD = post({
  id: "post-scheduled",
  byBoard: true,
  author: null,
  body: null,
  scheduledAt: "2030-05-04T08:00:00.000Z",
  news: {
    id: "news-1",
    slug: "staddag",
    title: "Städdag i maj",
    text: "Lördag.",
  },
});

const FEED: FeedPage = {
  pinned: [PINNED_IN_BOARD],
  scheduled: [SCHEDULED_FROM_BOARD],
  posts: [FROM_BOARD_ROOM, FROM_ADMIN, FROM_THE_HOUSE],
  earlier: null,
  latest: "cursor-post-board",
};

/** Every post on screen, top to bottom. */
function shown(): string[] {
  const list = screen.queryByRole("list", { name: "Inlägg" });
  return list === null
    ? []
    : within(list)
        .getAllByRole("article")
        .map((article) => article.querySelector("p")?.textContent ?? "");
}

beforeEach(() => {
  request.mockReset().mockImplementation((_method: string, path: string) => {
    if (path === "/api/feed/audiences") {
      return Promise.resolve(
        ok({
          audiences: [
            { ...ALL, unread: 1 },
            { ...BOARD, unread: 3 },
            ADMIN,
            GARDEN,
          ],
          mayCreateGroup: true,
          mayPostAsBoard: true,
        }),
      );
    }
    if (path.startsWith("/api/feed/posts/since")) {
      return Promise.resolve(
        ok({ posts: [], cursor: "unchanged", more: false }),
      );
    }
    if (path.startsWith("/api/feed/posts")) {
      return Promise.resolve(ok(FEED));
    }
    return Promise.resolve(ok({ readAt: "2026-09-17T09:00:00.000Z" }));
  });
});

afterEach(() => {
  forgetResidentPreview();
  sessionStorage.clear();
});

function renderFeed(): void {
  render(<FeedScreen viewer={viewer(["chat:participate"])} />);
}

describe("the feed while the preview is on", () => {
  it("shows the board member the house's feed and none of the board's", async () => {
    act(() => {
      setResidentPreview(true);
    });
    renderFeed();

    await screen.findByText("Tvättstugan är stängd på torsdag.");
    expect(shown()).toEqual(["Tvättstugan är stängd på torsdag."]);
    expect(screen.queryByText(/Budgeten är för hög/)).toBeNull();
    expect(screen.queryByText(/serverrummet/)).toBeNull();
    expect(screen.queryByText(/Fäst: styrelsens/)).toBeNull();
    expect(screen.queryByText("Städdag i maj")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Styrelsen Hantera flödet" }),
    ).toBeNull();
  });

  it("offers the audiences a resident is in, without Styrelsen and Administratörer", async () => {
    act(() => {
      setResidentPreview(true);
    });
    renderFeed();

    await screen.findByText("Tvättstugan är stängd på torsdag.");
    expect(screen.getByRole("button", { name: /^Alla/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Trädgårdsgruppen/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Styrelsen/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Administratörer/ }),
    ).toBeNull();
  });

  it("offers no way to write as Styrelsen or to Styrelsen", async () => {
    act(() => {
      setResidentPreview(true);
    });
    renderFeed();

    await userEvent.click(
      await screen.findByRole("button", { name: "Skriv ett inlägg..." }),
    );
    const dialog = screen.getByRole("dialog", { name: "Skriv ett inlägg" });
    // A resident is told who writes and where, and chooses neither.
    expect(within(dialog).queryByLabelText("Från")).toBeNull();
    expect(within(dialog).queryByLabelText("Till")).toBeNull();
    expect(within(dialog).queryByLabelText("Rubrik")).toBeNull();
    expect(within(dialog).getByText("Astrid Lindqvist")).toBeTruthy();
    expect(within(dialog).queryByText(/Styrelsen/)).toBeNull();
  });

  it("is back to the board's own feed, audiences and tools once it is stopped", async () => {
    act(() => {
      setResidentPreview(true);
    });
    const { unmount } = render(
      <FeedScreen viewer={viewer(["chat:participate"])} />,
    );
    await screen.findByText("Tvättstugan är stängd på torsdag.");
    unmount();

    // Stopped: the frame mounts the screen again, and the list it reads is the
    // server's own answer, which the preview never changed.
    act(() => {
      setResidentPreview(false);
    });
    renderFeed();

    expect(await screen.findByText(/Budgeten är för hög/)).toBeTruthy();
    expect(screen.getByText(/serverrummet/)).toBeTruthy();
    expect(screen.getByText("Städdag i maj")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Styrelsen/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Administratörer/ }),
    ).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Skriv ett inlägg..." }),
    );
    const dialog = screen.getByRole("dialog", { name: "Skriv ett inlägg" });
    expect(within(dialog).getByLabelText("Från")).toBeTruthy();
  });
});

/*
 * The house's posts and comments as the server answers a seated board member
 * who handles issues: every flag the board is given is true where the server
 * gives it, so a preview that kept the server's answer would show each one.
 */

const ME = {
  kind: "person",
  personId: ASTRID,
  name: "Astrid Lindqvist",
} as const;
const STRUCK_AT = "2026-09-17T11:00:00.000Z";
const EDITED_AT = "2026-09-17T10:30:00.000Z";

/** Seated, moderating and handling issues, as `/api/me` answers the account. */
const BOARD_MEMBER = viewer([
  "chat:moderate",
  "issues:handle",
  "issues:report",
  "news:comment",
]);

const EDITED_BY_BO = post({
  id: "post-edited",
  body: "Cykelrummet är fullt igen.",
  editedAt: EDITED_AT,
  comments: 3,
  mayReadHistory: true,
  mayReportIssue: true,
  mayStrike: true,
  createdAt: "2026-09-17T09:20:00.000Z",
});

const STRUCK_BY_THE_BOARD = post({
  id: "post-struck",
  body: "Grannen i 3B spelar för högt.",
  struckAt: STRUCK_AT,
  createdAt: "2026-09-17T09:15:00.000Z",
});

const REPORTED_BY_ANOTHER = post({
  id: "post-issue",
  body: "Hissen står still.",
  issue: { id: "issue-1", status: "IN_PROGRESS", reportedByReader: false },
  mayStrike: true,
  createdAt: "2026-09-17T09:12:00.000Z",
});

const MINE_STRUCK = post({
  id: "post-mine",
  author: ME,
  body: "Min text som styrelsen strök.",
  struckAt: STRUCK_AT,
  editedAt: EDITED_AT,
  mayReadHistory: true,
  createdAt: "2026-09-17T09:11:00.000Z",
});

/** The board's published news in Alla: important, pinned, and kept in a preview. */
const IMPORTANT_NEWS = post({
  id: "post-news",
  byBoard: true,
  author: null,
  body: null,
  important: true,
  pinned: true,
  mayListNotRead: true,
  news: {
    id: "news-water",
    slug: "vattnet",
    title: "Vattnet stängs av på tisdag",
    text: "Mellan nio och tolv.",
  },
  createdAt: "2026-09-16T08:00:00.000Z",
});

const HOUSE_FEED: FeedPage = {
  pinned: [IMPORTANT_NEWS],
  scheduled: [],
  posts: [EDITED_BY_BO, STRUCK_BY_THE_BOARD, REPORTED_BY_ANOTHER, MINE_STRUCK],
  earlier: null,
  latest: "cursor-post-edited",
};

const THREAD = {
  comments: [
    comment({
      id: "comment-edited",
      postId: EDITED_BY_BO.id,
      body: "Jag flyttade min cykel.",
      editedAt: EDITED_AT,
      mayReadHistory: true,
      mayStrike: true,
    }),
    comment({
      id: "comment-struck",
      postId: EDITED_BY_BO.id,
      body: "Det är 3B:s cyklar som står där.",
      struckAt: STRUCK_AT,
    }),
    comment({
      id: "comment-mine",
      postId: EDITED_BY_BO.id,
      author: ME,
      body: "Vi ser över det på styrelsemötet.",
      editedAt: EDITED_AT,
      mayEdit: true,
      mayReadHistory: true,
    }),
  ],
  earlier: null,
  latest: "cursor-comment-mine",
};

function answerAsTheBoard(): void {
  request.mockImplementation((_method: string, path: string) => {
    if (path === "/api/feed/audiences") {
      return Promise.resolve(
        ok({
          audiences: [ALL, BOARD, GARDEN],
          mayCreateGroup: true,
          mayPostAsBoard: true,
        }),
      );
    }
    if (path.startsWith("/api/feed/reports")) {
      return Promise.resolve(
        ok({ reports: [], next: null, mayModerate: true }),
      );
    }
    if (path.includes("/comments/since")) {
      return Promise.resolve(
        ok({ comments: [], cursor: "unchanged", more: false }),
      );
    }
    if (path.includes("/comments")) {
      return Promise.resolve(ok(THREAD));
    }
    if (path.startsWith("/api/feed/posts/since")) {
      return Promise.resolve(
        ok({ posts: [], cursor: "unchanged", more: false }),
      );
    }
    if (path.startsWith("/api/feed/posts")) {
      return Promise.resolve(ok(HOUSE_FEED));
    }
    return Promise.resolve(ok({ readAt: "2026-09-17T09:00:00.000Z" }));
  });
}

/** The card a text is on, once it is on screen. */
async function card(text: string): Promise<HTMLElement> {
  const found = (await screen.findByText(text)).closest("article");
  if (found === null) {
    throw new Error(`No post holds ${String(text)}.`);
  }
  return found;
}

/** What a post's or a comment's ⋯ offers, once it is opened. */
async function offered(more: HTMLElement): Promise<string[]> {
  await userEvent.click(more);
  return screen
    .getAllByRole("button")
    .map((button) => button.textContent ?? "")
    .filter((label) =>
      ["Tidigare versioner", "Gör felanmälan", "Anmäl till styrelsen"].includes(
        label,
      ),
    );
}

/** Renders the feed as the frame does: with the viewer `/api/me` gave it. */
function renderAsTheFrameDoes(): ReturnType<typeof render> {
  return render(<FeedScreen viewer={asPreviewed(BOARD_MEMBER)} />);
}

describe("the board's answers about the house's posts while the preview is on", () => {
  beforeEach(() => {
    answerAsTheBoard();
    act(() => {
      setResidentPreview(true);
    });
  });

  it("offers no strike-through and no must-read list, the pinned important news among them", async () => {
    renderAsTheFrameDoes();

    await screen.findByText("Cykelrummet är fullt igen.");
    // The board's published news in Alla is the house's, and stays.
    expect(screen.getByText("Vattnet stängs av på tisdag")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Stryk över" })).toEqual([]);
    expect(
      screen.queryByRole("button", { name: "Vilka har inte läst?" }),
    ).toBeNull();
  });

  it("offers neither the earlier versions of a neighbour's post nor an issue report made from it", async () => {
    renderAsTheFrameDoes();

    const edited = await card("Cykelrummet är fullt igen.");
    expect(
      await offered(
        within(edited).getByRole("button", {
          name: "Fler val för inlägget från Bo Ek",
        }),
      ),
    ).toEqual([]);
  });

  it("withholds a struck post's text and where somebody else's issue report stands", async () => {
    renderAsTheFrameDoes();

    await screen.findByText("Cykelrummet är fullt igen.");
    expect(screen.queryByText("Grannen i 3B spelar för högt.")).toBeNull();
    expect(
      screen.getByText("Styrelsen har strukit över inlägget och dolt texten."),
    ).toBeTruthy();
    expect(screen.getByText("Hissen står still.")).toBeTruthy();
    expect(screen.queryByText("Felanmälan:")).toBeNull();
  });

  it("keeps what the board member wrote as theirs: a struck post's text and its earlier versions", async () => {
    renderAsTheFrameDoes();

    const mine = await card("Min text som styrelsen strök.");
    expect(
      await offered(
        within(mine).getByRole("button", {
          name: "Fler val för inlägget från Astrid Lindqvist",
        }),
      ),
    ).toEqual(["Tidigare versioner"]);
  });

  it("offers no strike-through or neighbour's earlier versions in a thread, and withholds a struck comment's text", async () => {
    renderAsTheFrameDoes();

    const edited = await card("Cykelrummet är fullt igen.");
    await userEvent.click(
      within(edited).getByRole("button", { name: "3 kommentarer" }),
    );
    await screen.findByText("Jag flyttade min cykel.");

    expect(screen.queryAllByRole("button", { name: "Stryk över" })).toEqual([]);
    expect(screen.queryByText("Det är 3B:s cyklar som står där.")).toBeNull();
    expect(
      screen.getByText(
        "Styrelsen har strukit över kommentaren och dolt texten.",
      ),
    ).toBeTruthy();

    const editedComment = screen
      .getByText("Jag flyttade min cykel.")
      .closest("li");
    if (editedComment === null) {
      throw new Error("The edited comment is not in a list item.");
    }
    expect(
      await offered(
        within(editedComment).getByRole("button", {
          name: "Fler val för kommentaren från Bo Ek",
        }),
      ),
    ).toEqual([]);
    await userEvent.keyboard("{Escape}");
    expect(
      await offered(
        screen.getByRole("button", {
          name: "Fler val för kommentaren från Astrid Lindqvist",
        }),
      ),
    ).toEqual(["Tidigare versioner"]);
  });

  it("gives the board everything back once it is stopped", async () => {
    const { unmount } = renderAsTheFrameDoes();
    await screen.findByText("Cykelrummet är fullt igen.");
    unmount();

    act(() => {
      setResidentPreview(false);
    });
    renderAsTheFrameDoes();

    await screen.findByText("Cykelrummet är fullt igen.");
    expect(screen.getByText("Grannen i 3B spelar för högt.")).toBeTruthy();
    expect(screen.getByText("Felanmälan:")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Stryk över" }).length).toBe(
      2,
    );
    expect(
      screen.getByRole("button", { name: "Vilka har inte läst?" }),
    ).toBeTruthy();

    const edited = await card("Cykelrummet är fullt igen.");
    expect(
      await offered(
        within(edited).getByRole("button", {
          name: "Fler val för inlägget från Bo Ek",
        }),
      ),
    ).toEqual(["Tidigare versioner", "Gör felanmälan"]);
  });
});
