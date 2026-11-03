import type {
  IssueOutcome,
  IssueReporterGroup,
  IssueStatusMeaning,
  IssueWaitingReason,
} from "@openbrf/shared";

import type { TranslationKey } from "../i18n/translation-key";

/**
 * The words for the fixed vocabulary of an issue's statuses (ADR 0054), in
 * the reader's own language. Written once, so the queue, the board's settings,
 * the reporter's list and the data subject access report say the same thing.
 * A status's label is never among them: it is the board's own text.
 */

/** Each status meaning. Also what a reporter is shown of a status. */
export const ISSUE_MEANING_LABEL = {
  NEW: "issues.status.NEW",
  IN_PROGRESS: "issues.status.IN_PROGRESS",
  WAITING: "issues.status.WAITING",
  DONE: "issues.status.DONE",
} as const satisfies Readonly<Record<IssueStatusMeaning, TranslationKey>>;

export const ISSUE_WAITING_REASON_LABEL = {
  REPORTER: "issues.waitingReason.REPORTER",
  CONTRACTOR: "issues.waitingReason.CONTRACTOR",
  PARTS: "issues.waitingReason.PARTS",
  DECISION: "issues.waitingReason.DECISION",
} as const satisfies Readonly<Record<IssueWaitingReason, TranslationKey>>;

export const ISSUE_OUTCOME_LABEL = {
  FIXED: "issues.outcome.FIXED",
  TENANT_OWNER_RESPONSIBILITY: "issues.outcome.TENANT_OWNER_RESPONSIBILITY",
  NO_FAULT: "issues.outcome.NO_FAULT",
  REFERRED: "issues.outcome.REFERRED",
  DUPLICATE: "issues.outcome.DUPLICATE",
} as const satisfies Readonly<Record<IssueOutcome, TranslationKey>>;

export const ISSUE_REPORTER_GROUP_LABEL = {
  PUBLIC: "issues.reporters.PUBLIC",
  RESIDENTS: "issues.reporters.RESIDENTS",
  HANDLERS: "issues.reporters.HANDLERS",
} as const satisfies Readonly<Record<IssueReporterGroup, TranslationKey>>;
