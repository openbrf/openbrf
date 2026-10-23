import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Meeting } from "../api/meetings";
import {
  addedPositions,
  agendaProposalOf,
  droppedPositions,
} from "./MeetingAgendaPreview";
import type { PendingChange } from "./pending-changes-api";
import { PendingChangesScreen } from "./PendingChangesScreen";

/**
 * What a person confirming a proposed agenda is shown beside the bare ids: the
 * meeting, the agenda it has now, the one it would leave, and the items it
 * drops. The generic preview stays under it, so the ids are still shown.
 */

const fetchMyPendingChanges = vi.fn();
const fetchMeeting = vi.fn();

vi.mock("./pending-changes-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pending-changes-api")>()),
  fetchMyPendingChanges: () => fetchMyPendingChanges(),
}));

vi.mock("../api/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/meetings")>()),
  fetchMeeting: (id: string) => fetchMeeting(id),
}));

const CHANGE: PendingChange = {
  id: "pending-agenda",
  action: {
    title: "Ange dagordning",
    description: "Ersätter dagordningen för en stämma.",
    effect: "write",
    needsConfirmation: false,
    errors: [],
  },
  actionName: "meeting_set_agenda",
  input: {
    meetingId: "meeting-1",
    expectedItemIds: ["item-1", "item-2"],
    items: [
      { title: "Val av ordförande" },
      { title: "Val av revisor" },
      { title: "Övriga frågor" },
    ],
  },
  channel: "AI",
  clientHost: null,
  proposedAt: "2026-10-20T08:00:00.000Z",
  expiresAt: "2026-10-27T08:00:00.000Z",
};

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting-1",
    kind: "ORDINARY",
    heldOn: "2026-11-12",
    concludedAt: null,
    summoned: false,
    agendaItemCount: 2,
    agenda: [
      { id: "item-1", position: 1, title: "Val av ordförande", decision: null },
      {
        id: "item-2",
        position: 2,
        title: "Fråga om vaktmästeri",
        decision: null,
      },
    ],
    ...overrides,
  } as Meeting;
}

beforeEach(() => {
  fetchMyPendingChanges.mockReset();
  fetchMeeting.mockReset();
  fetchMyPendingChanges.mockResolvedValue({
    ok: true,
    value: { pendingChanges: [CHANGE] },
  });
  fetchMeeting.mockResolvedValue({ ok: true, value: meeting() });
});

