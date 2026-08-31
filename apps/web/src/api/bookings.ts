import { apiRequest, type ApiResult } from "./client";

/**
 * The booking endpoints.
 *
 * These types mirror the API's wire shapes rather than importing them: the
 * browser and the server are separate builds, and a shared declaration would
 * make the client's compilation depend on the server's source tree.
 *
 * Three base paths, because the API splits them by audience and so does this
 * file. `/api/bookings` is what a resident may do - what the house offers, what
 * a resource offers on a date, taking a slot, and cancelling one's own.
 * `/api/booking-admin` is the board's view of who holds which hour and
 * cancelling on somebody's behalf. `/api/bookable-resources` is the catalogue
 * the board writes. A screen that gates a panel on the wrong one of those would
 * be showing somebody a control every call behind it refuses.
 *
 * Two properties of the contract are load-bearing and invisible in the types.
 *
 * A slot's state is FREE, TAKEN, MINE or PAST and carries no identity: which
 * apartment holds nine o'clock is personal data the resident calendar is not
 * given, and TAKEN is the whole of what it says. Nothing in this file has a
 * field to put a booker in, which is what keeps that true through the screens
 * as well as through the endpoint.
 *
 * `startsAt` and `endsAt` are copied back verbatim from a slot the calendar
 * returned. The server compares instants against the slots it generates, so a
 * time assembled in the browser from a date and an hour is refused as a period
 * the resource does not offer - correctly, because a wall-clock hour on the two
 * Sundays the clocks move is not an instant the browser can name on its own.
 */

/** The three ways a thing in the house can be booked. */
export type BookingResourceMode = "TIME_SLOTS" | "WHOLE_DAY" | "DATE_RANGE";

export const BOOKING_RESOURCE_MODES: readonly BookingResourceMode[] = [
  "TIME_SLOTS",
  "WHOLE_DAY",
  "DATE_RANGE",
];

/**
 * Where a booking stands.
 *
 * `RELEASED` is reserved schema room that nothing in the core writes. It is in
 * the union because the column can hold it, and a screen reading a status it
 * has no word for would render an empty cell.
 */
export type BookingStatus = "BOOKED" | "CANCELLED" | "RELEASED";

/**
 * What a slot is to the person looking at it.
 *
 * `PAST` is a free slot that has already begun, kept in the answer so the grid
 * can still be drawn for a week whose earlier days have gone.
 */
export type BookingSlotState = "FREE" | "TAKEN" | "MINE" | "PAST";

/** An apartment a booking may be made for, as a picker shows it. */
export interface BookingApartment {
  id: string;
  number: string;
  /** "Storgatan 12", so a household with two entrances can tell them apart. */
  address: string;
}

export interface BookableSlot {
  /** ISO instants, and what a booking request sends back verbatim. */
  startsAt: string;
  endsAt: string;
  /** The Stockholm calendar day the slot opens on, "YYYY-MM-DD". */
  day: string;
  /** Minutes past local midnight it opens at, so 420 is 07:00. */
  opensAtMinute: number;
  state: BookingSlotState;
  /** Set only when the state is MINE. */
  bookingId: string | null;
}

export interface OwnBooking {
  id: string;
  resourceId: string;
  resourceName: string;
  mode: BookingResourceMode;
  status: BookingStatus;
  startsAt: string;
  endsAt: string;
  apartment: BookingApartment | null;
}

/**
 * Who made a booking, as the board may be told.
 *
 * `protected` carries no name: a person with protected personal data is masked
 * here, because the board's address book has a statutory reason to print it and
 * a booking calendar has none. `unknown` is a booker the register no longer
 * holds, which service-tier data has to be able to say rather than break.
 */
export type BookingBooker =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

export interface ManagedBooking extends OwnBooking {
  bookedBy: BookingBooker;
}

/**
 * A resource as somebody booking it is shown it.
 *
 * The two limits are on it because they are the rules the person booking is
 * subject to, so a screen can say what the allowance is before a refusal has
 * to. They are the board's policy for its own building rather than anybody's
 * data.
 */
export interface BookableResourceSummary {
  id: string;
  name: string;
  description: string | null;
  mode: BookingResourceMode;
  slotMinutes: number | null;
  opensAtMinute: number | null;
  closesAtMinute: number | null;
  maxConcurrentBookings: number | null;
  maxBookingsPerWeek: number | null;
}

/** A resource as the board configures it. */
export interface BookableResource extends BookableResourceSummary {
  /** ISO instant, or null while the resource is offered for booking. */
  deactivatedAt: string | null;
  /**
   * How many bookings have been made against it, cancelled ones included.
   *
   * A count and never a list: the board needs it to see what withdrawing a
   * resource would leave behind, and nothing about who booked what belongs on a
   * configuration screen.
   */
  bookingCount: number;
}

