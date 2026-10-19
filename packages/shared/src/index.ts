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
export type {
  AudienceKind,
  AudienceListView,
  AudienceView,
  AuthorView,
  CreatedGroupView,
  FeedFrom,
  FeedPage,
  FeedUpdate,
  GroupCandidateView,
  GroupMemberView,
  LikeView,
  PostAudienceView,
  PostCommentPage,
  PostCommentView,
  PostNewsView,
  PostReadView,
  PostReportQueueView,
  PostReportView,
  PostView,
} from "./feed.ts";
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
export type {
  AccountingReason,
  ApartmentBinderReason,
  ApartmentBinderTextPart,
  BookingReason,
  BookingTextField,
  ConnectedAppRevocationReason,
  EventReason,
  EventTextField,
  FeedReason,
  FeeReason,
  KeyOrderReason,
  KeyOrderTextPart,
  MediaReason,
  MeetingReason,
  MemberChargeReason,
  MotionReason,
  MotionTextPart,
  MoveReason,
  NewsCommentReason,
  PageWriteReason,
  SubletReason,
  SubletTextPart,
} from "./error-reasons.ts";
export { MAX_REPLY_CHARACTERS } from "./board-mailbox-limits.ts";
export { MAX_ADDRESS_BOOK_SEARCH_LENGTH } from "./address-book-limits.ts";
export { ISSUE_REPORT_LIMITS } from "./issue-report-limits.ts";
export { DATA_PROTECTION_LIMITS } from "./data-protection-limits.ts";
export { MAX_CONTACT_SUBMISSIONS_PER_REMOVAL } from "./contact-inbox-limits.ts";
export { isLoopbackHost } from "./loopback-host.ts";
export {
  MAX_IMPORT_CELL_LENGTH,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  MAX_IMPORT_UPLOAD_BYTES,
} from "./import-limits.ts";
export { PAGE_CONTENT_LIMITS } from "./page-content-limits.ts";
export {
  CORE_BLOCK_TYPE_PATTERN,
  defineBlock,
  isNamespacedBlockType,
  NAMESPACED_BLOCK_TYPE_PATTERN,
} from "./page-blocks/definition.ts";
export type {
  BlockCategory,
  BlockDefinition,
  BlockEditorMetadata,
  BlockIcon,
  BlockSchema,
  NamespacedBlockType,
  PageBlockShape,
  UnregisteredBlock,
} from "./page-blocks/definition.ts";
export type { AssociationFactsBlock } from "./page-blocks/blocks/association-facts.ts";
export type { BoardRosterBlock } from "./page-blocks/blocks/board-roster.ts";
export type { ControllerContactBlock } from "./page-blocks/blocks/controller-contact.ts";
export type { DocumentListBlock } from "./page-blocks/blocks/document-list.ts";
export type { EventCalendarBlock } from "./page-blocks/blocks/event-calendar.ts";
export type { FaqBlock, FaqItem } from "./page-blocks/blocks/faq.ts";
export type {
  ContactFormBlock,
  IssueReportFormBlock,
} from "./page-blocks/blocks/forms.ts";
export { headingBlock } from "./page-blocks/blocks/heading.ts";
export type { HeadingBlock } from "./page-blocks/blocks/heading.ts";
export type { ImageBlock } from "./page-blocks/blocks/image.ts";
export type { NewsTeaserBlock } from "./page-blocks/blocks/news-teaser.ts";
export { paragraphBlock } from "./page-blocks/blocks/paragraph.ts";
export type { ParagraphBlock } from "./page-blocks/blocks/paragraph.ts";
export {
  CORE_BLOCKS,
  createBlockRegistry,
  PAGE_BLOCKS,
} from "./page-blocks/registry.ts";
export type {
  BlockOf,
  BlockRegistry,
  CoreBlock,
  CoreBlockType,
  PageBlock,
} from "./page-blocks/registry.ts";
export { isPublishableUrl, LINK_PATTERN } from "./page-blocks/text-runs.ts";
export type { TextRun, Zod } from "./page-blocks/text-runs.ts";
export {
  numberedSlug,
  PAGE_SLUG_FALLBACK,
  PAGE_SLUG_MAX_LENGTH,
  slugFromTitle,
} from "./page-slug.ts";
export {
  ADDRESS_LIMITS,
  ADMINISTRATOR_LIMITS,
  BOOKABLE_RESOURCE_LIMITS,
  FINANCE_LIMITS,
  HOUSING_COOPERATIVE_LIMITS,
  ISSUE_TYPE_LIMITS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  SMS_LIMITS,
} from "./settings-limits.ts";
export { isAcceptableRedirectUri } from "./redirect-uri.ts";
export {
  isValidPersonalIdentityNumber,
  normalizeFreeText,
  normalizeSingleLineText,
  normalizePersonalIdentityNumber,
  parsePersonalIdentityNumber,
  personalIdentityNumberNeedsCentury,
  scanForPersonalIdentityNumberCandidates,
  scanForPersonalIdentityNumbers,
  withPersonalIdentityNumberCentury,
} from "./personal-identity-number.ts";
export type {
  PersonalIdentityNumberMatch,
  PersonalIdentityNumberParts,
} from "./personal-identity-number.ts";
export { scannableRuns } from "./scannable-text.ts";
export type { ScannableRun, ScannableText } from "./scannable-text.ts";
export {
  PLUGIN_INSTALL_FAILURE_REASONS,
  pluginInstallFailureReason,
  pluginInstallFailureValues,
} from "./plugin-install-failures.ts";
export type {
  PluginInstallFailureDetail,
  PluginInstallFailureReason,
} from "./plugin-install-failures.ts";
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
