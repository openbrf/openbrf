import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { OwnIssue, OwnIssueMessage } from "../api/issues";
import { OwnIssueConversation } from "./OwnIssueConversation";

/**
 * The conversation on one's own report (decisions 18 and 19).
 *
 * A handler's message reads as the board's or the property manager's and never
 * as a person's; the reporter's own as theirs. Nothing is read until the
 * conversation is opened, and a closed report offers no field to write in.
 */

const fetchOwnIssueMessages = vi.fn();
const sendOwnIssueMessage = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchOwnIssueMessages: (id: string) => fetchOwnIssueMessages(id),
  sendOwnIssueMessage: (input: unknown) => sendOwnIssueMessage(input),
}));

function own(overrides: Partial<OwnIssue> = {}): OwnIssue {
  return {
    id: "issue-1",
    meaning: "IN_PROGRESS",
    typeId: "type-water",
    typeName: "Vatten",
    location: null,
    description: "Det droppar i taket.",
    apartment: null,
    photos: [],
    enteredByHandler: false,
    replyMode: "MESSAGE",
    mergedIntoMeaning: null,
    descriptionRedactedAt: null,
    locationRedactedAt: null,
    freeTextRemovedAt: null,
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T08:00:00.000Z",
    ...overrides,
  };
}

const THREAD: OwnIssueMessage[] = [
  {
    id: "m-1",
    side: "REPORTER",
    body: "Kommer någon i dag?",
    redactedAt: null,
    createdAt: "2026-08-20T09:00:00.000Z",
  },
  {
    id: "m-2",
    side: "HANDLER",
    signature: "PROPERTY_MANAGER",
    body: "I eftermiddag.",
    redactedAt: null,
    createdAt: "2026-08-20T10:00:00.000Z",
  },
  {
    id: "m-3",
    side: "HANDLER",
    signature: "BOARD",
    body: "Vi har bokat rörmokaren.",
    redactedAt: null,
    createdAt: "2026-08-20T11:00:00.000Z",
  },
];

async function openConversation(
  session: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await session.click(screen.getByText("Meddelanden om Vatten"));
}

beforeEach(() => {
  fetchOwnIssueMessages
    .mockReset()
    .mockResolvedValue({ ok: true, value: THREAD });
  sendOwnIssueMessage
    .mockReset()
    .mockResolvedValue({ ok: true, value: THREAD[0] });
});

