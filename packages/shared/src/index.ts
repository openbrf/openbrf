export {
  apartmentNumberFor,
  ApartmentNumberingError,
  ENTRANCE_FLOOR_PREFIX,
  floorOfApartmentNumber,
  generateApartmentNumbers,
  HIGHEST_FLOOR,
  LOWEST_FLOOR,
  MAX_APARTMENTS_PER_FLOOR,
} from "./apartment-numbering.ts";
export type {
  ApartmentNumberRow,
  GenerateApartmentNumbersInput,
} from "./apartment-numbering.ts";
export { AUDIT_CHANNELS } from "./audit-channels.ts";
export { calendarDateSchema } from "./calendar-date-schema.ts";
export type { AuditChannelName } from "./audit-channels.ts";
export { DATA_SUBJECT_REPORT_SECTIONS } from "./data-subject-report-sections.ts";
export type { DataSubjectReportSection } from "./data-subject-report-sections.ts";
export {
  DATA_SUBJECT_CATEGORIES,
  PERSONAL_DATA_CATEGORIES,
} from "./data-protection.ts";
export type {
  DataSubjectCategory,
  PersonalDataCategory,
} from "./data-protection.ts";
export { MAX_REPLY_CHARACTERS } from "./board-mailbox-limits.ts";
export { MAX_CONTACT_SUBMISSIONS_PER_REMOVAL } from "./contact-inbox-limits.ts";
export { PAGE_CONTENT_LIMITS } from "./page-content-limits.ts";
export {
  isValidPersonalIdentityNumber,
  normalizePersonalIdentityNumber,
  parsePersonalIdentityNumber,
  scanForPersonalIdentityNumbers,
} from "./personal-identity-number.ts";
export type {
  PersonalIdentityNumberMatch,
  PersonalIdentityNumberParts,
} from "./personal-identity-number.ts";
export {
  PLUGIN_INSTALL_FAILURE_REASONS,
  pluginInstallFailureReason,
  pluginInstallFailureValues,
} from "./plugin-install-failures.ts";
export type {
  PluginInstallFailureDetail,
  PluginInstallFailureReason,
} from "./plugin-install-failures.ts";
export { scannableRunsText } from "./scannable-text.ts";
export type { ScannableRun } from "./scannable-text.ts";
export {
  addLocalDays,
  ASSOCIATION_TIME_ZONE,
  compareLocalDays,
  dateColumnOf,
  formatDateColumn,
  formatDayOfInstant,
  formatLocalDay,
  instantAt,
  localDayOf,
  localDayOfColumn,
  localDaysBetween,
  localMinuteOf,
  localWeekAround,
  MINUTES_PER_DAY,
  parseLocalDay,
} from "./stockholm-calendar.ts";
export type { LocalDay, Period } from "./stockholm-calendar.ts";

/** Placeholder version constant until the first release is cut via changesets. */
export const VERSION = "0.0.0";

/**
 * Minimal typed Result helper for explicit error handling without exceptions.
 * Domain services return Result instead of throwing for expected failures.
 */
export type Result<T, E = Error> =
  { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
