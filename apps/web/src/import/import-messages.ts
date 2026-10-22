import {
  MAX_IMPORT_CELL_LENGTH,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  MAX_IMPORT_UPLOAD_BYTES,
} from "@openbrf/shared";

import type { TranslationKey } from "../i18n/translation-key";
import type {
  ImportField,
  ImportFill,
  ImportOutcome,
  ImportPreviewRow,
  ImportRunStatus,
} from "./import-api";

/**
 * Codes from the API, turned into keys this interface owns.
 *
 * The API answers in English while the interface is Swedish by default, and how
 * much a failure explains is a decision for the screen. Anything unrecognised
 * falls back to a general message rather than rendering a code at a board
 * member.
 *
 * The same map covers both kinds of failure the import has: the one a request
 * answers with, and the one a job records on the session when it stops early.
 */

const FAILURES: Record<string, TranslationKey> = {
  "file-empty": "import.errors.fileEmpty",
  "file-too-large": "import.errors.fileTooLarge",
  "file-unreadable": "import.errors.fileUnreadable",
  "file-mixed-encoding": "import.errors.fileMixedEncoding",
  "too-many-rows": "import.errors.tooManyRows",
  "too-many-columns": "import.errors.tooManyColumns",
  "cell-too-long": "import.errors.cellTooLong",
  "unterminated-quote": "import.errors.unterminatedQuote",
  "workbook-too-large": "import.errors.workbookTooLarge",
  "mapping-invalid": "import.errors.mappingInvalid",
  "preview-required": "import.errors.previewRequired",
  "preview-outdated": "import.errors.previewOutdated",
  // Answered by previewing again, so the board only reads it when that fails.
  "decisions-not-previewed": "import.errors.previewOutdated",
  "preview-replaced": "import.errors.previewReplaced",
  "preview-interrupted": "import.errors.previewInterrupted",
  "preview-cancelled": "import.errors.previewCancelled",
  "session-not-found": "import.errors.sessionNotFound",
  "session-expired": "import.errors.sessionExpired",
  "session-already-applied": "import.errors.sessionAlreadyApplied",
  "another-import-running": "import.errors.anotherImportRunning",
  "ambiguous-rows-undecided": "import.errors.ambiguousRowsUndecided",
  "decision-not-a-candidate": "import.errors.decisionNotACandidate",
  "register-changed-during-apply": "import.errors.registerChangedDuringApply",
  "apply-interrupted": "import.errors.applyInterrupted",
  "apply-abandoned": "import.errors.applyAbandoned",
  "session-not-running": "import.errors.sessionNotRunning",
};

export function failureMessage(reason: string): TranslationKey {
  return FAILURES[reason] ?? "import.errors.unknown";
}

/**
 * The limits a refused file is told about, for the failure messages that name
 * one. The same numbers the API enforces, so the two cannot disagree.
 */
export const FAILURE_VALUES = {
  maxKilobytes: MAX_IMPORT_UPLOAD_BYTES / 1024,
  maxRows: MAX_IMPORT_ROWS,
  maxColumns: MAX_IMPORT_COLUMNS,
  maxCellLength: MAX_IMPORT_CELL_LENGTH,
} as const;

const MAPPING_PROBLEMS: Record<string, TranslationKey> = {
  "name-column-missing": "import.mappingProblem.name-column-missing",
  "apartment-column-missing": "import.mappingProblem.apartment-column-missing",
  "role-missing": "import.mappingProblem.role-missing",
  "moved-in-missing": "import.mappingProblem.moved-in-missing",
  "duplicate-field": "import.mappingProblem.duplicate-field",
  "default-role-with-column": "import.mappingProblem.default-role-with-column",
  "default-moved-in-with-column":
    "import.mappingProblem.default-moved-in-with-column",
  "mapping-length-mismatch": "import.mappingProblem.mapping-length-mismatch",
};

/**
 * What is wrong with a mapping the API refused, one message for each problem.
 *
 * The API lists the problems as codes, a duplicate with the field after a
 * colon, which the message does not need. An unrecognised code reads as the
 * general one, and the same message is not listed twice.
 */
export function mappingProblemMessages(detail: unknown): TranslationKey[] {
  if (!Array.isArray(detail)) {
    return [];
  }
  const messages = detail.map(
    (problem): TranslationKey =>
      MAPPING_PROBLEMS[String(problem).split(":")[0] ?? ""] ??
      "import.mappingProblem.unknown",
  );
  return [...new Set(messages)];
}

