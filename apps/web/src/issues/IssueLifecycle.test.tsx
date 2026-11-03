import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { IssueLinks, QueuedIssue } from "../api/issues";
import { IssueLifecycle } from "./IssueLifecycle";

/**
 * What a handler does to an issue beside its handling (decisions 8 and 22):
 * publish its known fault, merge it into another as a duplicate, and write to
 * every reporter of the issues merged into it.
 *
 * Who may and on which issue is the server's; what is under test is that the
 * screen offers each act where it applies, sends what was written, takes two
 * presses to merge, and reads the queue again once anything is saved.
 */

const fetchIssueLinks = vi.fn();
const publishKnownFault = vi.fn();
const withdrawKnownFault = vi.fn();
const mergeIssue = vi.fn();
const sendToDuplicateReporters = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueLinks: (id: string) => fetchIssueLinks(id),
  publishKnownFault: (input: unknown) => publishKnownFault(input),
  withdrawKnownFault: (id: string) => withdrawKnownFault(id),
  mergeIssue: (input: unknown) => mergeIssue(input),
  sendToDuplicateReporters: (input: unknown) => sendToDuplicateReporters(input),
}));

const NO_LINKS: IssueLinks = {
  mergedInto: null,
  duplicates: [],
  follows: null,
  followUps: [],
};

function issue(overrides: Partial<QueuedIssue> = {}): QueuedIssue {
  return {
    id: "issue-1",
    meaning: "IN_PROGRESS",
    status: { id: "s-progress", label: "Pågår" },
    waitingReason: null,
    outcome: null,
    typeReporters: ["RESIDENTS"],
    closedAt: null,
    typeId: "type-lift",
    typeName: "Hiss",
    location: "Port 14",
    description: "Hissen står still.",
    apartment: null,
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
    knownFault: null,
    ...overrides,
  } as QueuedIssue;
}

const OTHER = issue({
  id: "issue-2",
  location: "Port 14, hissen",
  createdAt: "2026-08-19T08:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchIssueLinks.mockResolvedValue({ ok: true, value: NO_LINKS });
  publishKnownFault.mockResolvedValue({ ok: true, value: issue() });
  mergeIssue.mockResolvedValue({ ok: true, value: issue() });
  sendToDuplicateReporters.mockResolvedValue({ ok: true, value: { sent: 2 } });
});

describe("the known fault", () => {
  it("publishes the handler's own words and reads the queue again", async () => {
    const onChanged = vi.fn();
    const session = userEvent.setup();
    render(
      <IssueLifecycle issue={issue()} candidates={[]} onChanged={onChanged} />,
    );

    await session.type(
      screen.getByLabelText("Hiss: känt fel"),
      "  Hissen står still till torsdag.  ",
    );
    await session.click(
      screen.getByRole("button", { name: "Publicera känt fel" }),
    );

    await waitFor(() => {
      expect(publishKnownFault).toHaveBeenCalledWith({
        issueId: "issue-1",
        body: "Hissen står still till torsdag.",
      });
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("is not offered on an issue the board keeps to itself, and says why", () => {
    render(
      <IssueLifecycle
        issue={issue({ boardOnly: true })}
        candidates={[]}
        onChanged={() => undefined}
      />,
    );
    expect(screen.queryByLabelText("Hiss: känt fel")).toBeNull();
    expect(
      screen.getByText(
        "Ett ärende som bara styrelsen hanterar kan inte ha något känt fel.",
      ),
    ).toBeTruthy();
  });

  it("is withdrawn once published", async () => {
    withdrawKnownFault.mockResolvedValue({ ok: true, value: issue() });
    const session = userEvent.setup();
    render(
      <IssueLifecycle
        issue={issue({
          knownFault: {
            body: "Hissen står still.",
            signature: "BOARD",
            publishedAt: "2026-08-21T08:00:00.000Z",
          },
        })}
        candidates={[]}
        onChanged={() => undefined}
      />,
    );
    await session.click(screen.getByRole("button", { name: "Ta bort" }));
    expect(withdrawKnownFault).toHaveBeenCalledWith("issue-1");
  });
});

describe("merging", () => {
  it("merges into the chosen issue only on the second press", async () => {
    const onChanged = vi.fn();
    const session = userEvent.setup();
    render(
      <IssueLifecycle
        issue={issue()}
        candidates={[issue(), OTHER]}
        onChanged={onChanged}
      />,
    );

    await session.selectOptions(
      await screen.findByLabelText("Hiss: slå samman med ett annat ärende"),
      "issue-2",
    );
    await session.click(
      screen.getByRole("button", { name: "Slå samman som dublett" }),
    );
    expect(mergeIssue).not.toHaveBeenCalled();
    await session.click(
      screen.getByRole("button", { name: "Ja, avsluta som dublett" }),
    );

    await waitFor(() => {
      expect(mergeIssue).toHaveBeenCalledWith({
        issueId: "issue-1",
        intoIssueId: "issue-2",
      });
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("writes to the duplicates' reporters instead on an issue others were merged into", async () => {
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        duplicates: [
          {
            kind: "issue",
            id: "issue-2",
            typeName: "Hiss",
            meaning: "DONE",
            createdAt: "2026-08-19T08:00:00.000Z",
          },
        ],
      },
    });
    const session = userEvent.setup();
    render(
      <IssueLifecycle
        issue={issue()}
        candidates={[issue(), OTHER]}
        onChanged={() => undefined}
      />,
    );

    const field = await screen.findByLabelText(
      "Hiss: meddelande till anmälarna till de sammanslagna anmälningarna",
    );
    expect(
      screen.queryByLabelText("Hiss: slå samman med ett annat ärende"),
    ).toBeNull();
    await session.type(field, "Tekniker kommer torsdag.");
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    await waitFor(() => {
      expect(sendToDuplicateReporters).toHaveBeenCalledWith({
        issueId: "issue-1",
        body: "Tekniker kommer torsdag.",
      });
    });
  });
});
