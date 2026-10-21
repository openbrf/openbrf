import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import type { PostView } from "@openbrf/shared";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import {
  ASTRID,
  BO,
  installIntersectionObserver,
  ok,
  post,
  refused,
  STAIRWELL,
} from "./feed-fixtures";
import { PostCard } from "./PostCard";

/**
 * One post, and what a reader may do with it.
 *
 * **"Läst av N" is a count and never names.** The payload carries a number and
 * the card shows the number.
 *
 * **There is no delete.** Not in the ⋯, not anywhere on the card: the board
 * strikes through, and the retention clock is the only thing that erases.
 *
 * **Reporting is the way out of a group, and only that.** Offered on a
 * neighbour's post in a group that the board has not answered about, and
 * nowhere else.
 *
 * **What an act is answered with is what is shown.** A like shows the count
 * the server gave back, not the count plus one.
 */

const likePost = vi.fn();
const markPostRead = vi.fn();
const reportToBoard = vi.fn();
const strikePost = vi.fn();
const readComments = vi.fn();
const writeComment = vi.fn();
const likeComment = vi.fn();
const pinPost = vi.fn();
const editPost = vi.fn();
const fetchPostRevisions = vi.fn();
const fetchNotRead = vi.fn();

vi.mock("../api/feed", () => ({
  likePost: (input: unknown) => likePost(input),
  markPostRead: (input: unknown) => markPostRead(input),
  reportToBoard: (input: unknown) => reportToBoard(input),
  strikePost: (input: unknown) => strikePost(input),
  pinPost: (input: unknown) => pinPost(input),
  readComments: (input: unknown) => readComments(input),
  writeComment: (input: unknown) => writeComment(input),
  likeComment: (input: unknown) => likeComment(input),
  editPost: (input: unknown) => editPost(input),
  fetchPostRevisions: (input: unknown) => fetchPostRevisions(input),
  fetchNotRead: (input: unknown) => fetchNotRead(input),
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

function show(
  shown: PostView,
  options: {
    onChange?: (patch: Partial<PostView>) => void;
    mayPostAsBoard?: boolean;
  } = {},
): void {
  render(
    <PostCard
      post={shown}
      viewerPersonId={ASTRID}
      mayPostAsBoard={options.mayPostAsBoard ?? false}
      showAudience
      onChange={options.onChange ?? (() => {})}
      onRefresh={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  readComments.mockResolvedValue(ok({ comments: [], earlier: null }));
});

describe("a post on its card", () => {
  it("says who wrote it, to whom, and what they wrote, and links to its own address", () => {
    show(post({ id: "post-1", body: "Tvättstugan är stängd på torsdag." }));

    expect(screen.getByText("Bo Ek")).toBeTruthy();
    expect(screen.getByText("Till Alla")).toBeTruthy();
    expect(screen.getByText("Tvättstugan är stängd på torsdag.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /2026/ }).getAttribute("href"),
    ).toBe("/feed/post-1");
  });

  it("reads a board post as Styrelsen via its writer, or as Styrelsen alone", () => {
    show(
      post({
        id: "post-1",
        byBoard: true,
        author: { kind: "person", personId: "person-ella", name: "Ella Berg" },
      }),
    );
    expect(screen.getByText("Styrelsen")).toBeTruthy();
    expect(screen.getByText("via")).toBeTruthy();
    expect(screen.getByText("Ella Berg")).toBeTruthy();
  });

  it("names nobody with protected personal data", () => {
    show(
      post({
        id: "post-1",
        author: { kind: "protected", personId: "person-hidden" },
      }),
    );

    expect(
      screen.getByText("Skyddade personuppgifter: namnges inte här."),
    ).toBeTruthy();
  });

  it("shows how many have read it, and no names", () => {
    show(post({ id: "post-1", readBy: 7 }));

    expect(screen.getByText("Läst av 7")).toBeTruthy();
  });

  it("shows the images on it, each linked at full size", () => {
    show(
      post({
        id: "post-1",
        images: [
          { id: "file-1", url: "/api/media/file-1", width: 800, height: 600 },
          { id: "file-2", url: "/api/media/file-2", width: 600, height: 800 },
        ],
      }),
    );

    const images = screen.getAllByRole("img");
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "/api/media/file-1",
      "/api/media/file-2",
    ]);
    expect(images[0]?.getAttribute("alt")).toBe("Bild 1 av 2 i inlägget");
  });

  it("offers no control that would delete it", async () => {
    show(post({ id: "post-1", audience: { ...STAIRWELL } }));

    await userEvent.click(
      screen.getByRole("button", { name: "Fler val för inlägget från Bo Ek" }),
    );
    expect(
      screen.queryByRole("button", { name: /radera|ta bort/i }),
    ).toBeNull();
  });
});

describe("liking a post", () => {
  it("shows the count the server answered with", async () => {
    const changes: Partial<PostView>[] = [];
    likePost.mockResolvedValue(ok({ liked: true, likes: 4 }));
    show(post({ id: "post-1", likes: 2 }), {
      onChange: (patch) => changes.push(patch),
    });

    await userEvent.click(screen.getByRole("button", { name: /Gilla/ }));

    expect(likePost).toHaveBeenCalledWith({ postId: "post-1", liked: true });
    await waitFor(() => {
      expect(changes).toEqual([{ liked: true, likes: 4 }]);
    });
  });

  it("says so when the like is refused", async () => {
    likePost.mockResolvedValue(refused(422, "post-erased"));
    show(post({ id: "post-1" }));

    await userEvent.click(screen.getByRole("button", { name: /Gilla/ }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Det inlägget har raderats.",
    );
  });
});

describe("the comments", () => {
  it("open under the post when the count is pressed", async () => {
    show(post({ id: "post-1", comments: 2 }));

    const toggle = screen.getByRole("button", { name: "2 kommentarer" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(readComments).toHaveBeenCalledWith({
      postId: "post-1",
      before: null,
    });
  });
});

describe("reading it", () => {
  it("is recorded once the post has been on screen, and the count updated", async () => {
    const { seeAll } = installIntersectionObserver();
    const changes: Partial<PostView>[] = [];
    markPostRead.mockResolvedValue(ok({ readBy: 3 }));
    show(post({ id: "post-1", readBy: 2 }), {
      onChange: (patch) => changes.push(patch),
    });

    expect(markPostRead).not.toHaveBeenCalled();
    seeAll();

    expect(markPostRead).toHaveBeenCalledWith({ postId: "post-1" });
    await waitFor(() => {
      expect(changes).toEqual([{ readBy: 3 }]);
    });
  });

  it("is never recorded for the reader's own post", () => {
    const { seeAll } = installIntersectionObserver();
    show(
      post({
        id: "post-1",
        author: { kind: "person", personId: ASTRID, name: "Astrid Lindqvist" },
      }),
    );

    seeAll();

    expect(markPostRead).not.toHaveBeenCalled();
  });
});

describe("the ⋯", () => {
  it("copies the text", async () => {
    const user = userEvent.setup();
    show(post({ id: "post-1", body: "Kom ihåg städdagen." }));

    await user.click(
      screen.getByRole("button", { name: "Fler val för inlägget från Bo Ek" }),
    );
    await user.click(screen.getByRole("button", { name: "Kopiera texten" }));

    expect(await navigator.clipboard.readText()).toBe("Kom ihåg städdagen.");
    expect(await screen.findByText("Texten är kopierad.")).toBeTruthy();
  });

  it("offers reporting a neighbour's post in a group, and sends it with the note", async () => {
    reportToBoard.mockResolvedValue(ok({ reportId: "report-1" }));
    show(post({ id: "post-1", audience: { ...STAIRWELL }, mayReport: true }));

    await userEvent.click(
      screen.getByRole("button", { name: "Fler val för inlägget från Bo Ek" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Anmäl till styrelsen" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Anmäl inlägget från Bo Ek till styrelsen",
    });
    await userEvent.type(
      within(dialog).getByLabelText("Vad vill du säga till styrelsen?"),
      "Det här är elakt.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Skicka anmälan" }),
    );

    // Out of a group, the dialog says the board sees nothing else from it.
    expect(within(dialog).getByText(/ingenting annat ur gruppen/)).toBeTruthy();
    expect(reportToBoard).toHaveBeenCalledWith({
      postId: "post-1",
      note: "Det här är elakt.",
    });
    expect(
      await screen.findByText("Inlägget är anmält till styrelsen."),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers reporting a neighbour's post in Alla, and says the board reads Alla", async () => {
    show(post({ id: "post-1", mayReport: true }));

    await userEvent.click(
      screen.getByRole("button", { name: "Fler val för inlägget från Bo Ek" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Anmäl till styrelsen" }),
    );

    expect(
      within(screen.getByRole("dialog")).getByText(
        /Styrelsen läser redan det som skrivs till Alla/,
      ),
    ).toBeTruthy();
  });

  it("offers no reporting where the server did not say so", async () => {
    // Styrelsen, the reader's own, a struck one, and the board's in Alla:
    // the server answers each with `mayReport: false`.
    show(post({ id: "post-1", audience: { ...STAIRWELL }, mayReport: false }));

    await userEvent.click(
      screen.getByRole("button", { name: /Fler val för inlägget/ }),
    );
    expect(
      screen.queryByRole("button", { name: "Anmäl till styrelsen" }),
    ).toBeNull();
  });
});

describe("striking a post in Alla", () => {
  it("is the board's, under its sign, asked once more, and puts the answer on the post", async () => {
    const struck = post({
      id: "post-1",
      struckAt: "2026-09-18T09:00:00.000Z",
    });
    strikePost.mockResolvedValue(ok(struck));
    const onChange = vi.fn();
    show(post({ id: "post-1", mayStrike: true }), { onChange });

    const controls = screen.getByRole("group", { name: "Styrelsen" });
    await userEvent.click(
      within(controls).getByRole("button", { name: "Stryk över" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Stryk över inlägget från Bo Ek?",
    });
    expect(strikePost).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stryk över" }),
    );

    expect(strikePost).toHaveBeenCalledWith({ postId: "post-1" });
    expect(onChange).toHaveBeenCalledWith(struck);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says why a strike was refused, inside the dialog", async () => {
    strikePost.mockResolvedValue(refused(422, "not-strikeable"));
    show(post({ id: "post-1", mayStrike: true }));

    await userEvent.click(screen.getByRole("button", { name: "Stryk över" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Stryk över" }),
    );

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "bara i Alla",
    );
  });

  it("is offered nowhere the server did not say so", () => {
    show(post({ id: "post-1" }));

    expect(screen.queryByRole("button", { name: "Stryk över" })).toBeNull();
  });
});

describe("a struck post", () => {
  it("withholds the text from the group as the server answered", () => {
    show(
      post({
        id: "post-1",
        audience: { ...STAIRWELL },
        body: null,
        struckAt: "2026-09-18T09:00:00.000Z",
      }),
    );

    expect(screen.getByText("Struket")).toBeTruthy();
    expect(
      screen.getByText("Styrelsen har strukit över inlägget och dolt texten."),
    ).toBeTruthy();
    expect(screen.getByText("Bo Ek")).toBeTruthy();
  });

  it("shows its author the struck text, struck through", () => {
    show(
      post({
        id: "post-1",
        audience: { ...STAIRWELL },
        author: { kind: "person", personId: ASTRID, name: "Astrid Lindqvist" },
        body: "Det jag skrev.",
        struckAt: "2026-09-18T09:00:00.000Z",
      }),
    );

    expect(
      screen.getByText("Det jag skrev.").closest("p")?.className,
    ).toContain("line-through");
  });
});

describe("an erased post", () => {
  it("says it was erased, and never attributes it to the board", () => {
    show(
      post({
        id: "post-1",
        author: null,
        body: null,
        erasedAt: "2026-09-18T09:00:00.000Z",
        commentsAllowed: false,
        comments: 1,
      }),
    );

    expect(screen.getByText("Raderat")).toBeTruthy();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(screen.queryByRole("button", { name: /Gilla/ })).toBeNull();
    expect(screen.getByRole("button", { name: "1 kommentar" })).toBeTruthy();
  });
});

describe("a post written as Styrelsen", () => {
  const notice = (facts: Partial<PostView> = {}): PostView =>
    post({
      id: "post-1",
      byBoard: true,
      author: null,
      body: null,
      news: {
        id: "news-1",
        slug: "vattnet",
        title: "Vattnet stängs av",
        text: "Tisdag 9-12.\n\nFyll en kanna kvällen före.",
      },
      ...facts,
    });

  it("shows its news item's title and text", () => {
    show(notice());

    expect(
      screen.getByRole("heading", { name: "Vattnet stängs av" }),
    ).toBeTruthy();
    // One text, its paragraphs kept apart by the blank line between them.
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "SPAN" &&
          element.textContent === "Tisdag 9-12.\n\nFyll en kanna kvällen före.",
      ),
    ).toBeTruthy();
  });

  it("offers the board the pin under its sign, and puts the server's answer on the post", async () => {
    pinPost.mockResolvedValue(ok(notice({ pinned: true })));
    const onChange = vi.fn();
    show(notice(), { onChange, mayPostAsBoard: true });

    // On the card in the board's own group, not among the acts in the ⋯.
    await userEvent.click(
      within(screen.getByRole("group", { name: "Styrelsen" })).getByRole(
        "button",
        { name: "Fäst överst" },
      ),
    );

    expect(pinPost).toHaveBeenCalledWith({ postId: "post-1", pinned: true });
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ pinned: true });
    });
    await userEvent.click(
      screen.getByRole("button", { name: /Fler val för inlägget/u }),
    );
    expect(screen.getAllByRole("button", { name: "Fäst överst" })).toHaveLength(
      1,
    );
  });

  it("offers the board the pin off a pinned post", () => {
    show(notice({ pinned: true }), { mayPostAsBoard: true });
    expect(
      within(screen.getByRole("group", { name: "Styrelsen" })).getByRole(
        "button",
        { name: "Lossa från toppen" },
      ),
    ).toBeTruthy();
  });

  it("offers the pin to nobody else, and on no neighbour's post", async () => {
    show(notice());
    expect(screen.queryByRole("group", { name: "Styrelsen" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /Fler val för inlägget/u }),
    );
    expect(screen.queryByRole("button", { name: "Fäst överst" })).toBeNull();
  });

  it("links to the news page only from a post to Alla", () => {
    show(
      notice({ audience: { id: "audience-admin", kind: "ADMIN", name: null } }),
    );
    // Written to Administratörer, its item is on nobody's news page.
    expect(screen.getByText("Till Administratörer")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Läs nyheten" })).toBeNull();
  });

  it("links a post to Alla to the news page", () => {
    show(notice());
    expect(screen.getByRole("link", { name: "Läs nyheten" })).toBeTruthy();
  });
});

/** Opens the ⋯ on a post from Bo. */
async function openMore(): Promise<void> {
  await userEvent.click(
    screen.getByRole("button", { name: "Fler val för inlägget från Bo Ek" }),
  );
}

describe("an issue report made from a post", () => {
  it("is offered where the server said so, and opens the form with the post", async () => {
    show(post({ id: "post-1", mayReportIssue: true }));
    await openMore();
    await userEvent.click(
      screen.getByRole("button", { name: "Gör felanmälan" }),
    );
    expect(navigate).toHaveBeenCalledWith({
      to: "/issues",
      search: { post: "post-1" },
    });
  });

  it("is offered nowhere the server did not say so", async () => {
    show(post({ id: "post-1" }));
    await openMore();
    expect(screen.queryByRole("button", { name: "Gör felanmälan" })).toBeNull();
  });

  it("shows where the report stands, as the server answered", () => {
    show(
      post({ id: "post-1", issue: { id: "issue-1", status: "IN_PROGRESS" } }),
    );
    expect(screen.getByText("Felanmälan:")).toBeTruthy();
    expect(screen.getByText("Pågår")).toBeTruthy();
  });
});

describe("editing a post", () => {
  const OWN = post({
    id: "post-1",
    author: { kind: "person", personId: ASTRID, name: "Astrid Lindqvist" },
    body: "Tvättstugan är stängd på tisdag.",
    mayEdit: true,
  });

  it("puts what the server answered onto the post", async () => {
    const onChange = vi.fn();
    const edited = {
      ...OWN,
      body: "Tvättstugan är stängd på torsdag.",
      editedAt: "2026-09-17T10:00:00.000Z",
    };
    editPost.mockResolvedValue(ok(edited));
    show(OWN, { onChange });

    await userEvent.click(
      screen.getByRole("button", {
        name: "Fler val för inlägget från Astrid Lindqvist",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Redigera" }));
    const field = screen.getByLabelText("Inlägget");
    expect((field as HTMLTextAreaElement).value).toBe(
      "Tvättstugan är stängd på tisdag.",
    );
    await userEvent.clear(field);
    await userEvent.type(field, "Tvättstugan är stängd på torsdag.");
    await userEvent.click(screen.getByRole("button", { name: "Spara" }));

    expect(editPost).toHaveBeenCalledWith({
      postId: "post-1",
      body: "Tvättstugan är stängd på torsdag.",
    });
    expect(onChange).toHaveBeenCalledWith(edited);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says why an edit was refused, inside the dialog", async () => {
    editPost.mockResolvedValue(refused(422, "not-editable"));
    show(OWN);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Fler val för inlägget från Astrid Lindqvist",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Redigera" }));
    await userEvent.type(screen.getByLabelText("Inlägget"), " Igen.");
    await userEvent.click(screen.getByRole("button", { name: "Spara" }));

    expect(
      await within(screen.getByRole("dialog")).findByText(
        /bara redigera det du själv har skrivit/u,
      ),
    ).toBeTruthy();
  });

  it("is offered nowhere the server did not say so", async () => {
    show(post({ id: "post-1" }));
    await openMore();
    expect(screen.queryByRole("button", { name: "Redigera" })).toBeNull();
  });
});

describe("a post's earlier versions", () => {
  it("are read when asked for, and shown with when each was replaced", async () => {
    fetchPostRevisions.mockResolvedValue(
      ok({
        revisions: [
          {
            body: "Tvättstugan är stängd på tisdag.",
            writtenAt: "2026-09-17T09:00:00.000Z",
            replacedAt: "2026-09-17T10:00:00.000Z",
          },
        ],
      }),
    );
    show(
      post({
        id: "post-1",
        editedAt: "2026-09-17T10:00:00.000Z",
        mayReadHistory: true,
      }),
    );
    expect(fetchPostRevisions).not.toHaveBeenCalled();

    await openMore();
    await userEvent.click(
      screen.getByRole("button", { name: "Tidigare versioner" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Tidigare versioner av inlägget från Bo Ek",
    });
    expect(
      await within(dialog).findByText("Tvättstugan är stängd på tisdag."),
    ).toBeTruthy();
    const version = within(dialog).getByText(
      (_, element) =>
        element?.tagName === "P" &&
        /^Skrivet .+, ersatt .+$/u.test(element.textContent),
    );
    // The two dates are register data, in the data face; the sentence is not.
    expect(version.className).not.toContain("font-data");
    const dates = [...version.querySelectorAll(".font-data")].map(
      (date) => date.textContent,
    );
    expect(dates).toHaveLength(2);
    expect(version.textContent).toBe(`Skrivet ${dates[0]}, ersatt ${dates[1]}`);
    expect(fetchPostRevisions).toHaveBeenCalledWith({ postId: "post-1" });
  });

  it("are offered nowhere the server did not say so", async () => {
    show(post({ id: "post-1", editedAt: "2026-09-17T10:00:00.000Z" }));
    expect(screen.getByText("Redigerat")).toBeTruthy();
    await openMore();
    expect(
      screen.queryByRole("button", { name: "Tidigare versioner" }),
    ).toBeNull();
  });
});

describe("who has not read an important post", () => {
  it("is the board's to ask for, under its sign, and names each of them", async () => {
    fetchNotRead.mockResolvedValue(
      ok({
        people: [
          { kind: "person", personId: BO, name: "Bo Ek" },
          { kind: "protected", personId: "person-hidden" },
        ],
      }),
    );
    show(post({ id: "post-1", important: true, mayListNotRead: true }));

    const board = screen.getByRole("group", { name: "Styrelsen" });
    await userEvent.click(
      within(board).getByRole("button", { name: "Vilka har inte läst?" }),
    );
    const list = await screen.findByRole("region", {
      name: "Har inte läst inlägget",
    });
    expect(within(list).getByText(/^2 i målgruppen/u)).toBeTruthy();
    expect(within(list).getByText("Bo Ek")).toBeTruthy();
    expect(within(list).getByText(/Skyddade personuppgifter/u)).toBeTruthy();
    expect(fetchNotRead).toHaveBeenCalledWith({ postId: "post-1" });
  });

  it("is a count for everybody else", () => {
    show(post({ id: "post-1", important: true, readBy: 4 }));
    expect(
      screen.queryByRole("button", { name: "Vilka har inte läst?" }),
    ).toBeNull();
    expect(screen.getByText("Läst av 4")).toBeTruthy();
  });
});
