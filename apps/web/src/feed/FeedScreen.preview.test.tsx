import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import type { AudienceView, FeedPage } from "@openbrf/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import {
  forgetResidentPreview,
  setResidentPreview,
} from "../api/viewer-preview";
import { ALL, BOARD, GARDEN, ok, post, viewer } from "./feed-fixtures";
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
  news: { id: "news-1", slug: "staddag", title: "Städdag i maj", text: "Lördag." },
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
    expect(screen.getByRole("button", { name: /Trädgårdsgruppen/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Styrelsen/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Administratörer/ })).toBeNull();
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
    const { unmount } = render(<FeedScreen viewer={viewer(["chat:participate"])} />);
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
