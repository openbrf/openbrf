/**
 * What a resource offers, worked out from how the board configured it.
 *
 * Slots are generated and never stored. A stored calendar would be a second
 * copy of the board's configuration that has to be regenerated when the board
 * changes the opening hours, and would be wrong until it was - so the day a
 * laundry room moves from two-hour to three-hour slots, every future row would
 * describe a resource that no longer exists. Generating means the answer is
 * always the current configuration read against the current calendar.
 *
 * ## The three modes
 *
 * TIME_SLOTS is a day cut into equal pieces between an opening and a closing
 * time. The pieces divide the opening hours exactly, which
 * `checkResourceSchedule` refuses to store otherwise, so this file never has to
 * decide what to do with a remainder.
 *
 * WHOLE_DAY is one slot per day, midnight to midnight.
 *
 * DATE_RANGE is one slot per night, which is the same geometry as WHOLE_DAY -
 * midnight to midnight - and a different rule about what one booking may claim.
 * A guest apartment is booked from a check-in day to a check-out day and the
 * nights between are the thing being taken; a common room is booked for a day
 * at a time and two days is two bookings. The calendar looks identical either
 * way, which is why the distinction lives in {@link periodFor} rather than
 * here.
 *
 * ## Daylight saving
 *
 * Every boundary is a local time of day converted through
 * {@link instantAt}, so a laundry room that opens at seven opens at seven on
 * the 23-hour Sunday in March and on the 25-hour Sunday in October, and the
 * instants it names differ by an hour either side of both.
 *
 * The two Sundays are handled by the boundaries themselves rather than by a
 * case. Slot ends are read off the next boundary rather than computed as start
 * plus length, so a boundary the clocks jumped over simply is not there and the
 * slot before it runs on to the next one that is. A resource open around the
 * clock in one-hour slots therefore offers 23 slots on the March Sunday - the
 * one labelled 01:00 ends at 03:00, which is one real hour - and 24 on the
 * October Sunday, where the one labelled 02:00 is two real hours long because
 * that is how long the wall clock spends reading 02:00 that day.
 */

import type { BookingResourceMode } from "../generated/prisma/enums";
import { checkResourceSchedule } from "./resource-schedule";
import {
  addLocalDays,
  compareLocalDays,
  instantAt,
  localDayOf,
  localDaysBetween,
  type LocalDay,
  type Period,
} from "./stockholm-calendar";

/**
 * The days one request may ask for.
 *
 * Two months, which covers the longest thing a screen shows at once - a guest
 * apartment calendar over a summer - and bounds what a single request costs.
 * A resource in one-minute slots would otherwise be asked for a year and answer
 * with half a million rows.
 */
export const MAX_SLOT_DAYS = 62;

/**
 * The nights one DATE_RANGE booking may cover.
 *
 * A cap on the length of one claim, and deliberately not a board setting: the
 * resource carries how many bookings an apartment may hold, not how long one
 * may be, and adding a column is a schema change rather than a rule this file
 * gets to invent. A month is past the point where booking a guest apartment
 * stops being a booking and starts being a tenancy, which is a decision a board
 * takes in writing rather than through this form.
 */
export const MAX_BOOKING_NIGHTS = 30;

/** The mechanics of a resource, as slot generation needs them. */
export interface SlotResource {
  mode: BookingResourceMode;
  slotMinutes: number | null;
  opensAtMinute: number | null;
  closesAtMinute: number | null;
}

/**
 * The slots a resource offers over a range of days, in order.
 *
 * Both bounds are inclusive local dates. A range whose end is before its start
 * is empty rather than an error: the caller bounds the span before asking, and
 * a generator that threw would put the decision in two places.
 */
export function generateSlots(
  resource: SlotResource,
  from: LocalDay,
  to: LocalDay,
): Period[] {
  if (compareLocalDays(from, to) > 0) {
    return [];
  }

  return resource.mode === "TIME_SLOTS"
    ? timeSlots(resource, from, to)
    : wholeDays(from, to);
}

/**
 * The slot a period names, or null when the resource offers no such slot.
 *
 * The single check every booking goes through, and the reason a request carries
 * instants copied from a slot rather than a time somebody typed: a period that
 * is not exactly a slot the resource offers is not bookable, whether it starts
 * half an hour late, runs past closing, or falls on a local time the clocks
 * jumped over.
 *
 * `endsAt` is optional and means "one slot" when it is absent, which is the
 * whole of TIME_SLOTS and WHOLE_DAY. A DATE_RANGE booking states it, and it has
 * to be the end of a later slot with every night between accounted for, which
 * contiguous day slots always are.
 */
