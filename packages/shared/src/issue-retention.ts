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
 * How many whole years after closing the free-text layer of an issue of an
 * ordinary type is removed: the board sets it between these bounds, and a new
 * instance starts at two. A ring-fenced type has a clock of its own, below.
 *
 * Two has no legal source. It matches motions, subletting applications and the
 * board mailbox, which keep their records two years after closing (decision
 * 33). Ten is the window chosen for a work order's text, sized to the general
 * limitation period for a claim about the work (preskriptionslagen 2 §), and a
 * longer clock would be no clock at all.
 */
export const ISSUE_TEXT_RETENTION_YEARS = {
  min: 1,
  max: 10,
  default: 2,
} as const;

/**
 * How many whole years after closing the free-text layer of a ring-fenced
 * issue type is removed (avskärmad ärendetyp, decision 32 of the issue module's
 * plan): a clock of its own, which the board sets between these bounds apart
 * from the one above, and which every instance starts at one.
 *
 * The legal review of decision 32 (2026-11-09) cleared keeping such a case and
 * gave the board the clock. No statute sets one: the bostadsrättslag sets no
 * deadline for acting on a disturbance, Bostadsrätterna has the disturbance log
 * deleted when it is no longer relevant and at most after ten years, and a
 * pattern that recurs after more than a year, or a neighbour's later claim
 * against the board for not acting, are what a short clock risks. One year is
 * the default, the clock the plan held such a report to before the review, and
 * the board lengthens it where its cases need it. A legal
 * hold on the issue (a damage case places one), or a legal hold or a
 * restriction on its reporter, stands over this clock as over the other, and
 * keeps the text until it is released (ADR 0057).
 */
export const RING_FENCED_ISSUE_TEXT_RETENTION_YEARS = {
  min: 1,
  max: 10,
  default: 1,
} as const;

/**
 * What a handler may redact on an issue: a text, which is emptied and marked
 * with the date, or a file, which is removed from storage.
 *
 * The description and the location are the issue's own, so they are named
 * alone; the rest are rows of their own and are named with their identifier.
 * A work order's text is erased and the work order stays, with whom it went to
 * and when (ADR 0057). A note or a photograph a contractor sent through a work
 * order's link (ADR 0055) is redacted like a handler's note or file. A person
 * an issue concerns (ADR 0057) is part of its free-text layer, and a handler
 * takes the record of them off as a redaction too: the record is deleted.
 */
export const ISSUE_REDACTION_TARGETS = [
  "description",
  "location",
  "message",
  "note",
  "photo",
  "attachment",
  "workOrder",
  "workOrderNote",
  "workOrderFile",
  "concernedPerson",
] as const;

export type IssueRedactionTarget = (typeof ISSUE_REDACTION_TARGETS)[number];
