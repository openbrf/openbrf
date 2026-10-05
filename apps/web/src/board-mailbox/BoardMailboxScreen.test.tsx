import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type {
  BoardMailboxStatus,
  BoardMailboxThread,
  BoardMailboxThreadSummary,
} from "../api/board-mailbox";
import { BoardMailboxScreen } from "./BoardMailboxScreen";

/**
 * The letters the collection set aside.
 *
 * A letter the collector read and would not store is in no thread, so this
 * screen is the only place the board can learn it is there. What it is shown is
 * the reason and the letter's own date, which is what finds it in a mail client.
 */

const fetchBoardMailboxStatus = vi.fn();
const fetchBoardMailboxThreads = vi.fn();
const fetchBoardMailboxThread = vi.fn();

vi.mock("../api/board-mailbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/board-mailbox")>()),
  fetchBoardMailboxStatus: () => fetchBoardMailboxStatus(),
  fetchBoardMailboxThreads: (after?: string) => fetchBoardMailboxThreads(after),
  fetchBoardMailboxThread: (id: string) => fetchBoardMailboxThread(id),
}));

const STATUS: BoardMailboxStatus = {
  configured: true,
  address: "styrelsen@example.test",
  setAside: [],
  setAsideCount: 0,
};

function summary(id: string, subject: string): BoardMailboxThreadSummary {
  return {
    id,
    subject,
    correspondent: { email: `${id}@example.test`, name: null },
    status: "NEW",
    takenBy: null,
    lastMessageAt: "2026-09-01T07:15:00.000Z",
    messageCount: 1,
    erasableFrom: "2028-09-01",
  };
}

function opened(row: BoardMailboxThreadSummary): BoardMailboxThread {
  return { ...row, messages: [], olderCursor: null };
}

const WATER = summary("thread-water", "Vattenläcka i källaren");
const BIKES = summary("thread-bikes", "Cyklar i trapphuset");

beforeEach(() => {
  fetchBoardMailboxStatus.mockReset();
  fetchBoardMailboxThreads
    .mockReset()
    .mockResolvedValue({ ok: true, value: { threads: [], nextCursor: null } });
  fetchBoardMailboxThread.mockReset().mockImplementation((id: string) =>
    Promise.resolve({
      ok: true,
      value: opened(id === WATER.id ? WATER : BIKES),
    }),
  );
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

  it("keeps the pages read past the first when a thread on one is opened", async () => {
    /*
     * Opening a thread reads that thread. Reading the inbox again from its
     * start would drop the page the thread was opened from, and the thread
     * with it.
     */
    fetchBoardMailboxStatus.mockResolvedValue({ ok: true, value: STATUS });
    fetchBoardMailboxThreads.mockImplementation((after?: string) =>
      Promise.resolve({
        ok: true,
        value:
          after === undefined
            ? { threads: [WATER], more: true, nextCursor: "after-water" }
            : { threads: [BIKES], more: false, nextCursor: null },
      }),
    );
    render(<BoardMailboxScreen />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Visa äldre trådar" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Cyklar i trapphuset/ }),
    );

    await waitFor(() => {
      expect(fetchBoardMailboxThread).toHaveBeenCalledWith(BIKES.id);
    });
    expect(await screen.findByLabelText("Ditt svar")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Cyklar i trapphuset/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(fetchBoardMailboxThreads).toHaveBeenCalledTimes(2);
  });

  it("never carries a reply typed for one thread into the next", async () => {
    // The reply is sent to the open thread's correspondent, whoever it was
    // typed for.
    fetchBoardMailboxStatus.mockResolvedValue({ ok: true, value: STATUS });
    fetchBoardMailboxThreads.mockResolvedValue({
      ok: true,
      value: { threads: [WATER, BIKES], more: false, nextCursor: null },
    });
    render(<BoardMailboxScreen />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Vattenläcka i källaren/ }),
    );
    await userEvent.type(
      await screen.findByLabelText("Ditt svar"),
      "Vi skickar en rörmokare.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Cyklar i trapphuset/ }),
    );
    await waitFor(() => {
      expect(fetchBoardMailboxThread).toHaveBeenCalledWith(BIKES.id);
    });

    expect(
      ((await screen.findByLabelText("Ditt svar")) as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });
});
