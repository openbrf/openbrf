import { apiRequest, type ApiResult } from "./client";

/**
 * The event calendar endpoints (evenemangskalendern).
 *
 * These types mirror the API's wire shapes rather than importing them: the
 * browser and the server are separate builds, and a shared declaration would
 * make the client's compilation depend on the server's source tree.
 *
 * Three base paths, because the API splits them by audience and so does this
 * file. `/api/events` is the board's: the series it arranges, publishing one,
 * and calling off a single date. `/api/event-signups` is what somebody living
 * here may do - the dates still to come, with their own place on each, and
 * taking or giving up that place. `/api/event-attendance` is who is coming, and
 * standing one of them down on their behalf. A screen that gated a panel on the
 * wrong one of those would be showing somebody a control every call behind it
 * refuses.
 *
 * Four properties of the contract are load-bearing and invisible in the types.
 *
 * The resident's list carries counts and never names. How many places are gone
 * is what somebody deciding whether to go needs; who has taken them is personal
 * data about other residents, and it is what events:manage exists to gate. There
 * is no field on {@link AttendableOccurrence} for an attendee, which is what
 * keeps that true through the screens as well as through the endpoint.
 *
 * Every write on the sign-up path answers with the whole state of the date - the
 * count, the places left, and the caller's own row - rather than with the
 * sign-up alone. That is what lets a screen be server-authoritative instead of
 * optimistic: the button and the number beside it are read out of one payload,
 * so they cannot disagree after a race.
 *
 * A refusal is not one of those answers. A 409 carries a reason and, for the one
 * refusal that names particulars, calendar dates - never a count. So a screen
 * that lost a race re-reads the calendar rather than reading `placesTaken` off
 * the failure and finding it undefined.
 *
 * `on` is the local date the API worked out on the association's own clock, and
 * it is what a calendar files an occurrence under. A midsummer party starting at
 * half past midnight is on the 21st of June in Stockholm and on the 20th in UTC,
 * and the notice in the stairwell says the 21st - so nothing here derives a date
 * from an instant.
 */

/** How a series repeats. */
export type EventRecurrenceFrequency = "WEEKLY" | "MONTHLY" | "ANNUAL";

export const EVENT_RECURRENCE_FREQUENCIES: readonly EventRecurrenceFrequency[] =
  ["WEEKLY", "MONTHLY", "ANNUAL"];

/**
 * Who a series is published to.
 *
 * The same two audiences a page and a news item carry, because it is the same
 * question: the street, or the people with an account. MEMBER is the default the
 * server applies, so a slip never puts a cleaning day on the website.
 */
export type EventVisibility = "PUBLIC" | "MEMBER";

/**
 * The bounds the API states for a recurrence rule.
 *
 * Mirrored rather than imported, like every other wire constant here. They are
 * the same numbers the server refuses beyond, so a form can hold a reader inside
 * them instead of letting the refusal be the first thing that says so.
 */
export const EVENT_MAX_OCCURRENCES = 105;
export const EVENT_MAX_DURATION_MINUTES = 24 * 60;
export const EVENT_MAX_INTERVAL = 52;

/** The recurrence rule as a request states it and a response answers with it. */
export interface EventRecurrence {
  frequency: EventRecurrenceFrequency;
  interval: number;
  /** How many occurrences in total, or null when the rule ends on a date. */
  count: number | null;
  /** "YYYY-MM-DD", or null when the rule ends on a count. */
  until: string | null;
}

/** One date in a series, as the board's own screen reads it. */
export interface EventOccurrence {
  id: string;
  /** ISO instants. */
  startsAt: string;
  endsAt: string;
  /** "YYYY-MM-DD", the local date it falls on, as the API worked it out. */
  on: string;
  /** ISO instant the board called it off, or null while it is going ahead. */
  cancelledAt: string | null;
}

