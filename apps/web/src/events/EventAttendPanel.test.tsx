import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { AttendableOccurrence } from "../api/events";
import { EventAttendPanel } from "./EventAttendPanel";

/**
 * Putting your name down for a date, and what the screen says about it.
 *
 * The capacity, the lock and the race are tested on the server against a real
 * database. What this file pins down is the half only a screen can get wrong.
 *
 * That the count and the button come from the same answer, and cannot disagree
 * after a race. Every act ends in a read of the list - whether the act was taken
 * or refused - and the panel shows what came back rather than what it asked for.
 * The refusal that most needs this is the one for a date whose last place has
 * just gone: the sentence says somebody was first, and the number beside it has
 * to say so too.
 *
 * That a date says how many places are gone and never who has them. That is what
 * events:manage exists to gate, so the whole text of a row is asserted rather
 * than merely the absence of a name.
 *
 * That only the row that was clicked reads as busy, and that the four states the
 * server refuses a sign-up for are statements rather than controls.
 */

/**
 * The day the panel believes it is, for as long as these tests run.
 *
 * Whether a date has begun is a comparison against the clock, so an unpinned one
 * would make every fixture below pass or fail depending on the date the suite is
 * run on. April the 1st is chosen for sitting before the fixtures, which are
 * later in April.
 *
 * Only `Date` is replaced. The timers stay real, so `userEvent` needs no
 * `advanceTimers` and `waitFor` behaves as it does everywhere else here.
 */
const TODAY = new Date("2026-04-01T09:00:00.000Z");

const fetchUpcomingOccurrences = vi.fn();
const signUpForOccurrence = vi.fn();
const withdrawFromOccurrence = vi.fn();

vi.mock("../api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/events")>()),
  fetchUpcomingOccurrences: () => fetchUpcomingOccurrences(),
  signUpForOccurrence: (id: string) => signUpForOccurrence(id),
  withdrawFromOccurrence: (id: string) => withdrawFromOccurrence(id),
}));

/** The cleaning day on the 18th of April, with eight of twenty places gone. */
const CLEANING: AttendableOccurrence = {
  occurrenceId: "occurrence-april",
  eventId: "event-cleaning",
  title: "Städdag",
  description: "Ta med handskar.",
  category: "Städdag",
  location: "Innergården",
  startsAt: "2026-04-18T08:00:00.000Z",
  endsAt: "2026-04-18T11:00:00.000Z",
  on: "2026-04-18",
  cancelledAt: null,
  signupOpen: true,
  capacity: 20,
  placesTaken: 8,
  placesLeft: 12,
  own: null,
};

/** The sauna evening the same week, which takes no sign-ups. */
const SAUNA: AttendableOccurrence = {
  occurrenceId: "occurrence-sauna",
  eventId: "event-sauna",
  title: "Bastukväll",
  description: null,
  category: null,
  location: null,
  startsAt: "2026-04-22T16:00:00.000Z",
  endsAt: "2026-04-22T19:00:00.000Z",
  on: "2026-04-22",
  cancelledAt: null,
  signupOpen: false,
  capacity: null,
  placesTaken: 0,
  placesLeft: null,
  own: null,
};

/** The same date with the reader's own place on it. */
const MINE: AttendableOccurrence = {
  ...CLEANING,
  placesTaken: 9,
  placesLeft: 11,
  own: {
    signupId: "signup-elin",
    signedUpAt: "2026-04-02T09:00:00.000Z",
    withdrawnAt: null,
  },
};

/** The same date with its last place gone to somebody else. */
const FULL: AttendableOccurrence = {
  ...CLEANING,
  placesTaken: 20,
  placesLeft: 0,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: TODAY });
  fetchUpcomingOccurrences
    .mockReset()
    .mockResolvedValue({ ok: true, value: [CLEANING, SAUNA] });
  signUpForOccurrence.mockReset().mockResolvedValue({ ok: true, value: MINE });
  withdrawFromOccurrence
    .mockReset()
    .mockResolvedValue({ ok: true, value: CLEANING });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Renders the panel and waits for the first read to land.
 *
 * The wait is on a row and not on the card's heading. A repeating cleaning day
 * puts the same title on several dates, so the marker has to be something only
 * the answer can produce rather than a name that might appear once or twice.
 */
async function open(): Promise<void> {
  render(<EventAttendPanel />);
  await waitFor(() => {
    expect(screen.getAllByRole("article").length).toBeGreaterThan(0);
  });
}

