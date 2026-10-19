import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import "../i18n";
import { comment, ok, post, refused } from "./feed-fixtures";
import { PostThread } from "./PostThread";

/**
 * The comments under a post.
 *
 * **Flat and oldest first.** The newest page is read first, so a long thread
 * opens where the conversation is, and the comments before it are a press away
 * above.
 *
 * **A comment is never put on the thread by the browser.** Writing one clears
 * the field and reads the thread again, and the post's count is read again too.
 *
 * **What is written after the thread opened arrives forwards**, from the newest
 * comment held: by poll while the tab is looked at, and at once after the
 * reader writes. More than a page written meanwhile arrives whole, never as its
 * newest page with a gap behind it.
 *
 * **A refusal keeps the draft**, so a personal identity number can be taken out
 * rather than the comment written again.
 */

const readComments = vi.fn();
const commentsSince = vi.fn();
const writeComment = vi.fn();
const likeComment = vi.fn();

vi.mock("../api/feed", () => ({
  readComments: (input: unknown) => readComments(input),
  commentsSince: (input: unknown) => commentsSince(input),
  writeComment: (input: unknown) => writeComment(input),
  likeComment: (input: unknown) => likeComment(input),
}));

/** The visibility the document reports, which jsdom has no control for. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

/**
 * Comments written one a minute from an instant, under the post, so their
 * order on screen is the order they are made in.
 */
