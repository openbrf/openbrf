/**
 * Every key of the data subject access report (registerutdrag, GDPR art. 15),
 * in the order the report declares them.
 *
 * Here rather than in either application because both render the report: the
 * API builds it and names its sections in the audit entry, and the browser
 * prints it and may not import server types. Each side holds its own type of
 * the report to exactly these keys, so a section one of them has and the other
 * lacks fails a build rather than a printed document.
 *
 * Swedish domain terms follow GLOSSARY.md.
 */
export const DATA_SUBJECT_REPORT_SECTIONS = [
  "generatedOn",
  "housingCooperative",
  "person",
  "residencies",
  "boardPositions",
  "systemRoles",
  "account",
  "connectedApps",
  "memberRegisterEntries",
  "transfers",
  "transferReversals",
  "terminations",
  "lienNotes",
  "registerReportObligations",
  "publicationConsents",
  "legalHolds",
  "issues",
  "documents",
  "apartmentDocuments",
  "bookings",
  "motions",
  "subletApplications",
  "keyOrders",
  "eventSignups",
  "memberCharges",
  "fees",
  "feeNotices",
  "newsComments",
  "chats",
  "chatReports",
  "boardMailboxThreads",
  "meetingAttendances",
  "proxyAuthorisations",
  "auditEntries",
  "dataSubjectRequests",
  "personalDataBreaches",
  "retention",
] as const;

export type DataSubjectReportSection =
  (typeof DATA_SUBJECT_REPORT_SECTIONS)[number];
