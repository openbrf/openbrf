import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { comment, ok, post, refused, viewer } from "./feed-fixtures";
import { PostScreen } from "./PostScreen";

/**
 * One post at its own address.
 *
 * **It opens with its comments.** Somebody who followed a link to a post came
 * for the post and what was said under it.
 *
 * **A post the reader may not read is the same refusal as one that does not
 * exist**, so an address pasted to somebody outside a group tells them nothing.
 */

const fetchPost = vi.fn();
const readComments = vi.fn();
const fetchAudiences = vi.fn();

vi.mock("../api/feed", () => ({
  fetchPost: (input: unknown) => fetchPost(input),
  fetchAudiences: () => fetchAudiences(),
  pinPost: vi.fn(),
  readComments: (input: unknown) => readComments(input),
  writeComment: vi.fn(),
  likeComment: vi.fn(),
  likePost: vi.fn(),
  markPostRead: vi.fn(),
  reportPost: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
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

beforeEach(() => {
  vi.clearAllMocks();
  fetchAudiences.mockResolvedValue(
    ok({ audiences: [], mayCreateGroup: false, mayPostAsBoard: false }),
  );
  readComments.mockResolvedValue(
    ok({
      comments: [comment({ id: "comment-1", body: "Bra!" })],
      earlier: null,
    }),
  );
});

describe("a post's own page", () => {
  it("shows the post with its comments open, and the way back", async () => {
    fetchPost.mockResolvedValue(
      ok(post({ id: "post-1", body: "Städdag på lördag.", comments: 1 })),
    );
    render(<PostScreen viewer={viewer()} postId="post-1" />);

    expect(await screen.findByText("Städdag på lördag.")).toBeTruthy();
    expect(await screen.findByText("Bra!")).toBeTruthy();
    expect(fetchPost).toHaveBeenCalledWith({ postId: "post-1" });
    expect(
      screen
        .getByRole("link", { name: "Tillbaka till flödet" })
        .getAttribute("href"),
    ).toBe("/feed");
  });

  it("does not link the post to the page it is already on", async () => {
    fetchPost.mockResolvedValue(ok(post({ id: "post-1" })));
    render(<PostScreen viewer={viewer()} postId="post-1" />);

    await screen.findByText("Tvättstugan är stängd på torsdag.");
    expect(
      screen.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toEqual(["/feed"]);
  });

  it("refuses a post the reader may not read exactly as one that does not exist", async () => {
    fetchPost.mockResolvedValue(refused(404, "post-not-found"));
    render(<PostScreen viewer={viewer()} postId="post-in-a-group" />);

    expect(
      await screen.findByText(
        "Det inlägget finns inte, eller är inte ditt att läsa.",
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(readComments).not.toHaveBeenCalled();
    });
  });
});
