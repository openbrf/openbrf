/**
 * The rule that says a resource's booking mechanics are configured coherently.
 *
 * Pure, and separate from the service, because it is the one piece of resource
 * administration with a decision in it: the rest is a row written the way it
 * arrived. A board configuring a laundry room states a slot length and an
 * opening and closing time, and three of the ways those can disagree produce a
 * catalogue entry nothing can generate a slot from. Catching them here means
 * the board is told at the moment it can still fix it, rather than a resident
 * meeting an empty day.
 *
 * The `mode` decides which fields are configuration and which are noise. A
 * whole-day resource has no slot length, and one stored on it would be a
 * setting the board could change with no effect - the worst kind, because it
 * reads as though it did something.
 */

import type { BookingResourceMode } from "../generated/prisma/enums";

/** Minutes in a day, which is the bound on a time of day and on a slot. */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * The booking mechanics as a board states them.
 *
 * Nulls throughout rather than optional fields: an update that leaves a field
 * out is saying it should be empty, and a shape that could not tell the two
 * apart would let a resource keep a slot length after it was changed to
 * whole-day booking.
 */
export interface ResourceSchedule {
  mode: BookingResourceMode;
  slotMinutes: number | null;
  opensAtMinute: number | null;
  closesAtMinute: number | null;
}

/**
 * Why a schedule cannot be stored, or null when it can.
 *
 * These are the reasons a {@link BookingError} carries, so the refusal a board
 * member reads names the rule that refused rather than the field it happened to
 * check last.
 */
export type ScheduleProblem =
  | "schedule-required"
  | "schedule-not-applicable"
  | "closes-before-opens"
  | "slot-does-not-fit";

/**
 * Checks the schedule against the mode it belongs to.
 *
 * TIME_SLOTS needs all three fields and the other two modes must carry none of
 * them. The opening has to come before the closing, and the day between them
 * has to be a whole number of slots: a laundry room open 07:00-21:00 in
 * three-hour slots is four slots and a two-hour remainder, and the remainder
 * has to be decided by the board rather than left for slot generation to
 * discard or to offer as a short booking. Refusing it is what makes "the day is
 * its slots" true.
 *
 * Bounds are checked here as well as by the endpoint's schema. The endpoint
 * bounds what a request may carry; this bounds what the table may hold, and the
 * service is not the only caller a table gets.
 */
export function checkResourceSchedule(
  schedule: ResourceSchedule,
): ScheduleProblem | null {
  const { mode, slotMinutes, opensAtMinute, closesAtMinute } = schedule;

  if (mode !== "TIME_SLOTS") {
    return slotMinutes === null &&
      opensAtMinute === null &&
      closesAtMinute === null
      ? null
      : "schedule-not-applicable";
  }

  if (
    slotMinutes === null ||
    opensAtMinute === null ||
    closesAtMinute === null
  ) {
    return "schedule-required";
  }
  if (
    !isWholeMinuteWithin(slotMinutes, 1, MINUTES_PER_DAY) ||
    !isWholeMinuteWithin(opensAtMinute, 0, MINUTES_PER_DAY - 1) ||
    !isWholeMinuteWithin(closesAtMinute, 1, MINUTES_PER_DAY)
  ) {
    return "schedule-required";
  }

  if (closesAtMinute <= opensAtMinute) {
    // Equal is refused with the same reason as reversed: a day that opens and
    // closes at the same minute holds no slots, which is a resource nobody can
    // book rather than a resource that is closed.
    return "closes-before-opens";
  }

  const open = closesAtMinute - opensAtMinute;
  if (open % slotMinutes !== 0) {
    return "slot-does-not-fit";
  }

  return null;
}

/** A whole number of minutes inside an inclusive range. */
function isWholeMinuteWithin(
  value: number,
  lowest: number,
  highest: number,
): boolean {
  return Number.isInteger(value) && value >= lowest && value <= highest;
}
