import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it decides what an issue's closing date
 * is.
 *
 * `closedAt` is not a fact the request carries; it is derived from the status
 * being asked for and the one the row already holds - set on the move into
 * done, cleared on a reopen, and left alone on a repeat. That derivation is a
 * read followed by a write, and at READ COMMITTED - the isolation everything in
 * this application runs at - a reopen and a close arriving together both read
 * the same old value and the later write wins with a date neither of them
 * decided on.
 *
 * What that costs is not a wrong timestamp on a screen. `issue-retention.ts`
 * runs the purge clock for a public-form report on this column, so a stale
 * value moves the day the reporter's name and email address are erased - and
 * moves it earlier, which is the direction that cannot be undone.
 *
 * Attaching a photograph takes it too, for the same shape of reason: the cap
 * on photographs is a count followed by an insert.
 *
 * An advisory lock for the reason `legal-hold-lock.ts` gives: the invariant
 * spans a read and a write rather than a row, so no constraint can state it.
 * Held here rather than beside the writer because a lock only works if every
 * writer uses the same key, and a second spelling of this string would read as
 * serialised without being so.
 */
export async function lockIssue(
  tx: Prisma.TransactionClient,
  issueId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`issue:${issueId}`}))`;
}

/**
 * The lock a transaction takes before it changes an issue type's statuses.
 *
 * Two rules span the rows of one type rather than one row: a type carries at
 * most so many statuses, which is a count followed by an insert, and each
 * meaning has exactly one default, which moves from one row to another in two
 * writes. Two boards acting on one type at once would otherwise both pass the
 * count, or both demote the old default and leave the partial unique index to
 * refuse one of them with a 500. An advisory lock for the reason `lockIssue`
 * gives.
 *
 * The seed of a new instance's types takes it under a key of its own, `seed`,
 * which no type's identifier can be.
 */
export async function lockIssueType(
  tx: Prisma.TransactionClient,
  typeId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`issue-type:${typeId}`}))`;
}

/**
 * The lock a transaction takes before it counts what one handler has sent
 * contractors in the last hour and adds a work order to it.
 *
 * The sending budget (`WorkOrderService.send`) is a count followed by an
 * insert across every issue the handler sends from, so the issue's own lock
 * does not serialise it: two sendings from two issues at once would both pass
 * the count. Taken after the type's and the issue's, the order every sending
 * takes them in. An advisory lock for the reason `lockIssue` gives.
 */
export async function lockWorkOrderSender(
  tx: Prisma.TransactionClient,
  personId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`work-order-sender:${personId}`}))`;
}
