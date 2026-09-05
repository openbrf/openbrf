import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { EventSeries } from "../api/events";
import { EventAdminPanel } from "./EventAdminPanel";

/**
 * The calendar the board keeps.
 *
 * The recurrence generator, the personal-identity-number scan, the refusal to
 * move a date people are standing on and the audit entries are all tested on the
 * server. What this file pins down is the half only a screen can get wrong.
 *
 * That the two refusals which publish particulars turn them into something the
 * board can act on: the fields a personal identity number was found in, named as
 * the form names them, and the dates people have signed up to, so the board knows
 * which ones to call off. Both are read off the response - a screen that guessed
 * would send somebody to edit text that holds nothing.
 *
 * That publishing states the audience and taking down does not, because taking a
 * series down says nothing about who it was arranged for.
 *
 * That the list is read again after a refusal as well as after a success. Most of
 * these refusals are about state the board is looking at, so the list it goes
 * back to has to be the current one.
 *
 * That who is coming is read when it is opened and not with the series, because a
 * weekly series would otherwise put a year of residents' names through one screen.
 *
 * That the read is a period, that earlier and later move it by exactly the window
 * the API answers for, and that a card states how many dates the series has
 * rather than how many of them the period holds.
 *
 * That a called-off date offers the way back while it is still ahead and offers
 * nothing once it has begun - read off the row, because the server decided it.
 */

const TODAY = new Date("2026-04-01T09:00:00.000Z");

const fetchEventSeries = vi.fn();
const createEventSeries = vi.fn();
const updateEventSeries = vi.fn();
const publishEventSeries = vi.fn();
const cancelEventOccurrence = vi.fn();
const reinstateEventOccurrence = vi.fn();
const removeEventSeries = vi.fn();
const fetchRollCall = vi.fn();

vi.mock("../api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/events")>()),
  // The window travels into the double, because which period the panel asks for
  // is half of what this file pins down.
  fetchEventSeries: (window: unknown) => fetchEventSeries(window),
  createEventSeries: (input: unknown) => createEventSeries(input),
  updateEventSeries: (input: unknown) => updateEventSeries(input),
  publishEventSeries: (input: unknown) => publishEventSeries(input),
  cancelEventOccurrence: (id: string) => cancelEventOccurrence(id),
  reinstateEventOccurrence: (id: string) => reinstateEventOccurrence(id),
  removeEventSeries: (id: string) => removeEventSeries(id),
  fetchRollCall: (id: string) => fetchRollCall(id),
}));

/** A cleaning day twice a year, published to the members, taking sign-ups. */
const CLEANING: EventSeries = {
  id: "event-cleaning",
  title: "Städdag",
  description: "Ta med handskar.",
  category: "Gemensamt arbete",
  location: "Innergården",
  visibility: "MEMBER",
  published: true,
  publishedAt: "2026-03-01T08:00:00.000Z",
  signupOpen: true,
  capacity: 20,
  firstOn: "2026-04-18",
  startsAtMinute: 600,
  durationMinutes: 180,
  recurrence: {
    frequency: "MONTHLY",
    interval: 6,
    count: 2,
    until: null,
  },
  occurrenceCount: 2,
  occurrences: [
    {
      id: "occurrence-april",
      startsAt: "2026-04-18T08:00:00.000Z",
      endsAt: "2026-04-18T11:00:00.000Z",
      on: "2026-04-18",
      cancelledAt: null,
      begun: false,
    },
    {
      id: "occurrence-october",
      startsAt: "2026-10-17T08:00:00.000Z",
      endsAt: "2026-10-17T11:00:00.000Z",
      on: "2026-10-17",
      cancelledAt: null,
      begun: false,
    },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: TODAY });
  fetchEventSeries
    .mockReset()
    .mockResolvedValue({ ok: true, value: [CLEANING] });
  createEventSeries
    .mockReset()
    .mockResolvedValue({ ok: true, value: CLEANING });
  updateEventSeries
    .mockReset()
    .mockResolvedValue({ ok: true, value: CLEANING });
  publishEventSeries
    .mockReset()
    .mockResolvedValue({ ok: true, value: CLEANING });
  cancelEventOccurrence
    .mockReset()
    .mockResolvedValue({ ok: true, value: CLEANING });
  reinstateEventOccurrence
    .mockReset()
    .mockResolvedValue({ ok: true, value: CLEANING });
  removeEventSeries
    .mockReset()
    .mockResolvedValue({ ok: true, value: undefined });
  fetchRollCall.mockReset().mockResolvedValue({
    ok: true,
    value: {
      occurrenceId: "occurrence-april",
      eventId: "event-cleaning",
      title: "Städdag",
      startsAt: "2026-04-18T08:00:00.000Z",
      endsAt: "2026-04-18T11:00:00.000Z",
      on: "2026-04-18",
      cancelledAt: null,
      capacity: 20,
      placesTaken: 1,
      entries: [
        {
          signupId: "signup-elin",
          attendee: {
            kind: "resident",
            personId: "person-elin",
            name: "Elin Hammar",
          },
          signedUpAt: "2026-04-02T09:00:00.000Z",
          withdrawnAt: null,
        },
      ],
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Renders the panel and waits for the list to land.
 *
 * The wait is on a control that exists only once a series has arrived, rather
 * than on the card's own heading, which is rendered before the read comes back.
 */
async function open(): Promise<void> {
  render(<EventAdminPanel />);
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Publicera Städdag" }),
    ).toBeTruthy();
  });
}

