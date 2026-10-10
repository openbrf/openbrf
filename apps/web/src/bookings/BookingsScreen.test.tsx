import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Viewer } from "../api/instance";
import { BookingsScreen } from "./BookingsScreen";

/**
 * Which half of the booking screen a seat is given.
 *
 * The API refuses every call whatever the browser was shown, so hiding a panel
 * is courtesy. What is not courtesy is the read behind it: the board's view is
 * the one place a booking says which apartment and which person holds an hour,
 * and a screen that asked for it on a resident's behalf would be asking the
 * server for personal data on a page that has nowhere to put it. So this file
 * asserts the request as well as the panel.
 *
 * The catalogue is the other way round. Both halves are shown the same list of
 * what the house offers, and the two paths serving it are gated differently, so
 * which one a seat reads is decided here: the resident path for whoever may
 * book, and the board's own for a seat that runs the calendar without holding a
 * slot. Asking the resident path on that seat's behalf would be asking for a
 * refusal, and the panel behind it would then have no resource to filter by.
 */

const fetchBookableResources = vi.fn();
const fetchBoardBookableResources = vi.fn();
const fetchBookingApartments = vi.fn();
const fetchOwnBookings = vi.fn();
const fetchBookableSlots = vi.fn();
const fetchManagedBookings = vi.fn();
const cancelBookingForBoard = vi.fn();

vi.mock("../api/bookings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/bookings")>()),
  fetchBookableResources: () => fetchBookableResources(),
  fetchBoardBookableResources: () => fetchBoardBookableResources(),
  fetchBookingApartments: () => fetchBookingApartments(),
  fetchOwnBookings: () => fetchOwnBookings(),
  fetchBookableSlots: (input: unknown) => fetchBookableSlots(input),
  fetchManagedBookings: (input: unknown) => fetchManagedBookings(input),
  cancelBookingForBoard: (id: string) => cancelBookingForBoard(id),
}));

function viewer(capabilities: readonly string[]): Viewer {
  return {
    personId: "person-elin",
    firstName: "Elin",
    lastName: "Hammar",
    preferredLocale: "sv",
    capabilities: [...capabilities],
    housingCooperative: null,
  };
}

/** The one resource both catalogue paths answer with. */
const LAUNDRY = {
  id: "resource-laundry",
  name: "Tvättstugan i port 12",
  description: null,
  mode: "TIME_SLOTS",
  slotMinutes: 180,
  opensAtMinute: 420,
  closesAtMinute: 1260,
  maxConcurrentBookings: null,
  maxBookingsPerWeek: null,
} as const;

/** An instant this many hours from now, as the API writes one. */
function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

/** A booking of the laundry, as either list answers with it. */
function laundryBooking(
  startsAt: string,
  endsAt: string,
  status: "BOOKED" | "CANCELLED" = "BOOKED",
) {
  return {
    id: "booking-1",
    resourceId: "resource-laundry",
    resourceName: "Tvättstugan i port 12",
    mode: "TIME_SLOTS",
    status,
    startsAt,
    endsAt,
    apartment: { id: "apartment-1201", number: "1201", address: "" },
    bookedBy: { kind: "unknown" },
  };
}

beforeEach(() => {
  fetchBookableResources
    .mockReset()
    .mockResolvedValue({ ok: true, value: [LAUNDRY] });
  fetchBoardBookableResources
    .mockReset()
    .mockResolvedValue({ ok: true, value: [LAUNDRY] });
  fetchBookingApartments.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchOwnBookings.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchBookableSlots.mockReset().mockResolvedValue({ ok: true, value: [] });
  fetchManagedBookings.mockReset().mockResolvedValue({ ok: true, value: [] });
  cancelBookingForBoard.mockReset().mockResolvedValue({
    ok: true,
    value: {
      id: "booking-1",
      resourceId: "resource-laundry",
      resourceName: "Tvättstugan i port 12",
      mode: "TIME_SLOTS",
      status: "CANCELLED",
      startsAt: "2026-09-16T05:00:00.000Z",
      endsAt: "2026-09-16T08:00:00.000Z",
      apartment: null,
      bookedBy: { kind: "unknown" },
    },
  });
});

describe("a resident", () => {
  it("is given the booking half", async () => {
    render(<BookingsScreen viewer={viewer(["bookings:book"])} />);

    await waitFor(() => {
      expect(screen.getByText("Boka")).toBeTruthy();
    });
    expect(screen.getByText("Dina bokningar")).toBeTruthy();
  });

  it("is not given the board's view of who holds what", async () => {
    render(<BookingsScreen viewer={viewer(["bookings:book"])} />);

    await waitFor(() => {
      expect(screen.getByText("Boka")).toBeTruthy();
    });
    expect(screen.queryByText("Hela kalendern")).toBeNull();
  });

  it("never asks the server for it either", async () => {
    render(<BookingsScreen viewer={viewer(["bookings:book"])} />);

    await waitFor(() => {
      expect(screen.getByText("Boka")).toBeTruthy();
    });
    expect(fetchManagedBookings).not.toHaveBeenCalled();
  });

  it("reads the catalogue from the path their capability opens", async () => {
    render(<BookingsScreen viewer={viewer(["bookings:book"])} />);

    await waitFor(() => {
      expect(fetchBookableResources).toHaveBeenCalled();
    });
    expect(fetchBoardBookableResources).not.toHaveBeenCalled();
  });
});

