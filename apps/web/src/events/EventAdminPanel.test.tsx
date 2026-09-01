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
 */

const TODAY = new Date("2026-04-01T09:00:00.000Z");

const fetchEventSeries = vi.fn();
const createEventSeries = vi.fn();
const updateEventSeries = vi.fn();
const publishEventSeries = vi.fn();
const cancelEventOccurrence = vi.fn();
const removeEventSeries = vi.fn();
const fetchRollCall = vi.fn();

vi.mock("../api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/events")>()),
  fetchEventSeries: () => fetchEventSeries(),
  createEventSeries: (input: unknown) => createEventSeries(input),
  updateEventSeries: (input: unknown) => updateEventSeries(input),
  publishEventSeries: (input: unknown) => publishEventSeries(input),
  cancelEventOccurrence: (id: string) => cancelEventOccurrence(id),
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
  occurrences: [
    {
      id: "occurrence-april",
      startsAt: "2026-04-18T08:00:00.000Z",
      endsAt: "2026-04-18T11:00:00.000Z",
      on: "2026-04-18",
      cancelledAt: null,
    },
    {
      id: "occurrence-october",
      startsAt: "2026-10-17T08:00:00.000Z",
      endsAt: "2026-10-17T11:00:00.000Z",
      on: "2026-10-17",
      cancelledAt: null,
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

describe("entering a series", () => {
  /** No series yet, so the add form is the only set of fields on the screen. */
  async function openEmpty(): Promise<void> {
    fetchEventSeries.mockResolvedValue({ ok: true, value: [] });
    render(<EventAdminPanel />);
    await waitFor(() => {
      expect(screen.getByText("Inget är inlagt än.")).toBeTruthy();
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
    createEventSeries.mockResolvedValue({
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
          occurrences: [
            {
              id: "occurrence-april",
              startsAt: "2026-04-18T08:00:00.000Z",
              endsAt: "2026-04-18T11:00:00.000Z",
              on: "2026-04-18",
              cancelledAt: "2026-04-10T09:00:00.000Z",
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
    expect(screen.getByRole("alert").textContent).toContain(
      "avanmäl deltagarna, först: 2026-04-18, 2026-10-17",
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