export function periodFor(
  resource: SlotResource,
  requested: { startsAt: Date; endsAt: Date | null },
): Period | null {
  /*
   * A day either side of the requested start, and for a range as many days
   * beyond it as one booking may cover. The day before is there because a slot
   * that opens before midnight and closes after it belongs to the earlier day,
   * and generating that day is cheaper than reasoning about whether the board
   * configured one.
   */
  const from = addLocalDays(localDayOf(requested.startsAt), -1);
  const to = addLocalDays(
    from,
    resource.mode === "DATE_RANGE" ? MAX_BOOKING_NIGHTS + 2 : 2,
  );
  const slots = generateSlots(resource, from, to);

  const first = slots.findIndex(
    (slot) => slot.startsAt.getTime() === requested.startsAt.getTime(),
  );
  if (first === -1) {
    return null;
  }

  const start = slots[first];
  if (start === undefined) {
    return null;
  }
  if (requested.endsAt === null) {
    return start;
  }

  if (resource.mode !== "DATE_RANGE") {
    // One slot per booking. A common room taken for a weekend is two bookings,
    // because two days is two claims on the thing and the quota counts claims.
    return requested.endsAt.getTime() === start.endsAt.getTime() ? start : null;
  }

  for (let index = first; index < slots.length; index += 1) {
    const night = slots[index];
    if (night === undefined) {
      break;
    }
    if (index - first >= MAX_BOOKING_NIGHTS) {
      return null;
    }
    if (night.endsAt.getTime() === requested.endsAt.getTime()) {
      return { startsAt: start.startsAt, endsAt: night.endsAt };
    }
  }
  return null;
}

/**
 * How many days a period covers on the local calendar.
 *
 * One for a time slot or a whole day, and the number of nights for a range.
 * A count and nothing else, so an audit entry can say how much of the guest
 * apartment was taken without carrying the dates twice.
 */
export function daysIn(period: Period): number {
  return Math.max(
    1,
    localDaysBetween(localDayOf(period.startsAt), localDayOf(period.endsAt)),
  );
}

/** Equal pieces of each day between the opening and the closing time. */
function timeSlots(
  resource: SlotResource,
  from: LocalDay,
  to: LocalDay,
): Period[] {
  if (checkResourceSchedule(resource) !== null) {
    /*
     * Unreachable through the service, which refuses to store a schedule this
     * would reject. Answering with no slots rather than throwing is the safe
     * direction for a read: a row edited into an impossible state by hand makes
     * the resource unbookable, which is visible and harmless, rather than a
     * server error on every calendar the association loads.
     */
    return [];
  }
  const { slotMinutes, opensAtMinute, closesAtMinute } = resource;
  if (
    slotMinutes === null ||
    opensAtMinute === null ||
    closesAtMinute === null
  ) {
    return [];
  }

  const slots: Period[] = [];
  for (
    let day = from;
    compareLocalDays(day, to) <= 0;
    day = addLocalDays(day, 1)
  ) {
    /*
     * The boundaries first, then the pairs between them. A boundary the clocks
     * jumped over is dropped, and the slot before it runs on to the next one
     * that exists - which is why this is a two-pass loop rather than an end
     * computed as start plus the slot length.
     */
    const boundaries: Date[] = [];
    for (
      let minute = opensAtMinute;
      minute <= closesAtMinute;
      minute += slotMinutes
    ) {
      const instant = instantAt(day, minute);
      if (instant !== null) {
        boundaries.push(instant);
      }
    }

    for (let index = 0; index + 1 < boundaries.length; index += 1) {
      const startsAt = boundaries[index];
      const endsAt = boundaries[index + 1];
      if (
        startsAt !== undefined &&
        endsAt !== undefined &&
        endsAt.getTime() > startsAt.getTime()
      ) {
        slots.push({ startsAt, endsAt });
      }
    }
  }
  return slots;
}

/** One slot per day, local midnight to local midnight. */
function wholeDays(from: LocalDay, to: LocalDay): Period[] {
  const slots: Period[] = [];
  for (
    let day = from;
    compareLocalDays(day, to) <= 0;
    day = addLocalDays(day, 1)
  ) {
    const startsAt = instantAt(day, 0);
    const endsAt = instantAt(addLocalDays(day, 1), 0);
    if (
      startsAt !== null &&
      endsAt !== null &&
      endsAt.getTime() > startsAt.getTime()
    ) {
      slots.push({ startsAt, endsAt });
    }
  }
  return slots;
}
