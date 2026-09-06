import {
  dateColumnOf,
  localDayOf,
  localDayOfColumn,
} from "../bookings/stockholm-calendar";

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
 * ## Anchored on the calendar year, not on a day count
 *
 * That preservation period runs from the end of a calendar year, so this one
 * does too: every charge dated in 2026 becomes erasable on the same morning, the
 * 1st of January 2034, whether it was recorded in January or in December. A day
 * count from the charge date would erase a January charge eleven months before a
 * December one from the same books, which is a distinction the reason for the
 * window does not make.
 *
 * The financial year is assumed to be the calendar year, which is what
 * `chargedOn` can answer on its own. An association whose rakenskapsar runs
 * differently would have its charges kept a few months longer or shorter than
 * this reasoning intends; the platform does not record the financial year, and a
 * setting for it would be the ledger's question rather than this table's.
 *
 * Two functions, kept in one file because they are one decision read from two
 * ends, exactly as `events/event-signup-retention.ts` is.
 * {@link computeMemberChargePurgeDate} answers "when is this charge erased",
 * which is a computation per row and what a data subject access report states.
 * {@link memberChargePurgeCutoff} asks the opposite question of the whole table
 * at once - "which charges are dated in a year that has fallen out" - which has
 * to be one comparison in SQL. If the two disagree the product erases on a day
 * other than the one it stated, so `member-charge-retention.spec.ts` runs them
 * against each other rather than trusting the arithmetic to look symmetrical.
 */

/**
 * How many years after the charge's own calendar year a charge is kept.
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
 * @param retentionYears How many full calendar years after the charge's own the
 *   charge is kept.
 */
export function computeMemberChargePurgeDate(
  chargedOn: Date,
  retentionYears: number = MEMBER_CHARGE_RETENTION_YEARS,
): Date {
  assertRetentionYears(retentionYears);

  return dateColumnOf({
    year: localDayOfColumn(chargedOn).year + retentionYears + 1,
    month: 1,
    day: 1,
  });
}

/**
 * The first charge date that is still kept.
 *
 * A charge dated before this is erasable; one dated on or after it is not. A
 * bound rather than a last-erasable date because the comparison it feeds is over
 * a date column, and `lt` against the 1st of January says what "the year has
 * fallen out" means without any arithmetic about the last day of December.
 *
 * @param now The moment the job is running at, passed in so a test can drive the
 *   clock rather than wait seven years for it. Which year that is is read on the
 *   association's own calendar: a run starting at half past midnight on New
 *   Year's Day is running in the new year in Stockholm and in the old one in
 *   UTC, and the whole window is stated in calendar years.
 * @param retentionYears How many full calendar years after the charge's own the
 *   charge is kept.
 */
export function memberChargePurgeCutoff(
  now: Date,
  retentionYears: number = MEMBER_CHARGE_RETENTION_YEARS,
): Date {
  assertRetentionYears(retentionYears);

  return dateColumnOf({
    year: localDayOf(now).year - retentionYears,
    month: 1,
    day: 1,
  });
}

/**
 * Refuses a retention window that is not a number of whole years.
 *
 * The same refusal both functions need, for the reason `purge-window.ts` gives: a
 * window that is not a number would otherwise put the cutoff in the future and
 * erase charges whose retention had not run out - including ones from the year
 * that is still running.
 *
 * Whole years and not a fraction, because the window is stated in calendar years
 * and there is no half of one to anchor on. Rounding a fraction here would erase
 * on a year other than the one the caller asked for, without saying so; the
 * value is refused instead.
 */
function assertRetentionYears(retentionYears: number): void {
  if (!Number.isInteger(retentionYears) || retentionYears < 0) {
    throw new RangeError(
      `Member charge retention must be a non-negative whole number of years, got ${String(
        retentionYears,
      )}.`,
    );
  }
}