describe("the board", () => {
  it("is given both halves", async () => {
    render(
      <BookingsScreen viewer={viewer(["bookings:book", "bookings:manage"])} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Hela kalendern")).toBeTruthy();
    });
    expect(screen.getByText("Boka")).toBeTruthy();
    expect(screen.getByText("Dina bokningar")).toBeTruthy();
  });

  it("reads the month again after cancelling on somebody's behalf", async () => {
    /*
     * The board's half would otherwise go on drawing the month it read before
     * the cancellation, with the booking it has just cancelled still standing.
     * The read has to come from the effect that owns every other read rather
     * than from the save callback: a callback's read belongs to whichever month
     * and resource were on screen when the cancellation was sent, and landing it
     * after the reader has moved on replaces the month being looked at with the
     * one that was - which leaves the panel reading for ever, because nothing
     * else is in flight to end it.
     */
    fetchManagedBookings.mockResolvedValue({
      ok: true,
      value: [laundryBooking(hoursFromNow(24), hoursFromNow(27))],
    });

    const session = userEvent.setup();
    render(
      <BookingsScreen viewer={viewer(["bookings:book", "bookings:manage"])} />,
    );

    const cancelButton = await waitFor(() =>
      screen.getByRole("button", { name: /^Avboka/ }),
    );
    const readsBeforeCancelling = fetchManagedBookings.mock.calls.length;
    await session.click(cancelButton);

    await waitFor(() => {
      expect(cancelBookingForBoard).toHaveBeenCalledWith("booking-1");
    });
    await waitFor(() => {
      expect(fetchManagedBookings.mock.calls.length).toBeGreaterThan(
        readsBeforeCancelling,
      );
    });
  });

  it("reads the slots again after a cancellation, so the hour reads free", async () => {
    // The slot grid is the booking panel's own read. Without being told, it
    // would go on drawing the cancelled hour as held until the week changed.
    fetchManagedBookings.mockResolvedValue({
      ok: true,
      value: [
        {
          id: "booking-1",
          resourceId: "resource-laundry",
          resourceName: "Tvättstugan i port 12",
          mode: "TIME_SLOTS",
          status: "BOOKED",
          startsAt: hoursFromNow(48),
          endsAt: hoursFromNow(51),
          apartment: { id: "apartment-1201", number: "1201", address: "" },
          bookedBy: { kind: "unknown" },
        },
      ],
    });

    const session = userEvent.setup();
    render(
      <BookingsScreen viewer={viewer(["bookings:book", "bookings:manage"])} />,
    );

    const cancelButton = await waitFor(() =>
      screen.getByRole("button", { name: /^Avboka/ }),
    );
    await waitFor(() => {
      expect(fetchBookableSlots).toHaveBeenCalled();
    });
    const readsBeforeCancelling = fetchBookableSlots.mock.calls.length;
    await session.click(cancelButton);

    await waitFor(() => {
      expect(fetchBookableSlots.mock.calls.length).toBeGreaterThan(
        readsBeforeCancelling,
      );
    });
  });
});

/**
 * The server refuses a cancellation once the hour is out of reach: a resident's
 * from the moment the booking starts, the board's from the moment it ends. The
 * list is read fresh, so a booking under way is on it, and a button that always
 * refused would be a worse way to say so.
 */
describe("cancelling a booking that has started", () => {
  it("is not offered to a resident while the booking is under way", async () => {
    fetchOwnBookings.mockResolvedValue({
      ok: true,
      value: [laundryBooking(hoursFromNow(-1), hoursFromNow(2))],
    });

    render(<BookingsScreen viewer={viewer(["bookings:book"])} />);

    await waitFor(() => {
      expect(screen.getByText("1201")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /^Avboka/ })).toBeNull();
  });

  it("is offered to a resident before the booking starts", async () => {
    fetchOwnBookings.mockResolvedValue({
      ok: true,
      value: [laundryBooking(hoursFromNow(1), hoursFromNow(4))],
    });

    render(<BookingsScreen viewer={viewer(["bookings:book"])} />);

    expect(await screen.findByRole("button", { name: /^Avboka/ })).toBeTruthy();
  });
});

