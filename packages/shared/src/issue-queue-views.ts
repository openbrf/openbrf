import type { IssueStatusMeaning } from "./issue-status.ts";

/**
 * The views of the issue queue a handler works from (decision 15 of the issue
 * module plan), in the order the screen offers them.
 *
 * - `MINE` (Mina): the issues whose assignee is the reader.
 * - `UNASSIGNED` (Ej tilldelade): the issues nobody is assigned.
 * - `OVERDUE` (Försenade): the open issues whose target date has passed on the
 *   association's calendar. Never a closed one, because a closed issue is not
 *   overdue (GLOSSARY.md, senast klart).
 * - `ALL` (Alla): every issue the reader handles.
 *
 * The status filter narrows every view alike, and the screen opens it on the
 * open issues, so each view starts as work still to do and a closed issue is
 * one the handler asks for. Written once here, because the server answers
 * them and the screen and the board's front page name them, and the three
 * numbers on the front page are counts of these same views.
 */
export const ISSUE_QUEUE_VIEWS = [
  "MINE",
  "UNASSIGNED",
  "OVERDUE",
  "ALL",
] as const;

export type IssueQueueView = (typeof ISSUE_QUEUE_VIEWS)[number];

/**
 * The meanings an open issue stands in: every one but `DONE`, in the queue's
 * order.
 */
export const ISSUE_OPEN_MEANINGS = [
  "NEW",
  "IN_PROGRESS",
  "WAITING",
] as const satisfies readonly IssueStatusMeaning[];

/**
 * What the queue's status filter narrows to: one meaning, or `OPEN` for every
 * meaning but `DONE`. Never a board's label: statuses are per type, and a
 * filter across types reads the meaning, as everything that decides does
 * (ADR 0054).
 */
export type IssueMeaningFilter = IssueStatusMeaning | "OPEN";

/** How much the queue's search takes. */
export const ISSUE_SEARCH_LIMITS = {
  /** The text typed into the search box. */
  length: 100,
  /**
   * The words of it that are matched, each of which has to match somewhere;
   * words past this are not read. A handful finds an issue, and every word is
   * another pass over the queue's text.
   */
  terms: 6,
} as const;

/** Whether a string is one of the queue's views. */
export function isIssueQueueView(value: unknown): value is IssueQueueView {
  return (ISSUE_QUEUE_VIEWS as readonly unknown[]).includes(value);
}
