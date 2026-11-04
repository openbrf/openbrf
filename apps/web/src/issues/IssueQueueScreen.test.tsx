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

const fetchIssueQueueSnapshot = vi.fn();
const fetchHandlerIssueTypes = vi.fn();
const fetchOwnIssues = vi.fn();
const setIssueStatus = vi.fn();
const fetchIssuePlaceCounts = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueQueueSnapshot: (input: unknown) => fetchIssueQueueSnapshot(input),
  fetchHandlerIssueTypes: () => fetchHandlerIssueTypes(),
  fetchOwnIssues: () => fetchOwnIssues(),
  fetchIssuePlaceCounts: () => fetchIssuePlaceCounts(),
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
    number: 7,
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
    ...overrides,
  } as QueuedIssue;
}

/** The counts the queue is answered with unless a test says otherwise. */
const COUNTS = { mine: 1, unassigned: 2, overdue: 0, all: 5 };

/** A snapshot of the queue: one view's issues and every view's count. */
function answer(
  issues: readonly QueuedIssue[],
  counts: Record<keyof typeof COUNTS, number> = COUNTS,
) {
  return { ok: true, value: { issues: [...issues], counts } };
}

/** The external property manager: the queue, and nothing else of the board's. */
const PROPERTY_MANAGER = ["issues:handle", "self:manage"];

/** The one type the queue's issues are of, with a status to move to. */
const typeWater = {
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
    {
      id: "s-doing",
      meaning: "IN_PROGRESS",
      label: "Pågår",
      isDefault: false,
      active: true,
      sortOrder: 1,
      issueCount: 0,
    },
  ],
};

