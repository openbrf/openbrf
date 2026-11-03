/**
 * What happens to an issue (ärende) after it closes, and the notice a handler
 * publishes about a fault the house already knows of (ADR 0054, decisions 8
 * and 22 of the issue module plan).
 *
 * Here rather than beside the service, for the reason `ISSUE_REPORT_LIMITS`
 * gives: the reporter's screen and the board's both have to know the same
 * numbers.
 */

/**
 * How long after closing a reply from the reporter reopens an issue
 * (återöppning), in days of 24 hours from the instant it closed.
 *
 * After that the reporter is offered a new issue linked to the old one
 * instead. Counted in instants rather than calendar days, because the purge
 * clock it stops runs on the same column (`closedAt`), and a window that moved
 * with the reader's time zone would reopen an issue for one reader that it
 * refused another.
 */
export const ISSUE_REOPEN_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a reply at `now` still reopens an issue that closed at `closedAt`:
 * on the thirtieth day after closing it does, on the thirty-first it does not.
 * An issue with no closing date (one closed before the date was recorded)
 * is past the window, since nobody can say it is inside it.
 */
export function replyReopensIssue(closedAt: Date | null, now: Date): boolean {
  return (
    closedAt !== null &&
    now.getTime() - closedAt.getTime() <= ISSUE_REOPEN_WINDOW_DAYS * DAY_MS
  );
}

/**
 * What a reply field on one's own issue does, as the server decides it.
 *
 * - `MESSAGE`: the issue is open, and a reply is a message on it.
 * - `REOPENS`: the issue closed within the reopening window, and a reply
 *   reopens it.
 * - `NEW_REPORT`: the issue closed before that, or was merged into another
 *   issue, and the reporter is offered a new report linked to it instead.
 */
export const ISSUE_REPLY_MODES = ["MESSAGE", "REOPENS", "NEW_REPORT"] as const;

export type IssueReplyMode = (typeof ISSUE_REPLY_MODES)[number];

/** How much a known fault (känt fel) may say. */
export const ISSUE_KNOWN_FAULT_LIMITS = {
  /**
   * The notice itself: "The lift in entrance 14 is out; a technician comes on
   * Thursday." Short on purpose, since it is read on a report form by
   * somebody about to write the same thing, and a notice that needs more is a
   * news item.
   */
  body: 280,
} as const;
