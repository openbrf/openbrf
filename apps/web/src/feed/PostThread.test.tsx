import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
 * **A refusal keeps the draft**, so a personal identity number can be taken out
 * rather than the comment written again.
 */

const readComments = vi.fn();
const writeComment = vi.fn();
const likeComment = vi.fn();

vi.mock("../api/feed", () => ({
  readComments: (input: unknown) => readComments(input),
  writeComment: (input: unknown) => writeComment(input),
  likeComment: (input: unknown) => likeComment(input),
}));

beforeEach(() => {
  vi.clearAllMocks();
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
        }),
      )
      .mockResolvedValueOnce(
        ok({
          comments: [comment({ id: "comment-1", body: "Äldre." })],
          earlier: null,
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
      }),
    );
    render(<PostThread post={post({ id: "post-1" })} onCommented={() => {}} />);

    expect(await screen.findByText("Struket")).toBeTruthy();
    expect(screen.getByText("Bo Ek")).toBeTruthy();
  });

  it("likes a comment and shows the count the server answered with", async () => {
    readComments.mockResolvedValue(
      ok({ comments: [comment({ id: "comment-1", likes: 1 })], earlier: null }),
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
    readComments.mockResolvedValue(ok({ comments: [], earlier: null }));
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
    readComments.mockResolvedValue(ok({ comments: [], earlier: null }));
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
    readComments.mockResolvedValue(ok({ comments: [], earlier: null }));
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