beforeEach(() => {
  fetchIssueQueueSnapshot.mockReset().mockResolvedValue(answer([issue()]));
  fetchHandlerIssueTypes
    .mockReset()
    .mockResolvedValue({ ok: true, value: [typeWater] });
  fetchOwnIssues.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchIssuePlaceCounts.mockReset().mockResolvedValue({ ok: true, value: [] });
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
    expect(fetchIssueQueueSnapshot).toHaveBeenCalledTimes(1);
    // Mina, of the open issues: the handler's own work, first.
    expect(fetchIssueQueueSnapshot).toHaveBeenCalledWith({
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
    expect(fetchIssueQueueSnapshot).not.toHaveBeenCalled();
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
    fetchIssueQueueSnapshot.mockResolvedValue({
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
    // Opening an issue needs the types, not the queue.
    expect(screen.getByText("Lägg upp ett ärende")).toBeTruthy();
  });

  it("does not hold the list and its numbers behind a slow read of the types", async () => {
    fetchHandlerIssueTypes.mockReset().mockReturnValue(new Promise(() => {}));

    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    expect(await screen.findByText("Det droppar i taket.")).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Vyer" }))
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Mina 1", "Ej tilldelade 2", "Försenade 0", "Alla 5"]);
    expect(screen.queryByText("Hämtar ärendena...")).toBeNull();
    // Nothing to move an issue between yet, and nothing said to have failed.
    expect(
      screen.queryByLabelText("Vatten anmält 2026-08-20: status"),
    ).toBeNull();
    expect(screen.queryByText("Lägg upp ett ärende")).toBeNull();
  });

  it("reads the types alone on their retry, and keeps the list on screen", async () => {
    fetchHandlerIssueTypes.mockReset().mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    expect(
      await screen.findByText(
        "Statusarna kunde inte läsas just nu, så ärenden kan inte flyttas.",
      ),
    ).toBeTruthy();
    expect(fetchIssueQueueSnapshot).toHaveBeenCalledTimes(1);

    // The queue would fail now, were it read again.
    fetchIssueQueueSnapshot.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    fetchHandlerIssueTypes.mockResolvedValue({ ok: true, value: [typeWater] });

    await userEvent.click(screen.getByRole("button", { name: "Försök igen" }));

    await waitFor(() => {
      expect(fetchHandlerIssueTypes).toHaveBeenCalledTimes(2);
    });
    expect(fetchIssueQueueSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Det droppar i taket.")).toBeTruthy();
    expect(screen.queryByText("Ärendena kunde inte läsas just nu.")).toBeNull();
    // The types the retry read are the ones on screen: the issue can be moved
    // to a status of its type, and nothing says the statuses are unavailable.
    const status = await screen.findByLabelText(
      "Vatten anmält 2026-08-20: status",
    );
    expect(within(status).getByRole("option", { name: "Pågår" })).toBeTruthy();
    expect(
      screen.queryByText(
        "Statusarna kunde inte läsas just nu, så ärenden kan inte flyttas.",
      ),
    ).toBeNull();
  });
});

/** The views' navigation. */
const views = () => screen.getByRole("navigation", { name: "Vyer" });

/** The views' links as they read, numbers and all. */
const viewNames = () =>
  within(views())
    .getAllByRole("link")
    .map((link) => link.textContent);

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
    // Counted in the read of the list, under the filter it is read by.
    expect(fetchIssueQueueSnapshot).toHaveBeenCalledWith({
      view: "MINE",
      meaning: "OPEN",
    });
  });

  it("reads the view the address names", async () => {
    render(
      <IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} view="OVERDUE" />,
    );

    const overdue = await within(views()).findByRole("link", {
      name: "Försenade 0",
    });
    expect(overdue.getAttribute("aria-current")).toBe("page");
    expect(fetchIssueQueueSnapshot).toHaveBeenCalledWith({
      view: "OVERDUE",
      meaning: "OPEN",
    });
  });

  it("makes the overdue count stand out while there are overdue issues", async () => {
    fetchIssueQueueSnapshot.mockResolvedValue(
      answer([issue()], { mine: 0, unassigned: 0, overdue: 3, all: 3 }),
    );
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    const overdue = await within(views()).findByRole("link", {
      name: "Försenade 3",
    });
    expect(overdue.querySelector(".text-danger")?.textContent).toBe("3");
  });

  it("draws the views without numbers when the queue could not be read", async () => {
    fetchIssueQueueSnapshot.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    await screen.findByText("Ärendena kunde inte läsas just nu.");
    expect(
      within(views())
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Mina", "Ej tilldelade", "Försenade", "Alla"]);
  });

  it("says which view is empty, and says nothing matches once the filter narrows it", async () => {
    fetchIssueQueueSnapshot.mockResolvedValue(answer([]));
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    expect(
      await screen.findByText("Inga öppna ärenden har dig som ansvarig."),
    ).toBeTruthy();

    await userEvent.selectOptions(field("Prioritet"), "URGENT");
    expect(
      await screen.findByText("Inga ärenden stämmer med filtren just nu."),
    ).toBeTruthy();
  });
});

