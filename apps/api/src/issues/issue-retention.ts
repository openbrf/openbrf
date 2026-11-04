/**
 * How long an issue reported through the public form is kept, and when the
 * purge reaches it.
 *
 * Every other issue is keyed to a person, and the reporter link on it is
 * detached when that person's residency purge runs. An issue reported from the
 * public form is keyed to nobody: it carries the reporter's name and email as
 * ciphers and no personId at all, so no person-keyed purge will ever find it.
 * Without a clock of its own it would be the one place in the product where
 * contact details are kept for ever, which is exactly what a retention policy
 * exists to prevent.
 *
 * The clock is anchored on the day the issue was closed, not on the day it was
 * reported. The purpose the contact details are held for is being able to come
 * back to the person about the problem, and that purpose lasts as long as the
 * problem does: a leak reported in March and still being argued with a
 * contractor in December is a live matter, and erasing the reporter's email
 * halfway through would end the association's ability to answer them.
 *
 * `closedAt` and not `updatedAt`, which is the subtle one. Detaching some other
 * person from a neighbouring row is an update, and if the clock ran on
 * `updatedAt` every purge night would push these issues' own purge dates
 * further away. A clock that resets whenever the purge runs is not a clock.
 *
 * Two functions, one decision read from two ends, the shape and the reasoning
 * of `bookings/booking-retention.ts`: one date per row for what a report
 * states, one cutoff for what SQL can compare a whole table against. If they
 * disagree the product erases on a day other than the one it stated, so the
 * spec runs them against each other rather than trusting the arithmetic to look
 * symmetrical.
 */

import type { Prisma } from "../generated/prisma/client";
import { ISSUE_FREE_TEXT_STANDING_UNREDACTED } from "./issue-free-text";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How long a closed public-form issue keeps its reporter's contact details.
 *
 * A year, matching the finished-booking window and chosen the same way: it
 * covers a heating season, so a problem that recurs the following winter can
 * still be tied to the person who first reported it, and it is short enough
 * that the association is not holding a stranger's email address indefinitely
 * because a tap once dripped.
 *
 * A constant rather than a board setting, for the reason booking retention
 * gives: the association's own policy answers a different question, about a
 * person whose relationship with the cooperative has ended. Somebody who filled
 * in a form on the website never had one.
 */
export const ISSUE_RETENTION_DAYS = 365;

/**
 * How long a closed issue keeps the text of the work orders sent about it.
 *
 * A work order's text is the handler's free text to a firm and may name the
 * reporter or a neighbour, and nothing else ever erases it: the reporter's own
 * purge removes the reporter's details and never the work order's words. So
 * the text gets a clock of its own, anchored where the reporter's is, on the
 * day the issue was closed. The row stays, with whom it went to and when,
 * which is the record GDPR art. 15(1)(c) and 19 ask for.
 *
 * Ten years, the longest the text has a purpose for (ADR 0055). The owner
 * asked for the work order to be kept as long as the law allows, so the
 * association can see what it asked of whom (2026-11-03). What it said is the
 * association's evidence of what it ordered, and a claim about the work, the
 * association's against the contractor or the contractor's for payment,
 * becomes time-barred ten years after it arose (preskriptionslagen (1981:130)
 * 2 §). The work is done before the issue is closed, so ten years from the
 * closing covers the claim. Bookkeeping asks for less: räkenskapsinformation is
 * kept to the end of the seventh year after the financial year
 * (bokföringslagen (1999:1078) 7 kap. 2 §). Past ten years nothing in law
 * needs the text, and storage limitation (GDPR art. 5(1)(e)) ends it. A demand
 * that interrupts the limitation (5 §) starts ten years again, and this clock
 * does not see it: only a legal hold on the issue itself, or a legal hold or a
 * restriction against the issue's reporter, stops the purge
 * (`IssuePurgeService`).
 *
 * Counted in days as every clock here is, 3,653 of them: ten years of 365 and
 * the three leap days ten years can hold, so the text never goes before the
 * tenth anniversary of the closing. Where the ten years hold only two leap
 * days the tenth anniversary falls at 3,652 days and the text stays one more
 * day (closed 2025-03-01, erased from 2035-03-02); the docs say "ten years"
 * and mean this window.
 */
