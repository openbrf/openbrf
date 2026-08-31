import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type {
  BookableResourceSummary,
  BookableSlot,
  BookingApartment,
} from "../api/bookings";
import { BookSlotPanel } from "./BookSlotPanel";

/**
 * Taking a slot.
 *
 * The slot engine, the quota and the race are tested on the server against a
 * real database. What this file pins down is the half only a screen can get
 * wrong.
 *
 * That a slot somebody else holds says nothing but that it is held: the state
 * the API sends carries no identity, and this is where a screen would be the
 * place that leaked one - so the cell's whole text is asserted rather than
 * merely the absence of a name.
 *
 * That the instants a booking sends are the ones the slot arrived with. A time
 * reassembled from the date and the hour on screen would be a different instant
 * on the two Sundays the clocks move, and the server would refuse it.
 *
 * That a refusal reads as a sentence somebody can act on - and, for the one
 * refusal that is two situations behind one code, as the right one of the two.
 *
 * That a stay is unbroken, and that only a cell which can be chosen is
 * announced as one that can.
 */

/**
 * The day the panel believes it is, for as long as these tests run.
 *
 * The panel names the window it is showing from the association's clock, and
 * the name carries no year: on a real day whose window opens or closes on a
 * Wednesday the 16th of September, the navigation reads exactly what the
 * fixtures' day heading reads. A wait on that text is then satisfied by the
 * chrome before the calendar has arrived - the marker stops standing for the
 * data - so the queries after it race the response instead of following it.
 *
 * Two things answer that, and both are here: the waits below name something
 * only a slot can produce, and the clock is pinned so the window is the same on
 * every run. June is chosen for being nowhere near the fixtures, which are in
 * September.
 *
 * Only `Date` is replaced. The timers stay real, so `userEvent` needs no
 * `advanceTimers` and `waitFor` behaves as it does everywhere else in this
 * suite.
 */
const TODAY = new Date("2026-06-15T09:00:00.000Z");

const fetchBookableSlots = vi.fn();
const bookSlot = vi.fn();

vi.mock("../api/bookings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/bookings")>()),
  fetchBookableSlots: (input: unknown) => fetchBookableSlots(input),
  bookSlot: (input: unknown) => bookSlot(input),
}));

/** 07:00 to 10:00 on Wednesday the 16th of September 2026, Stockholm. */
const FREE: BookableSlot = {
  startsAt: "2026-09-16T05:00:00.000Z",
  endsAt: "2026-09-16T08:00:00.000Z",
  day: "2026-09-16",
  opensAtMinute: 420,
  state: "FREE",
  bookingId: null,
};

/** The next slot, held by somebody who is not the reader. */
const TAKEN: BookableSlot = {
  startsAt: "2026-09-16T08:00:00.000Z",
  endsAt: "2026-09-16T11:00:00.000Z",
  day: "2026-09-16",
  opensAtMinute: 600,
  state: "TAKEN",
  bookingId: null,
};

const LAUNDRY: BookableResourceSummary = {
  id: "resource-laundry",
  name: "Tvättstugan i port 12",
  description: null,
  mode: "TIME_SLOTS",
  slotMinutes: 180,
  opensAtMinute: 420,
  closesAtMinute: 1260,
  maxConcurrentBookings: null,
  maxBookingsPerWeek: 2,
};

const GUEST_APARTMENT: BookableResourceSummary = {
  id: "resource-guest-apartment",
  name: "Gästlägenheten",
  description: null,
  mode: "DATE_RANGE",
  slotMinutes: null,
  opensAtMinute: null,
  closesAtMinute: null,
  maxConcurrentBookings: null,
  maxBookingsPerWeek: null,
};

/**
 * One night of a resource booked by the night.
 *
 * A night runs from local midnight to local midnight, so its end is the
 * check-out date rather than a day before it. September is summer time in
 * Stockholm, which is why midnight is 22:00 UTC the day before.
 */
function night(date: number, state: BookableSlot["state"]): BookableSlot {
  const before = String(date - 1).padStart(2, "0");
  return {
    startsAt: `2026-09-${before}T22:00:00.000Z`,
    endsAt: `2026-09-${String(date).padStart(2, "0")}T22:00:00.000Z`,
    day: `2026-09-${String(date).padStart(2, "0")}`,
    opensAtMinute: 0,
    state,
    bookingId: null,
  };
}

const APARTMENT: BookingApartment = {
  id: "apartment-1201",
  number: "1201",
  address: "Storgatan 12",
};

/**
 * Renders the panel and waits for the calendar to arrive.
 *
 * The marker is a slot's own control, whose name carries the hours as well as
 * the date. Nothing but a slot can produce it, which is what makes the wait
 * stand for the data rather than for the frame drawn around it.
 */