/** The one series card on screen, for queries that would otherwise be ambiguous. */
function seriesCard(): HTMLElement {
  const [card] = screen.getAllByRole("article");
  if (card === undefined) {
    throw new Error("No series card is on screen.");
  }
  return card;
}

describe("a series the board has entered", () => {
  it("says who it is published for and how many dates it holds", async () => {
    await open();

    expect(screen.getByText("Publicerat för medlemmarna")).toBeTruthy();
    expect(screen.getByText("2 tillfällen")).toBeTruthy();
  });

  it("lists its dates on the association's own clock", async () => {
    await open();

    expect(
      screen.getByRole("button", { name: "Ställ in lördag 18 april 2026" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Ställ in lördag 17 oktober 2026" }),
    ).toBeTruthy();
  });

  it("seeds its fields from what is stored", async () => {
    await open();

    // Scoped to the card, because the form that adds a series renders the same
    // fields: a query by label alone would be ambiguous the moment the board has
    // entered anything at all.
    const card = within(seriesCard());
    expect(card.getByLabelText("Vad det heter")).toHaveProperty(
      "value",
      "Städdag",
    );
    expect(card.getByLabelText("Första datumet")).toHaveProperty(
      "value",
      "2026-04-18",
    );
    expect(card.getByLabelText("Börjar")).toHaveProperty("value", "10:00");
    // The rule states a count, so the form opens on the count and not on a last
    // date it does not have.
    expect(card.getByLabelText("Antal tillfällen")).toBeTruthy();
    expect(card.queryByLabelText("Sista datumet")).toBeNull();
  });
});

describe("the period on screen", () => {
  it("is asked for by name, two months from today", async () => {
    await open();

    // Stated on every read rather than left to the endpoint's default, so the
    // panel can say which period it is showing and offer to move it. Two months
    // is what one read answers for, and the last day is inside it.
    expect(fetchEventSeries).toHaveBeenCalledWith({
      from: "2026-04-01",
      to: "2026-06-01",
    });
  });

  it("moves by a whole period, forwards and back", async () => {
    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: "Senare" }));
    await waitFor(() => {
      // The day after the period that was on screen, so no date falls between
      // one period and the next.
      expect(fetchEventSeries).toHaveBeenCalledWith({
        from: "2026-06-02",
        to: "2026-08-02",
      });
    });

    await user.click(screen.getByRole("button", { name: "Tidigare" }));
    await waitFor(() => {
      expect(fetchEventSeries).toHaveBeenCalledWith({
        from: "2026-04-01",
        to: "2026-06-01",
      });
    });
  });

  it("says how many dates the series has, not how many are in the period", async () => {
    // The card's form edits the whole series, so a header counting the rows
    // under it would say a year's cleaning days happen twice.
    fetchEventSeries.mockResolvedValue({
      ok: true,
      value: [{ ...CLEANING, occurrenceCount: 12 }],
    });

    await open();

    expect(screen.getByText("12 tillfällen")).toBeTruthy();
    expect(screen.queryByText("2 tillfällen")).toBeNull();
  });
});

