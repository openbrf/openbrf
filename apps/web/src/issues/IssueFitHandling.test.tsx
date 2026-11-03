import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { IssueAttachment, QueuedIssue } from "../api/issues";
import { IssueFitHandling } from "./IssueFitHandling";

/**
 * What is particular to a Swedish house on an issue, for the handler (decisions
 * 29 to 31): the common area, the resident's answer about entering, and the
 * mark of an inspection finding.
 */

const fetchIssuePlaceCounts = vi.fn();
const fetchIssueAttachments = vi.fn();
const setIssuePlace = vi.fn();
const markIssueFinding = vi.fn();
const removeIssueFinding = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssuePlaceCounts: () => fetchIssuePlaceCounts(),
  fetchIssueAttachments: (id: string) => fetchIssueAttachments(id),
  setIssuePlace: (input: unknown) => setIssuePlace(input),
  markIssueFinding: (input: unknown) => markIssueFinding(input),
  removeIssueFinding: (id: string) => removeIssueFinding(id),
}));

const PLACES = [
  { id: "p-lift", name: "Hiss", active: true, issues: 2, open: 1 },
  { id: "p-yard", name: "Gård", active: true, issues: 0, open: 0 },
  { id: "p-sauna", name: "Bastu", active: false, issues: 0, open: 0 },
];

const PROTOCOL: IssueAttachment = {
  id: "att-1",
  url: "/api/media/f-1",
  fileName: "hissbesiktning.pdf",
  contentType: "application/pdf",
  width: null,
  height: null,
  createdAt: "2026-08-20T09:00:00.000Z",
};

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
    place: null,
    description: "Det droppar i taket.",
    apartment: null,
    entry: null,
    finding: null,
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

function renderFit(value: QueuedIssue) {
  const onChanged = vi.fn();
  render(<IssueFitHandling issue={value} onChanged={onChanged} />);
  return onChanged;
}

beforeEach(() => {
  fetchIssuePlaceCounts
    .mockReset()
    .mockResolvedValue({ ok: true, value: PLACES });
  fetchIssueAttachments
    .mockReset()
    .mockResolvedValue({ ok: true, value: [PROTOCOL] });
  setIssuePlace.mockReset().mockResolvedValue({ ok: true, value: issue() });
  markIssueFinding.mockReset().mockResolvedValue({ ok: true, value: issue() });
  removeIssueFinding
    .mockReset()
    .mockResolvedValue({ ok: true, value: issue() });
});

describe("the common area", () => {
  it("offers the places switched on, and saves a chosen one", async () => {
    const session = userEvent.setup();
    const onChanged = renderFit(issue());

    const select = await screen.findByLabelText("Gemensamt utrymme");
    await within(select).findByRole("option", { name: "Hiss" });
    expect(within(select).queryByRole("option", { name: "Bastu" })).toBeNull();

    await session.selectOptions(select, "p-lift");
    await session.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(setIssuePlace).toHaveBeenCalledWith({
        issueId: "issue-1",
        placeId: "p-lift",
      });
    });
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
  });

  it("keeps offering the place an issue stands in after the board switched it off", async () => {
    renderFit(issue({ place: { id: "p-sauna", name: "Bastu" } }));

    const select = await screen.findByLabelText("Gemensamt utrymme");
    await within(select).findByRole("option", { name: "Bastu" });
    expect((select as HTMLSelectElement).value).toBe("p-sauna");
  });
});

