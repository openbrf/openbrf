import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { BookingsScreen } from "./BookingsScreen";

/**
 * What the house's booking page gives a seat.
 *
 * The API refuses every call whatever the browser was shown, so hiding a panel
 * is courtesy. What is not courtesy is the read behind it: the board's view is
 * the one place a booking says which apartment and which person holds an hour,
 * and a page that asked for it on a resident's behalf would be asking the
 * server for personal data with nowhere to put it. That view is the board's
 * page now (ADR 0044), so this file asserts that the house's page never makes
 * the request, for the board as much as for anybody.
 *
 * The catalogue is read from the resident path, the one bookings:book opens;
 * the board's own path is its page's to read.
 */

const fetchBookableResources = vi.fn();
const fetchBoardBookableResources = vi.fn();
const fetchBookingApartments = vi.fn();
const fetchOwnBookings = vi.fn();
const fetchBookableSlots = vi.fn();
const fetchManagedBookings = vi.fn();

vi.mock("../api/bookings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/bookings")>()),
  fetchBookableResources: () => fetchBookableResources(),
  fetchBoardBookableResources: () => fetchBoardBookableResources(),
  fetchBookingApartments: () => fetchBookingApartments(),
  fetchOwnBookings: () => fetchOwnBookings(),
  fetchBookableSlots: (input: unknown) => fetchBookableSlots(input),
  fetchManagedBookings: (input: unknown) => fetchManagedBookings(input),
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

/**
 * One page, one audience: the board books from the house's page as anybody
 * does, and finds who holds which hour on its own page (ADR 0044).
 */
describe("the board", () => {
  it("shows no board content to a board member", async () => {
    render(
      <BookingsScreen viewer={viewer(["bookings:book", "bookings:manage"])} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Boka")).toBeTruthy();
    });
    expect(screen.getByText("Dina bokningar")).toBeTruthy();
    expect(screen.queryByText("Hela kalendern")).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(fetchManagedBookings).not.toHaveBeenCalled();
    expect(fetchBoardBookableResources).not.toHaveBeenCalled();
  });
});

/**
 * The server refuses a resident's cancellation from the moment the booking
 * starts. The list is read fresh, so a booking under way is on it, and a
 * button that always refused would be a worse way to say so.
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