describe("the filter and the search", () => {
  it("narrows the list and the counts alike by status, type and priority", async () => {
    // The filtered request is answered with counts of its own, so counts kept
    // from the filter before it would show.
    fetchIssueQueueSnapshot.mockImplementation(async (input) =>
      (input as { priority?: string }).priority === "LOW"
        ? answer([issue()], { mine: 0, unassigned: 0, overdue: 0, all: 1 })
        : answer([issue()]),
    );
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} view="ALL" />);
    await screen.findByText("Det droppar i taket.");

    await userEvent.selectOptions(field("Status"), "DONE");
    await userEvent.selectOptions(field("Typ"), "type-water");
    await userEvent.selectOptions(field("Prioritet"), "LOW");

    await waitFor(() => {
      expect(fetchIssueQueueSnapshot).toHaveBeenLastCalledWith({
        view: "ALL",
        meaning: "DONE",
        typeId: "type-water",
        priority: "LOW",
      });
    });
    await waitFor(() => {
      expect(viewNames()).toEqual([
        "Mina 0",
        "Ej tilldelade 0",
        "Försenade 0",
        "Alla 1",
      ]);
    });
  });

  it("asks for closed issues too only when the status filter says so", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} view="ALL" />);
    await screen.findByText("Det droppar i taket.");

    await userEvent.selectOptions(field("Status"), "Alla, även klara");

    await waitFor(() => {
      expect(fetchIssueQueueSnapshot).toHaveBeenLastCalledWith({ view: "ALL" });
    });
  });

  it("searches once the handler stops typing, trimmed, and clears with the filter", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);
    await screen.findByText("Det droppar i taket.");

    await userEvent.type(field("Sök"), "  läcka  ");
    await waitFor(() => {
      expect(fetchIssueQueueSnapshot).toHaveBeenLastCalledWith({
        view: "MINE",
        meaning: "OPEN",
        search: "läcka",
      });
    });
    // Asked for the word, never once per letter on the way to it.
    expect(
      fetchIssueQueueSnapshot.mock.calls.filter(
        ([input]) => (input as { search?: string }).search !== undefined,
      ),
    ).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Rensa filter" }));
    await waitFor(() => {
      expect(fetchIssueQueueSnapshot).toHaveBeenLastCalledWith({
        view: "MINE",
        meaning: "OPEN",
      });
    });
    expect((field("Sök") as HTMLInputElement).value).toBe("");
  });

  it("never draws an earlier filter's answer over a later one's", async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    fetchIssueQueueSnapshot
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockResolvedValue(
        answer([issue({ id: "issue-urgent", description: "Akut läcka." })]),
      );
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    await userEvent.selectOptions(field("Prioritet"), "URGENT");
    expect(await screen.findByText("Akut läcka.")).toBeTruthy();

    answerFirst(answer([issue()]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("Akut läcka.")).toBeTruthy();
    expect(screen.queryByText("Det droppar i taket.")).toBeNull();
  });
});

