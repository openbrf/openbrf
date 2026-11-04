import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
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
const fetchIssueHandlers = vi.fn();
const fetchIssueTimeline = vi.fn();
const assignIssue = vi.fn();
const setIssuePriority = vi.fn();
const setIssueTargetDate = vi.fn();
const setIssueBoardOnly = vi.fn();
const setIssueCostResponsibility = vi.fn();
const fetchHandlerResponsibilityGuide = vi.fn();
const fetchIssueCharges = vi.fn();
const removeIssueFinding = vi.fn();
/** The conversation beside the handling, read when an issue is opened. */
const conversationReads = {
  fetchIssueMessages: vi.fn(),
  fetchIssueNotes: vi.fn(),
  fetchIssueAttachments: vi.fn(),
  fetchIssueSavedReplies: vi.fn(),
};

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  setIssueStatus: (input: unknown) => setIssueStatus(input),
  fetchIssueHandlers: (id: string) => fetchIssueHandlers(id),
  fetchIssueTimeline: (id: string) => fetchIssueTimeline(id),
  assignIssue: (input: unknown) => assignIssue(input),
  setIssuePriority: (input: unknown) => setIssuePriority(input),
  setIssueTargetDate: (input: unknown) => setIssueTargetDate(input),
  setIssueBoardOnly: (input: unknown) => setIssueBoardOnly(input),
  fetchIssuePlaceCounts: () => Promise.resolve({ ok: true, value: [] }),
  removeIssueFinding: (id: string) => removeIssueFinding(id),
  fetchIssueMessages: (id: string) => conversationReads.fetchIssueMessages(id),
  fetchIssueNotes: (id: string) => conversationReads.fetchIssueNotes(id),
  fetchIssueAttachments: (id: string) =>
    conversationReads.fetchIssueAttachments(id),
  fetchIssueSavedReplies: () => conversationReads.fetchIssueSavedReplies(),
  setIssueCostResponsibility: (input: unknown) =>
    setIssueCostResponsibility(input),
  fetchHandlerResponsibilityGuide: () => fetchHandlerResponsibilityGuide(),
}));

