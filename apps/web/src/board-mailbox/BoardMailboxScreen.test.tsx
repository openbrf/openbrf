import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
const collectBoardMailbox = vi.fn();

vi.mock("../api/board-mailbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/board-mailbox")>()),
  fetchBoardMailboxStatus: () => fetchBoardMailboxStatus(),
  collectBoardMailbox: () => collectBoardMailbox(),
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
  collectBoardMailbox.mockReset();
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
            retryAt: "2026-09-02T16:00:00.000Z",
          },
          {
            reason: "no-sender-address",
            letterDate: null,
            setAsideAt: "2026-09-01T10:00:00.000Z",
            retryAt: null,
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
    expect(screen.getByText("Datum okänt")).toBeTruthy();
    // A letter set aside for failing is tried again, and the board is told
    // when; one refused for good carries no such line.
    expect(screen.getAllByText(/^prövas igen från .*18:00/)).toHaveLength(1);
    expect(screen.getByText("Och ett till.")).toBeTruthy();
  });

  it("says nothing about set-aside letters when there are none", async () => {
    fetchBoardMailboxStatus.mockResolvedValue({ ok: true, value: STATUS });

    render(<BoardMailboxScreen />);

    expect(await screen.findByText("Hämta nu")).toBeTruthy();
    expect(screen.queryByText(/kunde inte hämtas/)).toBeNull();
  });

  it("says why a mailbox on a private network is not collected", async () => {
    // A server saved before such hosts were refused, or a name that has since
    // moved to one. The remedy is not the port or the password, so the board
    // is not sent to check them.
    fetchBoardMailboxStatus.mockResolvedValue({ ok: true, value: STATUS });
    collectBoardMailbox.mockResolvedValue({
      ok: false,
      failure: { status: 502, reason: "host-not-public" },
    });
    const session = userEvent.setup();
    render(<BoardMailboxScreen />);

    await session.click(
      await screen.findByRole("button", { name: "Hämta nu" }),
    );

    expect(
      await screen.findByText(
        /^Den här instansen kan inte ansluta till brevlådans server: den hittades inte, eller så finns den på ett privat nätverk\./,
      ),
    ).toBeTruthy();
  });
});