describe("a save that finishes under another view or filter", () => {
  /** Holds the next save open until the test answers it. */
  function deferSave(): (value: unknown) => void {
    let finish: (value: unknown) => void = () => undefined;
    setIssueStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    return (value) => {
      finish(value);
    };
  }

  async function startSave(): Promise<(value: unknown) => void> {
    const finish = deferSave();
    await userEvent.selectOptions(
      screen.getByLabelText("Vatten anmält 2026-08-20: status"),
      "s-doing",
    );
    await userEvent.click(screen.getByRole("button", { name: "Spara status" }));
    await waitFor(() => {
      expect(setIssueStatus).toHaveBeenCalledTimes(1);
    });
    return finish;
  }

  it("marks the list busy while the read after a save is out", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);
    await screen.findByText("Det droppar i taket.");
    const finish = await startSave();

    let answerReread: (value: unknown) => void = () => undefined;
    fetchIssueQueueSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerReread = resolve;
        }),
    );
    finish({ ok: true, value: issue() });

    expect(await screen.findByText("Hämtar ärendena...")).toBeTruthy();
    const list = screen
      .getByText("Det droppar i taket.")
      .closest("[aria-busy]");
    expect(list?.getAttribute("aria-busy")).toBe("true");

    answerReread(answer([issue()]));
    await waitFor(() => {
      expect(screen.queryByText("Hämtar ärendena...")).toBeNull();
    });
    expect(list?.getAttribute("aria-busy")).toBe("false");
  });

  it("turns the status form and the handling off while the read after a save is out", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);
    await screen.findByText("Det droppar i taket.");
    await userEvent.click(screen.getByText(/^Hantera Vatten:/));
    const finish = await startSave();

    let answerReread: (value: unknown) => void = () => undefined;
    fetchIssueQueueSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerReread = resolve;
        }),
    );
    finish({ ok: true, value: issue() });
    await screen.findByText("Hämtar ärendena...");

    const status = screen.getByLabelText(
      "Vatten anmält 2026-08-20: status",
    ) as HTMLSelectElement;
    expect(status.disabled).toBe(true);
    // The handling under the row sits in a disabled fieldset, so every control
    // in it is off with it.
    const fieldset = document.querySelector("details fieldset");
    expect(fieldset?.hasAttribute("disabled")).toBe(true);

    answerReread(answer([issue()]));
    await waitFor(() => {
      expect(screen.queryByText("Hämtar ärendena...")).toBeNull();
    });
    expect(
      (
        screen.getByLabelText(
          "Vatten anmält 2026-08-20: status",
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(false);
    expect(
      document.querySelector("details fieldset")?.hasAttribute("disabled"),
    ).toBe(false);
  });

  it("keeps the types' retry beside the notice of a save that failed", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);
    await screen.findByText("Det droppar i taket.");

    // The save is refused as out of date; the types read after it fail.
    fetchHandlerIssueTypes.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    setIssueStatus.mockResolvedValueOnce({
      ok: false,
      failure: { status: 404, reason: "status-not-found" },
    });
    await userEvent.selectOptions(
      screen.getByLabelText("Vatten anmält 2026-08-20: status"),
      "s-doing",
    );
    await userEvent.click(screen.getByRole("button", { name: "Spara status" }));

    expect(
      await screen.findByText(
        "Den statusen erbjuds inte längre för den här typen. Kön har lästs om.",
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        "Statusarna kunde inte läsas just nu, så ärenden kan inte flyttas.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Försök igen" })).toBeTruthy();
    // It appears over a screen the reader is already on, so it is announced.
    expect(
      screen
        .getByText(
          "Statusarna kunde inte läsas just nu, så ärenden kan inte flyttas.",
        )
        .closest("[role='alert']"),
    ).not.toBeNull();
  });

  it("reads the view the handler moved to, not the one the save began in", async () => {
    const { rerender } = render(
      <IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} view="MINE" />,
    );
    await screen.findByText("Det droppar i taket.");
    const finish = await startSave();

    fetchIssueQueueSnapshot.mockResolvedValue(
      answer([issue({ id: "issue-all", description: "Hela kön." })], {
        mine: 0,
        unassigned: 4,
        overdue: 0,
        all: 4,
      }),
    );
    rerender(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} view="ALL" />);
    expect(await screen.findByText("Hela kön.")).toBeTruthy();

    finish({ ok: true, value: issue({ id: "issue-all" }) });
    await waitFor(() => {
      expect(fetchIssueQueueSnapshot).toHaveBeenCalledTimes(3);
    });
    expect(
      fetchIssueQueueSnapshot.mock.calls.map(
        ([input]) => (input as { view: string }).view,
      ),
    ).toEqual(["MINE", "ALL", "ALL"]);
    await waitFor(() => {
      expect(screen.queryByText("Hämtar ärendena...")).toBeNull();
    });
    expect(screen.getByText("Hela kön.")).toBeTruthy();
    expect(screen.queryByText("Det droppar i taket.")).toBeNull();
    expect(viewNames()).toEqual([
      "Mina 0",
      "Ej tilldelade 4",
      "Försenade 0",
      "Alla 4",
    ]);
  });

  it("reads under the filter the handler set while it was saving", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);
    await screen.findByText("Det droppar i taket.");
    const finish = await startSave();

    fetchIssueQueueSnapshot.mockResolvedValue(
      answer([issue({ id: "issue-urgent", description: "Akut läcka." })]),
    );
    await userEvent.selectOptions(field("Prioritet"), "URGENT");
    expect(await screen.findByText("Akut läcka.")).toBeTruthy();

    finish({ ok: true, value: issue() });
    await waitFor(() => {
      expect(fetchIssueQueueSnapshot).toHaveBeenCalledTimes(3);
    });
    expect(fetchIssueQueueSnapshot).toHaveBeenLastCalledWith({
      view: "MINE",
      meaning: "OPEN",
      priority: "URGENT",
    });
    await waitFor(() => {
      expect(screen.queryByText("Hämtar ärendena...")).toBeNull();
    });
    expect(screen.getByText("Akut läcka.")).toBeTruthy();
    expect(screen.queryByText("Det droppar i taket.")).toBeNull();
  });
});

