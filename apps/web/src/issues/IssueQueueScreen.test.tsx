import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { IssueReporter, QueuedIssue } from "../api/issues";
import { IssueQueueScreen } from "./IssueQueueScreen";

/**
 * The page the residents' reports are handled from.
 *
 * It is shared by the board and the external property manager, who holds
 * issues:handle and nothing else, so it is signed for both rather than for the
 * board alone - the sign is how a property manager on a phone, with no band in
 * view, is told whose page this is.
 *
 * The API refuses the read whatever the browser was shown, so hiding the queue
 * is courtesy. What is not courtesy is the request: the queue names who
 * reported what from which apartment, and a page that asked for it on a
 * resident's behalf would be asking the server for other people's data with
 * nowhere to put it. So this file asserts the request as well as the panel.
 */

const fetchIssueQueue = vi.fn();
const fetchIssueQueueCounts = vi.fn();
const fetchHandlerIssueTypes = vi.fn();
const fetchOwnIssues = vi.fn();
const setIssueStatus = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueQueue: (input?: unknown) => fetchIssueQueue(input),
  fetchIssueQueueCounts: (input?: unknown) => fetchIssueQueueCounts(input),
  fetchHandlerIssueTypes: () => fetchHandlerIssueTypes(),
  fetchOwnIssues: () => fetchOwnIssues(),
  setIssueStatus: (input: unknown) => setIssueStatus(input),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    className,
    "aria-current": current,
  }: {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
    className?: string;
    "aria-current"?: "page";
  }): ReactElement => (
    <a
      href={
        search === undefined
          ? to
          : `${to}?${new URLSearchParams(search).toString()}`
      }
      aria-current={current}
      className={className}
    >
      {children}
    </a>
  ),
}));

function viewer(capabilities: readonly string[]): Viewer {
  return {
    personId: "person-pia",
    firstName: "Pia",
    lastName: "Förvaltare",
    preferredLocale: "sv",
    capabilities: [...capabilities],
    housingCooperative: null,
  };
}

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

/** The external property manager: the queue, and nothing else of the board's. */
const PROPERTY_MANAGER = ["issues:handle", "self:manage"];

beforeEach(() => {
  fetchIssueQueue.mockReset().mockResolvedValue({ ok: true, value: [issue()] });
  fetchIssueQueueCounts.mockReset().mockResolvedValue({
    ok: true,
    value: { mine: 1, unassigned: 2, overdue: 0, all: 5 },
  });
  fetchHandlerIssueTypes.mockReset().mockResolvedValue({
    ok: true,
    value: [
      {
        id: "type-water",
        name: "Vatten",
        reporters: ["RESIDENTS"],
        active: true,
        sortOrder: 0,
        reportCount: 1,
        statuses: [
          {
            id: "s-new",
            meaning: "NEW",
            label: "Ny",
            isDefault: true,
            active: true,
            sortOrder: 0,
            issueCount: 1,
          },
        ],
      },
    ],
  });
  fetchOwnIssues.mockReset().mockResolvedValue({ ok: true, value: [] });
  setIssueStatus.mockReset().mockResolvedValue({ ok: true, value: issue() });
});

describe("the property manager", () => {
  it("is given the page under the sign it shares with the board", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Styrelse och förvaltare Hantera ärenden",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Det här ser bara styrelsen, föreningens förvaltare och administratören.",
      ),
    ).toBeTruthy();
  });

  it("is given the queue", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    await waitFor(() => {
      expect(screen.getByText("Ärendekön")).toBeTruthy();
    });
    expect(screen.getByText("Det droppar i taket.")).toBeTruthy();
    expect(screen.getByText("Rune Boende")).toBeTruthy();
    expect(fetchIssueQueue).toHaveBeenCalledTimes(1);
    // Mina, of the open issues: the handler's own work, first.
    expect(fetchIssueQueue).toHaveBeenCalledWith({
      view: "MINE",
      meaning: "OPEN",
    });
    // The statuses an issue is moved between, under the queue's own
    // capability: the property manager does not configure types.
    expect(fetchHandlerIssueTypes).toHaveBeenCalledTimes(1);
    expect(
      screen.getByLabelText("Vatten anmält 2026-08-20: status"),
    ).toBeTruthy();
    // A property manager reports nothing here and has no issues of their own
    // to follow; that is the house's page, and not asked for on this one.
    expect(fetchOwnIssues).not.toHaveBeenCalled();
  });
});