const PROBLEMS: Record<string, TranslationKey> = {
  "name-missing": "import.problem.name-missing",
  "name-not-splittable": "import.problem.name-not-splittable",
  "apartment-missing": "import.problem.apartment-missing",
  "apartment-not-found": "import.problem.apartment-not-found",
  "apartment-ambiguous": "import.problem.apartment-ambiguous",
  "role-missing": "import.problem.role-missing",
  "role-unrecognised": "import.problem.role-unrecognised",
  "moved-in-missing": "import.problem.moved-in-missing",
  "date-not-iso": "import.problem.date-not-iso",
  "moved-out-before-moved-in": "import.problem.moved-out-before-moved-in",
  "residency-conflict": "import.problem.residency-conflict",
  "invalid-personal-identity-number":
    "import.problem.invalid-personal-identity-number",
  "personal-identity-number-needs-century":
    "import.problem.personal-identity-number-needs-century",
  "invalid-email": "import.problem.invalid-email",
  "garbled-characters": "import.problem.garbled-characters",
};

export function problemMessage(reason: string): TranslationKey {
  return PROBLEMS[reason] ?? "import.problem.unknown";
}

export const FIELD_LABEL: Record<ImportField, TranslationKey> = {
  addressLabel: "import.field.addressLabel",
  apartmentNumber: "import.field.apartmentNumber",
  firstName: "import.field.firstName",
  lastName: "import.field.lastName",
  fullName: "import.field.fullName",
  role: "import.field.role",
  email: "import.field.email",
  phone: "import.field.phone",
  personalIdentityNumber: "import.field.personalIdentityNumber",
  postalStreet: "import.field.postalStreet",
  postalCode: "import.field.postalCode",
  postalCity: "import.field.postalCity",
  movedInOn: "import.field.movedInOn",
  movedOutOn: "import.field.movedOutOn",
};

/**
 * What the import is doing, in a word.
 *
 * Only the states the running screen can be in: a session still being mapped
 * has no run to describe, and the screen shows the mapping step for it instead.
 */
export const RUN_STATUS_LABEL: Record<
  Exclude<ImportRunStatus, "MAPPING">,
  TranslationKey
> = {
  QUEUED: "import.run.queued",
  APPLYING: "import.run.applying",
  APPLIED: "import.run.applied",
  FAILED: "import.run.failed",
};

/**
 * What the panel is called, which is not the same question as what the import
 * is doing: an import that stopped is not an import that is running, and a
 * heading that said so would be the first thing a board member read.
 */
export const RUN_TITLE: Record<
  Exclude<ImportRunStatus, "MAPPING">,
  TranslationKey
> = {
  QUEUED: "import.run.title",
  APPLYING: "import.run.title",
  APPLIED: "import.result.title",
  FAILED: "import.run.stopped",
};

/**
 * What a previewed row does, as the board reads it: the API's outcome, with an
 * update that fills in nothing told apart as `matched`. A file imported again
 * is mostly rows the register already agrees with, and the few that change it
 * are the ones worth reading.
 */
export type PreviewRowKind = ImportOutcome | "matched";

export function previewRowKind(row: ImportPreviewRow): PreviewRowKind {
  return row.outcome === "update" && row.fills.length === 0
    ? "matched"
    : row.outcome;
}

export const OUTCOME_LABEL: Record<PreviewRowKind, TranslationKey> = {
  create: "import.outcome.create",
  matched: "import.outcome.matched",
  update: "import.outcome.update",
  ambiguous: "import.outcome.ambiguous",
  error: "import.outcome.error",
};

/**
 * How an outcome reads on the row.
 *
 * Colour is never the only signal: each outcome carries its own word, and these
 * classes only reinforce it.
 */
export const OUTCOME_TONE: Record<PreviewRowKind, string> = {
  create: "text-ok",
  matched: "text-ink-muted",
  update: "text-ink",
  ambiguous: "text-warn",
  error: "text-danger",
};

export const FILL_LABEL: Record<ImportFill, TranslationKey> = {
  email: "import.fill.email",
  phone: "import.fill.phone",
  postalAddress: "import.fill.postalAddress",
  residency: "import.fill.residency",
};