describe("a date somebody can sign up to", () => {
  it("says how many places are gone and never who has them", async () => {
    await open();

    expect(screen.getByText("8 av 20 platser tagna.")).toBeTruthy();
    // The whole row, so a name added to the answer later would fail here rather
    // than being rendered. There is no field in the payload for one, and this is
    // the screen it would have to arrive on.
    const [row] = screen.getAllByRole("article");
    expect(row?.textContent).toBe(
      "StäddagStäddag10:00 till 13:00" +
        "Innergården" +
        "Ta med handskar." +
        "8 av 20 platser tagna." +
        "Anmäl dig",
    );
  });

  it("files it under the local date the server worked out", async () => {
    await open();

    // Not a date derived from the instant in the browser's own zone: the notice
    // in the stairwell says the 18th, and so does this.
    expect(
      screen.getByText("lördag 18 april 2026", { selector: "time" }),
    ).toBeTruthy();
  });
});

describe("taking a place", () => {
  it("sends the date's own identifier", async () => {
    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(
      screen.getByRole("button", {
        name: "Anmäl dig till Städdag den lördag 18 april 2026",
      }),
    );

    await waitFor(() => {
      expect(signUpForOccurrence).toHaveBeenCalledWith("occurrence-april");
    });
  });

  it("reads the calendar again rather than counting its own click", async () => {
    /*
     * The answer to the claim is deliberately ignored. It describes one date
     * while the list describes every date, so another household's claim landing
     * on another row in the meantime would be invisible until something else
     * happened to reload. The count below is the second read's, not the claim's.
     */
    fetchUpcomingOccurrences
      .mockResolvedValueOnce({ ok: true, value: [CLEANING, SAUNA] })
      .mockResolvedValue({
        ok: true,
        value: [{ ...MINE, placesTaken: 12, placesLeft: 8 }, SAUNA],
      });

    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(
      screen.getByRole("button", {
        name: "Anmäl dig till Städdag den lördag 18 april 2026",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("12 av 20 platser tagna.")).toBeTruthy();
    });
    expect(fetchUpcomingOccurrences).toHaveBeenCalledTimes(2);
    // The button follows the same answer, so the two agree: the reader now holds
    // a place and is offered the way out of it.
    expect(
      screen.getByRole("button", {
        name: "Avanmäl dig från Städdag den lördag 18 april 2026",
      }),
    ).toBeTruthy();
  });

  it("puts the busy word on the row that was clicked and no other", async () => {
    let settle = (): void => {};
    signUpForOccurrence.mockReturnValue(
      new Promise((resolve) => {
        settle = () => {
          resolve({ ok: true, value: MINE });
        };
      }),
    );
    // A second date that can also be signed up to, so there is another row for
    // the word to leak onto.
    fetchUpcomingOccurrences.mockResolvedValue({
      ok: true,
      value: [
        CLEANING,
        { ...CLEANING, occurrenceId: "occurrence-may", on: "2026-05-16" },
      ],
    });

    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(
      screen.getByRole("button", {
        name: "Anmäl dig till Städdag den lördag 18 april 2026",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Anmäler...")).toBeTruthy();
    });
    // One row says it, not both. One action serves the whole list, so without a
    // per-row marker a single click would put "Anmäler..." on every date.
    expect(screen.getAllByText("Anmäler...")).toHaveLength(1);
    expect(screen.getByText("Anmäl dig")).toBeTruthy();

    settle();
    await waitFor(() => {
      expect(screen.queryByText("Anmäler...")).toBeNull();
    });
  });
});

describe("losing the last place", () => {
  it("says so and reads the count again, so the two cannot disagree", async () => {
    /*
     * The race, from the screen's side. The reader is looking at twelve free
     * places; by the time they press, the last one has gone. Without the re-read
     * on a refusal the sentence would say the places were gone while the number
     * above it still offered twelve, and the button would still be there.
     */
    fetchUpcomingOccurrences
      .mockResolvedValueOnce({ ok: true, value: [CLEANING] })
      .mockResolvedValue({ ok: true, value: [FULL] });
    signUpForOccurrence.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "occurrence-full" },
    });

    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(
      screen.getByRole("button", {
        name: "Anmäl dig till Städdag den lördag 18 april 2026",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Platserna på tillfället är tagna. Någon hann före, och kalendern har lästs om.",
        ),
      ).toBeTruthy();
    });
    expect(screen.getByText("20 av 20 platser tagna.")).toBeTruthy();
    expect(
      screen.getByText(
        "Platserna är tagna. En blir ledig om någon avanmäler sig.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Anmäl dig till Städdag den lördag 18 april 2026",
      }),
    ).toBeNull();
  });
});

