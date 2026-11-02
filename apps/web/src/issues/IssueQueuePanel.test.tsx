import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type {
  IssueReporter,
  IssueStatusView,
  IssueTypeView,
  QueuedIssue,
} from "../api/issues";
import { IssueQueuePanel } from "./IssueQueuePanel";

/**
 * The triage queue.
 *
 * The case worth having is the protected reporter. This queue is read by an
 * external property manager, and a person with protected personal data
 * (skyddade personuppgifter) is masked in it - the server sends no name, and
 * the panel must not invent one from the identifier it does get.
 *
 * And the move between statuses (ADR 0054): the type's own statuses are
 * offered, a status that means waiting asks whom or what for, and closing asks
 * how the issue ended, before the save is let go.
 */

const setIssueStatus = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  setIssueStatus: (input: unknown) => setIssueStatus(input),
}));

function status(
  overrides: Partial<IssueStatusView> & Pick<IssueStatusView, "id">,
): IssueStatusView {
  return {
    meaning: "NEW",
    label: "Ny",
    isDefault: true,
    active: true,
    sortOrder: 0,
    issueCount: 0,
    ...overrides,
  };
}

const TYPES: readonly IssueTypeView[] = [
  {
    id: "type-water",
    name: "Vatten",
    reporters: ["RESIDENTS"],
    active: true,
    sortOrder: 0,
    reportCount: 1,
    statuses: [
      status({ id: "s-new", meaning: "NEW", label: "Ny" }),
      status({ id: "s-doing", meaning: "IN_PROGRESS", label: "Pågår" }),
      status({
        id: "s-contractor",
        meaning: "IN_PROGRESS",
        label: "Hos rörmokaren",
        isDefault: false,
        sortOrder: 1,
      }),
      status({
        id: "s-old",
        meaning: "IN_PROGRESS",
        label: "Gammal status",
        isDefault: false,
        active: false,
        sortOrder: 2,
      }),
      status({ id: "s-waiting", meaning: "WAITING", label: "Väntar" }),
      status({ id: "s-done", meaning: "DONE", label: "Klar" }),
    ],
  },
];

// The overrides are loose so a test can pair any reporter with any apartment;
// the server only ever sends the pairings `QueuedIssue` allows.
function issue(
  overrides: Partial<Omit<QueuedIssue, "reporter">> & {
    reporter?: IssueReporter;
  } = {},
): QueuedIssue {
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
    ...overrides,
  } as QueuedIssue;
}

/** The status select of the one row on screen. */
function statusSelect(): HTMLElement {
  return screen.getByLabelText("Vatten anmält 2026-08-20: status");
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: "Spara status" });
}

beforeEach(() => {
  setIssueStatus.mockReset().mockResolvedValue({ ok: true, value: issue() });
});

