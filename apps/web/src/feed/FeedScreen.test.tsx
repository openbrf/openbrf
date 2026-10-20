import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import type { FeedPage, PostView } from "@openbrf/shared";
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
  ALL,
  ASTRID,
  BOARD,
  GARDEN,
  ok,
  post,
  refused,
  viewer,
} from "./feed-fixtures";
import { FeedScreen } from "./FeedScreen";

/**
 * What the feed screen may decide, and what it may only render.
 *
 * **It decides nothing about who is in an audience.** The server answers with
 * the audiences this account is in, and an empty answer is an answer rather than
 * a failure: the administrator holds every capability, no seat and no
 * residency, so they reach this screen and find no audience. The screen says
 * why, because the alternative is an empty feed that reads as a broken page.
 *
 * **It never puts a post on the feed it has not read back.** Writing a post
 * closes the composer and asks the poll, and the post arrives because a read
 * brought it.
 *
 * **Every narrowing is a question to the server.** The audience chosen, the
 * search and the filter are each sent with the read, and nothing is filtered in
 * the browser - so nothing on this screen can show a post the server did not.
 *
 * **One filter's answer never lands under another.** Changing what is asked
 * changes it at once, and a read, a poll or a press still in flight for the
 * last question is dropped when it answers.
 *
 * The pieces have their own tests: `PostCard.test.tsx`, `PostThread.test.tsx`,
 * `PostComposer.test.tsx`, `FilterDialog.test.tsx`, `AudiencePanel.test.tsx`,
 * `GroupPanel.test.tsx` and `ReportQueue.test.tsx`. The polling mechanics are
 * `ui/use-poll.test.ts`; what happens to the rows is
 * `apps/api/src/feed/feed.int-spec.ts`.
 */

const fetchAudiences = vi.fn();
const readFeed = vi.fn();
const postsSince = vi.fn();
const fetchPost = vi.fn();
const markAudienceRead = vi.fn();
const writePost = vi.fn();
const writeBoardPost = vi.fn();
const createGroup = vi.fn();
const fetchReports = vi.fn();

vi.mock("../api/feed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/feed")>()),
  fetchAudiences: () => fetchAudiences(),
  readFeed: (input: unknown) => readFeed(input),
  postsSince: (input: unknown) => postsSince(input),
  fetchPost: (input: unknown) => fetchPost(input),
  markAudienceRead: (input: unknown) => markAudienceRead(input),
  markPostRead: () => Promise.resolve(ok({ readBy: 1 })),
  likePost: vi.fn(),
  writePost: (input: unknown) => writePost(input),
  writeBoardPost: (input: unknown) => writeBoardPost(input),
  uploadPostImage: vi.fn(),
  readComments: () => Promise.resolve(ok({ comments: [], earlier: null })),
  writeComment: vi.fn(),
  likeComment: vi.fn(),
  createGroup: (input: unknown) => createGroup(input),
  fetchGroupMembers: () => Promise.resolve(ok([])),
  fetchGroupCandidates: () => Promise.resolve(ok([])),
  addGroupMember: vi.fn(),
  leaveGroup: vi.fn(),
  reportPost: vi.fn(),
  fetchReports: () => fetchReports(),
  strikeReport: vi.fn(),
  dismissReport: vi.fn(),
}));

/** Where the card was asked to go. */
const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => (target: unknown) => navigate(target),
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params?: { postId?: string };
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a
      href={
        params?.postId === undefined ? to : to.replace("$postId", params.postId)
      }
      className={className}
    >
      {children}
    </a>
  ),
}));

const FROM_BO = post({
  id: "post-1",
  body: "Jag har tagit in en offert på taket.",
  createdAt: "2026-09-17T09:00:00.000Z",
});

const MINE = post({
  id: "post-2",
  author: { kind: "person", personId: ASTRID, name: "Astrid Lindqvist" },
  body: "Bra, då tar vi den på nästa möte.",
  createdAt: "2026-09-17T09:05:00.000Z",
});

/** One page of the feed as the API answers it: newest first. */
function page(
  posts: readonly PostView[],
  extra: Partial<FeedPage> = {},
): FeedPage {
  const newest = posts[0];
  return {
    pinned: [],
    scheduled: [],
    posts: [...posts],
    earlier: null,
    latest: newest === undefined ? null : `cursor-${newest.id}`,
    ...extra,
  };
}

