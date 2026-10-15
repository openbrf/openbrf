import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  correspondent: {
    email: "grannen@example.test",
    name: "Grannen",
    domain: null,
  },
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

describe("a sender whose domain is not plain ASCII", () => {
  it("warns about a lookalike domain and shows where a reply goes", () => {
    // The first letter of the domain is Cyrillic U+0435, not Latin "e".
    render(
      <BoardMailboxThreadPanel
        thread={{
          ...THREAD,
          correspondent: {
            email: "kalle@еxample.test",
            name: "Kalle",
            domain: { ascii: "xn--xample-2of.test", mixedScript: true },
          },
        }}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText(/xn--xample-2of\.test/)).toBeTruthy();
    expect(screen.getByText(/Se noga efter/)).toBeTruthy();
  });

  it("shows the punycode of a legitimate international domain without a warning", () => {
    render(
      <BoardMailboxThreadPanel
        thread={{
          ...THREAD,
          correspondent: {
            email: "anna@münchen.de",
            name: "Anna",
            domain: { ascii: "xn--mnchen-3ya.de", mixedScript: false },
          },
        }}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText(/xn--mnchen-3ya\.de/)).toBeTruthy();
    expect(screen.queryByText(/Se noga efter/)).toBeNull();
  });

  it("warns, and names no reply destination, when the domain cannot be converted", () => {
    render(
      <BoardMailboxThreadPanel
        thread={{
          ...THREAD,
          correspondent: {
            email: "kalle@еxample.test",
            name: "Kalle",
            domain: { ascii: null, mixedScript: false },
          },
        }}
        onChanged={() => undefined}
      />,
    );

    const warning = screen.getByText(/kan inte omvandlas/);
    // The notice carries its tone as the word beside the message, not only as
    // a colour.
    expect(
      within(warning.parentElement as HTMLElement).getByText("Observera"),
    ).toBeTruthy();
    expect(screen.queryByText(/xn--/)).toBeNull();
    expect(screen.queryByText(/Ett svar går till/)).toBeNull();
    // Nor does the reply form print the address as where the answer goes.
    expect(screen.queryByText(/Går till/)).toBeNull();
  });

  it("still says where a reply goes for a domain that can be converted", () => {
    render(
      <BoardMailboxThreadPanel
        thread={{
          ...THREAD,
          correspondent: {
            email: "anna@münchen.de",
            name: "Anna",
            domain: { ascii: "xn--mnchen-3ya.de", mixedScript: false },
          },
        }}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText(/Går till anna@münchen\.de/)).toBeTruthy();
  });

  it("says nothing about an ASCII domain", () => {
    render(
      <BoardMailboxThreadPanel thread={THREAD} onChanged={() => undefined} />,
    );

    expect(screen.queryByText(/Avsändarens domän/)).toBeNull();
  });
});
