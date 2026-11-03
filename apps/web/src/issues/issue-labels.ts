import type {
  IssueCostResponsibility,
  IssueHandledBy,
  IssueOutcome,
  IssuePriority,
  IssueReporterGroup,
  IssueSignature,
  IssueStatusMeaning,
  IssueWaitingReason,
  MaintenanceResponsibility,
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

/** Each priority (prioritet): Akut, Normal, Låg. */
export const ISSUE_PRIORITY_LABEL = {
  URGENT: "issues.priority.URGENT",
  NORMAL: "issues.priority.NORMAL",
  LOW: "issues.priority.LOW",
} as const satisfies Readonly<Record<IssuePriority, TranslationKey>>;

/** Who handles a type's issues: every handler, or the board only. */
export const ISSUE_HANDLED_BY_LABEL = {
  EVERY_HANDLER: "issues.handledBy.EVERY_HANDLER",
  BOARD: "issues.handledBy.BOARD",
} as const satisfies Readonly<Record<IssueHandledBy, TranslationKey>>;

/** Who pays for an issue (kostnadsansvar): Föreningen, Bostadsrättshavaren, Oklart. */
export const ISSUE_COST_RESPONSIBILITY_LABEL = {
  ASSOCIATION: "issues.costResponsibility.ASSOCIATION",
  TENANT_OWNER: "issues.costResponsibility.TENANT_OWNER",
  UNCLEAR: "issues.costResponsibility.UNCLEAR",
} as const satisfies Readonly<Record<IssueCostResponsibility, TranslationKey>>;

/** Who maintains a part, as a line of the responsibility guide states it. */
export const MAINTENANCE_RESPONSIBILITY_LABEL = {
  ASSOCIATION: "issues.maintenanceResponsibility.ASSOCIATION",
  TENANT_OWNER: "issues.maintenanceResponsibility.TENANT_OWNER",
} as const satisfies Readonly<
  Record<MaintenanceResponsibility, TranslationKey>
>;

/**
 * The role a handler's message is signed with (decision 19): what the reporter
 * reads in place of a name, and what the handlers read beside one.
 */
export const ISSUE_SIGNATURE_LABEL = {
  BOARD: "issues.conversation.signature.BOARD",
  PROPERTY_MANAGER: "issues.conversation.signature.PROPERTY_MANAGER",
} as const satisfies Readonly<Record<IssueSignature, TranslationKey>>;
