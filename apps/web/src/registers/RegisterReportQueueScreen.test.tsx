import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

import "../i18n";
import { RegisterReportQueueScreen } from "./RegisterReportQueueScreen";
import type { RegisterReportQueue } from "./registers-api";

/**
 * The queue of duties towards the cooperative housing register.
 *
 * The assertions that matter are the ones a screenshot review would miss. A
 * passed deadline is the only state on this screen that costs money - Lag
 * (2026:484) 3 kap. 10 § lets Lantmateriet order a late report in under penalty
 * of a fine - so the tests below break the screen's own claim that it is
 * unmistakable: they check that the state is named in words rather than only
 * coloured, that an overdue duty is never rendered as one still inside its
 * window, and that a duty reported after its deadline still says so.
 */

const fetchRegisterReportQueue = vi.fn();
const recordRegisterReportMade = vi.fn();

vi.mock("./registers-api", () => ({
  fetchRegisterReportQueue: () => fetchRegisterReportQueue(),
  recordRegisterReportMade: (input: unknown) => recordRegisterReportMade(input),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
}));

/**
 * One duty of each state, and one of them reported late.
 *
 * The dates are the server's answer and the day counts come with them, which is
 * what the screen renders: nothing here reads a clock, so the fixture can state
 * a passed deadline without the test depending on the day it runs.
 */
const QUEUE: RegisterReportQueue = {
  generatedOn: "2027-07-01",
  counts: { overdue: 1, due: 1, reported: 1 },
  duties: [
    {
      id: "duty-overdue",
      kind: "TERMINATION",
      apartmentId: "apartment-a",
      designation: "Bokgatan 3 1101",
      transferId: null,
      terminationId: "termination-a",
      triggeredOn: "2027-06-01",
      dueOn: "2027-06-15",
      state: "overdue",
      daysUntilDue: -16,
      reportedOn: null,
    },
    {
      id: "duty-due",
      kind: "TRANSFER",
      apartmentId: "apartment-b",
      designation: "Bokgatan 3 1102",
      transferId: "transfer-b",
      terminationId: null,
      triggeredOn: "2027-06-25",
      dueOn: "2027-07-09",
      state: "due",
      daysUntilDue: 8,
      reportedOn: null,
    },
    {
      id: "duty-reported",
      kind: "TRANSFER",
      apartmentId: "apartment-c",
      designation: "Bokgatan 5 1201",
      transferId: "transfer-c",
      terminationId: null,
      triggeredOn: "2027-05-01",
      dueOn: "2027-05-15",
      state: "reported",
      daysUntilDue: -47,
      reportedOn: "2027-05-20",
    },
  ],
};

beforeEach(() => {
  fetchRegisterReportQueue
    .mockReset()
    .mockResolvedValue({ ok: true, value: QUEUE });
  recordRegisterReportMade.mockReset();
});

describe("an overdue duty", () => {
  it("is grouped under its own heading and counted", async () => {
    render(<RegisterReportQueueScreen />);

    expect(await screen.findByText("Bokgatan 3 1101")).toBeTruthy();
    // The group heading, not only a coloured cell. A board member who cannot
    // distinguish the colours reads the same thing.
    expect(screen.getByRole("heading", { name: "Försenade" })).toBeTruthy();
  });

  it("says how many are past the deadline, and why that matters", async () => {
    render(<RegisterReportQueueScreen />);

    // The notice is the signal above the document, and it names the consequence
    // rather than only the count: a deadline nobody explains is a deadline
    // somebody deprioritises.
    expect(
      await screen.findByText(
        /1 anmälan har passerat sin lagstadgade sista dag/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/vite/)).toBeTruthy();
  });

  it("states how far past the deadline it is, as a positive number of days", async () => {
    // Not "-16 days left". The board reads this to decide what to do this week,
    // and a signed number is one more thing to work out at the moment it is
    // least welcome.
    render(<RegisterReportQueueScreen />);

    expect(await screen.findByText("16 dagar över sista dagen")).toBeTruthy();
    expect(screen.queryByText(/-16/)).toBeNull();
  });

  it("is never rendered as a duty still inside its window", async () => {
    /*
     * The regression this file exists for. A screen that grouped by the day
     * count, or that fell through to the "still to report" wording, would put a
     * duty the association can be fined over in with the ones it has a fortnight
     * for - and it would look entirely normal.
     */
    render(<RegisterReportQueueScreen />);

    const overdue = (await screen.findByText("Bokgatan 3 1101")).closest("tr");
    expect(overdue).not.toBeNull();
    expect(within(overdue as HTMLElement).getByText("Försenad")).toBeTruthy();
    expect(
      within(overdue as HTMLElement).queryByText("Kvar att anmäla"),
    ).toBeNull();
    expect(within(overdue as HTMLElement).queryByText(/dagar kvar/)).toBeNull();
  });
});

