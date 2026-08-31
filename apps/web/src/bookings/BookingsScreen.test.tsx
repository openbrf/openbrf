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
 */

const fetchBookableResources = vi.fn();
const fetchBookingApartments = vi.fn();
const fetchOwnBookings = vi.fn();
const fetchBookableSlots = vi.fn();
const fetchManagedBookings = vi.fn();
const cancelBookingForBoard = vi.fn();

vi.mock("../api/bookings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/bookings")>()),
  fetchBookableResources: () => fetchBookableResources(),
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

beforeEach(() => {
  fetchBookableResources.mockReset().mockResolvedValue({
    ok: true,
    value: [
      {
        id: "resource-laundry",
        name: "Tvättstugan i port 12",
        description: null,
        mode: "TIME_SLOTS",
        slotMinutes: 180,
        opensAtMinute: 420,
        closesAtMinute: 1260,
        maxConcurrentBookings: null,
        maxBookingsPerWeek: null,
      },
    ],
  });
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
      value: [
        {
          id: "booking-1",
          resourceId: "resource-laundry",
          resourceName: "Tvättstugan i port 12",
          mode: "TIME_SLOTS",
          status: "BOOKED",
          startsAt: "2026-09-16T05:00:00.000Z",
          endsAt: "2026-09-16T08:00:00.000Z",
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
        screen.getByText(
          "Bokningarna kunde inte läsas just nu. Ladda om sidan.",
        ),
      ).toBeTruthy();
    });
  });
});