describe("standing down", () => {
  it("is offered on a date this account holds, and gives the place back", async () => {
    fetchUpcomingOccurrences
      .mockResolvedValueOnce({ ok: true, value: [MINE] })
      .mockResolvedValue({ ok: true, value: [CLEANING] });

    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    expect(screen.getByText("Du kommer")).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: "Avanmäl dig från Städdag den lördag 18 april 2026",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Du är avanmäld och platsen är ledig igen."),
      ).toBeTruthy();
    });
    expect(withdrawFromOccurrence).toHaveBeenCalledWith("occurrence-april");
    expect(screen.getByText("8 av 20 platser tagna.")).toBeTruthy();
  });

  it("is offered again after standing down, at the back of the queue", async () => {
    // A withdrawal is a dated close and signing up again clears that date on the
    // same row, so somebody who changed their mind takes a place like anybody
    // else rather than keeping one in reserve.
    fetchUpcomingOccurrences.mockResolvedValue({
      ok: true,
      value: [
        {
          ...CLEANING,
          own: {
            signupId: "signup-elin",
            signedUpAt: "2026-04-02T09:00:00.000Z",
            withdrawnAt: "2026-04-03T09:00:00.000Z",
          },
        },
      ],
    });

    await open();

    expect(screen.queryByText("Du kommer")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Anmäl dig till Städdag den lördag 18 april 2026",
      }),
    ).toBeTruthy();
  });
});

describe("a date with no act to offer", () => {
  it("says an event takes no sign-ups rather than offering a button", async () => {
    await open();

    expect(
      screen.getByText("Det här evenemanget har ingen anmälan. Kom bara."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Anmäl dig till Bastukväll den onsdag 22 april 2026",
      }),
    ).toBeNull();
    // No places sentence either: a series that takes no sign-ups has no count
    // to state, and stating a zero would read as a limit the board never set.
    expect(screen.queryByText("0 av 0 platser tagna.")).toBeNull();
  });

  it("says a date has been called off", async () => {
    fetchUpcomingOccurrences.mockResolvedValue({
      ok: true,
      value: [{ ...CLEANING, cancelledAt: "2026-04-10T09:00:00.000Z" }],
    });

    await open();

    expect(
      screen.getByText("Styrelsen har ställt in det här tillfället."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Anmäl dig till Städdag den lördag 18 april 2026",
      }),
    ).toBeNull();
  });

  it("says a date has begun", async () => {
    // Today's event stays on the list, because a resident looking at it while it
    // runs is entitled to see it. What it does not offer is a place.
    vi.setSystemTime(new Date("2026-04-18T08:00:00.000Z"));
    fetchUpcomingOccurrences.mockResolvedValue({ ok: true, value: [CLEANING] });

    await open();

    expect(
      screen.getByText(
        "Tillfället har börjat, så det går inte att anmäla sig.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Anmäl dig till Städdag den lördag 18 april 2026",
      }),
    ).toBeNull();
  });

  it("still offers the way out of a date that has begun", async () => {
    /*
     * Standing down is not refused once the date has begun: it is a fact about
     * the person's intention with a date on it, and refusing it would only
     * strand somebody who forgot to say so in time.
     */
    vi.setSystemTime(new Date("2026-04-18T08:00:00.000Z"));
    fetchUpcomingOccurrences.mockResolvedValue({ ok: true, value: [MINE] });

    await open();

    expect(
      screen.getByRole("button", {
        name: "Avanmäl dig från Städdag den lördag 18 april 2026",
      }),
    ).toBeTruthy();
  });
});

describe("nothing to show", () => {
  it("says the calendar is empty rather than staying on the loading line", async () => {
    fetchUpcomingOccurrences.mockResolvedValue({ ok: true, value: [] });

    render(<EventAttendPanel />);

    await waitFor(() => {
      expect(screen.getByText("Inget är på gång.")).toBeTruthy();
    });
  });

  it("says the calendar could not be read", async () => {
    fetchUpcomingOccurrences.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<EventAttendPanel />);

    await waitFor(() => {
      expect(
        screen.getByText("Kalendern kunde inte läsas just nu. Ladda om sidan."),
      ).toBeTruthy();
    });
  });
});