async function open(): Promise<void> {
  render(
    <BookSlotPanel
      resources={[LAUNDRY]}
      apartments={[APARTMENT]}
      onBooked={() => undefined}
    />,
  );
  await waitFor(() => {
    expect(
      screen.getByRole("button", {
        name: "Boka onsdag 16 september 07:00-10:00",
      }),
    ).toBeTruthy();
  });
}

/** Renders the guest apartment over the nights given, and waits for them. */
async function openNights(nights: readonly BookableSlot[]): Promise<void> {
  fetchBookableSlots.mockResolvedValue({ ok: true, value: [...nights] });
  render(
    <BookSlotPanel
      resources={[GUEST_APARTMENT]}
      apartments={[APARTMENT]}
      onBooked={() => undefined}
    />,
  );
  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Boka onsdag 16 september" }),
    ).toBeTruthy();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: TODAY });
  fetchBookableSlots
    .mockReset()
    .mockResolvedValue({ ok: true, value: [FREE, TAKEN] });
  bookSlot.mockReset().mockResolvedValue({
    ok: true,
    value: {
      id: "booking-1",
      resourceId: LAUNDRY.id,
      resourceName: LAUNDRY.name,
      mode: "TIME_SLOTS",
      status: "BOOKED",
      startsAt: FREE.startsAt,
      endsAt: FREE.endsAt,
      apartment: APARTMENT,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a slot somebody else holds", () => {
  it("says that it is booked and nothing else about it", async () => {
    await open();

    const taken = screen.getByRole("button", {
      name: "onsdag 16 september 10:00-13:00: Bokad",
    });
    // The time and the state, and no third thing. Which apartment holds an hour
    // is what bookings:manage exists to gate, and this is the cell it would be
    // rendered into if anything ever sent it.
    expect(taken.textContent).toBe("10:00Bokad");
  });

  it("is not offered as something to press", async () => {
    await open();

    expect(
      screen.getByRole("button", {
        name: "onsdag 16 september 10:00-13:00: Bokad",
      }),
    ).toHaveProperty("disabled", true);
  });
});

describe("taking a free slot", () => {
  it("sends the instants the slot arrived with", async () => {
    const session = userEvent.setup();
    await open();

    await session.click(
      screen.getByRole("button", {
        name: "Boka onsdag 16 september 07:00-10:00",
      }),
    );

    await waitFor(() => {
      expect(bookSlot).toHaveBeenCalledWith({
        resourceId: "resource-laundry",
        apartmentId: "apartment-1201",
        // Copied, not rebuilt: 05:00 UTC is seven in the morning in Stockholm
        // in September and six in the morning in December.
        startsAt: "2026-09-16T05:00:00.000Z",
        // Absent for a resource booked in slots: one slot is one booking, and
        // its end is the slot's own.
        endsAt: null,
      });
    });
  });

  it("stops saying it is booking once the booking has been made", async () => {
    /*
     * The word in the cell and the accessible name have to agree. The slot the
     * click named is remembered so that one action does not put "booking" on
     * every hour of the week, and left standing it says "booking" over a
     * booking that has finished - reading, to somebody who has the words rather
     * than the tones, as a claim still in flight on an hour that is already
     * theirs.
     */
    const session = userEvent.setup();
    await open();

    await session.click(
      screen.getByRole("button", {
        name: "Boka onsdag 16 september 07:00-10:00",
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Bokar...")).toBeNull();
    });
  });

  it("reads the calendar again, so the slot it took shows as taken", async () => {
    /*
     * The panel would otherwise go on drawing the grid it read before the
     * booking, where the hour it has just taken is still free. The read has to
     * come from the effect that owns every other read rather than from the save
     * callback: a callback's read belongs to whichever resource and week were on
     * screen when the booking was sent, and landing it after the reader has
     * moved on replaces the calendar being looked at with the one that was.
     */
    const session = userEvent.setup();
    await open();
    const readsBeforeBooking = fetchBookableSlots.mock.calls.length;

    await session.click(
      screen.getByRole("button", {
        name: "Boka onsdag 16 september 07:00-10:00",
      }),
    );

    await waitFor(() => {
      expect(fetchBookableSlots.mock.calls.length).toBeGreaterThan(
        readsBeforeBooking,
      );
    });
  });

  it("says so when somebody was quicker", async () => {
    bookSlot.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "slot-taken" },
    });

    const session = userEvent.setup();
    await open();
    await session.click(
      screen.getByRole("button", {
        name: "Boka onsdag 16 september 07:00-10:00",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Någon hann före på den tiden. Kalendern har lästs om.",
        ),
      ).toBeTruthy();
    });
  });
});