/** A series as the board reads it: drafts included. */
export interface EventSeries {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  location: string | null;
  visibility: EventVisibility;
  published: boolean;
  /** ISO instant it was first published, or null while it never has been. */
  publishedAt: string | null;
  signupOpen: boolean;
  /** Places at ONE occurrence. Null is no limit. */
  capacity: number | null;
  /** "YYYY-MM-DD", the date the first occurrence falls on. */
  firstOn: string;
  /** Minutes past local midnight, so 600 is 10:00. */
  startsAtMinute: number;
  durationMinutes: number;
  /** The rule, or null for a series of one date. */
  recurrence: EventRecurrence | null;
  /** Every date in the series, earliest first, called-off ones included. */
  occurrences: EventOccurrence[];
}

/**
 * A series as the board states it.
 *
 * Every optional field is `null` rather than absent, because the API reads a
 * cleared field and an omitted one as the same thing. That is deliberate on its
 * side and has to be deliberate here: a form that left `recurrence` out when the
 * board turned a repeating cleaning day into a single date would be asking the
 * server to keep the rule on a series that no longer has one.
 */
export interface EventSeriesInput {
  title: string;
  description: string | null;
  category: string | null;
  location: string | null;
  signupOpen: boolean;
  capacity: number | null;
  /** "YYYY-MM-DD", the date the first occurrence falls on. */
  firstOn: string;
  /** Minutes past local midnight, so 600 is 10:00. */
  startsAtMinute: number;
  durationMinutes: number;
  recurrence: EventRecurrence | null;
}

/**
 * Whether a series is published, and who for.
 *
 * The audience is optional and left alone when absent, exactly as a news item's
 * is: taking a series down does not decide who it was for.
 */
export interface PublishEventInput {
  published: boolean;
  visibility?: EventVisibility;
}

/** The caller's own sign-up to one date, standing or stood down. */
export interface OwnSignup {
  signupId: string;
  /** ISO instant the sign-up that stands now was made. */
  signedUpAt: string;
  /** ISO instant they stood down, or null while they are expected. */
  withdrawnAt: string | null;
}

/**
 * One date, as somebody deciding whether to go reads it.
 *
 * A count and never a name; see the file comment. `own` is the whole of the
 * caller's own state and arrives with every answer the sign-up path gives, so
 * the count and the button are read from one payload.
 */
export interface AttendableOccurrence {
  occurrenceId: string;
  eventId: string;
  title: string;
  description: string | null;
  category: string | null;
  location: string | null;
  /** ISO instants. */
  startsAt: string;
  endsAt: string;
  /** "YYYY-MM-DD", the local date it falls on, as the API worked it out. */
  on: string;
  /** ISO instant the board called it off, or null while it is going ahead. */
  cancelledAt: string | null;
  /** Whether the series takes sign-ups at all. */
  signupOpen: boolean;
  /** Places at this date. Null is no limit. */
  capacity: number | null;
  /** Standing sign-ups at this date, withdrawals not counted. */
  placesTaken: number;
  /** Places still free, or null when there is no limit. */
  placesLeft: number | null;
  own: OwnSignup | null;
}

/**
 * Who signed up, as whoever manages events may be told.
 *
 * `protected` carries no name: a person with protected personal data (skyddade
 * personuppgifter) is a place on the roll-call and never a name, because the
 * statutory registers have a reason to print those names and a list read in a
 * stairwell doorway has none. `unknown` is a person reference the register no
 * longer holds, which service-tier data has to be able to say rather than break.
 */
export type EventAttendee =
  | { kind: "resident"; personId: string; name: string }
  | { kind: "protected"; personId: string }
  | { kind: "unknown" };

export interface RollCallEntry {
  signupId: string;
  attendee: EventAttendee;
  signedUpAt: string;
  /** ISO instant they stood down, or null while they are expected. */
  withdrawnAt: string | null;
}

/** One date and everybody who has put their name down for it. */
export interface RollCall {
  occurrenceId: string;
  eventId: string;
  title: string;
  /** ISO instants. */
  startsAt: string;
  endsAt: string;
  /** "YYYY-MM-DD" on the association's own clock. */
  on: string;
  cancelledAt: string | null;
  capacity: number | null;
  /** Standing sign-ups, which is what the capacity is measured against. */
  placesTaken: number;
  /** Everybody with a row for this date, the ones who stood down included. */
  entries: RollCallEntry[];
}

// --- signing up, as somebody living here ------------------------------------

