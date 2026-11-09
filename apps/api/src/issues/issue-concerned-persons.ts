import type { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { lockLegalHold } from "../retention/legal-hold-lock";
import { WITHHELD } from "../retention/withheld-persons";

/**
 * The people an issue concerns (berörd person, ADR 0057), as the rest of the
 * module reads them: the cases about a person, and the legal hold keys a write
 * that removes what the case holds about them takes.
 *
 * A handler records them (`IssueConcernedPersonService`). The record is part of
 * the issue's free-text layer (`issue-free-text.ts`), so it is removed with
 * the text, and a legal hold or a restriction on any of them keeps the layer
 * as one on the reporter does.
 */

type Db = Prisma.TransactionClient | PrismaService;

/**
 * The issues that concern a person and that they did not report: the cases a
 * neighbour's report is about them, which their access report carries apart
 * from the ones they reported themselves (EDPB Guidelines 01/2022, paras 96
 * and 104-105).
 *
 * An issue the person reported is left out even where a handler also recorded
 * them as concerned, because the `issues` section already carries it as
 * theirs. One reported from the website's form has no reporter column, and is
 * included: nothing ties it to this person as its reporter, whatever address
 * it gave. A duplicate the person reported and a handler merged into this one
 * leaves this one in: it is still somebody else's report.
 *
 * Only while the record stands, which is while the issue's free-text layer
 * does: the clock, the reporter's granted erasure request and a handler's
 * removal take it, and the case is then no longer one the association holds
 * as about them. The selector that stays for a work order's text
 * ({@link endConcernedPersonRecords}) is not the record.
 */
export function issuesConcerningPerson(
  personId: string,
): Prisma.IssueWhereInput {
  return {
    concernedPersons: { some: { personId, recordRemovedAt: null } },
    OR: [{ reporterPersonId: null }, { reporterPersonId: { not: personId } }],
  };
}

/**
 * An issue that concerns nobody under a legal hold or a restriction of
 * processing: what the clock and the issue erasure job ask beside the
 * reporter's hold, because the free-text layer is what the case holds about
 * each of them (`withheld-persons.ts` says why a hold and a restriction keep
 * alike), and what the work-order text purge asks, for the same reason
 * (`issue-purge.service.ts`). Spread beside the other conditions, never under
 * an `OR`.
 *
 * Read again by the job that removes: under each person's key
 * ({@link lockPersonHolds}), or under the legal hold registry key, which every
 * placement and restriction grant takes as well.
 */
export const CONCERNS_NO_WITHHELD_PERSON = {
  concernedPersons: { none: { person: WITHHELD } },
} satisfies Prisma.IssueWhereInput;

/** The opposite: an issue concerning somebody a hold or restriction keeps. */
export const CONCERNS_A_WITHHELD_PERSON = {
  concernedPersons: { some: { person: WITHHELD } },
} satisfies Prisma.IssueWhereInput;

/**
 * An issue that concerns nobody with protected personal data, which a read
 * leaving the instance (`mcp`, `ai`) asks as it asks after the reporter
 * (ADR 0056): a case about a protected person tells whoever reads it that they
 * live here.
 */
export const CONCERNS_NO_PROTECTED_PERSON = {
  concernedPersons: { none: { person: { protectedPersonalData: true } } },
} satisfies Prisma.IssueWhereInput;

/**
 * Every person the issue is recorded as concerning, in identifier order: the
 * order {@link lockPersonHolds} takes their keys in.
 */
export async function concernedPersonIdsOf(
  db: Db,
  issueId: string,
): Promise<string[]> {
  const rows = await db.issueConcernedPerson.findMany({
    where: { issueId },
    select: { personId: true },
    orderBy: { personId: "asc" },
  });
  return rows.map((row) => row.personId);
}

/**
 * Takes the legal hold key (`lockLegalHold`) of every person named, once each
 * and in identifier order, so two writes holding some of the same keys never
 * wait on each other the other way round. The reporter's key is taken among
 * them where the caller names the reporter too.
 *
 * Taken before the issue's own lock, the order the clock, a redaction and the
 * person purge keep: a hold placed or a restriction granted while the write
 * waited has to win, and the placing takes the same key.
 */
export async function lockPersonHolds(
  tx: Prisma.TransactionClient,
  personIds: readonly (string | null)[],
): Promise<void> {
  const keys = [
    ...new Set(personIds.filter((id): id is string => id !== null)),
  ].toSorted();
  for (const personId of keys) {
    await lockLegalHold(tx, personId);
  }
}

/**
 * Whether the issue now concerns somebody whose key the caller did not take:
 * a person recorded after the caller read whom it concerns, before it took
 * the issue's lock. Asked under that lock. A removal that finds one leaves the
 * issue for its next run rather than read that person's hold without their key.
 */
export async function concernsUnlockedPerson(
  tx: Prisma.TransactionClient,
  issueId: string,
  locked: readonly string[],
): Promise<boolean> {
  const now = await concernedPersonIdsOf(tx, issueId);
  return now.some((personId) => !locked.includes(personId));
}

/**
 * Ends the record of whom an issue concerns, as the free-text layer's removal
 * does, and answers how many records it ended.
 *
 * A work order's text stands on a clock of its own (ten years, ADR 0057), and
 * a legal hold or a restriction placed on a person the issue concerns after
 * the layer went has to reach it, as one on the reporter does through the
 * reporter column. So while any work order's text stands the row is kept, with
 * `recordRemovedAt` written, as the selector the hold checks read
 * ({@link concernedPersonIdsOf}, {@link CONCERNS_NO_WITHHELD_PERSON}) and
 * nothing else: no handler's list, limit or access report counts it. With no
 * text standing the rows are deleted, and so are selectors an earlier removal
 * kept.
 *
 * Called under the issue's lock, in the transaction that removes the layer.
 * The last work-order text's erasure deletes the selector
 * ({@link releaseConcernedSelectors}).
 */
export async function endConcernedPersonRecords(
  tx: Prisma.TransactionClient,
  issueId: string,
  now: Date,
): Promise<number> {
  const textStands = await tx.workOrder.count({
    where: { issueId, body: { not: null } },
  });
  if (textStands > 0) {
    const { count } = await tx.issueConcernedPerson.updateMany({
      where: { issueId, recordRemovedAt: null },
      data: { recordRemovedAt: now },
    });
    return count;
  }
  const { count } = await tx.issueConcernedPerson.deleteMany({
    where: { issueId, recordRemovedAt: null },
  });
  await releaseConcernedSelectors(tx, issueId);
  return count;
}

/**
 * Deletes the selectors {@link endConcernedPersonRecords} kept, once no work
 * order's text stands on the issue. Called by what erases a work order's text,
 * in the transaction that does, under the issue's lock: the work-order text
 * purge and a handler's redaction of one.
 */
export async function releaseConcernedSelectors(
  tx: Prisma.TransactionClient,
  issueId: string,
): Promise<number> {
  const { count } = await tx.issueConcernedPerson.deleteMany({
    where: {
      issueId,
      recordRemovedAt: { not: null },
      issue: { workOrders: { none: { body: { not: null } } } },
    },
  });
  return count;
}
