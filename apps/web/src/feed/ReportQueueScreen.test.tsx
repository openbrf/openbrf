import { render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { ok } from "./feed-fixtures";
import { ReportQueueScreen } from "./ReportQueueScreen";

/**
 * The board's page for reported posts: the queue, signed on its heading.
 *
 * The queue itself is `ReportQueue.test.tsx`. What is asserted here is the
 * page around it, and the read behind it: a report out of a group is the only
 * way anybody outside the group reads a word of what was said there, so a page
 * that asked for the queue on a resident's behalf would be asking the server
 * for exactly that with nowhere to put it (ADR 0049).
 */

const fetchReports = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }): ReactElement => (
    <a href="/">{children}</a>
  ),
}));

vi.mock("../api/feed", () => ({
  fetchReports: (input: unknown) => fetchReports(input),
  strikeReport: vi.fn(),
  dismissReport: vi.fn(),
}));

function viewer(capabilities: readonly string[]): Viewer {
  return {
    personId: "person-maja",
    firstName: "Maja",
    lastName: "Lind",
    preferredLocale: "sv",
    capabilities: [...capabilities],
    housingCooperative: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchReports.mockResolvedValue(
    ok({ reports: [], next: null, mayModerate: true }),
  );
});

describe("the page for whoever moderates", () => {
  it("is the board's page, signed on its heading, with the queue", async () => {
    render(<ReportQueueScreen viewer={viewer(["chat:moderate"])} />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Styrelsen Granska anmälda inlägg",
      }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Anmälda inlägg" }),
    ).toBeTruthy();
    expect(fetchReports).toHaveBeenCalled();
  });
});

describe("the page for anybody else", () => {
  it("says the page is the board's, with no sign and no read of the queue", () => {
    render(<ReportQueueScreen viewer={viewer(["chat:participate"])} />);

    expect(
      screen.getByText(
        "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(fetchReports).not.toHaveBeenCalled();
  });
});
