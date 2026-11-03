import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { IssueMessage, QueuedIssue } from "../api/issues";
import { IssueConversation } from "./IssueConversation";
import { IssueFreeTextSection, useIssueRedaction } from "./IssueRedaction";

/**
 * A handler's removals on an issue and the legal hold (ADR 0057).
 *
 * What only this shows: a removal is asked twice and then sent with nothing
 * in place of what it removes, the issue and its conversation are read again
 * after it, a redacted message reads as removed rather than as blank, and a
 * legal hold takes every removal away and says why.
 */

const fetchIssueMessages = vi.fn();
const fetchIssueNotes = vi.fn();
const fetchIssueAttachments = vi.fn();
const fetchIssueSavedReplies = vi.fn();
const redactIssue = vi.fn();
const setIssueLegalHold = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueMessages: (id: string) => fetchIssueMessages(id),
  fetchIssueNotes: (id: string) => fetchIssueNotes(id),
  fetchIssueAttachments: (id: string) => fetchIssueAttachments(id),
  fetchIssueSavedReplies: () => fetchIssueSavedReplies(),
  redactIssue: (input: unknown) => redactIssue(input),
  setIssueLegalHold: (input: unknown) => setIssueLegalHold(input),
}));

function issue(overrides: Partial<QueuedIssue> = {}): QueuedIssue {
  return {
    id: "issue-1",
    meaning: "DONE",
    status: { id: "s-done", label: "Klar" },
    waitingReason: null,
    outcome: "FIXED",
    typeReporters: ["RESIDENTS"],
    closedAt: "2026-09-01T08:00:00.000Z",
    typeId: "type-water",
    typeName: "Vatten",
    location: "Badrummet",
    description: "Grannen i 1402 spolar för mycket.",
    apartment: null,
    photos: [
      {
        id: "photo-1",
        url: "/api/media/file-1",
        fileName: "tak.jpg",
        width: 10,
        height: 10,
      },
    ],
    reporter: { kind: "resident", personId: "p-1", name: "Rune Boende" },
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    enteredByHandler: false,
    descriptionRedactedAt: null,
    locationRedactedAt: null,
    freeTextRemovedAt: null,
    typeHandledBy: "EVERY_HANDLER",
    priority: "NORMAL",
    targetDate: null,
    overdue: false,
    assignee: null,
    enteredBy: null,
    boardOnly: false,
    legalHoldAt: null,
    ...overrides,
  } as QueuedIssue;
}

const THREAD: IssueMessage[] = [
  {
    id: "m-1",
    side: "REPORTER",
    body: "Det luktar fukt.",
    redactedAt: null,
    createdAt: "2026-08-20T09:00:00.000Z",
  },
  {
    id: "m-2",
    side: "REPORTER",
    body: "",
    redactedAt: "2026-10-01T09:00:00.000Z",
    createdAt: "2026-08-20T10:00:00.000Z",
  },
];

/** The two halves a handler sees, sharing one control, as the queue does. */
function Harness({
  of,
  onChanged,
}: {
  of: QueuedIssue;
  onChanged: () => void;
}): ReactElement {
  const control = useIssueRedaction(of, onChanged);
  return (
    <>
      <IssueFreeTextSection issue={of} control={control} />
      <IssueConversation issue={of} onStale={vi.fn()} redaction={control} />
    </>
  );
}

beforeEach(() => {
  fetchIssueMessages.mockReset().mockResolvedValue({ ok: true, value: THREAD });
  fetchIssueNotes.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchIssueAttachments.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchIssueSavedReplies.mockReset().mockResolvedValue({ ok: true, value: [] });
  redactIssue.mockReset().mockResolvedValue({ ok: true, value: undefined });
  setIssueLegalHold.mockReset().mockResolvedValue({
    ok: true,
    value: { legalHoldAt: "2026-11-03T08:00:00.000Z" },
  });
});