/**
 * A resource as the board states it.
 *
 * Every optional field is `null` rather than absent, because the API reads a
 * cleared field and an omitted one as the same thing. That is deliberate on its
 * side and has to be deliberate here: a form that left `slotMinutes` out when
 * the board switched a laundry room to whole-day booking would be asking the
 * server to keep a slot length on a resource that has no slots.
 */
export interface BookableResourceInput {
  name: string;
  description: string | null;
  mode: BookingResourceMode;
  slotMinutes: number | null;
  opensAtMinute: number | null;
  closesAtMinute: number | null;
  maxConcurrentBookings: number | null;
  maxBookingsPerWeek: number | null;
}

export interface BookInput {
  resourceId: string;
  apartmentId: string;
  /** The slot's own start, copied from the calendar rather than assembled. */
  startsAt: string;
  /** The last night's end, for a resource booked by the night. Null otherwise. */
  endsAt: string | null;
}

/** The window a calendar request covers, as inclusive "YYYY-MM-DD" dates. */
export interface BookingWindow {
  from: string;
  to: string;
}

// --- booking, and one's own bookings -----------------------------------------

/** What the house offers today. Withdrawn resources are not on it. */
export function fetchBookableResources(): Promise<
  ApiResult<BookableResourceSummary[]>
> {
  return apiRequest("GET", "/api/bookings/resources");
}

/** The caller's own apartments, for the picker on the form. */
export function fetchBookingApartments(): Promise<
  ApiResult<BookingApartment[]>
> {
  return apiRequest("GET", "/api/bookings/apartments");
}

export function fetchBookableSlots(input: {
  resourceId: string;
  window: BookingWindow;
}): Promise<ApiResult<BookableSlot[]>> {
  return apiRequest(
    "GET",
    `/api/bookings/resources/${encodeURIComponent(input.resourceId)}/slots` +
      `?${windowQuery(input.window)}`,
  );
}

export function fetchOwnBookings(): Promise<ApiResult<OwnBooking[]>> {
  return apiRequest("GET", "/api/bookings/mine");
}

export function bookSlot(input: BookInput): Promise<ApiResult<OwnBooking>> {
  return apiRequest("POST", "/api/bookings", input);
}

export function cancelOwnBooking(
  bookingId: string,
): Promise<ApiResult<OwnBooking>> {
  return apiRequest(
    "POST",
    `/api/bookings/${encodeURIComponent(bookingId)}/cancel`,
  );
}

// --- the board's view of the calendar ----------------------------------------

export function fetchManagedBookings(input: {
  /** Every resource when absent, which is how the board reads the day. */
  resourceId?: string;
  window: BookingWindow;
}): Promise<ApiResult<ManagedBooking[]>> {
  const resource =
    input.resourceId === undefined || input.resourceId === ""
      ? ""
      : `&resourceId=${encodeURIComponent(input.resourceId)}`;
  return apiRequest(
    "GET",
    `/api/booking-admin?${windowQuery(input.window)}${resource}`,
  );
}

/** Cancels anybody's booking, recorded against the board member who did. */
export function cancelBookingForBoard(
  bookingId: string,
): Promise<ApiResult<OwnBooking>> {
  return apiRequest(
    "POST",
    `/api/booking-admin/${encodeURIComponent(bookingId)}/cancel`,
  );
}

// --- the catalogue the board writes ------------------------------------------

/** The whole catalogue, withdrawn resources included. */
export function fetchAllBookableResources(): Promise<
  ApiResult<BookableResource[]>
> {
  return apiRequest("GET", "/api/bookable-resources");
}

export function createBookableResource(
  input: BookableResourceInput,
): Promise<ApiResult<BookableResource>> {
  return apiRequest("POST", "/api/bookable-resources", input);
}

export function updateBookableResource(input: {
  id: string;
  values: BookableResourceInput;
}): Promise<ApiResult<BookableResource>> {
  return apiRequest(
    "PUT",
    `/api/bookable-resources/${encodeURIComponent(input.id)}`,
    input.values,
  );
}

/**
 * Withdraws a resource from booking.
 *
 * Nothing is deleted and there is no route that offers a withdrawn resource
 * again: what the house offers is a board decision, and reversing it is a
 * decision of the same size rather than a checkbox on a form.
 */
export function deactivateBookableResource(
  id: string,
): Promise<ApiResult<BookableResource>> {
  return apiRequest(
    "POST",
    `/api/bookable-resources/${encodeURIComponent(id)}/deactivate`,
  );
}

/** The two inclusive dates a calendar request is bounded by. */
function windowQuery(window: BookingWindow): string {
  return (
    `from=${encodeURIComponent(window.from)}` +
    `&to=${encodeURIComponent(window.to)}`
  );
}