describe("who reported it", () => {
  it("names an ordinary reporter", () => {
    render(
      <IssueQueuePanel
        issues={[issue()]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText("Rune Boende")).toBeTruthy();
  });

  it("withholds the name of a reporter with protected personal data", () => {
    render(
      <IssueQueuePanel
        issues={[issue({ reporter: { kind: "protected" }, apartment: null })]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );

    expect(
      screen.getByText("Skyddade personuppgifter: fråga styrelsen."),
    ).toBeTruthy();
    expect(screen.queryByText("Rune Boende")).toBeNull();
  });

  it("says the apartment of a protected reporter is withheld, not missing", () => {
    // The server sends no apartment for them: on their report it is where they
    // live. "Not about an apartment" would tell the handler something false.
    render(
      <IssueQueuePanel
        issues={[
          issue({
            reporter: { kind: "protected" },
            apartment: null,
          }),
        ]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );

    expect(
      screen.getByText("Visas inte, skyddade personuppgifter."),
    ).toBeTruthy();
    expect(screen.queryByText(/gäller ingen lägenhet/i)).toBeNull();
  });

  it("says plainly when the register no longer holds the reporter", () => {
    // Issue data is service tier and a person can be purged out from under it.
    // The queue says so rather than breaking or inventing a name.
    render(
      <IssueQueuePanel
        issues={[issue({ reporter: { kind: "unknown" } })]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText(/finns inte längre i registret/i)).toBeTruthy();
  });

  it("shows the contact details a report from the website carried", () => {
    render(
      <IssueQueuePanel
        issues={[
          issue({
            typeReporters: ["PUBLIC"],
            reporter: {
              kind: "external",
              name: "Grannen",
              email: "granne@exempel.se",
            },
          }),
        ]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText(/granne@exempel\.se/)).toBeTruthy();
  });
});

describe("moving a report to another status", () => {
  function show(queued: QueuedIssue = issue()): void {
    render(
      <IssueQueuePanel
        issues={[queued]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );
  }

  it("offers the type's switched-on statuses, grouped by meaning", () => {
    show();

    const select = statusSelect();
    const groups = within(select)
      .getAllByRole("group")
      .map((group) => group.getAttribute("label"));
    expect(groups).toEqual(["Ny", "Pågår", "Väntar", "Klar"]);
    expect(
      within(select).getByRole("option", { name: "Hos rörmokaren" }),
    ).toBeTruthy();
    // Switched off by the board, and this issue does not stand in it.
    expect(
      within(select).queryByRole("option", { name: "Gammal status" }),
    ).toBeNull();
  });

  it("offers nothing to save until the status is changed", async () => {
    const session = userEvent.setup();
    show();

    expect(saveButton()).toHaveProperty("disabled", true);
    await session.selectOptions(statusSelect(), "s-contractor");
    expect(saveButton()).toHaveProperty("disabled", false);
    await session.click(saveButton());

    await waitFor(() => {
      expect(setIssueStatus).toHaveBeenCalledWith({
        issueId: "issue-1",
        statusId: "s-contractor",
      });
    });
  });

  it("asks what the issue waits for before it may wait", async () => {
    const session = userEvent.setup();
    show();

    await session.selectOptions(statusSelect(), "s-waiting");
    expect(saveButton()).toHaveProperty("disabled", true);

    await session.selectOptions(
      screen.getByLabelText("Vatten anmält 2026-08-20: väntar på"),
      "CONTRACTOR",
    );
    await session.click(saveButton());

    await waitFor(() => {
      expect(setIssueStatus).toHaveBeenCalledWith({
        issueId: "issue-1",
        statusId: "s-waiting",
        waitingReason: "CONTRACTOR",
      });
    });
  });

  it("asks how the issue ended before it may close", async () => {
    const session = userEvent.setup();
    show();

    await session.selectOptions(statusSelect(), "s-done");
    expect(saveButton()).toHaveProperty("disabled", true);

    const outcome = screen.getByLabelText("Vatten anmält 2026-08-20: utfall");
    // A duplicate is what a merge writes, never a choice on closing.
    expect(
      within(outcome).queryByRole("option", { name: "Dublett" }),
    ).toBeNull();
    await session.selectOptions(outcome, "TENANT_OWNER_RESPONSIBILITY");
    await session.click(saveButton());

    await waitFor(() => {
      expect(setIssueStatus).toHaveBeenCalledWith({
        issueId: "issue-1",
        statusId: "s-done",
        outcome: "TENANT_OWNER_RESPONSIBILITY",
      });
    });
  });

  it("reopens a closed issue without asking for an outcome", async () => {
    const session = userEvent.setup();
    show(
      issue({
        meaning: "DONE",
        status: { id: "s-done", label: "Klar" },
        outcome: "FIXED",
        closedAt: "2026-08-21T08:00:00.000Z",
      }),
    );

    expect(screen.getByText("Utfall: Åtgärdat")).toBeTruthy();
    await session.selectOptions(statusSelect(), "s-new");
    await session.click(saveButton());

    await waitFor(() => {
      expect(setIssueStatus).toHaveBeenCalledWith({
        issueId: "issue-1",
        statusId: "s-new",
      });
    });
  });

  it("keeps a switched-off status the issue stands in on offer", () => {
    show(
      issue({
        meaning: "IN_PROGRESS",
        status: { id: "s-old", label: "Gammal status" },
      }),
    );

    expect(
      within(statusSelect()).getByRole("option", { name: "Gammal status" }),
    ).toBeTruthy();
  });

  it("puts the saving label on the row that was acted on and no other", async () => {
    // One save action serves the whole panel, so without a per-row check every
    // button in the queue reads "Sparar..." when one of them is clicked.
    let release: (value: unknown) => void = () => undefined;
    setIssueStatus.mockImplementation(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const session = userEvent.setup();
    render(
      <IssueQueuePanel
        issues={[
          issue(),
          issue({
            id: "issue-2",
            createdAt: "2026-08-22T08:00:00.000Z",
          }),
        ]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );

    await session.selectOptions(statusSelect(), "s-doing");
    await session.click(
      screen.getAllByRole("button", { name: "Spara status" })[0]!,
    );

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /sparar/i })).toHaveLength(
        1,
      );
    });
    expect(
      screen.getAllByRole("button", { name: "Spara status" }),
    ).toHaveLength(1);

    release({ ok: true, value: issue() });
  });

  it("says so when the change is refused, and reads the queue again", async () => {
    setIssueStatus.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "status-not-found" },
    });
    const onChanged = vi.fn();

    const session = userEvent.setup();
    render(
      <IssueQueuePanel
        issues={[issue()]}
        types={TYPES}
        onChanged={onChanged}
      />,
    );

    await session.selectOptions(statusSelect(), "s-doing");
    await session.click(saveButton());

    await waitFor(() => {
      expect(screen.getByText(/erbjuds inte längre/i)).toBeTruthy();
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("says that nothing can be moved when the statuses could not be read", () => {
    render(
      <IssueQueuePanel
        issues={[issue()]}
        types={null}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText(/statusarna kunde inte läsas/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Spara status" })).toBeNull();
  });
});

describe("the status of a report", () => {
  it("shows the board's label, with a word as well as a colour", () => {
    // DESIGN.md: colour is never the only signal.
    render(
      <IssueQueuePanel
        issues={[
          issue({
            meaning: "WAITING",
            status: { id: "s-waiting", label: "Väntar" },
            waitingReason: "PARTS",
          }),
        ]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText("Väntar på: Reservdelar")).toBeTruthy();
  });
});
