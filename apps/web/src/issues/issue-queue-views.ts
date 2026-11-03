import {
  ISSUE_QUEUE_VIEWS,
  type IssueMeaningFilter,
  type IssueQueueView,
} from "@openbrf/shared";

import type { IssueQueueCounts } from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";

/**
 * The views of the issue queue as the address names them (`/board/issues?view=
 * unassigned`), so the board's front page can lead to one and a handler can
 * keep one as a bookmark.
 */
export const VIEW_PARAM = {
  MINE: "mine",
  UNASSIGNED: "unassigned",
  OVERDUE: "overdue",
  ALL: "all",
} as const satisfies Readonly<Record<IssueQueueView, string>>;

export type IssueViewParam = (typeof VIEW_PARAM)[IssueQueueView];

/**
 * The view an address names, or null for anything else: a parameter that is
 * not one of the four is no view at all rather than a router error, and the
 * screen opens on its default.
 */
export function viewOfParam(value: unknown): IssueQueueView | null {
  return ISSUE_QUEUE_VIEWS.find((view) => VIEW_PARAM[view] === value) ?? null;
}

/** The view the queue opens on: the handler's own work (decision 15). */
export const DEFAULT_VIEW: IssueQueueView = "MINE";

/** Each view's name: Mina, Ej tilldelade, Försenade, Alla. */
export const VIEW_LABEL = {
  MINE: "issues.views.MINE",
  UNASSIGNED: "issues.views.UNASSIGNED",
  OVERDUE: "issues.views.OVERDUE",
  ALL: "issues.views.ALL",
} as const satisfies Readonly<Record<IssueQueueView, TranslationKey>>;

/** What each view says when it holds nothing and nothing narrows it. */
export const VIEW_EMPTY = {
  MINE: "issues.views.empty.MINE",
  UNASSIGNED: "issues.views.empty.UNASSIGNED",
  OVERDUE: "issues.views.empty.OVERDUE",
  ALL: "issues.views.empty.ALL",
} as const satisfies Readonly<Record<IssueQueueView, TranslationKey>>;

/** Which of the server's counts is each view's. */
export const VIEW_COUNT = {
  MINE: "mine",
  UNASSIGNED: "unassigned",
  OVERDUE: "overdue",
  ALL: "all",
} as const satisfies Readonly<Record<IssueQueueView, keyof IssueQueueCounts>>;

/**
 * The status filter's choices, in the order it lists them: every open meaning,
 * which the screen opens on, one meaning, or `ANY`, closed issues included.
 * The same in every view, so the numbers on the views are counted under the
 * one filter the handler sees.
 */
export type StatusChoice = IssueMeaningFilter | "ANY";

export const STATUS_CHOICES: readonly StatusChoice[] = [
  "OPEN",
  "NEW",
  "IN_PROGRESS",
  "WAITING",
  "DONE",
  "ANY",
];

/** The status filter's choice as the server's parameter: none for `ANY`. */
export function meaningFilterOf(
  choice: StatusChoice,
): IssueMeaningFilter | undefined {
  return choice === "ANY" ? undefined : choice;
}
