import type { APIRequestContext } from "@playwright/test";

import { stack } from "./stack";

/**
 * Resource booking, over HTTP.
 *
 * The screens are what the spec drives, because the screens are what the module
 * promises: a calendar of free and not free, a refusal read as a sentence, a
 * board cancelling on somebody's behalf. What lives here is the arrangement
 * around those - the resource the board has to have named before anything is
 * bookable, and the booking a second household has to find already made.
 *
 * Two of those are deliberately not done through a browser.
 *
 * The catalogue has its own coverage: the settings panel is photographed with a
 * laundry room named through the form, and the API refuses every malformed
 * schedule in an integration spec. Naming one here through the settings screen
 * would make each test in the file pay for a second sign-in and assert on a
 * form it is not about.
 *
 * The booking somebody else already holds is the harder one, and the reason is
 * the behaviour under test. A slot the calendar draws as taken is a disabled
 * control, so a second household cannot click it: reaching the refusal at all
 * means the first booking has to land while the second reader's page is open,
 * which is exactly the race a resident meets in life. So the first booking is
 * made from a context of its own, and what the browser then clicks is a slot
 * that was free when it was drawn.
 */

/** A resource as somebody booking it is shown it. */
export type BookableResourceSummary = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly mode: "TIME_SLOTS" | "WHOLE_DAY" | "DATE_RANGE";
  readonly slotMinutes: number | null;
  readonly opensAtMinute: number | null;
  readonly closesAtMinute: number | null;
  readonly maxConcurrentBookings: number | null;
  readonly maxBookingsPerWeek: number | null;
};

/** A resource as the board configures it. */
export type BookableResource = BookableResourceSummary & {
  readonly deactivatedAt: string | null;
  readonly bookingCount: number;
};

/** What the board states about a resource. Every field, every time. */
export type BookableResourceInput = {
  readonly name: string;
  readonly description: string | null;
  readonly mode: "TIME_SLOTS" | "WHOLE_DAY" | "DATE_RANGE";
  readonly slotMinutes: number | null;
  readonly opensAtMinute: number | null;
  readonly closesAtMinute: number | null;
  readonly maxConcurrentBookings: number | null;
  readonly maxBookingsPerWeek: number | null;
};

export type BookableSlot = {
  readonly startsAt: string;
  readonly endsAt: string;
  /** The Stockholm calendar day the slot opens on, "YYYY-MM-DD". */
  readonly day: string;
  readonly opensAtMinute: number;
  readonly state: "FREE" | "TAKEN" | "MINE" | "PAST";
  readonly bookingId: string | null;
};

export type BookingApartment = {
  readonly id: string;
  readonly number: string;
  readonly address: string;
};

export type OwnBooking = {
  readonly id: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly mode: "TIME_SLOTS" | "WHOLE_DAY" | "DATE_RANGE";
  readonly status: "BOOKED" | "CANCELLED" | "RELEASED";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly apartment: BookingApartment | null;
};

async function expectOk(
  response: {
    ok: () => boolean;
    status: () => number;
    text: () => Promise<string>;
  },
  what: string,
): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `${what} answered ${String(response.status())}: ${await response.text()}`,
    );
  }
}

/**
 * A laundry room whose day divides into whole slots.
 *
 * Two slots a day - seven hours each between 07:00 and 21:00 - because a slot
 * length that leaves a remainder is refused at save time, and two is enough for
 * a test that needs a second slot on one day without the grid becoming a wall.
 *
 * Both quotas are unset unless a caller asks for one, so a test that is not
 * about the allowance cannot be refused by it.
 */
export function timeSlotResource(input: {
  name: string;
  maxBookingsPerWeek?: number;
}): BookableResourceInput {
  return {
    name: input.name,
    description: null,
    mode: "TIME_SLOTS",
    slotMinutes: 7 * 60,
    opensAtMinute: 7 * 60,
    closesAtMinute: 21 * 60,
    maxConcurrentBookings: null,
    maxBookingsPerWeek: input.maxBookingsPerWeek ?? null,
  };
}