vi.mock("../charges/charges-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../charges/charges-api")>()),
  fetchIssueCharges: (id: string) => fetchIssueCharges(id),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    className,
    "aria-label": label,
  }: {
    to: string;
    search?: { issue?: string };
    children: ReactNode;
    className?: string;
    "aria-label"?: string;
  }): ReactElement => (
    <a
      href={search?.issue === undefined ? to : `${to}?issue=${search.issue}`}
      aria-label={label}
      className={className}
    >
      {children}
    </a>
  ),
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
    handledBy: "EVERY_HANDLER",
    defaultPriority: "NORMAL",
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
    place: null,
    description: "Det droppar i taket.",
    apartment: { id: "a-1", number: "1401", address: "Storgatan 12" },
    entry: null,
    finding: null,
    photos: [],
    reporter: { kind: "resident", personId: "p-1", name: "Rune Boende" },
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T08:00:00.000Z",
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
    costResponsibility: null,
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
  fetchIssueHandlers.mockReset().mockResolvedValue({
    ok: true,
    value: [
      { kind: "person", personId: "p-board", name: "Bea Styrelse" },
      { kind: "protected", personId: "p-shielded" },
      { kind: "person", personId: "p-manager", name: "Frida Förvaltare" },
    ],
  });
  fetchIssueTimeline.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchHandlerResponsibilityGuide.mockReset().mockResolvedValue({
    ok: true,
    value: {
      adoptedAt: null,
      items: [
        {
          part: "Golvbrunn, rensning",
          responsibility: "TENANT_OWNER",
          note: null,
        },
      ],
    },
  });
  fetchIssueCharges.mockReset().mockResolvedValue({
    ok: true,
    value: {
      issue: {
        issueId: "issue-1",
        typeName: "Vatten",
        costResponsibility: "TENANT_OWNER",
        party: { kind: "apartment", apartmentId: "a-1" },
      },
      charges: [
        {
          chargeId: "charge-1",
          chargedOn: "2026-08-28",
          chargedTo: {
            kind: "apartment",
            apartmentId: "a-1",
            apartment: { state: "visible", label: "Storgatan 12 1401" },
          },
          amount: "1250.00",
          vatTreatment: "EXEMPT",
          vatRatePercent: null,
          reason: "Ärende: Vatten",
          handedToManagerOn: null,
          deliveries: [],
          issueId: "issue-1",
        },
      ],
    },
  });
  for (const read of Object.values(conversationReads)) {
    read.mockReset().mockResolvedValue({ ok: true, value: [] });
  }
  for (const write of [
    assignIssue,
    setIssuePriority,
    setIssueTargetDate,
    setIssueBoardOnly,
    setIssueCostResponsibility,
    removeIssueFinding,
  ]) {
    write.mockReset().mockResolvedValue({ ok: true, value: issue() });
  }
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

  it("says a reply is not a notice to remedy when closing it as the tenant-owner's", async () => {
    const session = userEvent.setup();
    show();

    await session.selectOptions(statusSelect(), "s-done");
    const outcome = screen.getByLabelText("Vatten anmält 2026-08-20: utfall");
    await session.selectOptions(outcome, "FIXED");
    expect(screen.queryByText(/rättelseanmaning/)).toBeNull();

    await session.selectOptions(outcome, "TENANT_OWNER_RESPONSIBILITY");
    expect(screen.getByText(/7 kap\. 12 a §/)).toBeTruthy();
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

describe("handling an issue", () => {
  function show(queued: QueuedIssue = issue(), onChanged = vi.fn()) {
    render(
      <IssueQueuePanel issues={[queued]} types={TYPES} onChanged={onChanged} />,
    );
    return onChanged;
  }

  async function openHandling(session: ReturnType<typeof userEvent.setup>) {
    await session.click(
      screen.getByText(
        "Hantera Vatten: ansvarig, prioritet, senast klart, tidslinje och meddelanden",
      ),
    );
  }

  it("says who it is given to, how urgent it is and when it is overdue", () => {
    show(
      issue({
        assignee: { kind: "protected", personId: "p-shielded" },
        priority: "URGENT",
        targetDate: "2026-08-25",
        overdue: true,
        boardOnly: true,
        enteredBy: {
          kind: "person",
          personId: "p-board",
          name: "Bea Styrelse",
        },
      }),
    );

    expect(
      screen.getByText("Namnet visas inte (skyddade personuppgifter)"),
    ).toBeTruthy();
    expect(screen.getByText("Akut")).toBeTruthy();
    expect(screen.getByText("Försenat")).toBeTruthy();
    expect(screen.getByText("Bara styrelsen")).toBeTruthy();
    expect(screen.getByText("Bea Styrelse")).toBeTruthy();
  });

  it("reads the handlers and the timeline only once the issue is opened", async () => {
    const session = userEvent.setup();
    show();

    expect(fetchIssueHandlers).not.toHaveBeenCalled();
    await openHandling(session);

    await waitFor(() => {
      expect(fetchIssueHandlers).toHaveBeenCalledWith("issue-1");
    });
    expect(fetchIssueTimeline).toHaveBeenCalledWith("issue-1");
  });

  it("still shows who it is given to when the list of handlers could not be read", async () => {
    fetchIssueHandlers.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    const session = userEvent.setup();
    show(
      issue({
        assignee: { kind: "person", personId: "p-board", name: "Bea Styrelse" },
      }),
    );
    await openHandling(session);

    const select = (await screen.findByLabelText(
      "Vatten: ansvarig",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(fetchIssueHandlers).toHaveBeenCalled();
    });
    // Not "Ej tilldelat": the form is disabled, and it must not read as if the
    // issue were unassigned.
    await waitFor(() => {
      expect(select.disabled).toBe(true);
      expect(select.value).toBe("p-board");
      expect(select.selectedOptions[0]?.textContent).toBe("Bea Styrelse");
    });
  });

  it("assigns it to a handler from the names-only list, and reads the queue again", async () => {
    const session = userEvent.setup();
    const onChanged = show();
    await openHandling(session);

    const select = await screen.findByLabelText("Vatten: ansvarig");
    await waitFor(() => {
      expect((select as HTMLSelectElement).disabled).toBe(false);
    });
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Ej tilldelat",
      "Bea Styrelse",
      "Namnet visas inte (skyddade personuppgifter)",
      "Frida Förvaltare",
    ]);
    await session.selectOptions(select, "p-manager");
    const [save] = screen.getAllByRole("button", { name: "Spara" });
    await session.click(save as HTMLElement);

    await waitFor(() => {
      expect(assignIssue).toHaveBeenCalledWith({
        issueId: "issue-1",
        assigneePersonId: "p-manager",
      });
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("sets the priority and the target date", async () => {
    const session = userEvent.setup();
    show();
    await openHandling(session);

    await session.selectOptions(
      await screen.findByLabelText("Vatten: prioritet"),
      "LOW",
    );
    const buttons = screen.getAllByRole("button", { name: "Spara" });
    await session.click(buttons[1] as HTMLElement);
    await waitFor(() => {
      expect(setIssuePriority).toHaveBeenCalledWith({
        issueId: "issue-1",
        priority: "LOW",
      });
    });

    const date = screen.getByLabelText("Vatten: senast klart");
    await session.type(date, "2026-09-01");
    await session.click(
      screen.getAllByRole("button", { name: "Spara" })[2] as HTMLElement,
    );
    await waitFor(() => {
      expect(setIssueTargetDate).toHaveBeenCalledWith({
        issueId: "issue-1",
        targetDate: "2026-09-01",
      });
    });
  });

  it.each([
    {
      change: "clears",
      typed: "",
      reason: "finding-needs-target-date",
      message: "En anmärkning behöver ett senast klart-datum.",
    },
    {
      change: "moves",
      typed: "2026-12-01",
      reason: "finding-target-date-too-late",
      message:
        "Kvarstående fel på en hiss ska åtgärdas inom en månad från besiktningen. Välj ett tidigare datum.",
    },
  ])(
    "says why a finding's target date was refused when a handler $change it",
    async ({ typed, reason, message }) => {
      setIssueTargetDate.mockResolvedValue({
        ok: false,
        failure: { status: 422, reason },
      });
      const session = userEvent.setup();
      show(
        issue({
          targetDate: "2026-04-10",
          finding: {
            kind: "LIFT",
            inspectedOn: "2026-03-15",
            protocol: { attachmentId: "att-1", fileName: "hiss.pdf" },
          },
        }),
      );
      await openHandling(session);

      const date = await screen.findByLabelText("Vatten: senast klart");
      await session.clear(date);
      if (typed !== "") {
        await session.type(date, typed);
      }
      await session.click(
        screen.getAllByRole("button", { name: "Spara" })[2] as HTMLElement,
      );

      await waitFor(() => {
        expect(setIssueTargetDate).toHaveBeenCalledWith({
          issueId: "issue-1",
          targetDate: typed === "" ? null : typed,
        });
      });
      expect(await screen.findByText(message)).toBeTruthy();
      expect(
        screen.queryByText("Ärendet gick inte att ändra just nu. Försök igen."),
      ).toBeNull();
    },
  );

  it("closes an issue to the board", async () => {
    const session = userEvent.setup();
    show();
    await openHandling(session);

    await session.click(
      await screen.findByLabelText("Vatten: bara styrelsen hanterar ärendet"),
    );
    await waitFor(() => {
      expect(setIssueBoardOnly).toHaveBeenCalledWith({
        issueId: "issue-1",
        boardOnly: true,
      });
    });
  });

  it("records who pays, and says a reply is not a notice to remedy once it is the tenant-owner's", async () => {
    const session = userEvent.setup();
    const view = render(
      <IssueQueuePanel
        issues={[issue()]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );
    await openHandling(session);

    const select = await screen.findByLabelText("Vatten: vem betalar");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Inte angivet", "Föreningen", "Bostadsrättshavaren", "Oklart"]);
    expect(screen.queryByText(/rättelseanmaning/)).toBeNull();

    await session.selectOptions(select, "TENANT_OWNER");
    await session.click(
      within(select.closest("form") as HTMLElement).getByRole("button", {
        name: "Spara",
      }),
    );
    await waitFor(() => {
      expect(setIssueCostResponsibility).toHaveBeenCalledWith({
        issueId: "issue-1",
        costResponsibility: "TENANT_OWNER",
      });
    });

    view.rerender(
      <IssueQueuePanel
        issues={[issue({ costResponsibility: "TENANT_OWNER" })]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );
    expect(await screen.findByText(/7 kap\. 12 a §/)).toBeTruthy();
  });

  it("keeps saying a reply is not a notice to remedy on an issue closed as the tenant-owner's", async () => {
    const session = userEvent.setup();
    show(
      issue({
        meaning: "DONE",
        status: { id: "s-done", label: "Klar" },
        outcome: "TENANT_OWNER_RESPONSIBILITY",
        closedAt: "2026-08-22T08:00:00.000Z",
      }),
    );
    await openHandling(session);

    expect(await screen.findByText(/7 kap\. 12 a §/)).toBeTruthy();
  });

  it("does not say it on an issue closed with another outcome", async () => {
    const session = userEvent.setup();
    show(
      issue({
        meaning: "DONE",
        status: { id: "s-done", label: "Klar" },
        outcome: "FIXED",
        closedAt: "2026-08-22T08:00:00.000Z",
      }),
    );
    await openHandling(session);
    await screen.findByLabelText("Vatten: vem betalar");

    expect(screen.queryByText(/7 kap\. 12 a §/)).toBeNull();
  });

  it("shows the responsibility guide labelled as an example until the board adopts it", async () => {
    const session = userEvent.setup();
    show();
    await openHandling(session);

    await session.click(
      await screen.findByText("Ansvarsfördelning enligt stadgarna", {
        selector: "summary",
      }),
    );
    expect(await screen.findByText("Golvbrunn, rensning")).toBeTruthy();
    expect(screen.getByText(/^Exempel\./)).toBeTruthy();
  });

  it("reads no charges and shows no amount to a handler who may not read charges", async () => {
    const session = userEvent.setup();
    show();
    await openHandling(session);
    await screen.findByLabelText("Vatten: vem betalar");

    expect(fetchIssueCharges).not.toHaveBeenCalled();
    expect(screen.queryByText("Debiteringar")).toBeNull();
    expect(screen.queryByText(/1250\.00/)).toBeNull();
    expect(screen.queryByText("Skapa debitering")).toBeNull();
  });

  it("shows the charges made from it, with the amount, and the way to make one", async () => {
    const session = userEvent.setup();
    render(
      <IssueQueuePanel
        issues={[issue()]}
        types={TYPES}
        onChanged={() => undefined}
        canManageCharges
      />,
    );
    await openHandling(session);

    expect(await screen.findByText("1250.00")).toBeTruthy();
    expect(fetchIssueCharges).toHaveBeenCalledWith("issue-1");
    expect(
      screen
        .getByRole("link", { name: "Vatten: skapa debitering" })
        .getAttribute("href"),
    ).toBe("/board/charges?issue=issue-1");
  });

  it("says the charges are withheld, not that there are none, where the API withholds them", async () => {
    fetchIssueCharges.mockResolvedValue({
      ok: true,
      value: {
        issue: {
          issueId: "issue-1",
          typeName: "Vatten",
          costResponsibility: "TENANT_OWNER",
          party: null,
        },
        charges: null,
      },
    });
    const session = userEvent.setup();
    render(
      <IssueQueuePanel
        issues={[issue()]}
        types={TYPES}
        onChanged={() => undefined}
        canManageCharges
      />,
    );
    await openHandling(session);

    expect(
      await screen.findByText(
        "Visas inte: den som anmälde ärendet har skyddade personuppgifter, och en debitering skulle visa vem det är.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Ingen debitering har gjorts från ärendet."),
    ).toBeNull();
  });

  it("reads the charges and the guide again when the queue brings the issue again, so an open panel does not keep an earlier answer", async () => {
    const session = userEvent.setup();
    const view = render(
      <IssueQueuePanel
        issues={[issue()]}
        types={TYPES}
        onChanged={() => undefined}
        canManageCharges
      />,
    );
    await openHandling(session);
    expect(await screen.findByText("1250.00")).toBeTruthy();
    const charges = fetchIssueCharges.mock.calls.length;
    const guides = fetchHandlerResponsibilityGuide.mock.calls.length;

    // The reporter has become protected since: the same read now withholds.
    // Held, so that the window while the newer read is pending is seen.
    let releaseRefresh: () => void = () => undefined;
    fetchIssueCharges.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseRefresh = () => {
          resolve({
            ok: true,
            value: {
              issue: {
                issueId: "issue-1",
                typeName: "Vatten",
                costResponsibility: "TENANT_OWNER",
                party: null,
              },
              charges: null,
            },
          });
        };
      }),
    );
    view.rerender(
      <IssueQueuePanel
        issues={[issue()]}
        types={TYPES}
        onChanged={() => undefined}
        canManageCharges
      />,
    );

    // The last answer for this issue stays while the newer read is pending.
    await waitFor(() => {
      expect(fetchIssueCharges.mock.calls.length).toBeGreaterThan(charges);
    });
    expect(screen.getByText("1250.00")).toBeTruthy();
    releaseRefresh();
    expect(
      await screen.findByText(/Visas inte: den som anmälde ärendet/),
    ).toBeTruthy();
    expect(screen.queryByText("1250.00")).toBeNull();
    expect(fetchIssueCharges.mock.calls.length).toBeGreaterThan(charges);
    expect(fetchHandlerResponsibilityGuide.mock.calls.length).toBeGreaterThan(
      guides,
    );
  });

  it("offers no access switch on a type the board handles alone", async () => {
    const session = userEvent.setup();
    show(issue({ typeHandledBy: "BOARD" }));
    await openHandling(session);

    expect(
      await screen.findByText(
        "Bara styrelsen hanterar ärenden av den här typen.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText("Vatten: bara styrelsen hanterar ärendet"),
    ).toBeNull();
  });

  it("says what each step of the timeline was, and by whom", async () => {
    fetchIssueTimeline.mockResolvedValue({
      ok: true,
      value: [
        { kind: "reported", at: "2026-08-20T08:00:00.000Z", actor: null },
        {
          kind: "assigned",
          at: "2026-08-20T09:00:00.000Z",
          actor: null,
          assignee: {
            kind: "person",
            personId: "p-manager",
            name: "Frida Förvaltare",
          },
          byTypeDefault: true,
        },
        {
          kind: "status",
          at: "2026-08-21T09:00:00.000Z",
          actor: { kind: "protected", personId: "p-shielded" },
          fromMeaning: "NEW",
          toMeaning: "WAITING",
          fromStatusId: "s-new",
          toStatusId: "s-contractor",
          waitingReason: "CONTRACTOR",
          outcome: null,
        },
      ],
    });
    const session = userEvent.setup();
    show();
    await openHandling(session);

    const timeline = (await screen.findByText("Anmält")).closest("ol");
    expect(timeline).not.toBeNull();
    const steps = within(timeline as HTMLElement)
      .getAllByRole("listitem")
      .map((step) => step.textContent);
    expect(steps[1]).toContain(
      "Tilldelat enligt typens standard Frida Förvaltare",
    );
    // The board's own name for the status, from the type.
    expect(steps[2]).toContain("Flyttat till Hos rörmokaren");
    expect(steps[2]).toContain("Namnet visas inte (skyddade personuppgifter)");
  });

  it("adds a status just saved to the timeline while it stays open", async () => {
    const reported = {
      kind: "reported",
      at: "2026-08-20T08:00:00.000Z",
      actor: null,
    };
    fetchIssueTimeline.mockResolvedValueOnce({ ok: true, value: [reported] });
    const session = userEvent.setup();
    const queued = issue();
    const view = render(
      <IssueQueuePanel
        issues={[queued]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );
    await openHandling(session);
    const timeline = (await screen.findByText("Anmält")).closest("ol");
    expect(
      within(timeline as HTMLElement).getAllByRole("listitem"),
    ).toHaveLength(1);

    // The status form saves and the queue reloads: the same open issue comes
    // back in its new status, and the panel is not remounted.
    fetchIssueTimeline.mockResolvedValue({
      ok: true,
      value: [
        reported,
        {
          kind: "status",
          at: "2026-08-21T09:00:00.000Z",
          actor: null,
          fromMeaning: "NEW",
          toMeaning: "IN_PROGRESS",
          fromStatusId: "s-new",
          toStatusId: "s-doing",
          waitingReason: null,
          outcome: null,
        },
      ],
    });
    view.rerender(
      <IssueQueuePanel
        issues={[
          {
            ...queued,
            meaning: "IN_PROGRESS",
            status: { id: "s-doing", label: "Pågår" },
            updatedAt: "2026-08-21T09:00:00.000Z",
          },
        ]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );

    expect(await screen.findByText(/Flyttat till Pågår/)).toBeTruthy();
    expect(fetchIssueTimeline).toHaveBeenCalledTimes(2);
  });

  it("reads the timeline again when a finding is taken off", async () => {
    // Taking the mark off moves neither the issue's revision nor its status,
    // so only the save itself can tell the open timeline to read again.
    const session = userEvent.setup();
    render(
      <IssueQueuePanel
        issues={[
          issue({
            finding: {
              kind: "OVK",
              inspectedOn: "2026-03-10",
              protocol: null,
            },
          }),
        ]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );
    await openHandling(session);
    await waitFor(() => {
      expect(fetchIssueTimeline).toHaveBeenCalledTimes(1);
    });
    // Set after the first read, so only the read the removal starts gets it.
    fetchIssueTimeline.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          kind: "finding",
          at: "2026-08-22T09:00:00.000Z",
          actor: null,
          findingKind: null,
        },
      ],
    });
    expect(
      screen.queryByText("Markeringen som besiktningsanmärkning togs bort"),
    ).toBeNull();

    await session.click(
      await screen.findByRole("button", { name: "Ta bort markeringen" }),
    );

    await waitFor(() => {
      expect(removeIssueFinding).toHaveBeenCalledWith("issue-1");
    });
    expect(
      await screen.findByText(
        "Markeringen som besiktningsanmärkning togs bort",
      ),
    ).toBeTruthy();
    expect(fetchIssueTimeline).toHaveBeenCalledTimes(2);
  });

  it("drops a timeline read that a newer revision superseded", async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    fetchIssueTimeline.mockReturnValueOnce(
      new Promise((resolve) => {
        answerFirst = resolve;
      }),
    );
    const session = userEvent.setup();
    const queued = issue();
    const view = render(
      <IssueQueuePanel
        issues={[queued]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );
    await openHandling(session);
    await waitFor(() => {
      expect(fetchIssueTimeline).toHaveBeenCalledTimes(1);
    });

    fetchIssueTimeline.mockResolvedValue({
      ok: true,
      value: [
        { kind: "reported", at: "2026-08-20T08:00:00.000Z", actor: null },
        {
          kind: "status",
          at: "2026-08-21T09:00:00.000Z",
          actor: null,
          fromMeaning: "NEW",
          toMeaning: "IN_PROGRESS",
          fromStatusId: "s-new",
          toStatusId: "s-doing",
          waitingReason: null,
          outcome: null,
        },
      ],
    });
    view.rerender(
      <IssueQueuePanel
        issues={[
          {
            ...queued,
            meaning: "IN_PROGRESS",
            status: { id: "s-doing", label: "Pågår" },
            updatedAt: "2026-08-21T09:00:00.000Z",
          },
        ]}
        types={TYPES}
        onChanged={() => undefined}
      />,
    );
    expect(await screen.findByText(/Flyttat till Pågår/)).toBeTruthy();

    // The first read answers last, with the timeline as it stood before.
    await act(async () => {
      answerFirst({
        ok: true,
        value: [
          { kind: "reported", at: "2026-08-20T08:00:00.000Z", actor: null },
        ],
      });
      await Promise.resolve();
    });

    expect(screen.getByText(/Flyttat till Pågår/)).toBeTruthy();
  });
});