describe("cancelling a booking that has ended", () => {
  it("is not offered to the board", async () => {
    fetchManagedBookings.mockResolvedValue({
      ok: true,
      value: [laundryBooking(hoursFromNow(-5), hoursFromNow(-2))],
    });

    render(<BookingsScreen viewer={viewer(["bookings:manage"])} />);

    await waitFor(() => {
      expect(screen.getByText("1201")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /^Avboka/ })).toBeNull();
  });

  it("is still offered to the board while the booking is under way", async () => {
    fetchManagedBookings.mockResolvedValue({
      ok: true,
      value: [laundryBooking(hoursFromNow(-1), hoursFromNow(2))],
    });

    render(<BookingsScreen viewer={viewer(["bookings:manage"])} />);

    expect(await screen.findByRole("button", { name: /^Avboka/ })).toBeTruthy();
  });
});

/**
 * A seat that runs the calendar without holding a slot.
 *
 * No seat grants bookings:manage without bookings:book today, and this is what
 * stops that being load-bearing: the half the capability is for has to work on
 * its own, catalogue and all, the moment a seat does.
 */
describe("a viewer holding bookings:manage alone", () => {
  it("is given the board's half and not the booking half", async () => {
    render(<BookingsScreen viewer={viewer(["bookings:manage"])} />);

    await waitFor(() => {
      expect(screen.getByText("Hela kalendern")).toBeTruthy();
    });
    expect(screen.queryByText("Boka")).toBeNull();
    expect(screen.queryByText("Dina bokningar")).toBeNull();
  });

  it("reads the catalogue from the board's own path, never the resident's", async () => {
    render(<BookingsScreen viewer={viewer(["bookings:manage"])} />);

    await waitFor(() => {
      expect(fetchBoardBookableResources).toHaveBeenCalled();
    });
    expect(fetchBookableResources).not.toHaveBeenCalled();
    expect(fetchBookingApartments).not.toHaveBeenCalled();
    expect(fetchOwnBookings).not.toHaveBeenCalled();
  });

  it("does not say a refused cancellation over another month", async () => {
    fetchManagedBookings.mockResolvedValue({
      ok: true,
      value: [
        {
          id: "booking-1",
          resourceId: "resource-laundry",
          resourceName: "Tvättstugan i port 12",
          mode: "TIME_SLOTS",
          status: "BOOKED",
          startsAt: hoursFromNow(48),
          endsAt: hoursFromNow(51),
          apartment: null,
          bookedBy: { kind: "unknown" },
        },
      ],
    });
    cancelBookingForBoard.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "already-cancelled" },
    });
    const session = userEvent.setup();
    render(<BookingsScreen viewer={viewer(["bookings:manage"])} />);

    await session.click(await screen.findByRole("button", { name: /^Avboka/ }));
    await screen.findByText(
      "Bokningen är redan avbokad, så det finns inget att avboka.",
    );

    // The next month cannot be read: that is what has to be said now.
    fetchManagedBookings.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    await session.click(screen.getByRole("button", { name: "Senare" }));

    await screen.findByText("Det gick inte just nu. Försök igen.");
    expect(
      screen.queryByText(
        "Bokningen är redan avbokad, så det finns inget att avboka.",
      ),
    ).toBeNull();
  });

  it("is offered the resource the catalogue named, to filter the month by", async () => {
    render(<BookingsScreen viewer={viewer(["bookings:manage"])} />);

    /*
     * The filter is absent altogether when the list is empty, so the option is
     * what says the catalogue reached the panel. Without the board's own path
     * this viewer would be shown a working month with no resource on it and no
     * failure either, which is the shape a refusal nobody surfaces takes.
     */
    await waitFor(() => {
      expect(screen.getByRole("option", { name: LAUNDRY.name })).toBeTruthy();
    });
  });
});

describe("an account with neither capability", () => {
  it("is given no panel and makes no booking request", async () => {
    render(<BookingsScreen viewer={viewer(["self:manage"])} />);

    await waitFor(() => {
      expect(screen.getByText("Bokningar")).toBeTruthy();
    });
    expect(screen.queryByText("Boka")).toBeNull();
    expect(screen.queryByText("Hela kalendern")).toBeNull();
    expect(fetchBookableResources).not.toHaveBeenCalled();
    expect(fetchBoardBookableResources).not.toHaveBeenCalled();
    expect(fetchOwnBookings).not.toHaveBeenCalled();
    expect(fetchManagedBookings).not.toHaveBeenCalled();
  });
});

describe("a read that fails", () => {
  it("is reported as a read rather than as a failed save", async () => {
    fetchOwnBookings.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<BookingsScreen viewer={viewer(["bookings:book"])} />);

    await waitFor(() => {
      expect(
        screen.getByText("Bokningarna kunde inte läsas just nu."),
      ).toBeTruthy();
    });
  });
});
