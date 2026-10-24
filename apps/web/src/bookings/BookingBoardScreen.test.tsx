import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import { BookingBoardScreen } from "./BookingBoardScreen";

/**
 * The board's page for bookings: the whole calendar, who holds which hour, and
 * cancelling one on a household's behalf.
 *
 * The API refuses every call whatever the browser was shown, so hiding the page
 * is courtesy. What is not courtesy is the read behind it: this is the one
 * place a booking says which apartment and which person holds an hour, and a
 * page that asked for it on a resident's behalf would be asking the server for
 * personal data with nowhere to put it. So this file asserts the request as
 * well as the panel.
 *
 * The catalogue is read from the board's own path, gated on bookings:manage,
 * so a seat that runs the calendar without holding a slot is never sent to the
 * resident path for a refusal.
 */

const fetchBookableResources = vi.fn();
const fetchBoardBookableResources = vi.fn();
const fetchBookingApartments = vi.fn();
const fetchOwnBookings = vi.fn();
const fetchManagedBookings = vi.fn();
const cancelBookingForBoard = vi.fn();

vi.mock("../api/bookings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/bookings")>()),
  fetchBookableResources: () => fetchBookableResources(),
  fetchBoardBookableResources: () => fetchBoardBookableResources(),
  fetchBookingApartments: () => fetchBookingApartments(),
  fetchOwnBookings: () => fetchOwnBookings(),
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

/** The one resource the catalogue answers with. */
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

/** A booking of the laundry, as the board's list answers with it. */
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

describe("the board", () => {
  it("is given the page under the board's sign", async () => {
    render(
      <BookingBoardScreen
        viewer={viewer(["bookings:book", "bookings:manage"])}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Styrelsen Hantera bokningar",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Det här ser bara styrelsen och administratören."),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("Hela kalendern")).toBeTruthy();
    });
  });

  it("is not given the booking half here", async () => {
    render(
      <BookingBoardScreen
        viewer={viewer(["bookings:book", "bookings:manage"])}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Hela kalendern")).toBeTruthy();
    });
    expect(screen.queryByText("Boka")).toBeNull();
    expect(screen.queryByText("Dina bokningar")).toBeNull();
    expect(fetchBookableResources).not.toHaveBeenCalled();
    expect(fetchBookingApartments).not.toHaveBeenCalled();
    expect(fetchOwnBookings).not.toHaveBeenCalled();
  });

  it("reads the month again after cancelling on somebody's behalf", async () => {
    /*
     * The panel would otherwise go on drawing the month it read before the
     * cancellation, with the booking it has just cancelled still standing. The
     * read has to come from the effect that owns every other read rather than
     * from the save callback: a callback's read belongs to whichever month and
     * resource were on screen when the cancellation was sent, and landing it
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
      <BookingBoardScreen
        viewer={viewer(["bookings:book", "bookings:manage"])}
      />,
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

/**
 * The server refuses the board's cancellation from the moment the booking
 * ends. The list is read fresh, so a booking under way is on it, and a button
 * that always refused would be a worse way to say so.
 */
describe("cancelling a booking that has ended", () => {
  it("is not offered to the board", async () => {
    fetchManagedBookings.mockResolvedValue({
      ok: true,
      value: [laundryBooking(hoursFromNow(-5), hoursFromNow(-2))],
    });

    render(<BookingBoardScreen viewer={viewer(["bookings:manage"])} />);

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

    render(<BookingBoardScreen viewer={viewer(["bookings:manage"])} />);

    expect(await screen.findByRole("button", { name: /^Avboka/ })).toBeTruthy();
  });
});

/**
 * A seat that runs the calendar without holding a slot.
 *
 * No seat grants bookings:manage without bookings:book today, and this is what
 * stops that being load-bearing: the page the capability is for has to work on
 * its own, catalogue and all, the moment a seat does.
 */
describe("a viewer holding bookings:manage alone", () => {
  it("reads the catalogue from the board's own path, never the resident's", async () => {
    render(<BookingBoardScreen viewer={viewer(["bookings:manage"])} />);

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
          ...laundryBooking(hoursFromNow(48), hoursFromNow(51)),
          apartment: null,
        },
      ],
    });
    cancelBookingForBoard.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "already-cancelled" },
    });
    const session = userEvent.setup();
    render(<BookingBoardScreen viewer={viewer(["bookings:manage"])} />);

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

  it("cannot cancel the same booking twice by leaving the month and coming back", async () => {
    /*
     * Moving on clears the notice, and the buttons were held on the same state,
     * so coming back before the answer was in offered the booking again and a
     * second click sent a second cancellation.
     */
    fetchManagedBookings.mockResolvedValue({
      ok: true,
      value: [laundryBooking(hoursFromNow(48), hoursFromNow(51))],
    });
    let release!: () => void;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelled = cancelBookingForBoard.getMockImplementation();
    cancelBookingForBoard.mockImplementationOnce(async (id: string) => {
      await answered;
      return cancelled?.(id);
    });
    const session = userEvent.setup();
    render(<BookingBoardScreen viewer={viewer(["bookings:manage"])} />);

    await session.click(await screen.findByRole("button", { name: /^Avboka/ }));
    await session.click(screen.getByRole("button", { name: "Senare" }));
    await session.click(screen.getByRole("button", { name: "Tidigare" }));

    const button = await screen.findByRole("button", { name: /^Avboka/ });
    expect(button).toHaveProperty("disabled", true);
    await session.click(button);
    expect(cancelBookingForBoard).toHaveBeenCalledTimes(1);

    release();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Avboka/ })).toHaveProperty(
        "disabled",
        false,
      );
    });
    await session.click(screen.getByRole("button", { name: /^Avboka/ }));
    await waitFor(() => {
      expect(cancelBookingForBoard).toHaveBeenCalledTimes(2);
    });
  });

  it("is offered the resource the catalogue named, to filter the month by", async () => {
    render(<BookingBoardScreen viewer={viewer(["bookings:manage"])} />);

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

describe("a catalogue that cannot be read", () => {
  it("costs the filter and says so, and leaves the month in view", async () => {
    fetchBoardBookableResources.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<BookingBoardScreen viewer={viewer(["bookings:manage"])} />);

    await waitFor(() => {
      expect(
        screen.getByText("Bokningarna kunde inte läsas just nu."),
      ).toBeTruthy();
    });
    expect(screen.getByText("Hela kalendern")).toBeTruthy();
    expect(screen.queryByRole("option", { name: LAUNDRY.name })).toBeNull();
    await waitFor(() => {
      expect(fetchManagedBookings).toHaveBeenCalled();
    });
  });
});

describe("a resident", () => {
  it("is told the page is the board's, under no sign, and nothing is read", async () => {
    render(<BookingBoardScreen viewer={viewer(["bookings:book"])} />);

    expect(
      await screen.findByText(
        "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(screen.queryByText("Hela kalendern")).toBeNull();
    expect(fetchBoardBookableResources).not.toHaveBeenCalled();
    expect(fetchManagedBookings).not.toHaveBeenCalled();
  });
});
