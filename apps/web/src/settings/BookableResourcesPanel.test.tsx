import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { BookableResource } from "../api/bookings";
import { BookableResourcesPanel } from "./BookableResourcesPanel";

/**
 * The board's catalogue of bookable resources.
 *
 * The rules themselves live on the server and are tested there. What this file
 * pins down is the half only a form can get wrong.
 *
 * The mode decides which fields exist, and a field the mode does not use has to
 * be sent as empty rather than left out: the API reads a cleared field and an
 * omitted one as the same thing, so a form that omitted the slot length when a
 * laundry room became a common room would be asking the server to keep dead
 * configuration - which it refuses, and the board would read a refusal for a
 * field they cannot see.
 *
 * The two refusals a board meets most - a slot length that does not divide the
 * opening hours, and a resource somebody else withdrew while this page was open
 * - have to arrive as sentences naming what to change.
 */

const fetchAllBookableResources = vi.fn();
const createBookableResource = vi.fn();
const updateBookableResource = vi.fn();
const deactivateBookableResource = vi.fn();

vi.mock("../api/bookings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/bookings")>()),
  fetchAllBookableResources: () => fetchAllBookableResources(),
  createBookableResource: (input: unknown) => createBookableResource(input),
  updateBookableResource: (input: unknown) => updateBookableResource(input),
  deactivateBookableResource: (id: string) => deactivateBookableResource(id),
}));

function laundry(overrides: Partial<BookableResource> = {}): BookableResource {
  return {
    id: "resource-laundry",
    name: "Tvättstugan i port 12",
    description: null,
    mode: "TIME_SLOTS",
    slotMinutes: 180,
    opensAtMinute: 420,
    closesAtMinute: 1260,
    maxConcurrentBookings: null,
    maxBookingsPerWeek: 2,
    deactivatedAt: null,
    bookingCount: 0,
    ...overrides,
  };
}

/** Renders the panel and waits for the catalogue to arrive. */
async function open(): Promise<void> {
  render(<BookableResourcesPanel />);
  await waitFor(() => {
    expect(screen.getByDisplayValue("Tvättstugan i port 12")).toBeTruthy();
  });
}

/** The row's own field, which is always the first of its kind on the panel. */
function rowField(label: RegExp): HTMLElement {
  const fields = screen.getAllByLabelText(label);
  const first = fields[0];
  if (first === undefined) {
    throw new Error(`No field matched ${String(label)}`);
  }
  return first;
}

beforeEach(() => {
  fetchAllBookableResources
    .mockReset()
    .mockResolvedValue({ ok: true, value: [laundry()] });
  createBookableResource
    .mockReset()
    .mockResolvedValue({ ok: true, value: laundry() });
  updateBookableResource
    .mockReset()
    .mockResolvedValue({ ok: true, value: laundry() });
  deactivateBookableResource.mockReset().mockResolvedValue({
    ok: true,
    value: laundry({ deactivatedAt: "2026-09-16T05:00:00.000Z" }),
  });
});

describe("the fields a mode calls for", () => {
  it("carries the slot length and the opening hours for a resource booked in slots", async () => {
    await open();

    expect(rowField(/^Passets längd/)).toHaveProperty("value", "180");
    expect(rowField(/^Öppnar/)).toHaveProperty("value", "07:00");
    expect(rowField(/^Stänger/)).toHaveProperty("value", "21:00");
  });

  it("carries none of them for a resource booked by the day", async () => {
    fetchAllBookableResources.mockResolvedValue({
      ok: true,
      value: [
        laundry({
          id: "resource-common-room",
          name: "Föreningslokalen",
          mode: "WHOLE_DAY",
          slotMinutes: null,
          opensAtMinute: null,
          closesAtMinute: null,
        }),
      ],
    });

    render(<BookableResourcesPanel />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("Föreningslokalen")).toBeTruthy();
    });

    // Absent rather than empty: a setting that can be changed with no effect is
    // the worst kind there is, and the API refuses one on this mode in any case.
    // The add form below still offers them, because it opens on time slots.
    expect(screen.getAllByLabelText(/^Passets längd/)).toHaveLength(1);
    expect(screen.getAllByLabelText(/^Öppnar/)).toHaveLength(1);
  });

  it("sends them as empty when the board changes the mode", async () => {
    const session = userEvent.setup();
    await open();

    await session.selectOptions(rowField(/^Så bokas den/), "WHOLE_DAY");
    await session.click(screen.getByRole("button", { name: /^Spara$/ }));

    await waitFor(() => {
      expect(updateBookableResource).toHaveBeenCalledWith({
        id: "resource-laundry",
        values: {
          name: "Tvättstugan i port 12",
          description: null,
          mode: "WHOLE_DAY",
          // Cleared, not omitted. Omitted would leave a common room carrying
          // three-hour slots, which is exactly what the server refuses.
          slotMinutes: null,
          opensAtMinute: null,
          closesAtMinute: null,
          maxConcurrentBookings: null,
          maxBookingsPerWeek: 2,
        },
      });
    });
  });
});

describe("a closing time of midnight", () => {
  it("is the end of the day rather than the beginning", async () => {
    const session = userEvent.setup();
    await open();

    // A browser's time field cannot express 24:00, and minute 0 as a closing
    // time would be a resource that closes before it opens.
    fireEvent.change(rowField(/^Stänger/), { target: { value: "00:00" } });
    fireEvent.change(rowField(/^Öppnar/), { target: { value: "00:00" } });
    await session.click(screen.getByRole("button", { name: /^Spara$/ }));

    await waitFor(() => {
      expect(updateBookableResource).toHaveBeenCalledWith(
        expect.objectContaining({
          values: expect.objectContaining({
            opensAtMinute: 0,
            closesAtMinute: 1440,
          }),
        }),
      );
    });
  });
});