describe("the place filter", () => {
  /** The whole queue holds a water leak; narrowed to the lift, a stuck lift. */
  function queueByPlace(): void {
    fetchIssueQueueSnapshot.mockImplementation((input: { placeId?: string }) =>
      Promise.resolve(
        input.placeId === "p-lift"
          ? answer([
              issue({ id: "issue-lift", description: "Hissen står still." }),
            ])
          : answer([
              issue({ id: "issue-water", description: "Det droppar i taket." }),
            ]),
      ),
    );
  }

  /** The place each read of the queue asked for, in order. */
  function placesAsked(): (string | undefined)[] {
    return fetchIssueQueueSnapshot.mock.calls.map(
      ([input]) => (input as { placeId?: string }).placeId,
    );
  }

  const LIFT = { id: "p-lift", name: "Hiss", active: true, issues: 1, open: 1 };

  it("narrows the view to the place chosen, and the filter's clear leaves it", async () => {
    const session = userEvent.setup();
    queueByPlace();
    fetchIssuePlaceCounts.mockResolvedValue({ ok: true, value: [LIFT] });
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    await session.click(
      await screen.findByRole("button", { name: "Visa bara Hiss" }),
    );

    expect(await screen.findByText("Hissen står still.")).toBeTruthy();
    expect(screen.queryByText("Det droppar i taket.")).toBeNull();
    // The place narrows the view the screen opened on, with its filter.
    expect(fetchIssueQueueSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        view: "MINE",
        meaning: "OPEN",
        placeId: "p-lift",
      }),
    );

    await session.click(screen.getByRole("button", { name: "Rensa filter" }));

    expect(await screen.findByText("Det droppar i taket.")).toBeTruthy();
    expect(placesAsked().at(-1)).toBeUndefined();
  });

  it("is dropped when the counts cannot be read, so the whole queue is back", async () => {
    const session = userEvent.setup();
    queueByPlace();
    fetchIssuePlaceCounts.mockResolvedValue({ ok: true, value: [LIFT] });
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);
    const only = await screen.findByRole("button", { name: "Visa bara Hiss" });

    // The read the choice causes cannot give the counts: with no panel to
    // leave the place from, the queue is read again without it.
    fetchIssuePlaceCounts.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    await session.click(only);

    await waitFor(() => {
      expect(placesAsked()).toContain("p-lift");
    });
    await waitFor(() => {
      expect(placesAsked().at(-1)).toBeUndefined();
    });
    // The unnarrowed answer is the one drawn, not the lift's.
    expect(await screen.findByText("Det droppar i taket.")).toBeTruthy();
    expect(screen.queryByText("Hissen står still.")).toBeNull();
  });

  it("is dropped when the counts no longer list the place", async () => {
    const session = userEvent.setup();
    queueByPlace();
    fetchIssuePlaceCounts.mockResolvedValue({ ok: true, value: [LIFT] });
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);
    const only = await screen.findByRole("button", { name: "Visa bara Hiss" });

    // Switched off with nothing left on it, the lift drops out of the counts,
    // and with it the row that holds the way back to the whole queue.
    fetchIssuePlaceCounts.mockResolvedValue({ ok: true, value: [] });
    await session.click(only);

    await waitFor(() => {
      expect(placesAsked()).toContain("p-lift");
    });
    await waitFor(() => {
      expect(placesAsked().at(-1)).toBeUndefined();
    });
    expect(await screen.findByText("Det droppar i taket.")).toBeTruthy();
    expect(screen.queryByText("Hissen står still.")).toBeNull();
  });
});
