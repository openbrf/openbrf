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
 * contractors in the last hour and adds a work order to it, and that the purge
 * of the handler takes before it detaches their work orders.
 *
 * The sending budget (`WorkOrderService.send`) is a count followed by an
 * insert across every issue the handler sends from, so the issue's own lock
 * does not serialise it: two sendings from two issues at once would both pass
 * the count. Taken after the type's and the issue's, the order every sending
 * takes them in. An advisory lock for the reason `lockIssue` gives.
 *
 * The purge (`PurgeService`) takes it so that a sending which read the
 * handler's access before a role was withdrawn cannot commit its
 * `sentByPersonId` after the purge has detached the person's work orders. The
 * two serialise only on the same key: advisory locks are taken by the hash of
 * a string, so the purge calls this function rather than spelling the key
 * again, and a second spelling would hash to another lock and wait for
 * nothing.
 */
export async function lockWorkOrderSender(
  tx: Prisma.TransactionClient,
  personId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`work-order-sender:${personId}`}))`;
}

/**
 * The lock a filing takes before it counts how much of its sender's hourly
 * mail budget is spent (`IssueMailer.filedInTransaction`): one for the
 * website's form, whoever sends through it, and one for each signed-in
 * reporter.
 *
 * The budget is a count followed by an insert of the mail it allows, and two
 * reports filed together would otherwise each count without the other and
 * both be mailed about. Taken after the type's lock, which filing takes first,
 * and by nothing else, so the two never wait on each other the other way
 * round. An advisory lock for the reason `lockIssue` gives.
 */
export async function lockFilingBudget(
  tx: Prisma.TransactionClient,
  reporterPersonId: string | null,
): Promise<void> {
  const key =
    reporterPersonId === null
      ? "issue-filing-budget:public-form"
      : `issue-filing-budget:person:${reporterPersonId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/**
 * The lock a reporter's issue message takes before it counts how much of the
 * reporter's hourly mail budget for messages is spent
 * (`IssueMailer.messageInTransaction`): one for each reporter, across all of
 * their issues.
 *
 * The budget is a count followed by an insert of the mail it allows, and two
 * messages written together, on one issue or on two, would otherwise each
 * count without the other and both be mailed about. Taken after the issue's
 * lock, which a reporter's message takes first, and by nothing else, so the
 * two never wait on each other the other way round. An advisory lock for the
 * reason `lockIssue` gives.
 */
export async function lockMessageBudget(
  tx: Prisma.TransactionClient,
  reporterPersonId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`issue-message-budget:person:${reporterPersonId}`}))`;
}

/**
 * The lock a transaction takes before it replaces the responsibility guide.
 *
 * A save deletes every line and writes the board's, and at READ COMMITTED two
 * saves at once would each delete only the lines that existed when it began
 * and both leave their own behind. An advisory lock for the reason `lockIssue`
 * gives: the invariant is the whole table, not a row.
 */
export async function lockResponsibilityGuide(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"responsibility-guide"}))`;
}

/**
 * The locks a write takes before it decides whether its actor handles an
 * issue: the issue's type's, then the issue's own.
 *
 * Who handles an issue turns on its type's handlers and its own board-only
 * flag, and both can change while the write decides. The type's settings
 * change under the type's lock, so a write that holds it reads a setting
 * nobody is changing. The type is read first, unlocked: nothing moves an
 * issue to another type. Always the type before the issue, so two writes never
 * wait on each other in the opposite order. An issue that does not exist takes
 * its own key alone, and the write then finds nothing.
 */
export async function lockIssueForHandling(
  tx: Prisma.TransactionClient,
  issueId: string,
): Promise<void> {
  const issue = await tx.issue.findUnique({
    where: { id: issueId },
    select: { typeId: true },
  });
  if (issue !== null) {
    await lockIssueType(tx, issue.typeId);
  }
  await lockIssue(tx, issueId);
}

/**
 * `lockIssueForHandling` for a write that decides about several issues at
 * once, such as merging one into another.
 *
 * Every type's lock first and then every issue's, each set in one fixed order,
 * so two such writes, or one and a single-issue write, never wait on each
 * other in a cycle: taking the two issues' locks one issue at a time would hold
 * one issue while waiting on a type a single-issue write holds while waiting on
 * that issue.
 */
export async function lockIssuesForHandling(
  tx: Prisma.TransactionClient,
  issueIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(issueIds)].sort();
  const issues = await tx.issue.findMany({
    where: { id: { in: ids } },
    select: { typeId: true },
  });
  for (const typeId of [...new Set(issues.map((row) => row.typeId))].sort()) {
    await lockIssueType(tx, typeId);
  }
  for (const id of ids) {
    await lockIssue(tx, id);
  }
}

/**
 * The lock a transaction takes before it adds to the association's saved
 * replies, or seeds them: the bound on how many there are is a count followed
 * by an insert, and a new instance's seed writes only into an empty list. One
 * key for the whole list, which is the association's one list.
 */
export async function lockIssueSavedReplies(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"issue-saved-replies"}))`;
}

/**
 * The lock a transaction takes before it changes the association's list of
 * common-area places: the bound on how many there are is a count followed by
 * an insert, and a new instance's seed writes only into an empty list. One key
 * for the whole list, which is the association's one list.
 */
export async function lockIssuePlaces(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"issue-places"}))`;
}

/**
 * Holds a common-area place a write is about to name, and says whether it is
 * still offered.
 *
 * The place is read before the issue names it, and the board can remove it in
 * between: the write's foreign key would then fail with P2003, which the
 * reporting path would answer as a removed type and a handler's change as a
 * 500. `FOR KEY SHARE` makes the removal wait for this transaction, and the
 * database then refuses it as `place-in-use`. Renaming a place or switching it
 * off does not wait: an issue filed while the board switches its place off is
 * the same as one filed a moment before.
 */
export async function holdOfferedPlace(
  tx: Prisma.TransactionClient,
  placeId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ active: boolean }[]>`
    SELECT active FROM issue_place WHERE id = ${placeId} FOR KEY SHARE`;
  return rows[0]?.active === true;
}
