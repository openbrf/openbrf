import { localDayOf } from "@openbrf/shared";

import type { Prisma } from "../generated/prisma/client";
import { boardSeatHeldOn } from "../registers/held-on";

/**
 * Who holds a seat on the board today.
 *
 * A term that has begun and has not ended, on the association's calendar, by
 * the rule in `registers/held-on.ts`. An end date in the future is not a
 * technicality: a board can minute in April that a term runs to the annual
 * meeting, and that person is on the board until the date arrives. Nor is an
 * election date in the future: somebody elected from the first of July is not
 * on the board in June.
 *
 * This is the whole of the question and nothing else. It says who the board is,
 * not who the association can reach: a board member with no address recorded
 * still sits on the board, and a caller deciding who may read something must
 * not lose them. {@link activeBoardRecipientsWhere} is the narrower question and
 * is expressed in terms of this one, so the two can never drift apart on the
 * part they share.
 *
 * Which of the two a caller wants follows from what it is doing. Sending the
 * board a message wants the recipient list, because an address is what makes
 * somebody reachable. Deciding who is in a room, who may act, or who a record
 * belongs to wants this one, because none of those depend on an address at all.
 *
 * @param now Taken once by the caller, so a single request cannot see two
 *   different boards.
 */
export function activeBoardSeatWhere(now: Date): Prisma.PersonWhereInput {
  return {
    boardPositions: { some: boardSeatHeldOn(localDayOf(now)) },
  };
}

/**
 * Who counts as the board for a message the association sends itself.
 *
 * The move-out reminder, the contact form fan-out, the register reporting
 * notice and the breach reminder all ask it. The breach reminder asks it under
 * a deadline: a reminder that reached a board member whose term ended last
 * spring, or failed to reach one elected last week, is the difference between
 * the association answering a supervisory authority in time and not.
 *
 * The seat is {@link activeBoardSeatWhere}, and an address is added on top of
 * it. A board member with no address recorded is not an error to raise here -
 * they are simply not somebody this channel can reach, and the caller counts
 * what it sent.
 *
 * That extra condition is why this is not the helper a membership question
 * wants. Asking it to decide who is in a room would silently drop the board
 * member the association happens to hold no address for, and they hold their
 * seat either way.
 */
export function activeBoardRecipientsWhere(now: Date): Prisma.PersonWhereInput {
  return {
    ...activeBoardSeatWhere(now),
    emailCipher: { not: null },
  };
}