describe("the refusals a board meets", () => {
  it("names what to change when the slot length does not fit the hours", async () => {
    updateBookableResource.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "slot-does-not-fit" },
    });

    const session = userEvent.setup();
    await open();
    await session.click(screen.getByRole("button", { name: /^Spara$/ }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Passets längd delar inte öppettiderna i hela pass, så dagen skulle sluta med ett kort pass. Ändra längden, eller flytta stängningstiden.",
        ),
      ).toBeTruthy();
    });
  });

  it("says a quota of none is a withdrawal rather than a limit", async () => {
    updateBookableResource.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "quota-not-positive" },
    });

    const session = userEvent.setup();
    await open();
    await session.click(screen.getByRole("button", { name: /^Spara$/ }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "En gräns måste vara minst en bokning. Lämna den tom för ingen gräns; en resurs som ingen får boka är en resurs som är tagen ur bokning.",
        ),
      ).toBeTruthy();
    });
  });

  it("says a withdrawn resource cannot be edited, and that offering it again is its own decision", async () => {
    // Two board members on the screen at once: one withdraws the sauna while
    // the other is editing it.
    updateBookableResource.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "resource-deactivated" },
    });

    const session = userEvent.setup();
    await open();
    await session.click(screen.getByRole("button", { name: /^Spara$/ }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Resursen är tagen ur bokning och kan därför inte ändras. Att erbjuda den igen är ett eget beslut.",
        ),
      ).toBeTruthy();
    });
  });
});

describe("what changing the mechanics leaves behind", () => {
  it("is said on a resource that has been booked", async () => {
    fetchAllBookableResources.mockResolvedValue({
      ok: true,
      value: [laundry({ bookingCount: 3 })],
    });

    await open();

    expect(
      screen.getByText(
        "Redan gjorda bokningar: 3. Att ändra hur den bokas flyttar dem inte, så en av dem kan hamna över de nya passgränserna. Kalendern visar de timmarna som bokade och inte som lediga.",
      ),
    ).toBeTruthy();
  });

  it("is not said on a resource nothing has been booked against", async () => {
    await open();

    expect(screen.queryByText(/Redan gjorda bokningar/)).toBeNull();
  });
});

describe("withdrawing a resource", () => {
  it("is offered on every resource, because removal is not offered at all", async () => {
    // The bookings made against a resource say what they were for only through
    // it, so there is no removal route to reach even on an unbooked one.
    fetchAllBookableResources.mockResolvedValue({
      ok: true,
      value: [laundry({ bookingCount: 7 })],
    });

    const session = userEvent.setup();
    await open();
    await session.click(
      screen.getByRole("button", {
        name: "Ta Tvättstugan i port 12 ur bokning",
      }),
    );

    await waitFor(() => {
      expect(deactivateBookableResource).toHaveBeenCalledWith(
        "resource-laundry",
      );
    });
    expect(screen.queryByRole("button", { name: /^Ta bort$/ })).toBeNull();
  });

  it("leaves the resource readable, with what it left standing", async () => {
    fetchAllBookableResources.mockResolvedValue({
      ok: true,
      value: [
        laundry({
          deactivatedAt: "2026-09-16T05:00:00.000Z",
          bookingCount: 7,
        }),
      ],
    });

    render(<BookableResourcesPanel />);

    await waitFor(() => {
      expect(screen.getByText("Ur bokning")).toBeTruthy();
    });
    expect(screen.getByText("Tvättstugan i port 12")).toBeTruthy();
    expect(screen.getByText("Gjorda bokningar: 7")).toBeTruthy();
    // Not editable: a withdrawn resource has no fields on this screen, and the
    // API refuses the write in any case.
    expect(screen.queryByDisplayValue("Tvättstugan i port 12")).toBeNull();
  });
});

describe("adding a resource", () => {
  it("sends what the board typed, with the fields its mode does not use empty", async () => {
    const session = userEvent.setup();
    await open();

    const names = screen.getAllByLabelText(/^Resursens namn/);
    const last = names[names.length - 1];
    if (last === undefined) {
      throw new Error("The add form has no name field.");
    }
    await session.type(last, "Bastun");
    await session.selectOptions(
      screen.getAllByLabelText(/^Så bokas den/).slice(-1)[0]!,
      "DATE_RANGE",
    );
    await session.click(
      screen.getByRole("button", { name: /^Lägg till resurs$/ }),
    );

    await waitFor(() => {
      expect(createBookableResource).toHaveBeenCalledWith({
        name: "Bastun",
        description: null,
        mode: "DATE_RANGE",
        slotMinutes: null,
        opensAtMinute: null,
        closesAtMinute: null,
        maxConcurrentBookings: null,
        maxBookingsPerWeek: null,
      });
    });
  });

  it("says so when the catalogue cannot be read", async () => {
    fetchAllBookableResources.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<BookableResourcesPanel />);

    await waitFor(() => {
      expect(
        screen.getByText(
          "De bokningsbara resurserna kunde inte läsas just nu. Ladda om sidan.",
        ),
      ).toBeTruthy();
    });
  });
});
