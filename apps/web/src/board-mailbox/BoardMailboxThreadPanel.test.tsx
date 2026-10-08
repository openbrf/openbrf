import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { BoardMailboxThread } from "../api/board-mailbox";
import { BoardMailboxThreadPanel } from "./BoardMailboxThreadPanel";

/**
 * Answering a letter while the reply is still being sent.
 *
 * The draft is cleared once the reply is queued, so what is typed in the
 * meantime would be wiped without a word. The panel refuses it instead, and
 * hands focus back when the form opens again. The reply is sent with the
 * button: Enter in the draft is a line break.
 */

const replyToBoardMailboxThread = vi.fn();

vi.mock("../api/board-mailbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/board-mailbox")>()),
  replyToBoardMailboxThread: (input: unknown) =>
    replyToBoardMailboxThread(input),
}));

const THREAD: BoardMailboxThread = {
  id: "thread-1",
  subject: "Fråga om tvättstugan",
  correspondent: { email: "grannen@example.test", name: "Grannen" },
  status: "NEW",
  takenBy: null,
  lastMessageAt: "2026-06-01T09:00:00.000Z",
  messageCount: 1,
  erasableFrom: "2027-06-01T09:00:00.000Z",
  olderCursor: null,
  messages: [],
};

/** Holds the request open, so the panel is observed mid-save. */
function holdRequest(): (outcome: unknown) => void {
  let settle: (outcome: unknown) => void = () => undefined;
  replyToBoardMailboxThread.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  return (outcome) => {
    settle(outcome);
  };
}

beforeEach(() => {
  replyToBoardMailboxThread.mockReset();
});

describe("while a reply is being sent", () => {
  it("locks the draft, so nothing typed is lost when it is cleared", async () => {
    const user = userEvent.setup();
    const settle = holdRequest();
    render(
      <BoardMailboxThreadPanel thread={THREAD} onChanged={() => undefined} />,
    );

    const draft = screen.getByLabelText<HTMLTextAreaElement>("Ditt svar");
    await user.type(draft, "Tack för ditt brev.");
    expect(draft.matches(":disabled")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Skicka svaret" }));

    await waitFor(() => {
      expect(draft.matches(":disabled")).toBe(true);
    });
    await user.type(draft, "9");
    expect(draft.value).toBe("Tack för ditt brev.");

    settle({ ok: true, value: { id: "message-1" } });

    await waitFor(() => {
      expect(draft.matches(":disabled")).toBe(false);
    });
    expect(draft.value).toBe("");
  });

  it("hands focus back to the draft once the reply is queued", async () => {
    const user = userEvent.setup();
    const settle = holdRequest();
    render(
      <BoardMailboxThreadPanel thread={THREAD} onChanged={() => undefined} />,
    );

    const draft = screen.getByLabelText<HTMLTextAreaElement>("Ditt svar");
    await user.type(draft, "Tack för ditt brev.");
    await user.click(screen.getByRole("button", { name: "Skicka svaret" }));
    await waitFor(() => {
      expect(draft.matches(":disabled")).toBe(true);
    });
    // The button the reply was sent with is disabled again, as the draft it
    // sent is gone, so the draft is where the board member goes on.
    const refocus = vi.spyOn(draft, "focus");

    settle({ ok: true, value: { id: "message-1" } });

    // The hand-back runs in an effect after the field is enabled again, so it is
    // awaited together with the enabled state.
    await waitFor(() => {
      expect(draft.matches(":disabled")).toBe(false);
      expect(refocus).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(draft);
    });
  });

  it("hands focus back to the button when the reply is refused", async () => {
    const user = userEvent.setup();
    const settle = holdRequest();
    render(
      <BoardMailboxThreadPanel thread={THREAD} onChanged={() => undefined} />,
    );

    const draft = screen.getByLabelText<HTMLTextAreaElement>("Ditt svar");
    await user.type(draft, "Tack för ditt brev.");
    const send = screen.getByRole("button", { name: "Skicka svaret" });
    await user.click(send);
    await waitFor(() => {
      expect(draft.matches(":disabled")).toBe(true);
    });
    const refocus = vi.spyOn(send, "focus");

    settle({ ok: false, failure: { status: 422, reason: "empty-reply" } });

    // The hand-back runs in an effect after the field is enabled again, so it is
    // awaited together with the enabled state.
    await waitFor(() => {
      expect(draft.matches(":disabled")).toBe(false);
      expect(refocus).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(send);
    });
    // The draft is kept, so the button can be pressed again where it was.
    expect(draft.value).toBe("Tack för ditt brev.");
  });
});
