import type {
  EventRecurrenceFrequency,
  EventSeries,
  EventSeriesInput,
} from "../api/events";
import { minuteOfTimeValue, timeValueOfMinute } from "./event-calendar";

/**
 * A series as the form holds it, and what it sends.
 *
 * Every field is text until it is submitted, because that is what a form field
 * holds: a number input mid-edit is "1" on the way to "10", and a draft typed as
 * numbers would have to decide what an empty field means on every keystroke.
 *
 * Kept out of the components so the conversion in both directions can be read
 * and tested on its own. It is the half of this module with rules in it, and
 * those rules are about what a form has finished saying - never about whether a
 * series is allowed. The server decides that, and it decides it again for a
 * request this form could not have produced.
 */

/** Whether a repeating rule states its end as a count or as a last date. */
export type RecurrenceEnd = "count" | "until";

export interface EventDraft {
  title: string;
  description: string;
  category: string;
  location: string;
  signupOpen: boolean;
  /** Places at one date. Empty is no limit. */
  capacity: string;
  /** "YYYY-MM-DD", the date the first occurrence falls on. */
  firstOn: string;
  /** "HH:MM" on the association's clock, as a time field holds it. */
  startsAt: string;
  durationMinutes: string;
  /** Empty for a series of one date, which is the default a form opens on. */
  frequency: "" | EventRecurrenceFrequency;
  interval: string;
  end: RecurrenceEnd;
  count: string;
  until: string;
}

/**
 * The form a board opens on.
 *
 * Two hours at ten in the morning, not repeating. Chosen because it is the
 * commonest thing a housing cooperative puts in its calendar and because every
 * value in it is one a board changes rather than one it has to invent - an empty
 * duration field would make the first save a refusal.
 *
 * `end` is "count" while no rule is chosen at all, so turning a series into a
 * repeating one offers the simpler of the two ends first: "six times" is a
 * decision a board can make on the spot, and a last date is one it works out.
 */
export const EMPTY_DRAFT: EventDraft = {
  title: "",
  description: "",
  category: "",
  location: "",
  signupOpen: false,
  capacity: "",
  firstOn: "",
  startsAt: "10:00",
  durationMinutes: "120",
  frequency: "",
  interval: "1",
  end: "count",
  count: "",
  until: "",
};

/** "YYYY-MM-DD", the form a date field holds and the API states a date in. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What the form sends, or nothing while it is not finished.
 *
 * Null means the draft does not yet describe a series - a title nobody has
 * typed, a date nobody has picked, a repeating rule with no end stated. The
 * submit control is gated on the same answer, so there is one definition of
 * finished rather than one for the button and another for the payload.
 *
 * It is deliberately not a second opinion on whether the series is allowed. A
 * duration longer than a day, an interval of forty weeks, a rule reaching past
 * the horizon and a capacity of zero are all refused by the server with a reason
 * of their own, and this form's job is to let the board hear that reason rather
 * than to guess at it.
 *
 * Every field the shape does not use is sent as null rather than left out,
 * because the API reads a cleared field and an omitted one as the same thing: a
 * repeating series turned into a single date has to say that its rule is gone,
 * and one with sign-up closed has to say that its capacity is.
 */
export function inputOf(draft: EventDraft): EventSeriesInput | null {
  const title = draft.title.trim();
  const startsAtMinute = minuteOfTimeValue(draft.startsAt);
  const durationMinutes = positiveIntegerOf(draft.durationMinutes);

  if (
    title === "" ||
    !DAY_PATTERN.test(draft.firstOn) ||
    startsAtMinute === null ||
    durationMinutes === null
  ) {
    return null;
  }

  /*
   * A capacity is optional and, once typed, has to be a number. An unreadable
   * one is not read as "no limit": that would turn a slip in the places field
   * into an unlimited cleaning day, which is the one direction this must not
   * fail in.
   */
  const capacity = draft.signupOpen
    ? optionalPositiveInteger(draft.capacity)
    : null;
  if (capacity === "invalid") {
    return null;
  }

  const recurrence = recurrenceOf(draft);
  if (recurrence === "invalid") {
    return null;
  }

  return {
    title,
    description: textOrNull(draft.description),
    category: textOrNull(draft.category),
    location: textOrNull(draft.location),
    signupOpen: draft.signupOpen,
    capacity,
    firstOn: draft.firstOn,
    startsAtMinute,
    durationMinutes,
    recurrence,
  };
}

/** The stored series as the form holds it. */
export function draftOf(series: EventSeries): EventDraft {
  const rule = series.recurrence;
  return {
    title: series.title,
    description: series.description ?? "",
    category: series.category ?? "",
    location: series.location ?? "",
    signupOpen: series.signupOpen,
    capacity: series.capacity === null ? "" : String(series.capacity),
    firstOn: series.firstOn,
    startsAt: timeValueOfMinute(series.startsAtMinute),
    durationMinutes: String(series.durationMinutes),
    frequency: rule?.frequency ?? "",
    interval: String(rule?.interval ?? 1),
    // The rule states exactly one end, so which one it states is which one the
    // form opens on. A series with no rule keeps the default.
    end: rule !== null && rule.until !== null ? "until" : "count",
    count: rule?.count === null || rule === null ? "" : String(rule.count),
    until: rule?.until ?? "",
  };
}

/**
 * The stored values a row's fields are seeded from, as one string.
 *
 * Used as a key, so a row re-seeds its fields from what is now stored after a
 * save rather than going on showing what was typed. Every field the form can
 * change is in it: one that was left out would leave a row showing a value the
 * server had refused.
 */
export function signatureOf(series: EventSeries): string {
  return [
    series.id,
    series.title,
    series.description ?? "",
    series.category ?? "",
    series.location ?? "",
    String(series.signupOpen),
    series.capacity ?? "",
    series.firstOn,
    series.startsAtMinute,
    series.durationMinutes,
    series.recurrence?.frequency ?? "",
    series.recurrence?.interval ?? "",
    series.recurrence?.count ?? "",
    series.recurrence?.until ?? "",
  ].join("|");
}

/**
 * The rule the draft states, nothing for a single date, or "invalid".
 *
 * "Invalid" is the unfinished form and not a refusal: a rule the board has
 * chosen a frequency for but no end is a form still being filled in, and the API
 * has its own reason code for a rule that states none - which a board reaches by
 * sending one, not by being stopped here.
 */
function recurrenceOf(
  draft: EventDraft,
): EventSeriesInput["recurrence"] | "invalid" {
  if (draft.frequency === "") {
    return null;
  }
  const interval = positiveIntegerOf(draft.interval);
  if (interval === null) {
    return "invalid";
  }
  if (draft.end === "count") {
    const count = positiveIntegerOf(draft.count);
    return count === null
      ? "invalid"
      : { frequency: draft.frequency, interval, count, until: null };
  }
  return DAY_PATTERN.test(draft.until)
    ? {
        frequency: draft.frequency,
        interval,
        count: null,
        until: draft.until,
      }
    : "invalid";
}

/** The trimmed text, or null when the field holds nothing. */
function textOrNull(value: string): string | null {
  const text = value.trim();
  return text === "" ? null : text;
}

/** A whole number above zero, or null when the field is empty or not one. */
function positiveIntegerOf(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Null for an empty field, the number for a good one, "invalid" otherwise. */
function optionalPositiveInteger(value: string): number | null | "invalid" {
  if (value.trim() === "") {
    return null;
  }
  return positiveIntegerOf(value) ?? "invalid";
}
