import type { Prisma } from "../generated/prisma/client";

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
 * A term that has not ended, or ends in the future. The second half is not a
 * technicality: a board can minute in April that a term runs to the annual
 * meeting, and that person is on the board until the date arrives.
 *
 * An address is required, because the recipient list is for mail. A board
 * member with no address recorded is not an error to raise here - they are
 * simply not somebody this channel can reach, and the caller counts what it
 * sent.
 *
 * The three existing copies are deliberately left alone. They are correct, and
 * rewriting three working call sites to prove a helper is the kind of change
 * that belongs to whoever next has a reason to touch them.
 */
export function activeBoardRecipientsWhere(now: Date): Prisma.PersonWhereInput {
  return {
    boardPositions: {
      some: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
    },
    emailCipher: { not: null },
  };
}