describe("the reporter's conversation", () => {
  it("reads nothing until opened, then signs the handlers' messages with a role", async () => {
    const session = userEvent.setup();
    render(
      <OwnIssueConversation
        issue={own()}
        onChanged={() => undefined}
        onFollowUp={() => undefined}
      />,
    );

    expect(fetchOwnIssueMessages).not.toHaveBeenCalled();
    await openConversation(session);

    expect(await screen.findByText("Kommer någon i dag?")).toBeTruthy();
    expect(screen.getByText("Du")).toBeTruthy();
    expect(screen.getByText("Förvaltaren")).toBeTruthy();
    expect(screen.getByText("Styrelsen")).toBeTruthy();
  });

  it("shows a message a handler removed as removed, with the date, and not as blank", async () => {
    fetchOwnIssueMessages.mockResolvedValue({
      ok: true,
      value: [
        THREAD[0],
        {
          id: "m-4",
          side: "HANDLER",
          signature: "BOARD",
          body: "",
          redactedAt: "2026-10-01T09:00:00.000Z",
          createdAt: "2026-08-20T12:00:00.000Z",
        },
      ],
    });
    const session = userEvent.setup();
    render(
      <OwnIssueConversation
        issue={own()}
        onChanged={() => undefined}
        onFollowUp={() => undefined}
      />,
    );
    await openConversation(session);

    await screen.findByText("Kommer någon i dag?");
    expect(screen.getByText(/Borttaget av en handläggare/)).toBeTruthy();
    expect(screen.getByText("2026-10-01")).toBeTruthy();
  });

  it("sends a message and reads the conversation again", async () => {
    const session = userEvent.setup();
    render(
      <OwnIssueConversation
        issue={own()}
        onChanged={() => undefined}
        onFollowUp={() => undefined}
      />,
    );
    await openConversation(session);

    const field = await screen.findByLabelText("Vatten: ditt meddelande");
    await session.type(field, "Tack!");
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    await waitFor(() => {
      expect(sendOwnIssueMessage).toHaveBeenCalledWith({
        issueId: "issue-1",
        body: "Tack!",
      });
    });
    await waitFor(() => {
      expect(fetchOwnIssueMessages).toHaveBeenCalledTimes(2);
    });
    expect((field as HTMLTextAreaElement).value).toBe("");
  });

  it("does not offer to send a message without words", async () => {
    const session = userEvent.setup();
    render(
      <OwnIssueConversation
        issue={own()}
        onChanged={() => undefined}
        onFollowUp={() => undefined}
      />,
    );
    await openConversation(session);

    await session.type(
      await screen.findByLabelText("Vatten: ditt meddelande"),
      "   ",
    );
    expect(
      (screen.getByRole("button", { name: "Skicka" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("offers a new report instead of a field on a report closed too long ago", async () => {
    const onFollowUp = vi.fn();
    const session = userEvent.setup();
    render(
      <OwnIssueConversation
        issue={own({ meaning: "DONE", replyMode: "NEW_REPORT" })}
        onChanged={() => undefined}
        onFollowUp={onFollowUp}
      />,
    );
    await openConversation(session);

    expect(
      await screen.findByText(
        "Anmälan är avslutad och tar inte emot fler meddelanden.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Vatten: ditt meddelande")).toBeNull();
    await session.click(
      screen.getByRole("button", { name: "Gör en ny anmälan om detta" }),
    );
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(onFollowUp).toHaveBeenCalledWith("");
  });

  it("hands the reply the server refused as closed to the new report", async () => {
    sendOwnIssueMessage.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "issue-closed" },
    });
    const onFollowUp = vi.fn();
    const session = userEvent.setup();
    const { rerender } = render(
      <OwnIssueConversation
        issue={own()}
        onChanged={() => undefined}
        onFollowUp={onFollowUp}
      />,
    );
    await openConversation(session);
    await session.type(
      await screen.findByLabelText("Vatten: ditt meddelande"),
      "Det läcker igen",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));
    await screen.findByText(/Anmälan avslutades medan du skrev/);

    // The list is read again and says the window has passed: the field gives
    // way to the button, and the text goes on with it.
    rerender(
      <OwnIssueConversation
        issue={own({ meaning: "DONE", replyMode: "NEW_REPORT" })}
        onChanged={() => undefined}
        onFollowUp={onFollowUp}
      />,
    );
    await session.click(
      await screen.findByRole("button", { name: "Gör en ny anmälan om detta" }),
    );
    expect(onFollowUp).toHaveBeenCalledWith("Det läcker igen");
  });

  it("keeps the refused reply when the conversation is collapsed and opened again", async () => {
    sendOwnIssueMessage.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "issue-closed" },
    });
    const onFollowUp = vi.fn();
    const session = userEvent.setup();
    const { rerender } = render(
      <OwnIssueConversation
        issue={own()}
        onChanged={() => undefined}
        onFollowUp={onFollowUp}
      />,
    );
    await openConversation(session);
    await session.type(
      await screen.findByLabelText("Vatten: ditt meddelande"),
      "Det läcker igen",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));
    await screen.findByText(/Anmälan avslutades medan du skrev/);
    rerender(
      <OwnIssueConversation
        issue={own({ meaning: "DONE", replyMode: "NEW_REPORT" })}
        onChanged={() => undefined}
        onFollowUp={onFollowUp}
      />,
    );

    // Collapsing unmounts the thread; opening it again must not lose the text.
    await session.click(screen.getByText("Meddelanden om Vatten"));
    await session.click(screen.getByText("Meddelanden om Vatten"));
    await session.click(
      await screen.findByRole("button", { name: "Gör en ny anmälan om detta" }),
    );
    expect(onFollowUp).toHaveBeenCalledWith("Det läcker igen");
  });

  it("says a merged report is handled with another, and offers a new report", async () => {
    const session = userEvent.setup();
    render(
      <OwnIssueConversation
        issue={own({
          meaning: "DONE",
          replyMode: "NEW_REPORT",
          mergedIntoMeaning: "IN_PROGRESS",
        })}
        onChanged={() => undefined}
        onFollowUp={() => undefined}
      />,
    );
    await openConversation(session);

    expect(
      await screen.findByText(/har slagits samman med en annan anmälan/),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Vatten: ditt meddelande")).toBeNull();
  });

  it("says a reply reopens a report closed within the window, and reads the list again once sent", async () => {
    const onChanged = vi.fn();
    const session = userEvent.setup();
    render(
      <OwnIssueConversation
        issue={own({ meaning: "DONE", replyMode: "REOPENS" })}
        onChanged={onChanged}
        onFollowUp={() => undefined}
      />,
    );
    await openConversation(session);

    expect(await screen.findByText(/öppnas den igen/)).toBeTruthy();
    await session.type(
      await screen.findByLabelText("Vatten: ditt meddelande"),
      "Det läcker igen",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });

  it("reads the list again after a message sent to a report on screen as open", async () => {
    // The report may have closed while the screen was open, in which case the
    // server reopens it on this very send, and the list must say so.
    const onChanged = vi.fn();
    const session = userEvent.setup();
    render(
      <OwnIssueConversation
        issue={own({ replyMode: "MESSAGE" })}
        onChanged={onChanged}
        onFollowUp={() => undefined}
      />,
    );
    await openConversation(session);

    await session.type(
      await screen.findByLabelText("Vatten: ditt meddelande"),
      "Det läcker igen",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });

  it("says when a report closed while the message was written", async () => {
    sendOwnIssueMessage.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "issue-closed" },
    });
    const session = userEvent.setup();
    render(
      <OwnIssueConversation
        issue={own()}
        onChanged={() => undefined}
        onFollowUp={() => undefined}
      />,
    );
    await openConversation(session);

    await session.type(
      await screen.findByLabelText("Vatten: ditt meddelande"),
      "Det läcker igen",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    expect(
      await screen.findByText(
        "Anmälan avslutades medan du skrev. Ditt meddelande skickades inte.",
      ),
    ).toBeTruthy();
  });

  it("tells the list when the server says the report is closed", async () => {
    sendOwnIssueMessage.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "issue-closed" },
    });
    const onChanged = vi.fn();
    const session = userEvent.setup();
    render(
      <OwnIssueConversation
        issue={own()}
        onChanged={onChanged}
        onFollowUp={() => undefined}
      />,
    );
    await openConversation(session);

    await session.type(
      await screen.findByLabelText("Vatten: ditt meddelande"),
      "Det läcker igen",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });
});