describe("a duty still inside its window", () => {
  it("counts the days it has left", async () => {
    render(<RegisterReportQueueScreen />);

    const due = (await screen.findByText("Bokgatan 3 1102")).closest("tr");
    expect(
      within(due as HTMLElement).getByText("Kvar att anmäla"),
    ).toBeTruthy();
    expect(within(due as HTMLElement).getByText("8 dagar kvar")).toBeTruthy();
  });
});

describe("a duty that was reported", () => {
  it("stays reported, and still says it was late", async () => {
    /*
     * Both halves matter. Overwriting the state with "overdue" would leave
     * nothing separating a duty somebody dealt with late from one nobody has
     * dealt with at all; dropping the lateness would lose the fact a fine
     * attaches to.
     */
    render(<RegisterReportQueueScreen />);

    const reported = (await screen.findByText("Bokgatan 5 1201")).closest("tr");
    expect(within(reported as HTMLElement).getByText("Anmäld")).toBeTruthy();
    expect(
      within(reported as HTMLElement).getByText(
        "Anmäld 5 dagar efter sista dagen",
      ),
    ).toBeTruthy();
    expect(
      within(reported as HTMLElement).getByText("2027-05-20"),
    ).toBeTruthy();
  });

  it("offers no way to record a second report against it", async () => {
    // The audit log cannot correct an entry, so a second statement about one
    // anmalan is refused by the API. The screen does not offer it either.
    render(<RegisterReportQueueScreen />);

    const reported = (await screen.findByText("Bokgatan 5 1201")).closest("tr");
    expect(
      within(reported as HTMLElement).queryByRole("button", {
        name: /Registrera anmälan/,
      }),
    ).toBeNull();
  });
});

describe("recording that a report was made", () => {
  it("sends the day the board states, and re-reads the queue", async () => {
    const session = userEvent.setup();
    recordRegisterReportMade.mockResolvedValue({
      ok: true,
      value: {
        ...QUEUE.duties[0],
        state: "reported",
        reportedOn: "2027-06-20",
      },
    });
    render(<RegisterReportQueueScreen />);

    await session.click(
      await screen.findByRole("button", {
        name: "Registrera anmälan för Bokgatan 3 1101",
      }),
    );
    await session.type(screen.getByLabelText("Anmäld den"), "2027-06-20");
    await session.click(screen.getByRole("button", { name: "Registrera" }));

    await waitFor(() => {
      expect(recordRegisterReportMade).toHaveBeenCalledWith({
        obligationId: "duty-overdue",
        reportedOn: "2027-06-20",
      });
    });
    // Re-read rather than patched in place: the state and the counts are the
    // server's answer, and a screen that moved the row itself would compute them
    // a second time.
    expect(fetchRegisterReportQueue).toHaveBeenCalledTimes(2);
  });

  it("says the statement cannot be taken back before it is made", async () => {
    const session = userEvent.setup();
    render(<RegisterReportQueueScreen />);

    await session.click(
      await screen.findByRole("button", {
        name: "Registrera anmälan för Bokgatan 3 1101",
      }),
    );

    expect(
      screen.getByText(/kan inte ändras eller tas bort efteråt/),
    ).toBeTruthy();
    // Empty rather than prefilled with today: the day a complete anmalan reached
    // Lantmateriet is a statement, and a prefilled one is a statement the board
    // did not make.
    expect(
      (screen.getByLabelText("Anmäld den") as HTMLInputElement).value,
    ).toBe("");
  });

  it("reports a refusal without pretending the duty was discharged", async () => {
    const session = userEvent.setup();
    recordRegisterReportMade.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "report-already-recorded" },
    });
    render(<RegisterReportQueueScreen />);

    await session.click(
      await screen.findByRole("button", {
        name: "Registrera anmälan för Bokgatan 3 1101",
      }),
    );
    await session.type(screen.getByLabelText("Anmäld den"), "2027-06-20");
    await session.click(screen.getByRole("button", { name: "Registrera" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(fetchRegisterReportQueue).toHaveBeenCalledTimes(1);
  });
});

describe("when the queue cannot be read", () => {
  it("says so rather than showing an empty document", async () => {
    fetchRegisterReportQueue.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    render(<RegisterReportQueueScreen />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Inget att anmäla")).toBeNull();
  });
});

describe("an association with nothing outstanding", () => {
  it("says that no deadline has passed, and why the screen is empty", async () => {
    fetchRegisterReportQueue.mockResolvedValue({
      ok: true,
      value: {
        generatedOn: "2027-07-01",
        counts: { overdue: 0, due: 0, reported: 0 },
        duties: [],
      },
    });
    render(<RegisterReportQueueScreen />);

    expect(await screen.findByText("Inget att anmäla")).toBeTruthy();
    expect(
      screen.getByText("Ingen anmälan har passerat sin sista dag."),
    ).toBeTruthy();
  });
});