describe("entering a series", () => {
  /** No series yet, so the add form is the only set of fields on the screen. */
  async function openEmpty(): Promise<void> {
    fetchEventSeries.mockResolvedValue({ ok: true, value: [] });
    render(<EventAdminPanel />);
    await waitFor(() => {
      expect(
        screen.getByText(
          "Inget evenemang har ett tillfälle i den här perioden. " +
            "Använd tidigare och senare för att titta på en annan.",
        ),
      ).toBeTruthy();
    });
  }

  it("is not offered until the form describes a series", async () => {
    await openEmpty();

    const submit = screen.getByRole("button", {
      name: "Lägg in evenemanget",
    });
    expect(submit).toHaveProperty("disabled", true);
  });

  it("sends the time of day as minutes and the rule as the form states it", async () => {
    await openEmpty();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.type(screen.getByLabelText("Vad det heter"), "Städdag");
    await user.type(screen.getByLabelText("Första datumet"), "2026-04-18");
    await user.clear(screen.getByLabelText("Minuter"));
    await user.type(screen.getByLabelText("Minuter"), "180");
    await user.selectOptions(screen.getByLabelText("Hur ofta"), "MONTHLY");
    await user.type(screen.getByLabelText("Antal tillfällen"), "2");
    await user.click(
      screen.getByRole("button", { name: "Lägg in evenemanget" }),
    );

    await waitFor(() => {
      expect(createEventSeries).toHaveBeenCalledTimes(1);
    });
    expect(createEventSeries).toHaveBeenCalledWith({
      title: "Städdag",
      description: null,
      category: null,
      location: null,
      signupOpen: false,
      capacity: null,
      firstOn: "2026-04-18",
      // 10:00 on the association's clock, and never an instant assembled here:
      // the server turns the minute into one per date, which is what makes a
      // cleaning day at ten be at ten on the dates the clocks move.
      startsAtMinute: 600,
      durationMinutes: 180,
      recurrence: {
        frequency: "MONTHLY",
        interval: 1,
        count: 2,
        until: null,
      },
    });
  });

  it("clears the form once the series exists and not before", async () => {
    // Refused once and then taken, on one form, because both halves of the rule
    // are about the same fields: what the board typed survives a refusal they
    // have to act on, and goes once there is a series holding it.
    createEventSeries.mockResolvedValueOnce({
      ok: false,
      failure: { status: 422, reason: "recurrence-past-horizon" },
    });

    await openEmpty();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.type(screen.getByLabelText("Vad det heter"), "Städdag");
    await user.type(screen.getByLabelText("Första datumet"), "2026-04-18");
    await user.click(
      screen.getByRole("button", { name: "Lägg in evenemanget" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    // The refusal names one field to change, so the rest of what the board typed
    // has to still be there for them to change it in.
    expect(screen.getByLabelText("Vad det heter")).toHaveProperty(
      "value",
      "Städdag",
    );
    expect(screen.getByLabelText("Första datumet")).toHaveProperty(
      "value",
      "2026-04-18",
    );

    await user.click(
      screen.getByRole("button", { name: "Lägg in evenemanget" }),
    );

    // And empty once the series exists, so the next thing the board enters is
    // not the last one with a word changed.
    await waitFor(() => {
      expect(screen.getByLabelText("Vad det heter")).toHaveProperty(
        "value",
        "",
      );
    });
    expect(screen.getByLabelText("Första datumet")).toHaveProperty("value", "");
  });
});

describe("publishing", () => {
  it("states the audience the board chose", async () => {
    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.selectOptions(screen.getByLabelText("Vem det är för"), "PUBLIC");
    await user.click(screen.getByRole("button", { name: "Publicera Städdag" }));

    await waitFor(() => {
      expect(publishEventSeries).toHaveBeenCalledWith({
        id: "event-cleaning",
        values: { published: true, visibility: "PUBLIC" },
      });
    });
  });

  it("leaves the audience alone when the series is taken down", async () => {
    // Taking a series down says nothing about who it was arranged for, and the
    // API reads an absent audience as "leave it". Sending the select's value
    // would let a board that had idly changed it rewrite the audience on the way
    // out.
    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.selectOptions(screen.getByLabelText("Vem det är för"), "PUBLIC");
    await user.click(screen.getByRole("button", { name: "Ta ned Städdag" }));

    await waitFor(() => {
      expect(publishEventSeries).toHaveBeenCalledWith({
        id: "event-cleaning",
        values: { published: false },
      });
    });
  });

  it("offers no way down for a series that is not published", async () => {
    fetchEventSeries.mockResolvedValue({
      ok: true,
      value: [{ ...CLEANING, published: false, publishedAt: null }],
    });

    await open();

    expect(screen.getByText("Utkast")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ta ned Städdag" })).toBeNull();
  });
});

describe("calling off one date", () => {
  it("sends that date and leaves the rest of the series alone", async () => {
    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(
      screen.getByRole("button", { name: "Ställ in lördag 18 april 2026" }),
    );

    await waitFor(() => {
      expect(cancelEventOccurrence).toHaveBeenCalledWith("occurrence-april");
    });
    expect(cancelEventOccurrence).toHaveBeenCalledTimes(1);
  });

  it("keeps a called-off date on the list, with nothing left to call off", async () => {
    // The row is the record that the date was arranged and then called off.
    // Hiding it would say there had never been one.
    fetchEventSeries.mockResolvedValue({
      ok: true,
      value: [
        {
          ...CLEANING,
          occurrenceCount: 1,
          occurrences: [
            {
              id: "occurrence-april",
              startsAt: "2026-04-18T08:00:00.000Z",
              endsAt: "2026-04-18T11:00:00.000Z",
              on: "2026-04-18",
              cancelledAt: "2026-04-10T09:00:00.000Z",
              begun: false,
            },
          ],
        },
      ],
    });

    await open();

    expect(screen.getByText("Inställt")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Ställ in lördag 18 april 2026" }),
    ).toBeNull();
  });
});

describe("putting a called-off date back", () => {
  /** The one date of the fixture, called off and still ahead of the clock. */
  const calledOff = {
    ...CLEANING,
    occurrenceCount: 1,
    occurrences: [
      {
        id: "occurrence-april",
        startsAt: "2026-04-18T08:00:00.000Z",
        endsAt: "2026-04-18T11:00:00.000Z",
        on: "2026-04-18",
        cancelledAt: "2026-04-10T09:00:00.000Z",
        begun: false,
      },
    ],
  };

  it("is offered on a called-off date, and sends that date", async () => {
    fetchEventSeries.mockResolvedValue({ ok: true, value: [calledOff] });

    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(
      screen.getByRole("button", { name: "Återuppta lördag 18 april 2026" }),
    );

    await waitFor(() => {
      expect(reinstateEventOccurrence).toHaveBeenCalledWith("occurrence-april");
    });
    expect(reinstateEventOccurrence).toHaveBeenCalledTimes(1);
  });

  it("says that nobody who stood down has been signed up again", async () => {
    // The one thing a board could reasonably assume and that the calendar does
    // not do. A place given back while the date was off stays given back.
    fetchEventSeries.mockResolvedValue({ ok: true, value: [calledOff] });

    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(
      screen.getByRole("button", { name: "Återuppta lördag 18 april 2026" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "Ingen som avanmält sig har anmälts på nytt.",
      );
    });
  });

  it("is not offered once the date has begun", async () => {
    // Read off the row rather than compared here: the server says whether the
    // date has begun, and it refuses reinstating one that has - so a control
    // would be one that only ever produced a refusal.
    fetchEventSeries.mockResolvedValue({
      ok: true,
      value: [
        {
          ...calledOff,
          occurrences: [{ ...calledOff.occurrences[0], begun: true }],
        },
      ],
    });

    await open();

    expect(screen.getByText("Inställt")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Återuppta lördag 18 april 2026" }),
    ).toBeNull();
    // And nothing left to call off either: the date is already off.
    expect(
      screen.queryByRole("button", { name: "Ställ in lördag 18 april 2026" }),
    ).toBeNull();
  });
});

describe("removing a series", () => {
  it("asks first, and does nothing when the answer is no", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: "Ta bort Städdag" }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(removeEventSeries).not.toHaveBeenCalled();
  });

  it("removes it once the board has said yes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: "Ta bort Städdag" }));

    await waitFor(() => {
      expect(removeEventSeries).toHaveBeenCalledWith("event-cleaning");
    });
  });
});

describe("a refusal that publishes particulars", () => {
  it("names the fields a personal identity number was found in", async () => {
    publishEventSeries.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        reason: "personal-identity-number",
        detail: [
          { field: "description", offset: 42 },
          { field: "title", offset: 7 },
        ],
      },
    });

    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: "Publicera Städdag" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    // The fields as the form names them, so the board looks at the right box.
    // The offsets are deliberately not on screen: a character position in a
    // textarea is not something a person acts on, and the field is.
    expect(screen.getByRole("alert").textContent).toContain(
      "så ta bort det ur: Vad det handlar om, Vad det heter",
    );
    expect(screen.getByRole("alert").textContent).not.toContain("42");
  });

  it("names the dates people have signed up to", async () => {
    updateEventSeries.mockResolvedValue({
      ok: false,
      failure: {
        status: 409,
        reason: "occurrence-in-use",
        detail: ["2026-04-18", "2026-10-17"],
      },
    });

    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    // Which dates, so the board can go and call one off. Never who signed up:
    // the refusal does not say, and there is nowhere here to put it.
    //
    // Written the way the list below writes them, because that is the list the
    // board goes to next. The response states them as "2026-04-18", and a notice
    // saying that above a row saying "lördag 18 april 2026" would leave the
    // board mapping one form onto the other to find the date.
    expect(screen.getByRole("alert").textContent).toContain(
      "avanmäl deltagarna, först: lördag 18 april 2026, lördag 17 oktober 2026",
    );
  });

  it("reads the list again after being refused", async () => {
    // The refusal is about state the board is looking at, so what it goes back
    // to has to be the current list rather than the one that produced it.
    updateEventSeries.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "occurrence-in-use", detail: [] },
    });

    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(fetchEventSeries).toHaveBeenCalledTimes(2);
    });
  });
});

