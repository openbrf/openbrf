import { dateColumnOf, type LocalDay, localDayOf } from "@openbrf/shared";

import type { Prisma } from "../generated/prisma/client";

/**
 * Who holds what on a given day: a residency, and a seat on the board.
 *
 * Both are a period with two `@db.Date` ends, and both ends are read the same
 * way. The move-in date is the first day a residency is held and the move-out
 * date is the first day it is not; the election date is the first day a seat is
 * held and the end date is the first day it is not. So a household whose
 * move-out date is the 30th held the apartment on the 29th and not on the 30th,
 * and whoever moves in on the 30th holds it from that day: no day is held by two
 * households and none by nobody.
 *
 * The day is the association's calendar day, as a date. Every one of these
 * columns is read back as midnight UTC, and compared against an instant the
 * boundary falls at midnight UTC rather than at midnight here - so for an hour
 * or two a day a residency would still be held on the day it ended and not yet
 * on the day it began. The functions take a `LocalDay` rather than a `Date` so
 * that an instant cannot be handed to one: `localDayOf(now)` is today, and
 * `localDayOfColumn(value)` is the day a date column holds.
 *
 * A start ahead of today is ordinary on both tables. The move flow records a
 * buyer before they take over the apartment, and a board minutes an election
 * before the term begins, so a row whose first day has not arrived is held by
 * nobody yet and grants nothing.
 *
 * These answer "held on this day", which is what access, membership, a
 * register's current holders and every list of who is on the board ask. Whether
 * a period has not yet ended is a different question, asked of the end alone,
 * and it counts a period that has not started: that is what keeps a person out
 * of the purge and what decides whether a term's end date may still be
 * amended. ADR 0014 states both.
 */

/** The residencies held on a day. */
export function residencyHeldOn(day: LocalDay): Prisma.ResidencyWhereInput {
  const on = dateColumnOf(day);
  return {
    movedInOn: { lte: on },
    OR: [{ movedOutOn: null }, { movedOutOn: { gt: on } }],
  };
}

/** The board seats held on a day. */
export function boardSeatHeldOn(day: LocalDay): Prisma.BoardPositionWhereInput {
  const on = dateColumnOf(day);
  return {
    electedOn: { lte: on },
    OR: [{ endedOn: null }, { endedOn: { gt: on } }],
  };
}

/**
 * The board seats that have not ended by a day: held on it, or recorded from a
 * day still to come.
 *
 * The end alone, as {@link boardSeatHeldOn}'s doc comment says, so a seat whose
 * first day has not arrived counts. A withdrawn election, ended on or before the
 * day it would have begun, can still have an end date ahead; a caller that has
 * the rows asks `hasTermEnded` of them.
 */
export function boardSeatNotEndedOn(
  day: LocalDay,
): Prisma.BoardPositionWhereInput {
  const on = dateColumnOf(day);
  return { OR: [{ endedOn: null }, { endedOn: { gt: on } }] };
}

/**
 * Whether a residency has ended by the association's day an instant falls on.
 *
 * The move-out date is the first day a residency is no longer held, so a
 * move-out dated today has happened, and one dated in the future is a scheduled
 * move-out: the person is still resident until it arrives. This is the end
 * half of the rule PrincipalService decides access by ({@link residencyHeldOn}),
 * and the two must agree: a row shown as moved out while the account still has
 * resident access would be a lie in whichever direction the reader trusted.
 *
 * Not the negation of "held today": a household whose move-in date has not
 * arrived has not moved out either. The board's screens list it among an
 * apartment's residents rather than in its history, and an import matches a row
 * to it by apartment and name.
 *
 * Takes an instant rather than a `LocalDay`, unlike the rest of this module,
 * and reads the day it falls on here itself, so the instant cannot be compared
 * with the column directly.
 *
 * @param now An instant; the day it falls on here is the day asked about.
 */
export function hasMovedOut(
  movedOutOn: Date | null,
  now: Date,
): movedOutOn is Date {
  return (
    movedOutOn !== null &&
    movedOutOn.getTime() <= dateColumnOf(localDayOf(now)).getTime()
  );
}

/**
 * Whether a residency already read is held on a day.
 *
 * {@link residencyHeldOn} for a row in hand, and the same rule: a caller that
 * has the rows for another reason decides in memory rather than asking twice,
 * and a second spelling of the comparison is how the two would come to
 * disagree.
 */
export function isResidencyHeldOn(
  residency: { movedInOn: Date; movedOutOn: Date | null },
  day: LocalDay,
): boolean {
  const on = dateColumnOf(day).getTime();
  return (
    residency.movedInOn.getTime() <= on &&
    (residency.movedOutOn === null || residency.movedOutOn.getTime() > on)
  );
}
