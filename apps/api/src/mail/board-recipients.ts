import type { Prisma } from "../generated/prisma/client";

/**
 * Who holds a seat on the board right now.
 *
 * A term that has not ended, or ends in the future. The second half is not a
 * technicality: a board can minute in April that a term runs to the annual
 * meeting, and that person is on the board until the date arrives.
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
 * Six places already spell this clause out inline. They are correct and are
 * deliberately left alone, for the reason the recipient list's own history
 * gives: rewriting working call sites to prove a helper is the kind of change
 * that belongs to whoever next has a reason to touch them.
 *
 * @param now Taken once by the caller, so a single request cannot see two
 *   different boards.
 */
export function activeBoardSeatWhere(now: Date): Prisma.PersonWhereInput {
  return {
    boardPositions: {
      some: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
    },
  };
}

/**
 * Who counts as the board for a message the association sends itself.
 *
 * Three places already ask this question - the move-out reminder, the contact
 * form fan-out and the register reporting notice - and each spells the same
 * clause out again. This is the fourth asking it, for the breach reminder, and
 * the first to need it under a deadline: a reminder that reached a board member
 * whose term ended last spring, or failed to reach one elected last week, is
 * the difference between the association answering a supervisory authority in
 * time and not.
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
