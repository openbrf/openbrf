import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { BoardMailboxStatus } from "../api/board-mailbox";
import { BoardMailboxScreen } from "./BoardMailboxScreen";

/**
 * The letters the collection set aside.
 *
 * A letter the collector read and would not store is in no thread, so this
 * screen is the only place the board can learn it is there. What it is shown is
 * the reason and the letter's own date, which is what finds it in a mail client.
 */

const fetchBoardMailboxStatus = vi.fn();

vi.mock("../api/board-mailbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/board-mailbox")>()),
  fetchBoardMailboxStatus: () => fetchBoardMailboxStatus(),
  fetchBoardMailboxThreads: () =>
    Promise.resolve({ ok: true, value: { threads: [], nextCursor: null } }),
}));

const STATUS: BoardMailboxStatus = {
  configured: true,
  address: "styrelsen@example.test",
  setAside: [],
  setAsideCount: 0,
};

beforeEach(() => {
  fetchBoardMailboxStatus.mockReset();
});

describe("BoardMailboxScreen", () => {
  it("lists the letters the collection set aside, and says where they are", async () => {
    fetchBoardMailboxStatus.mockResolvedValue({
      ok: true,
      value: {
        ...STATUS,
        setAside: [
          {
            reason: "unstorable",
            letterDate: "2026-09-01T07:15:00.000Z",
            setAsideAt: "2026-09-02T10:00:00.000Z",
          },
          {
            reason: "no-sender-address",
            letterDate: null,
            setAsideAt: "2026-09-01T10:00:00.000Z",
          },
        ],
        setAsideCount: 3,
      },
    });

    render(<BoardMailboxScreen />);

    expect(
      await screen.findByText(
        "3 brev kunde inte hämtas. De ligger kvar i brevlådan: öppna dem där med ett e-postprogram.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Kunde inte sparas")).toBeTruthy();
    expect(
      screen.getByText("Ingen avsändaradress att svara till"),
    ).toBeTruthy();
    // The letter's own date, in the association's zone, to the minute.
    expect(screen.getByText(/^Daterat .*09:15/)).toBeTruthy();
    expect(
      screen.getByText("Inget datum som hämtningen kunde lita på"),
    ).toBeTruthy();
    expect(screen.getByText("Och ett till.")).toBeTruthy();
  });

  it("says nothing about set-aside letters when there are none", async () => {
    fetchBoardMailboxStatus.mockResolvedValue({ ok: true, value: STATUS });

    render(<BoardMailboxScreen />);

    expect(await screen.findByText("Hämta nu")).toBeTruthy();
    expect(screen.queryByText(/kunde inte hämtas/)).toBeNull();
  });
});