describe("the agenda preview", () => {
  it("names the meeting and sets the agenda now beside the proposed one", async () => {
    render(<PendingChangesScreen />);

    const current = await screen.findByRole("region", {
      name: "Dagordningen nu",
    });
    const proposed = screen.getByRole("region", {
      name: "Den föreslagna dagordningen",
    });
    expect(fetchMeeting).toHaveBeenCalledWith("meeting-1");
    expect(screen.getByText("Ordinarie föreningsstämma")).toBeTruthy();
    expect(screen.getByText(/12 nov/)).toBeTruthy();
    expect(within(current).getByText("Fråga om vaktmästeri")).toBeTruthy();
    expect(within(proposed).getByText("Övriga frågor")).toBeTruthy();
  });

  it("marks the item the proposal drops and the ones it adds, in words", async () => {
    render(<PendingChangesScreen />);

    const current = await screen.findByRole("region", {
      name: "Dagordningen nu",
    });
    const proposed = screen.getByRole("region", {
      name: "Den föreslagna dagordningen",
    });
    const dropped = within(current)
      .getByText("Fråga om vaktmästeri")
      .closest("li");
    expect(within(dropped as HTMLElement).getByText("Tas bort")).toBeTruthy();
    expect(within(current).getAllByText("Tas bort")).toHaveLength(1);
    expect(within(proposed).getAllByText("Ny")).toHaveLength(2);
    expect(
      screen.getByText(/1 punkt på dagordningen nu finns inte/),
    ).toBeTruthy();
  });

  it("says when the agenda has changed since it was proposed", async () => {
    fetchMeeting.mockResolvedValue({
      ok: true,
      value: meeting({
        agenda: [
          {
            id: "item-1",
            position: 1,
            title: "Val av ordförande",
            decision: null,
          },
          {
            id: "item-9",
            position: 2,
            title: "Fråga om vaktmästeri",
            decision: null,
          },
        ],
      }),
    });

    render(<PendingChangesScreen />);

    expect(
      await screen.findByText(/Dagordningen har ändrats sedan detta föreslogs/),
    ).toBeTruthy();
  });

  it("does not say it changed when the ids are the ones it was written against", async () => {
    render(<PendingChangesScreen />);

    await screen.findByRole("region", { name: "Dagordningen nu" });
    expect(screen.queryByText(/har ändrats sedan detta föreslogs/)).toBeNull();
  });

  it("warns when the notice is issued, since the agenda can then not change", async () => {
    fetchMeeting.mockResolvedValue({
      ok: true,
      value: meeting({ summoned: true }),
    });

    render(<PendingChangesScreen />);

    expect(
      await screen.findByText(/Kallelsen till den här stämman är utfärdad/),
    ).toBeTruthy();
  });

  it("keeps the generic preview, with the ids, under it", async () => {
    render(<PendingChangesScreen />);

    await screen.findByRole("region", { name: "Dagordningen nu" });
    expect(screen.getByText("meetingId")).toBeTruthy();
    expect(screen.getByText("meeting-1")).toBeTruthy();
    expect(screen.getByText("item-2")).toBeTruthy();
  });

  it("shows a markup title as text", async () => {
    fetchMeeting.mockResolvedValue({
      ok: true,
      value: meeting({
        agenda: [
          {
            id: "item-1",
            position: 1,
            title: '<img src="x" alt="leak">',
            decision: null,
          },
          {
            id: "item-2",
            position: 2,
            title: "Val av revisor",
            decision: null,
          },
        ],
      }),
    });

    const { container } = render(<PendingChangesScreen />);

    await screen.findByRole("region", { name: "Dagordningen nu" });
    expect(
      screen.getAllByText('<img src="x" alt="leak">').length,
    ).toBeGreaterThan(0);
    expect(container.querySelector("img")).toBeNull();
  });

  it("says the meeting could not be read, and reads it again on request", async () => {
    fetchMeeting.mockResolvedValueOnce({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });
    const user = userEvent.setup();

    render(<PendingChangesScreen />);

    expect(await screen.findByText(/Stämman kunde inte läsas/)).toBeTruthy();
    // The generic preview is still there to confirm against.
    expect(screen.getByText("meeting-1")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /försök igen/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("region", { name: "Dagordningen nu" }),
      ).toBeTruthy();
    });
    expect(fetchMeeting).toHaveBeenCalledTimes(2);
  });

  it("adds nothing to a change whose input is not an agenda", async () => {
    fetchMyPendingChanges.mockResolvedValue({
      ok: true,
      value: { pendingChanges: [{ ...CHANGE, input: { meetingId: 4 } }] },
    });

    render(<PendingChangesScreen />);

    await screen.findByRole("heading", { name: "Ange dagordning" });
    expect(fetchMeeting).not.toHaveBeenCalled();
  });
});

describe("matching items by title", () => {
  it("matches a repeated title one for one", () => {
    expect([...droppedPositions(["A", "A", "B"], ["A", "B"])]).toEqual([1]);
    expect([...addedPositions(["A", "B"], ["A", "A", "B"])]).toEqual([1]);
  });

  it("drops everything when the proposal shares no title", () => {
    expect([...droppedPositions(["A", "B"], ["C"])]).toEqual([0, 1]);
  });

  it("reads only a well-formed input as a proposal", () => {
    expect(agendaProposalOf(null)).toBeNull();
    expect(
      agendaProposalOf({ meetingId: "m", expectedItemIds: [], items: [{}] }),
    ).toBeNull();
    expect(
      agendaProposalOf({
        meetingId: "m",
        expectedItemIds: [],
        items: [{ title: "A" }],
      }),
    ).toEqual({ meetingId: "m", expectedItemIds: [], titles: ["A"] });
  });
});