describe("removing a text", () => {
  it("is asked twice, sends no replacement text, and reads the issue and its conversation again", async () => {
    const onChanged = vi.fn();
    const session = userEvent.setup();
    render(<Harness of={issue()} onChanged={onChanged} />);
    await screen.findByText("Det luktar fukt.");
    expect(fetchIssueMessages).toHaveBeenCalledTimes(1);

    await session.click(
      screen.getByRole("button", { name: "Vatten: ta bort beskrivningen" }),
    );
    expect(redactIssue).not.toHaveBeenCalled();
    expect(screen.getByText(/Det går inte att ångra/)).toBeTruthy();

    await session.click(
      screen.getByRole("button", { name: "Ta bort för gott" }),
    );

    await waitFor(() => {
      expect(redactIssue).toHaveBeenCalledWith({
        issueId: "issue-1",
        redaction: { target: "description" },
      });
    });
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
      expect(fetchIssueMessages).toHaveBeenCalledTimes(2);
    });
  });

  it("removes a message by its identifier", async () => {
    const session = userEvent.setup();
    render(<Harness of={issue()} onChanged={vi.fn()} />);
    await screen.findByText("Det luktar fukt.");

    await session.click(
      screen.getByRole("button", { name: /^Ta bort svaret från/ }),
    );
    await session.click(
      screen.getByRole("button", { name: "Ta bort för gott" }),
    );

    await waitFor(() => {
      expect(redactIssue).toHaveBeenCalledWith({
        issueId: "issue-1",
        redaction: { target: "message", id: "m-1" },
      });
    });
  });

  it("says why when a hold was placed meanwhile", async () => {
    redactIssue.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "legal-hold" },
    });
    const onChanged = vi.fn();
    const session = userEvent.setup();
    render(<Harness of={issue()} onChanged={onChanged} />);
    await screen.findByText("Det luktar fukt.");

    await session.click(
      screen.getByRole("button", { name: "Vatten: ta bort platsen" }),
    );
    await session.click(
      screen.getByRole("button", { name: "Ta bort för gott" }),
    );

    expect(
      await screen.findByText(
        /Ärendet har ett rättsligt bevarandekrav, så ingenting kan tas bort\. Ärendet har lästs om\./,
      ),
    ).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("a redacted message", () => {
  it("reads as removed, with the date, and offers nothing more to remove", async () => {
    render(<Harness of={issue()} onChanged={vi.fn()} />);
    await screen.findByText("Det luktar fukt.");

    const thread = screen.getByText("Det luktar fukt.").closest("ol");
    const items = within(thread as HTMLElement).getAllByRole("listitem");
    const redacted = items[1] as HTMLElement;
    expect(
      within(redacted).getByText(/Borttaget av en handläggare/),
    ).toBeTruthy();
    expect(within(redacted).getByText("2026-10-01")).toBeTruthy();
    expect(within(redacted).queryByRole("button")).toBeNull();
    // One remove act for the message that still stands, none for the other.
    expect(
      screen.getAllByRole("button", { name: /^Ta bort svaret från/ }),
    ).toHaveLength(1);
  });
});

describe("a legal hold", () => {
  it("takes every removal away and says why", async () => {
    render(
      <Harness
        of={issue({ legalHoldAt: "2026-10-15T08:00:00.000Z" })}
        onChanged={vi.fn()}
      />,
    );
    await screen.findByText("Det luktar fukt.");

    expect(screen.queryAllByRole("button", { name: /ta bort/i })).toHaveLength(
      0,
    );
    expect(
      screen.getByText(
        "Ärendet har ett rättsligt bevarandekrav, så ingenting kan tas bort förrän kravet hävs.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("2026-10-15")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Vatten: häv det rättsliga bevarandekravet",
      }),
    ).toBeTruthy();
  });

  it("is placed at once, and released only when asked twice", async () => {
    const session = userEvent.setup();
    const { rerender } = render(<Harness of={issue()} onChanged={vi.fn()} />);
    await screen.findByText("Det luktar fukt.");

    await session.click(
      screen.getByRole("button", {
        name: "Vatten: lägg ett rättsligt bevarandekrav",
      }),
    );
    await waitFor(() => {
      expect(setIssueLegalHold).toHaveBeenCalledWith({
        issueId: "issue-1",
        held: true,
      });
    });

    rerender(
      <Harness
        of={issue({ legalHoldAt: "2026-11-03T08:00:00.000Z" })}
        onChanged={vi.fn()}
      />,
    );
    await session.click(
      screen.getByRole("button", {
        name: "Vatten: häv det rättsliga bevarandekravet",
      }),
    );
    expect(setIssueLegalHold).toHaveBeenCalledTimes(1);
    await session.click(screen.getByRole("button", { name: "Häv" }));
    await waitFor(() => {
      expect(setIssueLegalHold).toHaveBeenLastCalledWith({
        issueId: "issue-1",
        held: false,
      });
    });
  });
});