export const WORK_ORDER_BODY_RETENTION_DAYS = 3653;

/**
 * An issue on which a work order's text still stands.
 *
 * While it does, the issue keeps what ties it to its reporter (ADR 0057: no
 * case whose text stands may lose its selector): the person purge leaves
 * `reporterPersonId` and the public-form purge leaves the address index, so a
 * legal hold or a restriction placed later on that person still reaches the
 * text. Read from the rows rather than from a flag, so a text erased by any
 * means releases the selector on the next run without anybody keeping a flag
 * in step.
 */
export const WORK_ORDER_TEXT_STANDING = {
  workOrders: { some: { body: { not: null } } },
} as const satisfies Prisma.IssueWhereInput;

/**
 * Detaches an issue's reporter once their erasure request has been carried
 * out and no text stands on the issue, and answers whether it did.
 *
 * Called by what removes text, the free-text layer's removal and the
 * work-order text purge, in the transaction that removes it and under the
 * issue's lock. The person purge detaches a reporter only from an issue on
 * which neither text stands, and no run selects a person after their request
 * is executed, so the job that removes the last text is the one left to clear
 * the link. While either text stands the link stays (ADR 0057: no case whose
 * text stands may lose its selector): a hold or a restriction placed later on
 * the person reaches that text only through it. A contractor's note a handler
 * has redacted holds no text and does not stand, though its blank row waits
 * for the clock.
 *
 * The columns the person purge clears when it detaches, all four of them.
 */
export async function detachErasedReporter(
  tx: Prisma.TransactionClient,
  issueId: string,
  reporterPersonId: string | null,
): Promise<boolean> {
  if (reporterPersonId === null) {
    return false;
  }
  const executed = await tx.dataSubjectRequest.count({
    where: {
      personId: reporterPersonId,
      kind: "ERASURE",
      executedAt: { not: null },
    },
  });
  if (executed === 0) {
    return false;
  }
  const { count } = await tx.issue.updateMany({
    where: {
      id: issueId,
      reporterPersonId,
      NOT: [ISSUE_FREE_TEXT_STANDING_UNREDACTED, WORK_ORDER_TEXT_STANDING],
    },
    data: {
      reporterPersonId: null,
      reporterNameCipher: null,
      reporterEmailCipher: null,
      reporterEmailIndex: null,
    },
  });
  return count > 0;
}

/**
 * The date a closed issue's reporter details become erasable.
 *
 * @param closedAt When the issue was closed. Null while it is open, which has
 *   no purge date at all rather than one far in the future: the association is
 *   still working on the problem and still needs to be able to answer.
 * @param retentionDays How long a closed issue keeps them.
 */
export function computeIssuePurgeDate(
  closedAt: Date | null,
  retentionDays: number = ISSUE_RETENTION_DAYS,
): Date | null {
  assertRetentionDays(retentionDays);

  if (closedAt === null) {
    return null;
  }

  // Day arithmetic on the UTC instant rather than calendar fields, as every
  // other retention clock in the product does it: adding days in Europe/
  // Stockholm shifts the result by an hour across a daylight saving boundary,
  // and an erasure an hour before the stated date is still early.
  return new Date(
    closedAt.getTime() + Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * The latest closing date whose purge date has arrived.
 *
 * An issue closed on or before this is erasable; one closed after it is not.
 *
 * @param now The moment the job is running at, passed in so a test can drive
 *   the clock rather than wait a year for it.
 * @param retentionDays How long a closed issue keeps its reporter details.
 */
export function issuePurgeCutoff(
  now: Date,
  retentionDays: number = ISSUE_RETENTION_DAYS,
): Date {
  assertRetentionDays(retentionDays);

  return new Date(
    now.getTime() - Math.round(retentionDays) * MILLISECONDS_PER_DAY,
  );
}

/**
 * Refuses a retention window that is not a number of days.
 *
 * The same refusal both functions need, for the reason the booking and purge
 * windows give: a window that is not a number would otherwise put the cutoff in
 * the future and erase reporter details whose retention had not run out.
 */
function assertRetentionDays(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(
      `Issue retention must be a non-negative number of days, got ${String(
        retentionDays,
      )}.`,
    );
  }
}
