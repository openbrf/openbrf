import {
  CALENDAR_YEAR_START_MONTH,
  preservationCutoff,
  preservationEndOf,
} from "../retention/financial-year";

/**
 * How long a fee and its notices are kept, and when the purge reaches them.
 *
 * The same window as the charges, the same statute and the same arithmetic,
 * because it is the same question asked of the same kind of record. A fee rate
 * and the notices issued from it are service-tier personal data: a rate says
 * what one apartment pays, and an apartment leads back to whoever lives in it.
 * The purpose they are held for is being able to say afterwards what was billed
 * and on what basis, and that purpose ends when the accounting record they fed
 * has outlived its own preservation period.
 *
 * A housing cooperative is a legal person and so bokforingsskyldig
 * (bokforingslagen (1999:1078) 2 kap. 1 §; 2 kap. 2 § names the kinds of
 * association that are not, and a bostadsrattsforening is not among them).
 * 7 kap. 2 § of that act keeps the documents preserving rakenskapsinformation
 * "fram till och med det sjunde aret efter utgangen av det kalenderar da
 * rakenskapsaret avslutades", and a notification run is rakenskapsinformation
 * by 1 kap. 2 § 9 through 5 kap. 6-7 §§. Erasing it before then would leave the
 * board holding entries in its books it can no longer explain.
 *
 * That statute is the reason for the number and is deliberately not a claim
 * about these tables. Open BRF holds the basis and not the ledger, so the
 * association's obligation is discharged by its accounting system rather than by
 * these rows; the window is chosen to outlast that obligation rather than to
 * meet it.
 *
 * ## Two anchors, because the two rows are dated by different things
 *
 * A notification run is anchored on the last day of the period it billed. A fee
 * rate is anchored on the day it stopped applying - and a rate still in force
 * has no such day and is never erased, which is the one thing that makes this
 * window different from the charges'. Erasing the rate an apartment is paying
 * under would leave the board unable to say what it is billing, and no
 * preservation period has run out on a fact that is still true.
 *
 * Which calendar year either clock starts in is the association's financial
 * year's answer rather than the row's own date. The reasoning, the correction it
 * represents and the arithmetic are in `retention/financial-year.ts`, shared
 * with the charge window because it is one reading of one statute.
 *
 * Two functions, kept in one file because they are one decision read from two
 * ends, exactly as `charges/member-charge-retention.ts` is.
 * {@link computeFeePurgeDate} answers "when is this row erased", which is a
 * computation per row and what a data subject access report states.
 * {@link feePurgeCutoff} asks the opposite question of the whole table at once,
 * which has to be one comparison in SQL. If the two disagree the product erases
 * on a day other than the one it stated, so `fee-retention.spec.ts` runs them
 * against each other.
 */

/**
 * How many years after the one the financial year ended in a fee is kept.
 *
 * A constant rather than a board setting, on the argument the charge window
 * makes: the association's retention policy is about a person whose
 * relationship with the cooperative has ended, and this window is about a
 * financial year that has closed, whoever was billed and whether or not they
 * still live here.
 *
 * Seven, from the preservation period in the module comment. Stated here rather
 * than imported from the charge module, because the two are the same number for
 * the same reason and not one number two modules share: shortening one is a
 * decision about that module, and an import would make it a decision about both.
 * The date is derived from this and never stored, which is what lets a shorter
 * window be chosen later without a migration or a recomputation job.
 */
export const FEE_RETENTION_YEARS = 7;

/**
 * The date a row becomes erasable: the first day of the year after the last
 * year it is kept in.
 *
 * @param dated The day the row's preservation is counted from - the last day of
 *   a notification run's period, or the day a rate stopped applying - as the
 *   `@db.Date` column holds it. Read as a calendar date rather than as an
 *   instant, because a date column carries neither a time nor a zone.
 * @param financialYearStartMonth The month the association's rakenskapsar
 *   begins in, from `Association.financialYearStartMonth`.
 * @param retentionYears How many full calendar years after the one that
 *   financial year ended in the row is kept.
 */
export function computeFeePurgeDate(
  dated: Date,
  financialYearStartMonth: number = CALENDAR_YEAR_START_MONTH,
  retentionYears: number = FEE_RETENTION_YEARS,
): Date {
  return preservationEndOf(dated, financialYearStartMonth, retentionYears);
}

/**
 * The first date that is still kept.
 *
 * A row dated before this is erasable; one dated on or after it is not. A bound
 * rather than a last-erasable date because the comparison it feeds is over a
 * date column.
 *
 * @param now The moment the job is running at, passed in so a test can drive the
 *   clock rather than wait seven years for it. Which year that is is read on the
 *   association's own calendar: a run starting at half past midnight on New
 *   Year's Day is running in the new year in Stockholm and in the old one in
 *   UTC, and the whole window is stated in calendar years.
 * @param financialYearStartMonth The month the association's rakenskapsar
 *   begins in.
 * @param retentionYears How many full calendar years after the one the financial
 *   year ended in the row is kept.
 */
export function feePurgeCutoff(
  now: Date,
  financialYearStartMonth: number = CALENDAR_YEAR_START_MONTH,
  retentionYears: number = FEE_RETENTION_YEARS,
): Date {
  return preservationCutoff(now, financialYearStartMonth, retentionYears);
}
