import type { TranslationKey } from "../i18n/translation-key";
import type { ImportField, ImportOutcome } from "./import-api";

/**
 * Codes from the API, turned into keys this interface owns.
 *
 * The API answers in English while the interface is Swedish by default, and how
 * much a failure explains is a decision for the screen. Anything unrecognised
 * falls back to a general message rather than rendering a code at a board
 * member.
 */

const FAILURES: Record<string, TranslationKey> = {
  "file-empty": "import.errors.fileEmpty",
  "file-too-large": "import.errors.fileTooLarge",
  "file-unreadable": "import.errors.fileUnreadable",
  "too-many-rows": "import.errors.tooManyRows",
  "mapping-invalid": "import.errors.mappingInvalid",
  "session-not-found": "import.errors.sessionNotFound",
  "session-expired": "import.errors.sessionExpired",
  "session-already-applied": "import.errors.sessionAlreadyApplied",
  "ambiguous-rows-undecided": "import.errors.ambiguousRowsUndecided",
  "decision-not-a-candidate": "import.errors.decisionNotACandidate",
};

export function failureMessage(reason: string): TranslationKey {
  return FAILURES[reason] ?? "import.errors.unknown";
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
  "invalid-personal-identity-number":
    "import.problem.invalid-personal-identity-number",
  "invalid-email": "import.problem.invalid-email",
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

export const OUTCOME_LABEL: Record<ImportOutcome, TranslationKey> = {
  create: "import.outcome.create",
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
export const OUTCOME_TONE: Record<ImportOutcome, string> = {
  create: "text-ok",
  update: "text-ink",
  ambiguous: "text-warn",
  error: "text-danger",
};