/**
 * Names a resource, unless the catalogue already holds one by that name.
 *
 * Looked up before it is written, because creating one is not idempotent and
 * every test in a file calls its fixture: unconditional creation would leave
 * one identical laundry room per test per run in a catalogue nothing can delete
 * from. The name is what settles it, and the specs make theirs unique to the
 * run for exactly that reason.
 *
 * The caller's context has to be signed in as somebody holding
 * bookings:configure.
 */
export async function ensureResource(
  request: APIRequestContext,
  input: BookableResourceInput,
): Promise<BookableResource> {
  const listed = await request.get(`${stack.baseUrl}/api/bookable-resources`);
  await expectOk(listed, "GET /api/bookable-resources");
  const existing = (await listed.json()) as readonly BookableResource[];
  const already = existing.find((resource) => resource.name === input.name);
  if (already !== undefined) {
    return already;
  }

  const created = await request.post(
    `${stack.baseUrl}/api/bookable-resources`,
    { data: input },
  );
  await expectOk(created, "POST /api/bookable-resources");
  return (await created.json()) as BookableResource;
}

/** The apartments this context may book against. */
export async function ownApartments(
  request: APIRequestContext,
): Promise<readonly BookingApartment[]> {
  const response = await request.get(
    `${stack.baseUrl}/api/bookings/apartments`,
  );
  await expectOk(response, "GET /api/bookings/apartments");
  return (await response.json()) as readonly BookingApartment[];
}

/** What a resource offers between two "YYYY-MM-DD" days, both ends included. */
export async function slotsOn(
  request: APIRequestContext,
  input: { resourceId: string; from: string; to: string },
): Promise<readonly BookableSlot[]> {
  const response = await request.get(
    `${stack.baseUrl}/api/bookings/resources/${input.resourceId}/slots` +
      `?from=${input.from}&to=${input.to}`,
  );
  await expectOk(response, "GET /api/bookings/resources/:id/slots");
  return (await response.json()) as readonly BookableSlot[];
}

/**
 * Takes one slot of a day, by the order the day offers them.
 *
 * The instants come from the answer rather than being assembled here. The
 * server compares what it is sent against the slots it generates, and a
 * wall-clock hour is not enough to name an instant on the two Sundays the
 * clocks move - so a spec that built one would be asserting on its own
 * arithmetic.
 */
export async function bookNthSlotOn(
  request: APIRequestContext,
  input: {
    resourceId: string;
    apartmentId: string;
    day: string;
    /** Zero-based, among the slots the day offers. */
    index: number;
  },
): Promise<OwnBooking> {
  const slots = await slotsOn(request, {
    resourceId: input.resourceId,
    from: input.day,
    to: input.day,
  });
  const slot = slots[input.index];
  if (slot === undefined) {
    throw new Error(
      `${input.day} offers ${String(slots.length)} slots on resource ` +
        `${input.resourceId}, so there is no slot ${String(input.index)}`,
    );
  }
  if (slot.state !== "FREE") {
    throw new Error(
      `slot ${String(input.index)} on ${input.day} is ${slot.state}, not free`,
    );
  }

  const response = await request.post(`${stack.baseUrl}/api/bookings`, {
    data: {
      resourceId: input.resourceId,
      apartmentId: input.apartmentId,
      startsAt: slot.startsAt,
      endsAt: null,
    },
  });
  await expectOk(response, "POST /api/bookings");
  return (await response.json()) as OwnBooking;
}

/** What this context holds: live and unfinished bookings, nearest first. */
export async function ownBookings(
  request: APIRequestContext,
): Promise<readonly OwnBooking[]> {
  const response = await request.get(`${stack.baseUrl}/api/bookings/mine`);
  await expectOk(response, "GET /api/bookings/mine");
  return (await response.json()) as readonly OwnBooking[];
}
