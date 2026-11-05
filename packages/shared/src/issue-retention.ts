/**
 * The two layers of an issue's retention (ADR 0057, decision 33 of the issue
 * module plan).
 *
 * The building record stays: what, where, when, and the outcome. The free-text
 * layer goes on a clock after the issue closes, unless a legal hold applies:
 * the description, the free-text location, every issue message and internal
 * note, and every photograph and handler's file. A handler may redact any of
 * it, or remove a file, before then.
 *
 * Here rather than beside the schema, for the reason `ISSUE_REPORT_LIMITS`
 * gives: the board's settings form has to refuse the same numbers the API
 * refuses, and the issue screen has to offer the same targets.
 */

/**
 * How many whole years after closing the free-text layer is removed: the board
 * sets it between these bounds, and a new instance starts at two.
 *
 * Two has no legal source. It matches motions, subletting applications and the
 * board mailbox, which keep their records two years after closing (decision
 * 33). Ten is the ordinary limitation period for a claim about the work
 * (preskriptionslagen 2 §), and a longer clock would be no clock at all.
 */
export const ISSUE_TEXT_RETENTION_YEARS = {
  min: 1,
  max: 10,
  default: 2,
} as const;

/**
 * How many whole years after closing the free-text layer of a ring-fenced
 * issue type is removed (avskärmad ärendetyp, decision 32 of the issue module's
 * plan), whatever the board set above.
 *
 * Shorter than the board's own clock may be, and not the board's to set: a
 * report about a neighbour, such as Störningar holds, is the kind of record
 * Bostadsrätterna says "bör föras separat", and the plan holds it to one year
 * after closing until the legal review of decision 32 says how long it may be
 * kept, or whether at all. That review changes this number and nothing else;
 * it is never a setting. The purge reads the shorter of this and the board's
 * setting, so a ring-fenced issue's text never outlasts an ordinary one's
 * clock, whatever the review sets. A legal hold on the issue (a damage case
 * places one), or a legal hold or a restriction on its reporter, stands over
 * this clock as over the board's, and keeps the text until it is released
 * (ADR 0057).
 */
export const RING_FENCED_ISSUE_TEXT_RETENTION_YEARS = 1;

/**
 * What a handler may redact on an issue: a text, which is emptied and marked
 * with the date, or a file, which is removed from storage.
 *
 * The description and the location are the issue's own, so they are named
 * alone; the rest are rows of their own and are named with their identifier.
 * A work order's text is erased and the work order stays, with whom it went to
 * and when (ADR 0057).
 */
export const ISSUE_REDACTION_TARGETS = [
  "description",
  "location",
  "message",
  "note",
  "photo",
  "attachment",
  "workOrder",
] as const;

export type IssueRedactionTarget = (typeof ISSUE_REDACTION_TARGETS)[number];
