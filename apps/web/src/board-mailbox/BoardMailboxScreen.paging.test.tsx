import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { BoardMailboxThreadSummary } from "../api/board-mailbox";
import { BoardMailboxScreen } from "./BoardMailboxScreen";

/**
 * The inbox read a page at a time.
 *
 * The server sorts the inbox by status and last message but pages it by an
 * identifier cursor, so a thread that changes between two page reads can be on
 * both pages. And a page that does not answer has to be said, or the button
 * going back to its idle label reads as "there was nothing more".
 */

const fetchBoardMailboxStatus = vi.fn();
const fetchBoardMailboxThreads = vi.fn();

vi.mock("../api/board-mailbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/board-mailbox")>()),
  fetchBoardMailboxStatus: () => fetchBoardMailboxStatus(),
  fetchBoardMailboxThreads: (cursor?: string) =>
    fetchBoardMailboxThreads(cursor),
}));

function summary(id: string, subject: string): BoardMailboxThreadSummary {
  return {
    id,
    subject,
    correspondent: { name: "Eva Berg", email: "eva@example.test" },
    status: "NEW",
    takenBy: null,
    lastMessageAt: "2026-09-20T08:00:00.000Z",
    messageCount: 1,
    erasableFrom: "2028-09-20T08:00:00.000Z",
  };
}

const LEAKING_TAP = summary("thread-1", "Droppande kran");
const NOISY_NEIGHBOUR = summary("thread-2", "Störande granne");
const BIKE_ROOM = summary("thread-3", "Cykelrummet");

beforeEach(() => {
  fetchBoardMailboxStatus.mockReset().mockResolvedValue({
    ok: true,
    value: { configured: true, address: "styrelsen@example.test" },
  });
  fetchBoardMailboxThreads.mockReset().mockResolvedValue({
    ok: true,
    value: { threads: [LEAKING_TAP, NOISY_NEIGHBOUR], nextCursor: "page-2" },
  });
});

async function inbox(): Promise<HTMLElement> {
  await screen.findByText("Droppande kran");
  const list = screen.getByRole("list");
  return list;
}

describe("the older threads", () => {
  it("lists a thread that is on two pages once", async () => {
    render(<BoardMailboxScreen />);
    await inbox();

    // The second thread moved between the two reads and is answered again.
    fetchBoardMailboxThreads.mockResolvedValueOnce({
      ok: true,
      value: { threads: [NOISY_NEIGHBOUR, BIKE_ROOM], nextCursor: null },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Visa äldre trådar" }),
    );

    await screen.findByText("Cykelrummet");
    expect(fetchBoardMailboxThreads).toHaveBeenLastCalledWith("page-2");
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Droppande kran"),
      expect.stringContaining("Störande granne"),
      expect.stringContaining("Cykelrummet"),
    ]);
  });

  it("says so when they could not be read, and reads them on the next press", async () => {
    render(<BoardMailboxScreen />);
    await inbox();

    fetchBoardMailboxThreads.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Visa äldre trådar" }),
    );

    expect(
      await screen.findByText(
        "De äldre trådarna kunde inte läsas just nu. Försök igen.",
      ),
    ).not.toBeNull();

    fetchBoardMailboxThreads.mockResolvedValueOnce({
      ok: true,
      value: { threads: [BIKE_ROOM], nextCursor: null },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Visa äldre trådar" }),
    );

    await screen.findByText("Cykelrummet");
    expect(
      screen.queryByText(
        "De äldre trådarna kunde inte läsas just nu. Försök igen.",
      ),
    ).toBeNull();
  });
});
