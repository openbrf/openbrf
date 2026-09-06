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
