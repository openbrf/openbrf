import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
 */

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

const APARTMENT: BookingApartment = {
  id: "apartment-1201",
  number: "1201",
  address: "Storgatan 12",
};

/** Renders the panel and waits for the calendar to arrive. */
async function open(): Promise<void> {
  render(
    <BookSlotPanel
      resources={[LAUNDRY]}
      apartments={[APARTMENT]}
      onBooked={() => undefined}
    />,
  );
  await waitFor(() => {
    expect(screen.getByText("onsdag 16 september")).toBeTruthy();
  });
}

beforeEach(() => {
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
      expect(screen.getByText("onsdag 16 september")).toBeTruthy();
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
