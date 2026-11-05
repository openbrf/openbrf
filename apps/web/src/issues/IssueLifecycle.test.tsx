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
  duplicateCount: 0,
  follows: null,
  followUps: [],
  followUpCount: 0,
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
  sendToDuplicateReporters.mockResolvedValue({
    ok: true,
    value: { sent: 2, skipped: 0 },
  });
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
    const onChanged = vi.fn();
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
        onChanged={onChanged}
      />,
    );
    await session.click(screen.getByRole("button", { name: "Ta bort" }));
    expect(withdrawKnownFault).toHaveBeenCalledWith("issue-1");
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
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

  it("offers no issue that is done to merge into", async () => {
    render(
      <IssueLifecycle
        issue={issue()}
        candidates={[
          issue(),
          OTHER,
          issue({ id: "issue-3", meaning: "DONE", location: "Port 9" }),
        ]}
        onChanged={() => undefined}
      />,
    );

    const picker = await screen.findByLabelText(
      "Hiss: slå samman med ett annat ärende",
    );
    const values = [...picker.querySelectorAll("option")].map(
      (option) => option.value,
    );
    expect(values).toEqual(["", "issue-2"]);
  });

  it("reads the links again when the merge is refused because others were merged into this issue meanwhile", async () => {
    fetchIssueLinks.mockResolvedValueOnce({ ok: true, value: NO_LINKS });
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        duplicateCount: 1,
        duplicates: [
          {
            kind: "issue",
            id: "issue-4",
            typeName: "Hiss",
            meaning: "DONE",
            createdAt: "2026-08-19T08:00:00.000Z",
          },
        ],
      },
    });
    mergeIssue.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "merge-has-duplicates" },
    });
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
    await session.click(
      screen.getByRole("button", { name: "Ja, avsluta som dublett" }),
    );

    // The queue is read again, and so are the links, though nothing of this
    // issue changed: the panel now offers the message to the duplicates and
    // no longer the merge it just failed.
    expect(
      await screen.findByLabelText(
        "Hiss: meddelande till anmälarna till de sammanslagna anmälningarna",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText("Hiss: slå samman med ett annat ärende"),
    ).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(fetchIssueLinks).toHaveBeenCalledTimes(2);
  });

  it("writes to the duplicates' reporters instead on an issue others were merged into", async () => {
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        duplicateCount: 1,
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

  it("says how many merged reports were not reached because their reporter has no account", async () => {
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        duplicateCount: 3,
        duplicates: ["issue-2", "issue-3", "issue-4"].map((id) => ({
          kind: "issue",
          id,
          typeName: "Hiss",
          meaning: "DONE",
          createdAt: "2026-08-19T08:00:00.000Z",
        })),
      },
    });
    sendToDuplicateReporters.mockResolvedValue({
      ok: true,
      value: { sent: 2, skipped: 1 },
    });
    const session = userEvent.setup();
    render(
      <IssueLifecycle
        issue={issue()}
        candidates={[]}
        onChanged={() => undefined}
      />,
    );

    await session.type(
      await screen.findByLabelText(
        "Hiss: meddelande till anmälarna till de sammanslagna anmälningarna",
      ),
      "Tekniker kommer torsdag.",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    expect(await screen.findByText(/Skickat till 2 anmälare\./)).toBeTruthy();
    expect(screen.getByText(/1 sammanslagen anmälan nåddes inte/)).toBeTruthy();
  });

  it("drops the count an earlier message reached when the next one is refused", async () => {
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        duplicateCount: 1,
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
    sendToDuplicateReporters.mockResolvedValueOnce({
      ok: true,
      value: { sent: 1, skipped: 0 },
    });
    const session = userEvent.setup();
    render(
      <IssueLifecycle
        issue={issue()}
        candidates={[]}
        onChanged={() => undefined}
      />,
    );
    const field = await screen.findByLabelText(
      "Hiss: meddelande till anmälarna till de sammanslagna anmälningarna",
    );
    await session.type(field, "Tekniker kommer torsdag.");
    await session.click(screen.getByRole("button", { name: "Skicka" }));
    expect(await screen.findByText(/Skickat till 1 anmälare\./)).toBeTruthy();

    sendToDuplicateReporters.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, reason: "no-reporter" },
    });
    await session.type(field, "Tekniker kommer fredag i stället.");
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    await waitFor(() => {
      expect(sendToDuplicateReporters).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByText(/Skickat till 1 anmälare\./)).toBeNull();
    });
  });

  it("drops the count a message reached once the duplicates change, and keeps it while they do not", async () => {
    const duplicate = (id: string) => ({
      kind: "issue" as const,
      id,
      typeName: "Hiss",
      meaning: "DONE" as const,
      createdAt: "2026-08-19T08:00:00.000Z",
    });
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        duplicateCount: 1,
        duplicates: [duplicate("issue-2")],
      },
    });
    const session = userEvent.setup();
    const { rerender } = render(
      <IssueLifecycle
        issue={issue()}
        candidates={[]}
        queueRead={1}
        onChanged={() => undefined}
      />,
    );
    await session.type(
      await screen.findByLabelText(
        "Hiss: meddelande till anmälarna till de sammanslagna anmälningarna",
      ),
      "Tekniker kommer torsdag.",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));
    expect(await screen.findByText(/Skickat till 2 anmälare\./)).toBeTruthy();

    // The queue is read again and the same duplicates come back.
    rerender(
      <IssueLifecycle
        issue={issue()}
        candidates={[]}
        queueRead={2}
        onChanged={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(fetchIssueLinks).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText(/Skickat till 2 anmälare\./)).toBeTruthy();

    // Another issue is merged into this one: the count is of the earlier set.
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        duplicateCount: 2,
        duplicates: [duplicate("issue-2"), duplicate("issue-3")],
      },
    });
    rerender(
      <IssueLifecycle
        issue={issue()}
        candidates={[]}
        queueRead={3}
        onChanged={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/Skickat till 2 anmälare\./)).toBeNull();
    });
  });

  it("does not tell a send that finished after the duplicates changed beside the new duplicates", async () => {
    const duplicate = (id: string) => ({
      kind: "issue" as const,
      id,
      typeName: "Hiss",
      meaning: "DONE" as const,
      createdAt: "2026-08-19T08:00:00.000Z",
    });
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        duplicateCount: 1,
        duplicates: [duplicate("issue-2")],
      },
    });
    let finish: (value: unknown) => void = () => undefined;
    sendToDuplicateReporters.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const session = userEvent.setup();
    const { rerender } = render(
      <IssueLifecycle
        issue={issue()}
        candidates={[]}
        queueRead={1}
        onChanged={() => undefined}
      />,
    );
    await session.type(
      await screen.findByLabelText(
        "Hiss: meddelande till anmälarna till de sammanslagna anmälningarna",
      ),
      "Tekniker kommer torsdag.",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));

    // While the send is in flight another issue is merged into this one.
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        duplicateCount: 2,
        duplicates: [duplicate("issue-2"), duplicate("issue-3")],
      },
    });
    rerender(
      <IssueLifecycle
        issue={issue()}
        candidates={[]}
        queueRead={2}
        onChanged={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(fetchIssueLinks).toHaveBeenCalledTimes(2);
    });

    finish({ ok: true, value: { sent: 2, skipped: 0 } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Skicka" })).toBeTruthy();
    });
    expect(screen.queryByText(/Skickat till 2 anmälare\./)).toBeNull();
  });

  it("drops the count a message reached when one duplicate is replaced by another at the same count", async () => {
    const duplicate = (id: string) => ({
      kind: "issue" as const,
      id,
      typeName: "Hiss",
      meaning: "DONE" as const,
      createdAt: "2026-08-19T08:00:00.000Z",
    });
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        duplicateCount: 1,
        duplicates: [duplicate("issue-2")],
      },
    });
    sendToDuplicateReporters.mockResolvedValueOnce({
      ok: true,
      value: { sent: 1, skipped: 0 },
    });
    const session = userEvent.setup();
    const { rerender } = render(
      <IssueLifecycle
        issue={issue()}
        candidates={[]}
        queueRead={1}
        onChanged={() => undefined}
      />,
    );
    await session.type(
      await screen.findByLabelText(
        "Hiss: meddelande till anmälarna till de sammanslagna anmälningarna",
      ),
      "Tekniker kommer torsdag.",
    );
    await session.click(screen.getByRole("button", { name: "Skicka" }));
    expect(await screen.findByText(/Skickat till 1 anmälare\./)).toBeTruthy();

    // A different duplicate takes the place of issue-2; the count stays at 1.
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        duplicateCount: 1,
        duplicates: [duplicate("issue-3")],
      },
    });
    rerender(
      <IssueLifecycle
        issue={issue()}
        candidates={[]}
        queueRead={2}
        onChanged={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/Skickat till 1 anmälare\./)).toBeNull();
    });
  });

  it("does not confirm a merge into an issue that is no longer offered", async () => {
    const third = issue({ id: "issue-3", typeName: "Tvättstuga" });
    const session = userEvent.setup();
    const { rerender } = render(
      <IssueLifecycle
        issue={issue()}
        candidates={[issue(), OTHER, third]}
        onChanged={() => undefined}
      />,
    );
    const target = await screen.findByLabelText(
      "Hiss: slå samman med ett annat ärende",
    );
    await session.selectOptions(target, "issue-2");
    await session.click(
      screen.getByRole("button", { name: "Slå samman som dublett" }),
    );
    expect(
      screen.getByRole("button", { name: "Ja, avsluta som dublett" }),
    ).toBeTruthy();

    // The chosen issue is closed and leaves the list.
    rerender(
      <IssueLifecycle
        issue={issue()}
        candidates={[issue(), third]}
        onChanged={() => undefined}
      />,
    );

    expect(
      (
        screen.getByLabelText(
          "Hiss: slå samman med ett annat ärende",
        ) as HTMLSelectElement
      ).value,
    ).toBe("");
    expect(
      screen.queryByRole("button", { name: "Ja, avsluta som dublett" }),
    ).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Slå samman som dublett",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(mergeIssue).not.toHaveBeenCalled();
  });

  it("says how many follow-ups there are when only a page of them is listed", async () => {
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: {
        ...NO_LINKS,
        followUps: [
          {
            kind: "issue",
            id: "issue-5",
            typeName: "Hiss",
            meaning: "NEW",
            createdAt: "2026-08-19T08:00:00.000Z",
          },
        ],
        followUpCount: 51,
      },
    });
    render(
      <IssueLifecycle
        issue={issue()}
        candidates={[issue(), OTHER]}
        onChanged={() => undefined}
      />,
    );

    expect(
      await screen.findByText("Visar de första 1 av 51 uppföljningar."),
    ).toBeTruthy();
  });

  it("explains a merge refused because the issue merged into has as many duplicates as one may, and reads the queue again", async () => {
    mergeIssue.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "merge-limit" },
    });
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
    await session.click(
      screen.getByRole("button", { name: "Ja, avsluta som dublett" }),
    );

    expect(
      await screen.findByText(/redan så många dubletter som det får ha/),
    ).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it("does not offer a merge while issues this handler does not see were merged into it", async () => {
    fetchIssueLinks.mockResolvedValue({
      ok: true,
      value: { ...NO_LINKS, duplicateCount: 1 },
    });
    render(
      <IssueLifecycle
        issue={issue()}
        candidates={[issue(), OTHER]}
        onChanged={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(fetchIssueLinks).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.queryByLabelText("Hiss: slå samman med ett annat ärende"),
    ).toBeNull();
  });

  it("hides what it knew of the links when a later read of them fails, and keeps a half-chosen merge target for the next one", async () => {
    const session = userEvent.setup();
    const { rerender } = render(
      <IssueLifecycle
        issue={issue()}
        candidates={[issue(), OTHER]}
        queueRead={1}
        onChanged={() => undefined}
      />,
    );
    await session.selectOptions(
      await screen.findByLabelText("Hiss: slå samman med ett annat ärende"),
      "issue-2",
    );

    fetchIssueLinks.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });
    rerender(
      <IssueLifecycle
        issue={issue()}
        candidates={[issue(), OTHER]}
        queueRead={2}
        onChanged={() => undefined}
      />,
    );

    expect(await screen.findByText(/kopplingar kunde inte läsas/)).toBeTruthy();
    // Out of reach while the links may be out of date, not thrown away.
    const picker = screen.getByLabelText(
      "Hiss: slå samman med ett annat ärende",
    );
    expect(picker.closest("[hidden]")).not.toBeNull();

    fetchIssueLinks.mockResolvedValue({ ok: true, value: NO_LINKS });
    rerender(
      <IssueLifecycle
        issue={issue()}
        candidates={[issue(), OTHER]}
        queueRead={3}
        onChanged={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen
          .getByLabelText("Hiss: slå samman med ett annat ärende")
          .closest("[hidden]"),
      ).toBeNull();
    });
    expect(
      (
        screen.getByLabelText(
          "Hiss: slå samman med ett annat ärende",
        ) as HTMLSelectElement
      ).value,
    ).toBe("issue-2");
    expect(screen.queryByText(/kopplingar kunde inte läsas/)).toBeNull();
  });

  it("explains a merge refused because the issue is already a duplicate of another, and reads the queue again", async () => {
    mergeIssue.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "merge-already-duplicate" },
    });
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
    await session.click(
      screen.getByRole("button", { name: "Ja, avsluta som dublett" }),
    );

    expect(
      await screen.findByText(/redan en dublett av ett annat/),
    ).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("names the merge candidates by more than their type, day and first words", async () => {
    const twin = issue({
      id: "issue-5",
      location: "Port 14, hissen",
      createdAt: "2026-08-19T08:00:00.000Z",
      status: { id: "s-waiting", label: "Väntar på tekniker" },
    });
    render(
      <IssueLifecycle
        issue={issue()}
        candidates={[issue(), OTHER, twin]}
        onChanged={() => undefined}
      />,
    );

    const picker = await screen.findByLabelText(
      "Hiss: slå samman med ett annat ärende",
    );
    const labels = [...picker.querySelectorAll("option")].map(
      (option) => option.textContent,
    );
    expect(new Set(labels).size).toBe(labels.length);
  });
});