/** The texts of the posts on screen, top to bottom. */
function shown(): string[] {
  const list = screen.queryByRole("list", { name: "Inlägg" });
  return list === null
    ? []
    : within(list)
        .getAllByRole("article")
        .map((article) => article.querySelector("p")?.textContent ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchAudiences.mockResolvedValue(
    ok({
      audiences: [ALL, BOARD],
      mayCreateGroup: true,
      mayPostAsBoard: false,
    }),
  );
  readFeed.mockResolvedValue(ok(page([FROM_BO])));
  postsSince.mockResolvedValue(
    ok({ posts: [], cursor: "unchanged", more: false }),
  );
  markAudienceRead.mockResolvedValue(ok({ readAt: FROM_BO.createdAt }));
  fetchReports.mockResolvedValue(ok({ reports: [], mayModerate: true }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the feed", () => {
  it("shows the posts newest first, with the pinned ones on top", async () => {
    readFeed.mockResolvedValue(
      ok(
        page([MINE, FROM_BO], {
          pinned: [
            post({
              id: "post-0",
              body: "Fäst: ordningsregler.",
              pinned: true,
              createdAt: "2026-08-01T09:00:00.000Z",
            }),
          ],
        }),
      ),
    );
    render(<FeedScreen viewer={viewer()} />);

    await screen.findByText("Fäst: ordningsregler.");
    expect(shown()).toEqual([
      "Fäst: ordningsregler.",
      "Bra, då tar vi den på nästa möte.",
      "Jag har tagit in en offert på taket.",
    ]);
    expect(readFeed).toHaveBeenCalledWith({
      filter: { audienceId: null, search: "", from: null, important: false },
      before: null,
    });
  });

  it("marks each audience read at its newest post on screen, never at now", async () => {
    readFeed.mockResolvedValue(
      ok(
        page([
          post({
            id: "post-board",
            audience: { id: BOARD.id, kind: "BOARD", name: null },
            createdAt: "2026-09-17T10:00:00.000Z",
          }),
          FROM_BO,
        ]),
      ),
    );
    render(<FeedScreen viewer={viewer()} />);

    await waitFor(() => {
      expect(markAudienceRead).toHaveBeenCalledTimes(2);
    });
    expect(markAudienceRead).toHaveBeenCalledWith({
      audienceId: ALL.id,
      readAt: FROM_BO.createdAt,
    });
    expect(markAudienceRead).toHaveBeenCalledWith({
      audienceId: BOARD.id,
      readAt: "2026-09-17T10:00:00.000Z",
    });
  });

  it("says nothing has been written in a feed nobody has written in", async () => {
    readFeed.mockResolvedValue(ok(page([])));
    render(<FeedScreen viewer={viewer()} />);

    expect(
      await screen.findByText("Ingenting har skrivits här än."),
    ).toBeTruthy();
  });
});

describe("the account that is in no audience", () => {
  it("says why rather than showing an empty feed", async () => {
    fetchAudiences.mockResolvedValue(
      ok({ audiences: [], mayCreateGroup: false, mayPostAsBoard: false }),
    );
    render(<FeedScreen viewer={viewer()} />);

    expect(
      await screen.findByText(/Flödet är för dem som bor här och för den som/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Skriv ett inlägg..." }),
    ).toBeNull();
    expect(readFeed).not.toHaveBeenCalled();
  });

  it("is told the report queue is the board's, when it holds the capability", async () => {
    fetchAudiences.mockResolvedValue(
      ok({ audiences: [], mayCreateGroup: false, mayPostAsBoard: false }),
    );
    fetchReports.mockResolvedValue(ok({ reports: [], mayModerate: false }));
    render(<FeedScreen viewer={viewer(["chat:moderate"])} />);

    expect(await screen.findByText(/Den här kön är styrelsens/)).toBeTruthy();
    expect(screen.queryByText("Ingenting är anmält.")).toBeNull();
  });
});

describe("the account the feed is not for", () => {
  it("says who the feed is for rather than offering a retry", async () => {
    fetchAudiences.mockResolvedValue(refused(403, "forbidden"));
    render(<FeedScreen viewer={viewer()} />);

    expect(
      await screen.findByText(/Flödet är för dem som bor i huset/),
    ).toBeTruthy();
    expect(screen.queryByText(/Ladda om sidan/)).toBeNull();
  });

  it("says the feed could not be opened when the list gets no answer", async () => {
    fetchAudiences.mockResolvedValue(refused(0, "offline"));
    render(<FeedScreen viewer={viewer()} />);

    expect(
      await screen.findByText(
        "Flödet kunde inte öppnas just nu. Ladda om sidan.",
      ),
    ).toBeTruthy();
  });
});

describe("narrowing the feed", () => {
  it("asks for one audience when it is chosen, and says which it is", async () => {
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    await userEvent.click(screen.getByRole("button", { name: "Styrelsen" }));

    await waitFor(() => {
      expect(readFeed).toHaveBeenLastCalledWith({
        filter: {
          audienceId: BOARD.id,
          search: "",
          from: null,
          important: false,
        },
        before: null,
      });
    });
    expect(screen.getByRole("heading", { name: "Styrelsen" })).toBeTruthy();
  });

  it("asks for what is searched for once the reader stops typing", async () => {
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    await userEvent.type(screen.getByLabelText("Sök i inläggen"), "taket");

    await waitFor(() => {
      expect(readFeed).toHaveBeenLastCalledWith({
        filter: {
          audienceId: null,
          search: "taket",
          from: null,
          important: false,
        },
        before: null,
      });
    });
    // Once, for the word: not for "t", "ta", "tak" on the way to it.
    expect(
      readFeed.mock.calls.filter(
        ([input]) =>
          (input as { filter: { search: string } }).filter.search !== "",
      ),
    ).toHaveLength(1);
  });

  it("asks for what the filter chose, and says how many are chosen", async () => {
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    await userEvent.click(
      screen.getByRole("button", { name: "Filtrera inlägg" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Filtrera inlägg" });
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Grannar" }),
    );
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: "Bara viktiga inlägg" }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Visa inläggen" }),
    );

    await waitFor(() => {
      expect(readFeed).toHaveBeenLastCalledWith({
        filter: {
          audienceId: null,
          search: "",
          from: "neighbours",
          important: true,
        },
        before: null,
      });
    });
    expect(
      screen.getByRole("button", { name: "Filtrera inlägg (2 val)" }),
    ).toBeTruthy();
  });

  it("marks nothing read while the feed is narrowed", async () => {
    render(<FeedScreen viewer={viewer()} />);
    await waitFor(() => {
      expect(markAudienceRead).toHaveBeenCalledTimes(1);
    });

    readFeed.mockResolvedValue(
      ok(
        page([
          post({
            id: "post-new",
            body: "Taket igen.",
            createdAt: "2026-09-18T09:00:00.000Z",
          }),
        ]),
      ),
    );
    await userEvent.type(screen.getByLabelText("Sök i inläggen"), "taket");
    await screen.findByText("Taket igen.");

    // A narrowed feed leaves out posts the reader has not seen, so its newest
    // is no measure of how far they have read.
    expect(markAudienceRead).toHaveBeenCalledTimes(1);
  });

  it("says nothing matched rather than that nothing was written", async () => {
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    readFeed.mockResolvedValue(ok(page([])));
    await userEvent.type(screen.getByLabelText("Sök i inläggen"), "zzz");

    expect(
      await screen.findByText(
        "Inga inlägg här matchar sökningen eller filtret.",
      ),
    ).toBeTruthy();
  });

  it("never shows one audience's answer under another's name", async () => {
    let answerBoard!: () => void;
    const boardAnswered = new Promise<void>((resolve) => {
      answerBoard = resolve;
    });
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    readFeed.mockImplementationOnce(async () => {
      await boardAnswered;
      return ok(page([post({ id: "post-b", body: "Bara för styrelsen." })]));
    });
    await userEvent.click(screen.getByRole("button", { name: "Styrelsen" }));
    // Alla again, before the board's read has answered.
    readFeed.mockResolvedValue(ok(page([FROM_BO])));
    await userEvent.click(screen.getByRole("button", { name: "Alla" }));
    await screen.findByText("Jag har tagit in en offert på taket.");

    await act(async () => {
      answerBoard();
      await boardAnswered;
    });

    expect(screen.queryByText("Bara för styrelsen.")).toBeNull();
    expect(screen.getByRole("heading", { name: "Alla" })).toBeTruthy();
  });
});

describe("writing a post", () => {
  it("goes to Alla from the whole feed, and is read back rather than appended", async () => {
    writePost.mockResolvedValue(ok(MINE));
    postsSince.mockResolvedValue(
      ok({ posts: [MINE], cursor: "cursor-post-2", more: false }),
    );
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    await userEvent.click(
      screen.getByRole("button", { name: "Skriv ett inlägg..." }),
    );
    const dialog = screen.getByRole("dialog", { name: "Skriv ett inlägg" });
    expect(within(dialog).getByText("Astrid Lindqvist")).toBeTruthy();
    expect(within(dialog).getByText("Alla")).toBeTruthy();
    await userEvent.type(
      within(dialog).getByLabelText("Text"),
      "Bra, då tar vi den på nästa möte.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Skapa" }),
    );

    expect(writePost).toHaveBeenCalledWith({
      audienceId: ALL.id,
      body: "Bra, då tar vi den på nästa möte.",
      imageIds: [],
    });
    await waitFor(() => {
      expect(postsSince).toHaveBeenCalledWith({
        filter: { audienceId: null, search: "", from: null, important: false },
        after: "cursor-post-1",
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      expect(shown()).toEqual([
        "Bra, då tar vi den på nästa möte.",
        "Jag har tagit in en offert på taket.",
      ]);
    });
  });

  it("goes to the audience that is open", async () => {
    fetchAudiences.mockResolvedValue(
      ok({
        audiences: [ALL, GARDEN],
        mayCreateGroup: true,
        mayPostAsBoard: false,
      }),
    );
    writePost.mockResolvedValue(ok(MINE));
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    await userEvent.click(
      screen.getByRole("button", { name: "Trädgårdsgruppen" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Skriv ett inlägg..." }),
    );
    const dialog = screen.getByRole("dialog", { name: "Skriv ett inlägg" });
    expect(within(dialog).getByText("Trädgårdsgruppen")).toBeTruthy();
    await userEvent.type(
      within(dialog).getByLabelText("Text"),
      "Vattning i kväll.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Skapa" }),
    );

    expect(writePost).toHaveBeenCalledWith({
      audienceId: GARDEN.id,
      body: "Vattning i kväll.",
      imageIds: [],
    });
  });
});

describe("catching up after the screen was closed", () => {
  it("asks from the cursor each answer gave, and stops when told to", async () => {
    /*
     * The backlog case, and the one the loop exists for. Asserted on the second
     * call's cursor rather than only on the post arriving, because a loop that
     * never advanced would still show the first page - and never stop.
     */
    writePost.mockResolvedValue(ok(MINE));
    postsSince
      .mockResolvedValueOnce(
        ok({ posts: [MINE], cursor: "cursor-2", more: true }),
      )
      .mockResolvedValueOnce(
        ok({ posts: [], cursor: "cursor-3", more: false }),
      );
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    await userEvent.click(
      screen.getByRole("button", { name: "Skriv ett inlägg..." }),
    );
    await userEvent.type(screen.getByLabelText("Text"), "Hej.");
    await userEvent.click(screen.getByRole("button", { name: "Skapa" }));

    await waitFor(() => {
      expect(postsSince).toHaveBeenCalledTimes(2);
    });
    expect(postsSince).toHaveBeenLastCalledWith({
      filter: { audienceId: null, search: "", from: null, important: false },
      after: "cursor-2",
    });
  });

  it("asks again from where an interval poll left off when a post is written during it", async () => {
    /*
     * The interval's read may have been answered from before the write, so the
     * writer's own post would wait for the next interval. The ask is queued
     * behind it, not dropped, and starts from the cursor that answer gave.
     */
    vi.useFakeTimers({ shouldAdvanceTime: true });
    writePost.mockResolvedValue(ok(MINE));
    let answerInterval: (value: unknown) => void = () => {};
    postsSince
      .mockReturnValueOnce(
        new Promise((resolve) => {
          answerInterval = resolve;
        }),
      )
      .mockResolvedValueOnce(
        ok({ posts: [MINE], cursor: "cursor-post-2", more: false }),
      );
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(postsSince).toHaveBeenCalledTimes(1);

    await userEvent.click(
      screen.getByRole("button", { name: "Skriv ett inlägg..." }),
    );
    await userEvent.type(screen.getByLabelText("Text"), "Hej.");
    await userEvent.click(screen.getByRole("button", { name: "Skapa" }));
    await waitFor(() => {
      expect(writePost).toHaveBeenCalled();
    });
    expect(postsSince).toHaveBeenCalledTimes(1);

    await act(async () => {
      answerInterval(ok({ posts: [], cursor: "cursor-before", more: false }));
    });

    await waitFor(() => {
      expect(postsSince).toHaveBeenCalledTimes(2);
    });
    expect(postsSince).toHaveBeenLastCalledWith({
      filter: { audienceId: null, search: "", from: null, important: false },
      after: "cursor-before",
    });
    expect(
      await screen.findByText("Bra, då tar vi den på nästa möte."),
    ).toBeTruthy();
  });

  it("reads the newest page again while nothing matched, so the first post is not waited for for ever", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    readFeed.mockResolvedValueOnce(ok(page([])));
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Ingenting har skrivits här än.");

    readFeed.mockResolvedValue(ok(page([FROM_BO])));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(
      await screen.findByText("Jag har tagit in en offert på taket."),
    ).toBeTruthy();
    expect(postsSince).not.toHaveBeenCalled();
  });
});

describe("a feed that could not be read", () => {
  it("says so once, and does not also call the feed empty", async () => {
    readFeed.mockResolvedValue(refused(404, "audience-not-found"));
    render(<FeedScreen viewer={viewer()} />);

    expect(await screen.findByText(/Den målgruppen finns inte/)).toBeTruthy();
    expect(screen.queryByText("Ingenting har skrivits här än.")).toBeNull();
  });

  it("says the feed could not be read, not that something could not be saved", async () => {
    readFeed.mockResolvedValue(refused(0, "offline"));
    render(<FeedScreen viewer={viewer()} />);

    expect(
      await screen.findByText("Flödet kunde inte läsas just nu. Försök igen."),
    ).toBeTruthy();
    expect(screen.queryByText(/kunde inte sparas/)).toBeNull();
  });

  it("gives the feed back once a later read answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    readFeed
      .mockResolvedValueOnce(refused(502, "unavailable"))
      .mockResolvedValue(ok(page([FROM_BO])));
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Flödet kunde inte läsas just nu. Försök igen.");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(
      await screen.findByText("Jag har tagit in en offert på taket."),
    ).toBeTruthy();
    expect(
      screen.queryByText("Flödet kunde inte läsas just nu. Försök igen."),
    ).toBeNull();
  });
});

