import {
  CALENDAR_YEAR_START_MONTH,
  preservationCutoff,
  preservationEndOf,
} from "../retention/financial-year";

/**
 * How long a charge is kept, and when the purge reaches it.
 *
 * A charge (debitering) is service-tier personal data: it says that the
 * association put a named sum on a named person, or on an apartment whoever
 * holds it. The purpose it is held for is handing the basis to whoever keeps the
 * association's books and being able to say afterwards what a line on that
 * bookkeeper's ledger was for. So the clock is anchored on the day the charge is
 * dated rather than on a move-out: the board's need for it belongs to the
 * financial year the charge falls in, and the residency purge would never reach
 * it at all while the household stayed.
 *
 * ## Why the window is the accounting archive's and not a year
 *
 * The booking and the sign-up are each kept for one turn of the association's
 * own calendar, because that is how long the thing they were collected to run
 * stays comparable. A charge is different: it is the basis for an entry in an
 * accounting record the association is obliged to keep for far longer, and the
 * question the basis answers - what was this line, and who was it put on - is
 * asked for as long as that record can be asked about.
 *
 * A housing cooperative is a legal person and so bokforingsskyldig
 * (bokforingslagen (1999:1078) 2 kap. 1 §; 2 § names the kinds of association
 * that are not, and a bostadsrattsforening is not among them). 7 kap. 2 § of that
 * act keeps the documents preserving rakenskapsinformation "fram till och med
 * det sjunde aret efter utgangen av det kalenderar da rakenskapsaret
 * avslutades". Erasing the basis before then would leave the board holding an
 * entry in its books it can no longer explain, and the member unable to have it
 * explained.
 *
 * That statute is the reason for the number and is deliberately not a claim
 * about this table. Open BRF holds the basis and not the ledger, so the
 * association's obligation is discharged by its accounting system rather than by
 * this row; the window is chosen to outlast that obligation rather than to meet
 * it.
 *
 * ## Anchored on the financial year, not on a day count
 *
 * That preservation period runs from the end of a calendar year, so this one
 * does too: every charge in one financial year becomes erasable on the same
 * morning, whether it was recorded in the first month of that year or the last.
 * A day count from the charge date would erase a January charge eleven months
 * before a December one from the same books, which is a distinction the reason
 * for the window does not make.
 *
 * Which calendar year the clock starts at is the association's financial year's
 * answer and not the charge date's. 7 kap. 2 § counts from the end of the year
 * "da rakenskapsaret avslutades", and for an association whose rakenskapsar is
 * not the calendar year those are two different years for part of every year:
 * on a year running from the 1st of May, a charge dated in June 2026 falls in
 * the year that ends on the 30th of April 2027 and is preserved from the end of
 * 2027, while one dated in March 2026 falls in the year that ended that April
 * and is preserved from the end of 2026. Reading the charge's own calendar year
 * gets the second right and the first a full year early.
 *
 * So `Association.financialYearStartMonth` is passed in rather than assumed.
 * The default is 1, the calendar year, and on it both functions compute exactly
 * the dates they computed before the column existed - which is what makes
 * correcting a shipped window safe. Correcting it can only move a date later,
 * never earlier, because the year a financial year ends in is never before the
 * calendar year of a day inside it; no erasure date already stated to a named
 * person on a data subject access report is brought forward.
 *
 * The arithmetic itself is in `retention/financial-year.ts`, shared with the fee
 * window, because it is one reading of one statute and two copies of it could
 * disagree.
 *
 * Two functions, kept in one file because they are one decision read from two
 * ends, exactly as `events/event-signup-retention.ts` is.
 * {@link computeMemberChargePurgeDate} answers "when is this charge erased",
 * which is a computation per row and what a data subject access report states.
 * {@link memberChargePurgeCutoff} asks the opposite question of the whole table
 * at once - "which charges fall in a financial year that has fallen out" - which
 * has to be one comparison in SQL. If the two disagree the product erases on a
 * day other than the one it stated, so `member-charge-retention.spec.ts` runs
 * them against each other rather than trusting the arithmetic to look
 * symmetrical.
 */

/**
 * How many years after the one the financial year ended in a charge is kept.
 *
 * A constant rather than a board setting, on the argument
 * `EVENT_SIGNUP_RETENTION_DAYS` makes: the association's retention policy is
 * about a person whose relationship with the cooperative has ended, and this
 * window is about a financial year that has closed, whoever was charged and
 * whether or not they still live here.
 *
 * Seven, from the preservation period in the module comment. The date is derived
 * from this and never stored, which is what lets a shorter window be chosen later
 * without a migration or a recomputation job: every pending purge date moves by
 * that act alone.
 */
export const MEMBER_CHARGE_RETENTION_YEARS = 7;

/**
 * The date a charge becomes erasable: the first day of the year after the last
 * year it is kept in.
 *
 * @param chargedOn The day the charge is dated, as the `@db.Date` column holds
 *   it. Read as a calendar date rather than as an instant, because a date column
 *   carries neither a time nor a zone.
 * @param financialYearStartMonth The month the association's rakenskapsar
 *   begins in, from `Association.financialYearStartMonth`. Defaulted to the
 *   calendar year so a caller that has not read the association computes what
 *   this window computed before the column existed.
 * @param retentionYears How many full calendar years after the one the charge's
 *   financial year ended in the charge is kept.
 */
export function computeMemberChargePurgeDate(
  chargedOn: Date,
  financialYearStartMonth: number = CALENDAR_YEAR_START_MONTH,
  retentionYears: number = MEMBER_CHARGE_RETENTION_YEARS,
): Date {
  return preservationEndOf(chargedOn, financialYearStartMonth, retentionYears);
}

/**
 * The first charge date that is still kept.
 *
 * A charge dated before this is erasable; one dated on or after it is not. A
 * bound rather than a last-erasable date because the comparison it feeds is over
 * a date column, and `lt` against the first day of a financial year says what
 * "the year has fallen out" means without any arithmetic about the last day of
 * it.
 *
 * @param now The moment the job is running at, passed in so a test can drive the
 *   clock rather than wait seven years for it. Which year that is is read on the
 *   association's own calendar: a run starting at half past midnight on New
 *   Year's Day is running in the new year in Stockholm and in the old one in
 *   UTC, and the whole window is stated in calendar years.
 * @param financialYearStartMonth The month the association's rakenskapsar begins
 *   in, from `Association.financialYearStartMonth`.
 * @param retentionYears How many full calendar years after the one the charge's
 *   financial year ended in the charge is kept.
 */
export function memberChargePurgeCutoff(
  now: Date,
  financialYearStartMonth: number = CALENDAR_YEAR_START_MONTH,
  retentionYears: number = MEMBER_CHARGE_RETENTION_YEARS,
): Date {
  return preservationCutoff(now, financialYearStartMonth, retentionYears);
}
