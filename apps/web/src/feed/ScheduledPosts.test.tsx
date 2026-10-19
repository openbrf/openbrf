import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { post } from "./feed-fixtures";
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
      />,
    );

    expect(screen.getByText("Städdag i maj")).toBeTruthy();
    expect(screen.getByText(/^Publiceras 4 maj 2030/u)).toBeTruthy();
    expect(screen.getByText(/Viktigt/u)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Till nyhetssidan" })
        .getAttribute("href"),
    ).toBe("/admin/site/news");
  });
});