describe("the posts before this page", () => {
  it("are one press away, and go below", async () => {
    readFeed.mockResolvedValueOnce(
      ok(page([FROM_BO], { earlier: "cursor-earlier" })),
    );
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    readFeed.mockResolvedValueOnce(
      ok(
        page(
          [
            post({
              id: "post-0",
              body: "Skrivet innan den här sidan.",
              createdAt: "2026-09-01T09:00:00.000Z",
            }),
          ],
          { latest: null },
        ),
      ),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Visa tidigare inlägg" }),
    );

    await waitFor(() => {
      expect(shown()).toEqual([
        "Jag har tagit in en offert på taket.",
        "Skrivet innan den här sidan.",
      ]);
    });
    expect(readFeed).toHaveBeenLastCalledWith({
      filter: { audienceId: null, search: "", from: null, important: false },
      before: "cursor-earlier",
    });
    expect(
      screen.queryByRole("button", { name: "Visa tidigare inlägg" }),
    ).toBeNull();
  });

  it("offers no control when the feed starts on this page", async () => {
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    expect(
      screen.queryByRole("button", { name: "Visa tidigare inlägg" }),
    ).toBeNull();
  });
});

describe("a group", () => {
  it("opens as soon as it is made, once the list carries it", async () => {
    createGroup.mockResolvedValue(
      ok({ audienceId: "audience-new", name: "Uppgång C" }),
    );
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    fetchAudiences.mockResolvedValue(
      ok({
        audiences: [
          ALL,
          BOARD,
          { ...GARDEN, id: "audience-new", name: "Uppgång C" },
        ],
        mayCreateGroup: true,
        mayPostAsBoard: false,
      }),
    );
    await userEvent.type(screen.getByLabelText("Starta en grupp"), "Uppgång C");
    await userEvent.click(
      screen.getByRole("button", { name: "Skapa gruppen" }),
    );

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Uppgång C" })
          .getAttribute("aria-current"),
      ).toBe("true");
    });
    expect(readFeed).toHaveBeenLastCalledWith({
      filter: {
        audienceId: "audience-new",
        search: "",
        from: null,
        important: false,
      },
      before: null,
    });
  });
});

