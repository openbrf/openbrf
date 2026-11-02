/**
 * The fixed vocabulary an issue's statuses are built on (ADR 0054).
 *
 * A board names the statuses of each issue type itself, and those names are its
 * own monolingual text. What every status means is not: each belongs to one of
 * the four meanings below, and everything that decides - the queue's order, the
 * views, reminders, the purge, the data subject access report, the badge on a
 * post - reads the meaning and never a label. Written once here, because both
 * applications read them and a list spelled out in each would drift.
 */

/**
 * The four meanings, in the order the queue is worked: what nobody has taken
 * up yet first, what is closed last.
 *
 * The order is this list's and never a database enum's declaration order, so a
 * meaning added later cannot move to the end of the queue by accident.
 */
export const ISSUE_STATUS_MEANINGS = [
  "NEW",
  "IN_PROGRESS",
  "WAITING",
  "DONE",
] as const;

export type IssueStatusMeaning = (typeof ISSUE_STATUS_MEANINGS)[number];

/**
 * Whom or what an issue in the waiting meaning waits on (vänteorsak). Required
 * on the move into that meaning and cleared on the move out of it.
 */
export const ISSUE_WAITING_REASONS = [
  "REPORTER",
  "CONTRACTOR",
  "PARTS",
  "DECISION",
] as const;

export type IssueWaitingReason = (typeof ISSUE_WAITING_REASONS)[number];

/**
 * How an issue ended (utfall). Required on the move into the done meaning and
 * cleared when the issue is reopened. A fixed list, translated rather than
 * written by the board, because "the tenant-owner's responsibility" is a
 * statement about BRL 7 kap. that a board should not be able to reword.
 */
export const ISSUE_OUTCOMES = [
  "FIXED",
  "TENANT_OWNER_RESPONSIBILITY",
  "NO_FAULT",
  "REFERRED",
  "DUPLICATE",
] as const;

export type IssueOutcome = (typeof ISSUE_OUTCOMES)[number];

/**
 * The outcomes a handler may choose when closing an issue.
 *
 * Every outcome but `DUPLICATE`, which is what merging an issue into another
 * writes (ADR 0054): an issue closed as a duplicate of nothing would leave its
 * reporter without the updates a merge promises them.
 */
export const ISSUE_CLOSING_OUTCOMES = [
  "FIXED",
  "TENANT_OWNER_RESPONSIBILITY",
  "NO_FAULT",
  "REFERRED",
] as const satisfies readonly IssueOutcome[];

export type IssueClosingOutcome = (typeof ISSUE_CLOSING_OUTCOMES)[number];

/**
 * Who may report an issue of a type: a set of these, never a level.
 *
 * - `PUBLIC`: the form on the association's website, and a signed-in person who
 *   does not live in the house, which is what they are to the building.
 * - `RESIDENTS`: a signed-in person who lives in the house.
 * - `HANDLERS`: whoever handles issues, for the board's own internal types.
 */
export const ISSUE_REPORTER_GROUPS = [
  "PUBLIC",
  "RESIDENTS",
  "HANDLERS",
] as const;

export type IssueReporterGroup = (typeof ISSUE_REPORTER_GROUPS)[number];

/** How much a board may write and add to one issue type's statuses. */
export const ISSUE_STATUS_LIMITS = {
  /** A status's label, such as "Väntar på styrelsebeslut". */
  label: 60,
  /**
   * Statuses on one type, switched-off ones included. Four is the default set;
   * a queue whose type has more steps than this is not one a handler can read.
   */
  perType: 20,
  /**
   * The highest place a status can have within its meaning. The board sets
   * no place above it, and a status added behind one at this place numbers
   * its meaning's statuses afresh rather than passing it. A queue cursor
   * carries the place, and its published pattern allows these digits.
   */
  sortOrder: 999,
} as const;

/** Whether a string is one of the four meanings. */
export function isIssueStatusMeaning(
  value: unknown,
): value is IssueStatusMeaning {
  return (ISSUE_STATUS_MEANINGS as readonly unknown[]).includes(value);
}