describe("a resident", () => {
  it("is told the page is the board's, under no sign, and nothing is read", async () => {
    render(
      <IssueQueueScreen viewer={viewer(["issues:report", "self:manage"])} />,
    );

    expect(
      await screen.findByText(
        "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("Styrelse och förvaltare")).toBeNull();
    expect(screen.queryByText("Ärendekön")).toBeNull();
    expect(fetchIssueQueue).not.toHaveBeenCalled();
    expect(fetchHandlerIssueTypes).not.toHaveBeenCalled();
  });
});

describe("a read that fails", () => {
  it("says so, and does not say nothing has been reported", async () => {
    /*
     * An empty list and a list that failed to arrive are different answers, and
     * the panel has words for only one of them: handed no issues it says nothing
     * has been reported. Said from a request that never answered, that would
     * tell the people who handle the house's faults there are none, and the
     * notice above it would not undo the sentence.
     */
    fetchIssueQueue.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    await waitFor(() => {
      expect(
        screen.getByText("Ärendena kunde inte läsas just nu."),
      ).toBeTruthy();
    });
    expect(screen.queryByText("Ingenting har anmälts.")).toBeNull();
    expect(screen.queryByText("Ärendekön")).toBeNull();
  });
});

/** The views' navigation. */
const views = () => screen.getByRole("navigation", { name: "Vyer" });

/** One of the filter's fields, by its label. */
const field = (label: string) =>
  within(
    screen.getByRole("search", { name: "Sök och filtrera ärenden" }),
  ).getByLabelText(label);

describe("the four views", () => {
  it("opens on Mina, with how many issues each view holds under the same filter", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    const mine = await within(views()).findByRole("link", { name: "Mina 1" });
    expect(mine.getAttribute("aria-current")).toBe("page");
    expect(mine.getAttribute("href")).toBe("/board/issues?view=mine");
    for (const [name, href] of [
      ["Ej tilldelade 2", "/board/issues?view=unassigned"],
      ["Försenade 0", "/board/issues?view=overdue"],
      ["Alla 5", "/board/issues?view=all"],
    ] as const) {
      const link = within(views()).getByRole("link", { name });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("aria-current")).toBeNull();
    }
    // Counted under the filter the list is read by, without the view.
    expect(fetchIssueQueueCounts).toHaveBeenCalledWith({ meaning: "OPEN" });
  });

  it("reads the view the address names", async () => {
    render(
      <IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} view="OVERDUE" />,
    );

    const overdue = await within(views()).findByRole("link", {
      name: "Försenade 0",
    });
    expect(overdue.getAttribute("aria-current")).toBe("page");
    expect(fetchIssueQueue).toHaveBeenCalledWith({
      view: "OVERDUE",
      meaning: "OPEN",
    });
  });

  it("makes the overdue count stand out while there are overdue issues", async () => {
    fetchIssueQueueCounts.mockResolvedValue({
      ok: true,
      value: { mine: 0, unassigned: 0, overdue: 3, all: 3 },
    });
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    const overdue = await within(views()).findByRole("link", {
      name: "Försenade 3",
    });
    expect(overdue.querySelector(".text-danger")?.textContent).toBe("3");
  });

  it("draws the views without numbers when they could not be counted", async () => {
    fetchIssueQueueCounts.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    await screen.findByText("Det droppar i taket.");
    expect(
      within(views())
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Mina", "Ej tilldelade", "Försenade", "Alla"]);
  });

  it("says which view is empty, and says nothing matches once the filter narrows it", async () => {
    fetchIssueQueue.mockResolvedValue({ ok: true, value: [] });
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    expect(
      await screen.findByText("Inga öppna ärenden har dig som ansvarig."),
    ).toBeTruthy();

    await userEvent.selectOptions(field("Prioritet"), "URGENT");
    expect(
      await screen.findByText(
        "Inga ärenden stämmer med sökningen och filtret.",
      ),
    ).toBeTruthy();
  });
});

describe("the filter and the search", () => {
  it("narrows the list and the counts alike by status, type and priority", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} view="ALL" />);
    await screen.findByText("Det droppar i taket.");

    await userEvent.selectOptions(field("Status"), "DONE");
    await userEvent.selectOptions(field("Typ"), "type-water");
    await userEvent.selectOptions(field("Prioritet"), "LOW");

    await waitFor(() => {
      expect(fetchIssueQueue).toHaveBeenLastCalledWith({
        view: "ALL",
        meaning: "DONE",
        typeId: "type-water",
        priority: "LOW",
      });
    });
    expect(fetchIssueQueueCounts).toHaveBeenLastCalledWith({
      meaning: "DONE",
      typeId: "type-water",
      priority: "LOW",
    });
  });

  it("asks for closed issues too only when the status filter says so", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} view="ALL" />);
    await screen.findByText("Det droppar i taket.");

    await userEvent.selectOptions(field("Status"), "Alla, även klara");

    await waitFor(() => {
      expect(fetchIssueQueue).toHaveBeenLastCalledWith({ view: "ALL" });
    });
    expect(fetchIssueQueueCounts).toHaveBeenLastCalledWith({});
  });

  it("searches once the handler stops typing, trimmed, and clears with the filter", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);
    await screen.findByText("Det droppar i taket.");

    await userEvent.type(field("Sök"), "  läcka  ");
    await waitFor(() => {
      expect(fetchIssueQueue).toHaveBeenLastCalledWith({
        view: "MINE",
        meaning: "OPEN",
        search: "läcka",
      });
    });
    expect(fetchIssueQueueCounts).toHaveBeenLastCalledWith({
      meaning: "OPEN",
      search: "läcka",
    });
    // Asked for the word, never once per letter on the way to it.
    expect(
      fetchIssueQueue.mock.calls.filter(
        ([input]) => (input as { search?: string }).search !== undefined,
      ),
    ).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Rensa filter" }));
    await waitFor(() => {
      expect(fetchIssueQueue).toHaveBeenLastCalledWith({
        view: "MINE",
        meaning: "OPEN",
      });
    });
    expect((field("Sök") as HTMLInputElement).value).toBe("");
  });

  it("never draws an earlier filter's answer over a later one's", async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    fetchIssueQueue
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockResolvedValue({
        ok: true,
        value: [issue({ id: "issue-urgent", description: "Akut läcka." })],
      });
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    await userEvent.selectOptions(field("Prioritet"), "URGENT");
    expect(await screen.findByText("Akut läcka.")).toBeTruthy();

    answerFirst({ ok: true, value: [issue()] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("Akut läcka.")).toBeTruthy();
    expect(screen.queryByText("Det droppar i taket.")).toBeNull();
  });
});
