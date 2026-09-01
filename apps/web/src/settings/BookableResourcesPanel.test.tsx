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
 *
 * And that the one refusal which publishes particulars turns them into
 * something the board can act on: the fields a personal identity number was
 * found in, named as the form names them, and never the offset the response
 * also carried. Read off the response - a screen that guessed would send
 * somebody to edit text that holds nothing.
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

/** The add form's field, which is always the last of its kind on the panel. */
function addField(label: RegExp): HTMLElement {
  const fields = screen.getAllByLabelText(label);
  const last = fields[fields.length - 1];
  if (last === undefined) {
    throw new Error(`No field matched ${String(label)}`);
  }
  return last;
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

  it("says which bookings are in the way when the mechanics cannot be changed yet", async () => {
    // Somebody holds next Tuesday under the hours the board is rewriting. The
    // refusal has to say what to do about it, and that the fields it does not
    // cover can still be saved.
    updateBookableResource.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "resource-in-use" },
    });

    const session = userEvent.setup();
    await open();
    await session.click(screen.getByRole("button", { name: /^Spara$/ }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Resursen har bokningar som inte har passerat, så hur den bokas kan inte ändras än. Avboka dem, eller vänta tills de har passerat. Namnet, beskrivningen och gränserna går att ändra nu.",
        ),
      ).toBeTruthy();
    });
  });

  it("names the fields a personal identity number was found in", async () => {
    updateBookableResource.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        reason: "personal-identity-number",
        detail: [
          { field: "description", offset: 26 },
          { field: "name", offset: 12 },
        ],
      },
    });

    const session = userEvent.setup();
    await open();
    await session.click(screen.getByRole("button", { name: /^Spara$/ }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    // The fields as the form names them, so the board looks at the right box.
    // The offsets are deliberately not on screen: a character position in a
    // textarea is not something a person acts on, and the field is.
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain(
      "så ta bort det ur: Vad de boende behöver veta, Resursens namn",
    );
    expect(alert).not.toContain("26");
    expect(alert).not.toContain("12");
  });

  it("names no field for a refusal that publishes none", async () => {
    /*
     * The sentence stays one sentence. Every other refusal carries no
     * locations, and a screen that appended whatever it found would end each of
     * them with a field name nothing had been found in.
     */
    updateBookableResource.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "quota-not-positive" },
    });

    const session = userEvent.setup();
    await open();
    await session.click(screen.getByRole("button", { name: /^Spara$/ }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("En gräns måste vara minst en bokning.");
    expect(alert).not.toContain("Resursens namn");
  });
});

describe("when the mechanics can be changed", () => {
  /*
   * Said without a count, and said on every resource. The server refuses a
   * mechanics change while a booking against the resource is still to come, and
   * the only number this screen has is every booking the resource has ever
   * taken - the right number for what withdrawing it would leave behind and the
   * wrong one for this. A resource booked once last winter would otherwise
   * carry a warning for ever while the change it warned about went through.
   */
  it("is said on a resource nothing has ever been booked against", async () => {
    await open();

    expect(
      screen.getByText(
        "Hur en resurs bokas kan bara ändras när ingen bokning på den återstår. Avboka de bokningar som inte har passerat, eller vänta tills de har passerat. Namnet, beskrivningen och gränserna går alltid att ändra.",
      ),
    ).toBeTruthy();
  });

  it("states the rule with no number in it", async () => {
    /*
     * The row still prints how many bookings the resource has taken, because
     * that is the right number for what withdrawing it would leave behind. What
     * this asserts is that the rule's own sentence carries no number at all: the
     * count on this screen is every booking ever made against the resource, and
     * a rule driven off it would warn for ever about a laundry room booked once
     * last winter while the change it warned about went through.
     */
    fetchAllBookableResources.mockResolvedValue({
      ok: true,
      value: [laundry({ bookingCount: 3 })],
    });

    await open();

    const rule = screen.getByText(/Hur en resurs bokas kan bara ändras/);
    expect(rule.textContent).not.toMatch(/\d/);
    expect(screen.getByText("Gjorda bokningar: 3")).toBeTruthy();
  });
});

describe("the notice above three acts that share it", () => {
  it("is the refusal the last act met and not one an earlier act met", async () => {
    /*
     * The board adds a resource, the add is refused, and they then save a row
     * that saves perfectly. Three save states with a fixed precedence and
     * nothing clearing them would leave the add's refusal on screen, so a
     * success would read as a failure - and while it sat there it would answer
     * every later refusal with the add's sentence rather than its own.
     */
    createBookableResource.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "slot-does-not-fit" },
    });

    const session = userEvent.setup();
    await open();

    await session.type(addField(/^Resursens namn/), "Bastun i port 14");
    await session.click(
      screen.getByRole("button", { name: "Lägg till resurs" }),
    );
    await waitFor(() => {
      expect(screen.getByText(/^Passets längd delar inte/)).toBeTruthy();
    });

    await session.click(screen.getByRole("button", { name: /^Spara$/ }));

    await waitFor(() => {
      expect(screen.queryByText(/^Passets längd delar inte/)).toBeNull();
    });
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