function writtenInTurn(from: number, count: number, body: string) {
  return Array.from({ length: count }, (_, index) =>
    comment({
      id: `comment-${String(from + index).padStart(3, "0")}`,
      body: `${body} ${String(from + index)}.`,
      createdAt: new Date(
        Date.UTC(2026, 8, 17, 10, from + index),
      ).toISOString(),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  commentsSince.mockResolvedValue(
    ok({ comments: [], cursor: "cursor-idle", more: false }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a thread", () => {
  it("shows the comments oldest first, each with its likes", async () => {
    readComments.mockResolvedValue(
      ok({
        comments: [
          comment({ id: "comment-1", body: "Först." }),
          comment({
            id: "comment-2",
            body: "Sedan.",
            createdAt: "2026-09-17T11:00:00.000Z",
            likes: 3,
          }),
        ],
        earlier: null,
        latest: "cursor-latest",
      }),
    );
    render(<PostThread post={post({ id: "post-1" })} onCommented={() => {}} />);

    const items = await screen.findAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Först."),
      expect.stringContaining("Sedan."),
    ]);
    expect(items[1]?.textContent).toContain("3");
  });

  it("puts the comments before this page above it, one press away", async () => {
    readComments
      .mockResolvedValueOnce(
        ok({
          comments: [
            comment({
              id: "comment-2",
              body: "Nyare.",
              createdAt: "2026-09-17T11:00:00.000Z",
            }),
          ],
          earlier: "cursor-a",
          latest: "cursor-2",
        }),
      )
      .mockResolvedValueOnce(
        ok({
          comments: [comment({ id: "comment-1", body: "Äldre." })],
          earlier: null,
          latest: "cursor-1",
        }),
      );
    render(<PostThread post={post({ id: "post-1" })} onCommented={() => {}} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Visa tidigare kommentarer" }),
    );

    expect(readComments).toHaveBeenLastCalledWith({
      postId: "post-1",
      before: "cursor-a",
    });
    await waitFor(() => {
      expect(
        screen.getAllByRole("listitem").map((item) => item.textContent),
      ).toEqual([
        expect.stringContaining("Äldre."),
        expect.stringContaining("Nyare."),
      ]);
    });
    expect(
      screen.queryByRole("button", { name: "Visa tidigare kommentarer" }),
    ).toBeNull();
  });

  it("withholds a struck comment's text as the server answered", async () => {
    readComments.mockResolvedValue(
      ok({
        comments: [
          comment({
            id: "comment-1",
            body: null,
            struckAt: "2026-09-18T09:00:00.000Z",
          }),
        ],
        earlier: null,
        latest: "cursor-latest",
      }),
    );
    render(<PostThread post={post({ id: "post-1" })} onCommented={() => {}} />);

    expect(await screen.findByText("Struket")).toBeTruthy();
    expect(screen.getByText("Bo Ek")).toBeTruthy();
    // The comment was struck, not the post it answers.
    expect(
      screen.getByText(
        "Styrelsen har strukit över kommentaren och dolt texten.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/strukit över inlägget/)).toBeNull();
  });

  it("likes a comment and shows the count the server answered with", async () => {
    readComments.mockResolvedValue(
      ok({
        comments: [comment({ id: "comment-1", likes: 1 })],
        earlier: null,
        latest: "cursor-1",
      }),
    );
    likeComment.mockResolvedValue(ok({ liked: true, likes: 5 }));
    render(<PostThread post={post({ id: "post-1" })} onCommented={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: /Gilla/ }));

    expect(likeComment).toHaveBeenCalledWith({
      commentId: "comment-1",
      liked: true,
    });
    expect(
      (await screen.findByRole("button", { name: /Gillat/ })).textContent,
    ).toContain("5");
  });
});

describe("writing a comment", () => {
  it("clears the field and reads the thread rather than appending", async () => {
    readComments.mockResolvedValue(
      ok({ comments: [], earlier: null, latest: null }),
    );
    writeComment.mockResolvedValue(ok(comment({ id: "comment-9" })));
    const onCommented = vi.fn();
    render(
      <PostThread post={post({ id: "post-1" })} onCommented={onCommented} />,
    );
    await screen.findByText("Ingen har kommenterat än.");

    readComments.mockResolvedValue(
      ok({
        comments: [comment({ id: "comment-9", body: "Bra initiativ!" })],
        earlier: null,
        latest: "cursor-latest",
      }),
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Din kommentar" }),
      "Bra initiativ!",
    );
    await userEvent.click(screen.getByRole("button", { name: "Skicka" }));

    expect(writeComment).toHaveBeenCalledWith({
      postId: "post-1",
      body: "Bra initiativ!",
    });
    expect(await screen.findByText("Bra initiativ!")).toBeTruthy();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Din kommentar",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(readComments).toHaveBeenCalledTimes(2);
    expect(onCommented).toHaveBeenCalledTimes(1);
  });

  it("puts a refused personal identity number in words, and keeps the draft", async () => {
    readComments.mockResolvedValue(
      ok({ comments: [], earlier: null, latest: null }),
    );
    writeComment.mockResolvedValue(refused(422, "personal-identity-number"));
    render(<PostThread post={post({ id: "post-1" })} onCommented={() => {}} />);

    const field = await screen.findByRole("textbox", { name: "Din kommentar" });
    await userEvent.type(field, "Mitt nummer är 19811218-9876");
    await userEvent.click(screen.getByRole("button", { name: "Skicka" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "personnummer",
    );
    expect((field as HTMLInputElement).value).toBe(
      "Mitt nummer är 19811218-9876",
    );
  });

  it("is not offered on a post that takes no comments", async () => {
    readComments.mockResolvedValue(
      ok({ comments: [], earlier: null, latest: null }),
    );
    render(
      <PostThread
        post={post({ id: "post-1", commentsAllowed: false })}
        onCommented={() => {}}
      />,
    );

    expect(
      await screen.findByText("Inlägget tar inte emot kommentarer."),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("what is written after the thread opened", () => {
  it("arrives whole after the reader writes, however many neighbours wrote in between", async () => {
    /*
     * The thread opened with one comment and nothing before it. Fifty-one
     * neighbours then answered, and the reader writes: the read after the write
     * goes forwards from the comment held, page after page, rather than taking
     * the newest fifty and leaving the first of the neighbours behind them with
     * no cursor that reaches them.
     */
    const opening = writtenInTurn(0, 1, "Först");
    const between = writtenInTurn(1, 51, "Granne");
    const own = writtenInTurn(52, 1, "Mitt svar");
    readComments.mockResolvedValue(
      ok({ comments: opening, earlier: null, latest: "cursor-0" }),
    );
    commentsSince
      .mockResolvedValueOnce(
        ok({
          comments: between.slice(0, 50),
          cursor: "cursor-50",
          more: true,
        }),
      )
      .mockResolvedValueOnce(
        ok({
          comments: [...between.slice(50), ...own],
          cursor: "cursor-52",
          more: false,
        }),
      );
    writeComment.mockResolvedValue(ok(own[0]));
    const onCommented = vi.fn();
    render(
      <PostThread post={post({ id: "post-1" })} onCommented={onCommented} />,
    );
    await screen.findByText("Först 0.");

    await userEvent.type(
      screen.getByRole("textbox", { name: "Din kommentar" }),
      "Mitt svar 52.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Skicka" }));

    await screen.findByText("Mitt svar 52.");
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(
      [...opening, ...between, ...own].map((each) =>
        expect.stringContaining(each.body ?? ""),
      ),
    );
    expect(commentsSince.mock.calls).toEqual([
      [{ postId: "post-1", after: "cursor-0" }],
      [{ postId: "post-1", after: "cursor-50" }],
    ]);
    // Nothing is behind the thread that a press would have to fetch.
    expect(
      screen.queryByRole("button", { name: "Visa tidigare kommentarer" }),
    ).toBeNull();
    expect(readComments).toHaveBeenCalledTimes(1);
    expect(onCommented).toHaveBeenCalledTimes(1);
  });

  it("arrives by poll while the thread is open, without the reader writing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const [opening] = writtenInTurn(0, 1, "Först");
    const [neighbour] = writtenInTurn(1, 1, "Grannen svarar");
    readComments.mockResolvedValue(
      ok({ comments: [opening], earlier: null, latest: "cursor-0" }),
    );
    const onCommented = vi.fn();
    render(
      <PostThread post={post({ id: "post-1" })} onCommented={onCommented} />,
    );
    await screen.findByText("Först 0.");
    expect(commentsSince).not.toHaveBeenCalled();

    commentsSince.mockResolvedValueOnce(
      ok({ comments: [neighbour], cursor: "cursor-1", more: false }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(await screen.findByText("Grannen svarar 1.")).toBeTruthy();
    expect(commentsSince).toHaveBeenCalledWith({
      postId: "post-1",
      after: "cursor-0",
    });
    // The post's count is read again, because it has changed.
    expect(onCommented).toHaveBeenCalledTimes(1);

    // And the next interval goes on from where that one stopped.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(commentsSince).toHaveBeenLastCalledWith({
      postId: "post-1",
      after: "cursor-1",
    });
    expect(onCommented).toHaveBeenCalledTimes(1);
  });

  it("is not asked for while the tab is hidden, and is asked for at once when it is looked at again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    readComments.mockResolvedValue(
      ok({
        comments: writtenInTurn(0, 1, "Först"),
        earlier: null,
        latest: "cursor-0",
      }),
    );
    render(<PostThread post={post({ id: "post-1" })} onCommented={() => {}} />);
    await screen.findByText("Först 0.");

    act(() => {
      setVisibility("hidden");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(commentsSince).not.toHaveBeenCalled();

    commentsSince.mockResolvedValueOnce(
      ok({
        comments: writtenInTurn(1, 1, "Medan du var borta"),
        cursor: "cursor-1",
        more: false,
      }),
    );
    act(() => {
      setVisibility("visible");
    });

    expect(await screen.findByText("Medan du var borta 1.")).toBeTruthy();
    expect(commentsSince).toHaveBeenCalledTimes(1);
  });

  it("reads again after a write that lands while a poll is on its way, from where the poll stopped", async () => {
    /*
     * The poll is mid-read when the reader's comment is stored. Dropping the
     * read after the write would leave their own comment off the thread until
     * the next interval; running it alongside would ask from the cursor the
     * poll is about to move.
     */
    vi.useFakeTimers({ shouldAdvanceTime: true });
    readComments.mockResolvedValue(
      ok({
        comments: writtenInTurn(0, 1, "Först"),
        earlier: null,
        latest: "cursor-0",
      }),
    );
    let answerPoll: (value: unknown) => void = () => {};
    commentsSince.mockReturnValueOnce(
      new Promise((resolve) => {
        answerPoll = resolve;
      }),
    );
    const [own] = writtenInTurn(2, 1, "Mitt svar");
    writeComment.mockResolvedValue(ok(own));
    render(<PostThread post={post({ id: "post-1" })} onCommented={() => {}} />);
    await screen.findByText("Först 0.");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(commentsSince).toHaveBeenCalledTimes(1);

    await userEvent.type(
      screen.getByRole("textbox", { name: "Din kommentar" }),
      "Mitt svar 2.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Skicka" }));
    await waitFor(() => {
      expect(writeComment).toHaveBeenCalled();
    });
    // Not a second read from the same cursor while the first is unanswered.
    expect(commentsSince).toHaveBeenCalledTimes(1);

    commentsSince.mockResolvedValueOnce(
      ok({ comments: [own], cursor: "cursor-2", more: false }),
    );
    await act(async () => {
      answerPoll(
        ok({
          comments: writtenInTurn(1, 1, "Grannen"),
          cursor: "cursor-1",
          more: false,
        }),
      );
    });

    expect(await screen.findByText("Mitt svar 2.")).toBeTruthy();
    expect(screen.getByText("Grannen 1.")).toBeTruthy();
    expect(commentsSince).toHaveBeenLastCalledWith({
      postId: "post-1",
      after: "cursor-1",
    });
  });
});

describe("a thread that could not be read", () => {
  it("says the feed could not be read, not that something could not be saved", async () => {
    readComments.mockResolvedValue(refused(0, "offline"));
    render(<PostThread post={post({ id: "post-1" })} onCommented={() => {}} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Flödet kunde inte läsas just nu.",
    );
    expect(screen.queryByText("Ingen har kommenterat än.")).toBeNull();
  });
});