describe("a quota that has been spent", () => {
  /** Clicks the free slot and waits for whatever the refusal says. */
  async function refuse(detail: unknown): Promise<void> {
    bookSlot.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "quota-reached", detail },
    });
    const session = userEvent.setup();
    await open();
    await session.click(
      screen.getByRole("button", {
        name: "Boka onsdag 16 september 07:00-10:00",
      }),
    );
  }

  it("says a later week is open when it is the weekly allowance", async () => {
    // The two limits are answered differently by whoever reads the refusal, and
    // the API says which one was reached. One sentence for both would leave the
    // reader guessing whether to wait or to cancel something.
    await refuse(["maxBookingsPerWeek"]);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Lägenheten har använt sina bokningar för den veckan. Gränsen räknas på veckan bokningen gäller, så en senare vecka är öppen.",
        ),
      ).toBeTruthy();
    });
  });

  it("says to cancel one when it is the limit on bookings held ahead", async () => {
    await refuse(["maxConcurrentBookings"]);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Lägenheten har redan så många bokningar framåt som den får ha. Avboka en av dem för att boka en till.",
        ),
      ).toBeTruthy();
    });
  });

  it("falls back to the plain sentence when no limit is named", async () => {
    await refuse(undefined);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Lägenheten har redan så många bokningar av det här som den får ha.",
        ),
      ).toBeTruthy();
    });
  });
});

describe("the rules the board set", () => {
  it("are stated before a refusal has to state them", async () => {
    await open();

    expect(
      screen.getByText("Bokningar per vecka och lägenhet: högst 2."),
    ).toBeTruthy();
  });
});

describe("a stay of several nights", () => {
  it("is put together from a check-in and a check-out", async () => {
    const session = userEvent.setup();
    await openNights([night(16, "FREE"), night(17, "FREE")]);

    await session.click(
      screen.getByRole("button", { name: "Boka onsdag 16 september" }),
    );
    await session.click(
      screen.getByRole("button", { name: "Boka torsdag 17 september" }),
    );

    // The check-out is the morning after the last night, which is the end the
    // second night already carries. Nothing is added to it and nothing is
    // subtracted from it.
    expect(
      screen.getByText("Ankomst 16 september 2026, avresa 18 september 2026."),
    ).toBeTruthy();

    await session.click(screen.getByRole("button", { name: "Boka vistelsen" }));

    await waitFor(() => {
      expect(bookSlot).toHaveBeenCalledWith({
        resourceId: "resource-guest-apartment",
        apartmentId: "apartment-1201",
        startsAt: "2026-09-15T22:00:00.000Z",
        endsAt: "2026-09-17T22:00:00.000Z",
      });
    });
  });

  it("cannot be made to span a night somebody else holds", async () => {
    /*
     * The night between is held, so it cannot be clicked - but clicking past it
     * would produce a range that covers it, and the server refuses such a range
     * whole with a code that names no night. The click starts a new stay at the
     * night that was clicked instead, which is what the sentence then says.
     */
    const session = userEvent.setup();
    await openNights([
      night(16, "FREE"),
      night(17, "TAKEN"),
      night(18, "FREE"),
    ]);

    await session.click(
      screen.getByRole("button", { name: "Boka onsdag 16 september" }),
    );
    await session.click(
      screen.getByRole("button", { name: "Boka fredag 18 september" }),
    );

    expect(
      screen.getByText("Ankomst 18 september 2026. Välj vilken dag du reser."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Boka vistelsen" }),
    ).toHaveProperty("disabled", true);
  });

  it("announces only the nights that can be chosen as ones that can", async () => {
    // A held night is disabled, so announcing it as a toggle offers a screen
    // reader a control that cannot be operated. A free night is a toggle
    // whether or not a stay has been started, so the announced role does not
    // change halfway through choosing one.
    const session = userEvent.setup();
    await openNights([night(16, "FREE"), night(17, "TAKEN")]);

    const free = screen.getByRole("button", {
      name: "Boka onsdag 16 september",
    });
    const held = screen.getByRole("button", {
      name: "torsdag 17 september: Bokad",
    });

    expect(free.getAttribute("aria-pressed")).toBe("false");
    expect(held.getAttribute("aria-pressed")).toBeNull();

    await session.click(free);

    expect(free.getAttribute("aria-pressed")).toBe("true");
    expect(held.getAttribute("aria-pressed")).toBeNull();
  });
});

describe("a household the register holds no apartment for", () => {
  it("is told why, rather than left with a grid that refuses", async () => {
    render(
      <BookSlotPanel
        resources={[LAUNDRY]}
        apartments={[]}
        onBooked={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Boka onsdag 16 september 07:00-10:00",
        }),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(
        "En bokning räknas mot en lägenhet, och registret har ingen för dig. Be styrelsen registrera var du bor.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Boka onsdag 16 september 07:00-10:00",
      }),
    ).toHaveProperty("disabled", true);
  });
});
