import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type {
  BoardMailboxMessage,
  BoardMailboxThread,
} from "../api/board-mailbox";
import { BoardMailboxThreadPanel } from "./BoardMailboxThreadPanel";

const fetchBoardMailboxThread = vi.fn();

vi.mock("../api/board-mailbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/board-mailbox")>()),
  fetchBoardMailboxThread: (threadId: string, before?: string) =>
    fetchBoardMailboxThread(threadId, before),
}));

function message(id: string, body: string): BoardMailboxMessage {
  return {
    id,
    direction: "INBOUND",
    body,
    bodyFromHtml: false,
    bodyTruncated: false,
    attachmentsDropped: 0,
    occurredAt: "2026-09-20T08:00:00.000Z",
    sentBy: null,
    delivery: null,
    attachments: [],
  };
}

const THREAD: BoardMailboxThread = {
  id: "thread-1",
  subject: "Droppande kran",
  correspondent: { name: "Eva Berg", email: "eva@example.test" },
  status: "NEW",
  takenBy: null,
  lastMessageAt: "2026-09-20T08:00:00.000Z",
  messageCount: 2,
  erasableFrom: "2028-09-20T08:00:00.000Z",
  messages: [message("message-2", "Kranen droppar fortfarande.")],
  olderCursor: "before-2",
};

beforeEach(() => {
  fetchBoardMailboxThread.mockReset();
});

describe("the earlier messages on a thread", () => {
  it("says so when they could not be read, and reads them on the next press", async () => {
    fetchBoardMailboxThread.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    render(<BoardMailboxThreadPanel thread={THREAD} onChanged={() => {}} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Visa tidigare meddelanden" }),
    );

    expect(
      await screen.findByText(
        "De tidigare meddelandena kunde inte läsas just nu. Försök igen.",
      ),
    ).not.toBeNull();
    expect(fetchBoardMailboxThread).toHaveBeenLastCalledWith(
      "thread-1",
      "before-2",
    );

    fetchBoardMailboxThread.mockResolvedValueOnce({
      ok: true,
      value: {
        ...THREAD,
        messages: [message("message-1", "Kranen i köket droppar.")],
        olderCursor: null,
      },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Visa tidigare meddelanden" }),
    );

    await screen.findByText("Kranen i köket droppar.");
    expect(
      screen.queryByText(
        "De tidigare meddelandena kunde inte läsas just nu. Försök igen.",
      ),
    ).toBeNull();
  });
});
