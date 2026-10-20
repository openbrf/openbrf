import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import i18n from "../i18n";
import { BOARD, post } from "./feed-fixtures";
import { ScheduledPosts } from "./ScheduledPosts";

/**
 * The board's posts waiting for their instant: each says when it appears,
 * who it is from and what it will do, and changing one is the news screen's.
 */

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
      <ScheduledPosts posts={[toBoard]} showAudience />,
    );
    expect(screen.getByText(/Till Styrelsen/u)).toBeTruthy();

    rerender(<ScheduledPosts posts={[toBoard]} showAudience={false} />);
    expect(screen.queryByText(/Till Styrelsen/u)).toBeNull();
  });
});
