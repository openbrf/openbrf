import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { IssueMessage, IssueNote, QueuedIssue } from "../api/issues";
import { IssueConversation } from "./IssueConversation";

/**
 * The conversation on an issue as a handler works it (decision 18).
 *
 * The cases worth having: a handler's message is shown with who wrote it and
 * the role the reporter reads it under, a protected handler is not named, a
 * saved reply fills the field without sending anything, a refusal keeps the
 * words, and an issue nobody can read an answer on offers no field to write
 * one in.
 */

const fetchIssueMessages = vi.fn();
const fetchIssueNotes = vi.fn();
const fetchIssueAttachments = vi.fn();
const fetchIssueSavedReplies = vi.fn();
const sendIssueMessage = vi.fn();
const addIssueNote = vi.fn();
const attachIssueFile = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueMessages: (id: string) => fetchIssueMessages(id),
  fetchIssueNotes: (id: string) => fetchIssueNotes(id),
  fetchIssueAttachments: (id: string) => fetchIssueAttachments(id),
  fetchIssueSavedReplies: () => fetchIssueSavedReplies(),
  sendIssueMessage: (input: unknown) => sendIssueMessage(input),
  addIssueNote: (input: unknown) => addIssueNote(input),
  attachIssueFile: (input: unknown) => attachIssueFile(input),
}));

function issue(overrides: Partial<QueuedIssue> = {}): QueuedIssue {
  return {
    id: "issue-1",
    meaning: "NEW",
    status: { id: "s-new", label: "Ny" },
    waitingReason: null,
    outcome: null,
    typeReporters: ["RESIDENTS"],
    closedAt: null,
    typeId: "type-water",
    typeName: "Vatten",
    location: null,
    description: "Det droppar i taket.",
    apartment: { id: "a-1", number: "1401", address: "Storgatan 12" },
    photos: [],
    reporter: { kind: "resident", personId: "p-1", name: "Rune Boende" },
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T08:00:00.000Z",
    enteredByHandler: false,
    typeHandledBy: "EVERY_HANDLER",
    priority: "NORMAL",
    targetDate: null,
    overdue: false,
    assignee: null,
    enteredBy: null,
    boardOnly: false,
    ...overrides,
  } as QueuedIssue;
}

const THREAD: IssueMessage[] = [
  {
    id: "m-1",
    side: "REPORTER",
    body: "Kommer någon i dag?",
    createdAt: "2026-08-20T09:00:00.000Z",
  },
  {
    id: "m-2",
    side: "HANDLER",
    signature: "PROPERTY_MANAGER",
    author: { kind: "person", personId: "p-manager", name: "Frida Förvaltare" },
    body: "I eftermiddag.",
    createdAt: "2026-08-20T10:00:00.000Z",
  },
  {
    id: "m-3",
    side: "HANDLER",
    signature: "BOARD",
    author: { kind: "protected", personId: "p-shielded" },
    body: "Vi har bokat rörmokaren.",
    createdAt: "2026-08-20T11:00:00.000Z",
  },
];

const NOTES: IssueNote[] = [
  {
    id: "n-1",
    author: { kind: "person", personId: "p-board", name: "Bea Styrelse" },
    body: "Grannen har klagat förut.",
    createdAt: "2026-08-20T12:00:00.000Z",
  },
];

beforeEach(() => {
  fetchIssueMessages.mockReset().mockResolvedValue({ ok: true, value: THREAD });
  fetchIssueNotes.mockReset().mockResolvedValue({ ok: true, value: NOTES });
  fetchIssueAttachments.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchIssueSavedReplies.mockReset().mockResolvedValue({
    ok: true,
    value: [
      {
        id: "r-1",
        title: "Ditt ansvar enligt stadgarna",
        body: "Enligt stadgarna är det ditt ansvar.",
        sortOrder: 0,
      },
    ],
  });
  sendIssueMessage
    .mockReset()
    .mockResolvedValue({ ok: true, value: THREAD[1] });
  addIssueNote.mockReset().mockResolvedValue({ ok: true, value: NOTES[0] });
  attachIssueFile.mockReset();
});