/**
 * The dates still to come, with the caller's own place on each.
 *
 * Every published series, whether or not it takes sign-ups: a cleaning day to
 * put your name down for and a notice that the water is off belong on the same
 * calendar, and `signupOpen` says which is which. Drafts are absent.
 */
export function fetchUpcomingOccurrences(): Promise<
  ApiResult<AttendableOccurrence[]>
> {
  return apiRequest("GET", "/api/event-signups");
}

/** Takes a place at one date, and answers with the date as it then stands. */
export function signUpForOccurrence(
  occurrenceId: string,
): Promise<ApiResult<AttendableOccurrence>> {
  return apiRequest(
    "POST",
    `/api/event-signups/${encodeURIComponent(occurrenceId)}`,
  );
}

/**
 * Stands the caller down from one date.
 *
 * Keyed on the date rather than on the sign-up: what the person has is the
 * cleaning day on the 18th, and the place is free the moment the withdrawal date
 * is written.
 */
export function withdrawFromOccurrence(
  occurrenceId: string,
): Promise<ApiResult<AttendableOccurrence>> {
  return apiRequest(
    "POST",
    `/api/event-signups/${encodeURIComponent(occurrenceId)}/withdraw`,
  );
}

// --- the series the board arranges ------------------------------------------

/** Every series, drafts included, the most recently arranged first. */
export function fetchEventSeries(): Promise<ApiResult<EventSeries[]>> {
  return apiRequest("GET", "/api/events");
}

export function createEventSeries(
  input: EventSeriesInput,
): Promise<ApiResult<EventSeries>> {
  return apiRequest("POST", "/api/events", input);
}

export function updateEventSeries(input: {
  id: string;
  values: EventSeriesInput;
}): Promise<ApiResult<EventSeries>> {
  return apiRequest(
    "PUT",
    `/api/events/${encodeURIComponent(input.id)}`,
    input.values,
  );
}

/**
 * Publishes a series or takes it down, and says who it is for.
 *
 * One act rather than two, exactly as a news item's publication is: a series is
 * announced to the people it was arranged for, and a second route for the
 * audience alone would be a second way for the record of that decision to be
 * missed.
 */
export function publishEventSeries(input: {
  id: string;
  values: PublishEventInput;
}): Promise<ApiResult<EventSeries>> {
  return apiRequest(
    "POST",
    `/api/events/${encodeURIComponent(input.id)}/publish`,
    input.values,
  );
}

/**
 * Calls off one date, leaving the rest of the series standing.
 *
 * A POST to a named act rather than a DELETE, because nothing is deleted: the
 * row stays with the date it was called off on. "The cleaning day on the 18th
 * was called off" is a different thing to say than "there was never one".
 */
export function cancelEventOccurrence(
  occurrenceId: string,
): Promise<ApiResult<EventSeries>> {
  return apiRequest(
    "POST",
    `/api/events/occurrences/${encodeURIComponent(occurrenceId)}/cancel`,
  );
}

/**
 * Removes a series and every date in it.
 *
 * Refused while anybody has signed up to one of those dates, which is what the
 * `occurrence-in-use` refusal says and why it names them.
 */
export function removeEventSeries(id: string): Promise<ApiResult<void>> {
  return apiRequest("DELETE", `/api/events/${encodeURIComponent(id)}`);
}

// --- who is coming ----------------------------------------------------------

/** Everybody with a row for one date, the ones who stood down included. */
export function fetchRollCall(
  occurrenceId: string,
): Promise<ApiResult<RollCall>> {
  return apiRequest(
    "GET",
    `/api/event-attendance/occurrences/${encodeURIComponent(occurrenceId)}`,
  );
}

/**
 * Withdraws one sign-up on behalf of the person who made it.
 *
 * Keyed on the sign-up, which is what the roll-call gives: the board is standing
 * one named person down rather than clearing a date. There is deliberately no
 * route that withdraws everybody at once - calling the date off is the act for
 * that, and it leaves the sign-ups saying who had been expected.
 */
export function withdrawSignupForBoard(
  signupId: string,
): Promise<ApiResult<RollCall>> {
  return apiRequest(
    "POST",
    `/api/event-attendance/signups/${encodeURIComponent(signupId)}/withdraw`,
  );
}