describe("permission to enter", () => {
  it("is offered on an issue about an apartment that is still open", async () => {
    renderFit(
      issue({
        apartment: { id: "a-1", number: "1401", address: "Storgatan 12" },
      }),
    );

    expect(await screen.findByText("Tillträde")).toBeTruthy();
    expect(screen.getByLabelText("Ja")).toBeTruthy();
  });

  it("is not offered without an apartment, or once the issue is done", () => {
    const { unmount } = render(
      <IssueFitHandling issue={issue()} onChanged={vi.fn()} />,
    );
    expect(screen.queryByText("Tillträde")).toBeNull();
    unmount();

    render(
      <IssueFitHandling
        issue={issue({
          meaning: "DONE",
          apartment: { id: "a-1", number: "1401", address: "Storgatan 12" },
        })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByText("Tillträde")).toBeNull();
  });
});

describe("the inspection finding", () => {
  it("marks a finding with its protocol and target date", async () => {
    const session = userEvent.setup();
    renderFit(issue());

    await screen.findByRole("option", { name: "hissbesiktning.pdf" });
    await session.selectOptions(screen.getByLabelText("Besiktning"), "OVK");
    await session.type(screen.getByLabelText("Besiktigad den"), "2026-03-10");
    await session.type(screen.getByLabelText("Senast klart"), "2026-09-30");
    await session.selectOptions(screen.getByLabelText(/^protokoll/i), "att-1");
    await session.click(
      screen.getByRole("button", { name: "Markera som anmärkning" }),
    );

    await waitFor(() => {
      expect(markIssueFinding).toHaveBeenCalledWith({
        issueId: "issue-1",
        finding: {
          kind: "OVK",
          inspectedOn: "2026-03-10",
          protocolAttachmentId: "att-1",
          targetDate: "2026-09-30",
        },
      });
    });
  });

  it("holds a lift to a month from the inspection, and says so before it is refused", async () => {
    const session = userEvent.setup();
    renderFit(issue());

    await screen.findByRole("option", { name: "hissbesiktning.pdf" });
    await session.selectOptions(screen.getByLabelText("Besiktning"), "LIFT");
    await session.type(screen.getByLabelText("Besiktigad den"), "2026-01-31");

    // 31 January is a month on at the end of February.
    expect(screen.getByText(/BFS 2025:11 1 kap\. 17 §/)).toBeTruthy();
    expect(screen.getByText("2026-02-28")).toBeTruthy();

    await session.type(screen.getByLabelText("Senast klart"), "2026-03-05");
    await session.selectOptions(screen.getByLabelText(/^protokoll/i), "att-1");
    expect(
      (
        screen.getByRole("button", {
          name: "Markera som anmärkning",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    // The standing rule, and the warning that this date is past it.
    expect(
      screen.getAllByText(/inom en månad från besiktningen/i).length,
    ).toBeGreaterThanOrEqual(2);
    expect(markIssueFinding).not.toHaveBeenCalled();
  });

  it("offers the latest day for a lift", async () => {
    const session = userEvent.setup();
    renderFit(issue());

    await screen.findByRole("option", { name: "hissbesiktning.pdf" });
    await session.selectOptions(screen.getByLabelText("Besiktning"), "LIFT");
    await session.type(screen.getByLabelText("Besiktigad den"), "2026-03-15");
    await session.click(
      screen.getByRole("button", { name: "Använd det datumet" }),
    );

    expect(
      (screen.getByLabelText("Senast klart") as HTMLInputElement).value,
    ).toBe("2026-04-15");
  });

  it("asks for the protocol to be attached first when the issue has no file", async () => {
    fetchIssueAttachments.mockResolvedValue({ ok: true, value: [] });
    renderFit(issue());

    expect(
      await screen.findByText(/bifoga protokollet under filer först/i),
    ).toBeTruthy();
  });

  it("shows a finding, and takes the mark off", async () => {
    const session = userEvent.setup();
    renderFit(
      issue({
        targetDate: "2026-09-30",
        finding: {
          kind: "OVK",
          inspectedOn: "2026-03-10",
          protocol: { attachmentId: "att-1", fileName: "hissbesiktning.pdf" },
        },
      }),
    );

    expect(
      await screen.findByText(
        /markerat som besiktningsanmärkning: ventilation/i,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Protokoll: hissbesiktning.pdf")).toBeTruthy();

    await session.click(
      screen.getByRole("button", { name: "Ta bort markeringen" }),
    );
    await waitFor(() => {
      expect(removeIssueFinding).toHaveBeenCalledWith("issue-1");
    });
  });

  it("says in words what the server refused", async () => {
    const session = userEvent.setup();
    markIssueFinding.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "finding-protocol-not-found" },
    });
    renderFit(issue());

    await screen.findByRole("option", { name: "hissbesiktning.pdf" });
    await session.selectOptions(screen.getByLabelText("Besiktning"), "FIRE");
    await session.type(screen.getByLabelText("Besiktigad den"), "2026-03-10");
    await session.type(screen.getByLabelText("Senast klart"), "2026-09-30");
    await session.selectOptions(screen.getByLabelText(/^protokoll/i), "att-1");
    await session.click(
      screen.getByRole("button", { name: "Markera som anmärkning" }),
    );

    expect(
      await screen.findByText(/inte längre bifogad ärendet/i),
    ).toBeTruthy();
  });
});