describe("the conversation with the reporter", () => {
  it("names each handler and the role the reporter reads them as, and withholds a protected one", async () => {
    render(<IssueConversation issue={issue()} onStale={vi.fn()} />);

    expect(await screen.findByText("Kommer någon i dag?")).toBeTruthy();
    expect(screen.getByText("Anmälaren")).toBeTruthy();
    expect(screen.getByText("Frida Förvaltare")).toBeTruthy();
    expect(screen.getByText("till anmälaren som Förvaltaren")).toBeTruthy();
    expect(screen.getByText("till anmälaren som Styrelsen")).toBeTruthy();
    // The protected handler is named to nobody, and said to be withheld.
    expect(
      screen.getByText("Namnet visas inte (skyddade personuppgifter)"),
    ).toBeTruthy();
    expect(screen.queryByText("p-shielded")).toBeNull();
  });

  it("fills the field from a saved reply and sends nothing until asked", async () => {
    const session = userEvent.setup();
    render(<IssueConversation issue={issue()} onStale={vi.fn()} />);

    const picker = await screen.findByLabelText("Sparat svar");
    await session.selectOptions(picker, "r-1");

    const field = screen.getByLabelText("Vatten: meddelande till anmälaren");
    expect((field as HTMLTextAreaElement).value).toBe(
      "Enligt stadgarna är det ditt ansvar.",
    );
    expect(sendIssueMessage).not.toHaveBeenCalled();

    await session.type(field, " Hör av dig.");
    await session.click(screen.getByRole("button", { name: "Skicka" }));
    await waitFor(() => {
      expect(sendIssueMessage).toHaveBeenCalledWith({
        issueId: "issue-1",
        body: "Enligt stadgarna är det ditt ansvar. Hör av dig.",
      });
    });
    // Sent: the field is empty and the conversation is read again.
    await waitFor(() => {
      expect((field as HTMLTextAreaElement).value).toBe("");
    });
    expect(fetchIssueMessages).toHaveBeenCalledTimes(2);
  });

  it("keeps the words and says why when the server refuses them", async () => {
    sendIssueMessage.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "personal-identity-number" },
    });
    const session = userEvent.setup();
    render(<IssueConversation issue={issue()} onStale={vi.fn()} />);

    const field = await screen.findByLabelText(
      "Vatten: meddelande till anmälaren",
    );
    await session.type(field, "Ring 19811218-9876");
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    expect(
      await screen.findByText(
        "Texten innehåller ett personnummer. Ta bort det och skicka igen.",
      ),
    ).toBeTruthy();
    expect((field as HTMLTextAreaElement).value).toBe("Ring 19811218-9876");

    // A changed draft clears the refusal it was about.
    await session.type(field, "x");
    expect(
      screen.queryByText(
        "Texten innehåller ett personnummer. Ta bort det och skicka igen.",
      ),
    ).toBeNull();
  });

  it("offers no field on an issue nobody can read an answer on", async () => {
    render(
      <IssueConversation
        issue={issue({ reporter: { kind: "unknown" } })}
        onStale={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/Ingen kan läsa ett svar på det här ärendet/),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText("Vatten: meddelande till anmälaren"),
    ).toBeNull();
    // A note is still the handlers' own to write.
    expect(screen.getByLabelText("Vatten: intern anteckning")).toBeTruthy();
  });

  it("tells the queue when the issue is no longer the reader's", async () => {
    sendIssueMessage.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "issue-not-found" },
    });
    const onStale = vi.fn();
    const session = userEvent.setup();
    render(<IssueConversation issue={issue()} onStale={onStale} />);

    await session.type(
      await screen.findByLabelText("Vatten: meddelande till anmälaren"),
      "Hej",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    await waitFor(() => {
      expect(onStale).toHaveBeenCalled();
    });
  });
});

describe("internal notes", () => {
  it("are shown with who wrote them and said to be the handlers' alone", async () => {
    const session = userEvent.setup();
    render(<IssueConversation issue={issue()} onStale={vi.fn()} />);

    const notes = (await screen.findByText("Interna anteckningar"))
      .parentElement as HTMLElement;
    expect(within(notes).getByText("Grannen har klagat förut.")).toBeTruthy();
    expect(within(notes).getByText("Bea Styrelse")).toBeTruthy();
    expect(
      within(notes).getByText(
        "Bara de som hanterar ärendet läser dessa. Anmälaren gör det aldrig.",
      ),
    ).toBeTruthy();

    await session.type(
      within(notes).getByLabelText("Vatten: intern anteckning"),
      "Ring försäkringsbolaget",
    );
    await session.click(
      within(notes).getByRole("button", { name: "Lägg till anteckning" }),
    );
    await waitFor(() => {
      expect(addIssueNote).toHaveBeenCalledWith({
        issueId: "issue-1",
        body: "Ring försäkringsbolaget",
      });
    });
    expect(sendIssueMessage).not.toHaveBeenCalled();
  });
});