describe("the board's queue of reported posts", () => {
  it("is on the screen for whoever moderates", async () => {
    render(<FeedScreen viewer={viewer(["chat:moderate"])} />);

    expect(
      await screen.findByRole("heading", { name: "Anmälda inlägg" }),
    ).toBeTruthy();
  });

  it("is absent for somebody who does not moderate", async () => {
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    expect(
      screen.queryByRole("heading", { name: "Anmälda inlägg" }),
    ).toBeNull();
    expect(fetchReports).not.toHaveBeenCalled();
  });
});

describe("the board's tools", () => {
  it("shows the board its scheduled posts, and offers it Styrelsen to write as", async () => {
    fetchAudiences.mockResolvedValue(
      ok({
        audiences: [ALL, BOARD],
        mayCreateGroup: false,
        mayPostAsBoard: true,
      }),
    );
    readFeed.mockResolvedValue(
      ok(
        page([FROM_BO], {
          scheduled: [
            post({
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
            }),
          ],
        }),
      ),
    );
    render(<FeedScreen viewer={viewer(["chat:moderate"])} />);

    expect(await screen.findByText("Städdag i maj")).toBeTruthy();
    // One board zone, holding both of the board's panels under their own
    // headings: what waits for its instant, and the reports to answer.
    const zones = screen.getAllByRole("region", {
      name: "Styrelsen Hantera flödet",
    });
    expect(zones).toHaveLength(1);
    const zone = zones[0] as HTMLElement;
    expect(
      within(zone).getByRole("heading", { name: "Schemalagda inlägg" }),
    ).toBeTruthy();
    expect(
      await within(zone).findByRole("heading", { name: "Anmälda inlägg" }),
    ).toBeTruthy();
    expect(within(zone).getByText("Städdag i maj")).toBeTruthy();
    // Beside the feed, not in it.
    expect(shown()).toEqual(["Jag har tagit in en offert på taket."]);

    await userEvent.click(
      screen.getByRole("button", { name: "Skriv ett inlägg..." }),
    );
    const dialog = screen.getByRole("dialog", { name: "Skriv ett inlägg" });
    // "Från" offers Styrelsen, and "Till" offers Alla and Styrelsen.
    expect(
      within(within(dialog).getByLabelText("Från")).getByRole("option", {
        name: "Styrelsen",
      }),
    ).toBeTruthy();
    expect(
      within(within(dialog).getByLabelText("Till"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Alla", "Styrelsen"]);
  });

  it("lists a post scheduled to Styrelsen from Alla only where Styrelsen's feed is read", async () => {
    fetchAudiences.mockResolvedValue(
      ok({
        audiences: [ALL, BOARD],
        mayCreateGroup: false,
        mayPostAsBoard: true,
      }),
    );
    const toBoard = post({
      id: "post-to-board",
      audience: { id: BOARD.id, kind: "BOARD", name: null },
      byBoard: true,
      author: null,
      body: null,
      scheduledAt: "2030-05-04T08:00:00.000Z",
      createdAt: "2030-05-04T08:00:00.000Z",
      news: {
        id: "news-1",
        slug: "styrelsemote",
        title: "Styrelsemöte i maj",
        text: "Tisdag.",
      },
    });
    writeBoardPost.mockResolvedValue(ok(toBoard));
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");
    await userEvent.click(screen.getByRole("button", { name: "Alla" }));
    await screen.findByRole("heading", { name: "Alla" });

    await userEvent.click(
      screen.getByRole("button", { name: "Skriv ett inlägg..." }),
    );
    const dialog = screen.getByRole("dialog", { name: "Skriv ett inlägg" });
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Från"),
      "Styrelsen",
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Till"),
      BOARD.id,
    );
    await userEvent.type(
      within(dialog).getByLabelText(/^Rubrik/u),
      "Styrelsemöte i maj",
    );
    await userEvent.type(within(dialog).getByLabelText("Text"), "Tisdag.");
    await userEvent.type(
      within(dialog).getByLabelText(/^Schemalägg publicering/u),
      "2030-05-04T10:00",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Schemalägg" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Alla's poll never delivers a post to Styrelsen, so nothing on Alla's
    // list would ever take it off again.
    expect(writeBoardPost).toHaveBeenCalledWith(
      expect.objectContaining({ audienceId: BOARD.id }),
    );
    expect(screen.queryByText("Schemalagda inlägg")).toBeNull();
    expect(screen.queryByText("Styrelsemöte i maj")).toBeNull();

    // Styrelsen's own read is where it waits.
    readFeed.mockResolvedValue(ok(page([FROM_BO], { scheduled: [toBoard] })));
    await userEvent.click(screen.getByRole("button", { name: "Styrelsen" }));
    expect(await screen.findByText("Styrelsemöte i maj")).toBeTruthy();
  });

  it("offers nobody else Styrelsen, and shows them nothing scheduled", async () => {
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");

    expect(screen.queryByText("Schemalagda inlägg")).toBeNull();
    // Nothing of the board's to show, so no zone and no empty frame.
    expect(
      screen.queryByRole("region", { name: /Hantera flödet/u }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Skriv ett inlägg..." }),
    );
    const dialog = screen.getByRole("dialog", { name: "Skriv ett inlägg" });
    expect(within(dialog).queryByLabelText("Från")).toBeNull();
  });
});

describe("what is new since the last visit", () => {
  /** The audiences answer, each with the marker its reader had left. */
  function withMarkers(all: string | null, board: string | null) {
    return ok({
      audiences: [
        { ...ALL, readAt: all },
        { ...BOARD, readAt: board },
      ],
      mayCreateGroup: true,
      mayPostAsBoard: false,
    });
  }

  const NEWER = post({
    id: "post-new",
    body: "Hissen står still igen.",
    createdAt: "2026-09-18T08:00:00.000Z",
  });

  it("draws one line below the newest posts the reader had not seen", async () => {
    fetchAudiences.mockResolvedValue(
      withMarkers("2026-09-17T12:00:00.000Z", null),
    );
    readFeed.mockResolvedValue(ok(page([NEWER, MINE, FROM_BO])));
    render(<FeedScreen viewer={viewer()} />);

    const line = await screen.findByRole("separator", {
      name: "Ovanför: nytt sedan ditt senaste besök",
    });
    // Directly under the new post, and above the ones read before.
    expect(line.closest("li")?.textContent).toContain(
      "Hissen står still igen.",
    );
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("keeps the line where the last visit ended once the marker moves", async () => {
    fetchAudiences
      .mockResolvedValueOnce(withMarkers("2026-09-17T12:00:00.000Z", null))
      // The screen marks the audience read; every later read says so.
      .mockResolvedValue(withMarkers(NEWER.createdAt, null));
    readFeed.mockResolvedValue(ok(page([NEWER, FROM_BO])));
    render(<FeedScreen viewer={viewer()} />);

    await screen.findByRole("separator");
    await waitFor(() => {
      expect(markAudienceRead).toHaveBeenCalled();
    });
    expect(screen.getByRole("separator")).toBeTruthy();
  });

  it("draws no line in an audience never opened, nor for the reader's own post", async () => {
    fetchAudiences.mockResolvedValue(withMarkers(null, null));
    readFeed.mockResolvedValue(ok(page([NEWER, FROM_BO])));
    const view = render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Hissen står still igen.");
    expect(screen.queryByRole("separator")).toBeNull();
    view.unmount();

    fetchAudiences.mockResolvedValue(
      withMarkers("2026-09-17T08:00:00.000Z", null),
    );
    // Only the reader's own post was written since: it is not news to them.
    readFeed.mockResolvedValue(ok(page([MINE, FROM_BO])));
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Bra, då tar vi den på nästa möte.");
    await waitFor(() => {
      expect(readFeed).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("draws no line when everything on screen is new", async () => {
    fetchAudiences.mockResolvedValue(
      withMarkers("2026-09-01T00:00:00.000Z", null),
    );
    readFeed.mockResolvedValue(ok(page([NEWER, FROM_BO])));
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Hissen står still igen.");
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("does not call posts new again when the reader comes back before the next read", async () => {
    // The list never changes: every read says the marker is still the old one.
    fetchAudiences.mockResolvedValue(
      withMarkers("2026-09-17T12:00:00.000Z", null),
    );
    markAudienceRead.mockResolvedValue(ok({ readAt: NEWER.createdAt }));
    readFeed.mockResolvedValue(ok(page([NEWER, FROM_BO])));
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByRole("separator");
    await waitFor(() => {
      expect(markAudienceRead).toHaveBeenCalled();
    });

    await userEvent.click(screen.getByRole("button", { name: "Styrelsen" }));
    await waitFor(() => {
      expect(screen.queryByRole("separator")).toBeNull();
    });
    await userEvent.click(screen.getByRole("button", { name: "Alla" }));
    await screen.findByText("Hissen står still igen.");

    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("draws the line below a pinned post that arrived since the last visit", async () => {
    fetchAudiences.mockResolvedValue(
      withMarkers("2026-09-17T12:00:00.000Z", null),
    );
    const PINNED_NEW = post({
      id: "post-pinned-new",
      body: "Fäst: vattnet stängs av.",
      pinned: true,
      createdAt: "2026-09-18T07:00:00.000Z",
    });
    // Everything below it was read before the marker.
    readFeed.mockResolvedValue(
      ok(page([MINE, FROM_BO], { pinned: [PINNED_NEW] })),
    );
    render(<FeedScreen viewer={viewer()} />);

    const line = await screen.findByRole("separator", {
      name: "Ovanför: nytt sedan ditt senaste besök",
    });
    expect(line.closest("li")?.textContent).toContain(
      "Fäst: vattnet stängs av.",
    );
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("draws no line for a pinned post read before, nor one below it", async () => {
    fetchAudiences.mockResolvedValue(
      withMarkers("2026-09-17T12:00:00.000Z", null),
    );
    const PINNED_OLD = post({
      id: "post-pinned-old",
      body: "Fäst: ordningsregler.",
      pinned: true,
      createdAt: "2026-08-01T09:00:00.000Z",
    });
    readFeed.mockResolvedValue(
      ok(page([MINE, FROM_BO], { pinned: [PINNED_OLD] })),
    );
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Fäst: ordningsregler.");
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("keeps posts the poll brings above the line", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchAudiences.mockResolvedValue(
      withMarkers("2026-09-17T12:00:00.000Z", null),
    );
    readFeed.mockResolvedValue(ok(page([NEWER, FROM_BO])));
    const LATER = post({
      id: "post-later",
      body: "Nu går den igen.",
      createdAt: "2026-09-18T09:00:00.000Z",
    });
    postsSince.mockResolvedValueOnce(
      ok({ posts: [LATER], cursor: "cursor-post-later", more: false }),
    );
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByRole("separator");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await screen.findByText("Nu går den igen.");
    expect(shown()).toEqual([
      "Nu går den igen.",
      "Hissen står still igen.",
      "Jag har tagit in en offert på taket.",
    ]);
    expect(screen.getByRole("separator").closest("li")?.textContent).toContain(
      "Hissen står still igen.",
    );
  });
});

describe("the counts beside every audience", () => {
  it("are read again on the feed's poll, not only when the feed opens", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<FeedScreen viewer={viewer()} />);
    await screen.findByText("Jag har tagit in en offert på taket.");
    const before = fetchAudiences.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await waitFor(() => {
      expect(fetchAudiences.mock.calls.length).toBeGreaterThan(before);
    });
  });
});