describe("who is coming", () => {
  it("is read when it is opened and not with the series", async () => {
    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    expect(fetchRollCall).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: "Vilka kommer den lördag 18 april 2026",
      }),
    );

    await waitFor(() => {
      expect(fetchRollCall).toHaveBeenCalledWith("occurrence-april");
    });
    expect(screen.getByText("Elin Hammar")).toBeTruthy();
    // One date's list, not the series'. Reading every roll-call of a weekly
    // series would be reading a year of residents' names to draw one screen.
    expect(fetchRollCall).toHaveBeenCalledTimes(1);
  });

  it("is not offered for a series nobody can sign up to", async () => {
    fetchEventSeries.mockResolvedValue({
      ok: true,
      value: [{ ...CLEANING, signupOpen: false, capacity: null }],
    });

    await open();

    expect(
      screen.queryByRole("button", {
        name: "Vilka kommer den lördag 18 april 2026",
      }),
    ).toBeNull();
  });
});

describe("a list that could not be read", () => {
  it("says so, and stops saying it is reading", async () => {
    fetchEventSeries.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<EventAdminPanel />);

    await waitFor(() => {
      expect(
        screen.getByText("Kalendern kunde inte läsas just nu."),
      ).toBeTruthy();
    });
    // The read is over, so a loading line under the notice would go on saying
    // something is still happening when nothing is.
    expect(screen.queryByText("Läser kalendern...")).toBeNull();
    // The form to enter a series is still there: nothing about a list that could
    // not be read stops a board writing the next thing down.
    expect(
      screen.getByRole("button", { name: "Lägg in evenemanget" }),
    ).toBeTruthy();
  });

  it("does not carry the notice over into the next period's read", async () => {
    /*
     * The failure belongs to the read that produced it, and the assertion is
     * about the moment the next read is in flight - which is the only moment the
     * two behaviours differ, because a read that succeeds clears the notice
     * either way.
     *
     * Carried over, the sentence for the period that could not be read would sit
     * above the period being fetched, and with no list for that period yet the
     * panel would draw it with no loading line under it and no read left in
     * flight to end it: a calendar that reads as broken rather than as loading.
     *
     * So the second read is held open here rather than resolved, and both halves
     * are asserted while it is: the notice gone, and the panel saying it is
     * reading.
     */
    fetchEventSeries.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    let answer: (result: unknown) => void = () => undefined;
    fetchEventSeries.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    render(<EventAdminPanel />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await waitFor(() => {
      expect(
        screen.getByText("Kalendern kunde inte läsas just nu."),
      ).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Senare" }));

    // The read for the new period is still open at this point.
    await waitFor(() => {
      expect(screen.getByText("Läser kalendern...")).toBeTruthy();
    });
    expect(
      screen.queryByText("Kalendern kunde inte läsas just nu."),
    ).toBeNull();

    // Answered, so the test leaves no read in flight and the list it was
    // waiting for is what lands.
    answer({ ok: true, value: [CLEANING] });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Publicera Städdag" }),
      ).toBeTruthy();
    });
  });

  it("keeps the period's list when a re-read of it fails", async () => {
    // The other half of the same rule, and the reason the outcome is held per
    // period rather than as one flag: the cards the board is editing are still
    // the last thing the server said about this period, and taking them away
    // over a failed refresh would take the form the board is typing in with
    // them.
    await open();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fetchEventSeries.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    // The act succeeds; the read it asks for afterwards is what fails.
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(
        screen.getByText("Kalendern kunde inte läsas just nu."),
      ).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Publicera Städdag" }),
    ).toBeTruthy();
    // And no loading line: the read is over, and one under the notice would go
    // on saying something is still happening.
    expect(screen.queryByText("Läser kalendern...")).toBeNull();
  });
});
