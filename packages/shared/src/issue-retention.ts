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
 * 33). Ten is where a claim about the work is time-barred (preskriptionslagen
 * 2 §), and a longer clock would be no clock at all.
 */
export const ISSUE_TEXT_RETENTION_YEARS = {
  min: 1,
  max: 10,
  default: 2,
} as const;

/**
 * What a handler may redact on an issue: a text, which is emptied and marked
 * with the date, or a file, which is removed from storage.
 *
 * The description and the location are the issue's own, so they are named
 * alone; the rest are rows of their own and are named with their identifier.
 */
export const ISSUE_REDACTION_TARGETS = [
  "description",
  "location",
  "message",
  "note",
  "photo",
  "attachment",
] as const;

export type IssueRedactionTarget = (typeof ISSUE_REDACTION_TARGETS)[number];
