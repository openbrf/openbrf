import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import i18n from "../i18n";
import { BOARD, ok, post, refused } from "./feed-fixtures";
import { ScheduledPosts } from "./ScheduledPosts";

/**
 * The board's posts waiting for their instant: each says when it appears,
 * who it is from and what it will do, and changing one to Alla is the news
 * screen's. Each can be cancelled here, after a second press, and leaves the
 * list only once the server has answered that it is gone.
 */

const cancelBoardPost = vi.fn();

vi.mock("../api/feed", () => ({
  cancelBoardPost: (input: unknown) => cancelBoardPost(input),
}));

/** A list nothing is taken off, for the tests that do not cancel. */
const kept = vi.fn();

beforeEach(() => {
  cancelBoardPost.mockReset();
  kept.mockReset();
});

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

describe("the scheduled posts", () => {
  it("say when each appears, from whom, and that it is important", () => {
    render(
      <ScheduledPosts
        onCancelled={kept}
        posts={[
          post({
            id: "post-1",
            byBoard: true,
            author: null,
            body: null,
            important: true,
            scheduledAt: "2030-05-04T08:00:00.000Z",
            news: {
              id: "news-1",
              slug: "staddag",
              title: "Städdag i maj",
              text: "Lördag.",
            },
          }),
        ]}
        showAudience={false}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Schemalagda inlägg" }),
    ).toBeTruthy();
    expect(screen.getByText("Städdag i maj")).toBeTruthy();
    expect(screen.getByText(/^Publiceras 4 maj 2030/u)).toBeTruthy();
    expect(screen.getByText(/Viktigt/u)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Till nyhetssidan" })
        .getAttribute("href"),
    ).toBe("/admin/site/news");
  });

  it("say in English that a post is scheduled, not that it was published", async () => {
    await i18n.changeLanguage("en");
    try {
      render(
        <ScheduledPosts
          onCancelled={kept}
          posts={[
            post({
              id: "post-1",
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
          ]}
          showAudience={false}
        />,
      );
      expect(screen.getByText(/^Scheduled for /u)).toBeTruthy();
      expect(screen.queryByText(/Published/u)).toBeNull();
    } finally {
      await i18n.changeLanguage("sv");
    }
  });

  it("say which audience each is for on the whole feed, and not inside one", () => {
    const toBoard = post({
      id: "post-1",
      audience: { id: BOARD.id, kind: "BOARD", name: null },
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
    const { rerender } = render(
      <ScheduledPosts onCancelled={kept} posts={[toBoard]} showAudience />,
    );
    expect(screen.getByText(/Till Styrelsen/u)).toBeTruthy();

    rerender(
      <ScheduledPosts
        onCancelled={kept}
        posts={[toBoard]}
        showAudience={false}
      />,
    );
    expect(screen.queryByText(/Till Styrelsen/u)).toBeNull();
  });

  it("link to the news screen only while a post to Alla waits there", () => {
    const toBoard = post({
      id: "post-1",
      audience: { id: BOARD.id, kind: "BOARD", name: null },
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
    const toAll = post({
      id: "post-2",
      byBoard: true,
      author: null,
      body: null,
      scheduledAt: "2030-05-05T08:00:00.000Z",
      news: {
        id: "news-2",
        slug: "fest",
        title: "Fest",
        text: "Söndag.",
      },
    });
    const { rerender } = render(
      <ScheduledPosts onCancelled={kept} posts={[toBoard]} showAudience />,
    );
    expect(screen.queryByRole("link", { name: "Till nyhetssidan" })).toBeNull();

    rerender(
      <ScheduledPosts
        onCancelled={kept}
        posts={[toBoard, toAll]}
        showAudience
      />,
    );
    expect(screen.getByRole("link", { name: "Till nyhetssidan" })).toBeTruthy();
  });

  it("cancel a post after a second press, and take it off once the server answers", async () => {
    const user = userEvent.setup();
    cancelBoardPost.mockResolvedValue(ok(undefined));
    const onCancelled = vi.fn();
    render(
      <ScheduledPosts
        onCancelled={onCancelled}
        posts={[
          post({
            id: "post-1",
            audience: { id: BOARD.id, kind: "BOARD", name: null },
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
        ]}
        showAudience={false}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Ta bort det schemalagda inlägget Städdag i maj",
      }),
    );
    // The first press only asks: nothing has been sent.
    expect(cancelBoardPost).not.toHaveBeenCalled();
    expect(screen.getByText(/går inte att ångra/u)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Ta bort inlägget" }));
    expect(cancelBoardPost).toHaveBeenCalledWith({ postId: "post-1" });
    expect(onCancelled).toHaveBeenCalledWith("post-1");
  });

  it("take a post off when another board member withdrew it first", async () => {
    const user = userEvent.setup();
    cancelBoardPost.mockResolvedValue(refused(404, "post-not-found"));
    const onCancelled = vi.fn();
    render(
      <ScheduledPosts
        onCancelled={onCancelled}
        posts={[
          post({
            id: "post-1",
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
        ]}
        showAudience={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Ta bort det/u }));
    await user.click(screen.getByRole("button", { name: "Ta bort inlägget" }));
    await vi.waitFor(() => {
      expect(onCancelled).toHaveBeenCalledWith("post-1");
    });
  });

  it("keep a post the board changed its mind about, and say why one was refused", async () => {
    const user = userEvent.setup();
    cancelBoardPost.mockResolvedValue(refused(422, "not-scheduled"));
    const onCancelled = vi.fn();
    const scheduled = post({
      id: "post-1",
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
    render(
      <ScheduledPosts
        onCancelled={onCancelled}
        posts={[scheduled]}
        showAudience={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Ta bort det/u }));
    await user.click(screen.getByRole("button", { name: "Behåll det" }));
    expect(
      screen.queryByRole("button", { name: "Ta bort inlägget" }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: /Ta bort det/u }));
    await user.click(screen.getByRole("button", { name: "Ta bort inlägget" }));
    expect(
      await screen.findByText(/har redan publicerats och kan inte tas bort/u),
    ).toBeTruthy();
    expect(onCancelled).not.toHaveBeenCalled();
  });
});
