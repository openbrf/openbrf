import type { DataSubjectReport } from "../retention/data-subject-report";
import type { SeedKey } from "./processing-activity-seed";

/**
 * Which processing in the record covers each section of the data subject
 * access report, and what the portability export does with it.
 *
 * Two rules nothing enforced before this map. The record of processing
 * activities (GDPR art. 30) is to name every processing the instance performs,
 * and a module that starts holding personal data about a person adds a section
 * to the access report (art. 15) - so a section that names no row is a
 * processing the record is silent about. And the portability export (art. 20)
 * carries only what rests on a consent or a contract, which is a fact the
 * record states row by row - so the export reads each section's basis from the
 * row that covers it rather than from a second list kept by hand, and the two
 * can no longer disagree.
 *
 * Typed exhaustively rather than derived by walking the source. The report's
 * sections are an interface the compiler already enumerates, so `satisfies`
 * below fails to compile for a key added to {@link DataSubjectReport} without
 * an entry, for an entry naming a key that does not exist, and for a row that
 * is not a {@link SeedKey}. A walk of what the code does, the way
 * `erasure-domains.spec.ts` walks `testing/erasure-source-facts.ts`, is for a
 * fact only visible there - which jobs read granted requests - and this is not
 * one. `section-processing.spec.ts` holds what the compiler cannot: which keys
 * may be part of the document, and which rows no section reaches.
 *
 * The tie is to the product's statement of each basis, the seed's shapes, and
 * not to an instance's edited row: a board that edits the basis on its own
 * record changes its record, not what the product exports. A row counts by the
 * basis it records, including a row whose note names a second basis for part of
 * its subjects.
 *
 * The imports are type-only, so this module has no runtime dependency and the
 * retention module reads it without a cycle.
 */

/** Every key of the data subject access report. */
export type ReportSection = keyof DataSubjectReport;

/**
 * What the portability export does with a section (GDPR art. 20(1)).
 *
 * "otherBasis": the row rests on neither consent nor contract, so art.
 *   20(1)(a) does not reach it.
 * "notProvided": the row rests on one of them, and the section is the
 *   association's own account rather than something the person provided.
 * "carried": both bounds hold.
 */
export type Portability = "carried" | "notProvided" | "otherBasis";

/**
 * A key that is part of the document rather than a processing: the date it
 * was produced on, the controller it is produced by, and what is derived from
 * sections that have rows of their own.
 */
export type DocumentPart = "stamp" | "controller" | "derived";

export type SectionProcessing =
  | { readonly row: SeedKey; readonly portability: Portability }
  | { readonly documentPart: DocumentPart };

/**
 * One entry per key of the report, in the interface's own order - which is the
 * order the access report's audit entry names its sections in.
 */
export const SECTION_PROCESSING = {
  generatedOn: { documentPart: "stamp" },
  housingCooperative: { documentPart: "controller" },
  /*
   * The address book's entry for the person, whose row rests on the contract.
   * The personal identity number on it is apartment register content, which
   * the export leaves out field by field; the section's row is the address
   * book, whose entry it is.
   */
  person: { row: "addressBookAndAccounts", portability: "carried" },
  residencies: { row: "addressBookAndAccounts", portability: "carried" },
  boardPositions: {
    row: "boardPositionsAndSystemRoles",
    portability: "otherBasis",
  },
  systemRoles: {
    row: "boardPositionsAndSystemRoles",
    portability: "otherBasis",
  },
  /*
   * On the contract, and still not carried: when the account was created and
   * whether it has a second factor are the association's record of the
   * account rather than something the person provided.
   */
  account: { row: "addressBookAndAccounts", portability: "notProvided" },
  connectedApps: { row: "connectedApps", portability: "carried" },
  memberRegisterEntries: { row: "memberRegister", portability: "otherBasis" },
  /*
   * The transfers, their reversals, the terminations and the lien notes are
   * the apartment register's, whose row lists the insats and the liens as
   * financial data.
   */
  transfers: { row: "apartmentRegister", portability: "otherBasis" },
  transferReversals: { row: "apartmentRegister", portability: "otherBasis" },
  terminations: { row: "apartmentRegister", portability: "otherBasis" },
  lienNotes: { row: "apartmentRegister", portability: "otherBasis" },
  registerReportObligations: {
    row: "cooperativeHousingRegisterReporting",
    portability: "otherBasis",
  },
  publicationConsents: { row: "websitePublication", portability: "carried" },
  legalHolds: { row: "legalHolds", portability: "otherBasis" },
  // Legitimate interest: managing the property.
  issues: { row: "issues", portability: "otherBasis" },
  // Legitimate interest: preserving the association's records.
  documents: { row: "documents", portability: "otherBasis" },
  apartmentDocuments: { row: "apartmentBinder", portability: "otherBasis" },
  bookings: { row: "bookings", portability: "carried" },
  motions: { row: "motions", portability: "carried" },
  subletApplications: { row: "subletApplications", portability: "carried" },
  keyOrders: { row: "keyOrders", portability: "carried" },
  eventSignups: { row: "events", portability: "carried" },
  memberCharges: { row: "memberCharges", portability: "otherBasis" },
  fees: { row: "fees", portability: "otherBasis" },
  feeNotices: { row: "fees", portability: "otherBasis" },
  // Legitimate interest: letting the house talk under what the board publishes.
  newsComments: { row: "newsComments", portability: "otherBasis" },
  // Legitimate interest: administering the association, and letting the house
  // organise itself. The reports to the board are part of the same processing.
  chats: { row: "chat", portability: "otherBasis" },
  chatReports: { row: "chat", portability: "otherBasis" },
  boardMailboxThreads: { row: "boardMailbox", portability: "otherBasis" },
  meetingAttendances: { row: "meetingRecords", portability: "otherBasis" },
  proxyAuthorisations: { row: "meetingRecords", portability: "otherBasis" },
  auditEntries: { row: "auditLog", portability: "otherBasis" },
  // Legal obligation: GDPR art. 12(3)-(4), 17, 18 and 21, and art. 5(2).
  dataSubjectRequests: {
    row: "dataSubjectRequests",
    portability: "otherBasis",
  },
  personalDataBreaches: {
    row: "personalDataBreaches",
    portability: "otherBasis",
  },
  /*
   * Derived when the report is drawn, from the residencies, the retention
   * policy and the holds, each of which has a section of its own.
   */
  retention: { documentPart: "derived" },
} as const satisfies Record<ReportSection, SectionProcessing>;

/** A section some processing in the record covers. */
export type ProcessedSection = {
  [K in ReportSection]: (typeof SECTION_PROCESSING)[K] extends { row: SeedKey }
    ? K
    : never;
}[ReportSection];

/** A section the portability export carries. */
export type PortableSection = {
  [K in ReportSection]: (typeof SECTION_PROCESSING)[K] extends {
    portability: "carried";
  }
    ? K
    : never;
}[ReportSection];

const SECTIONS = Object.keys(SECTION_PROCESSING) as ReportSection[];

function isProcessed(section: ReportSection): section is ProcessedSection {
  return "row" in SECTION_PROCESSING[section];
}

function isPortable(section: ReportSection): section is PortableSection {
  const entry: SectionProcessing = SECTION_PROCESSING[section];
  return "portability" in entry && entry.portability === "carried";
}

/** What the access report's audit entry names, in the report's order. */
export const REPORTED_SECTIONS: readonly ProcessedSection[] =
  SECTIONS.filter(isProcessed);

/** What the portability export carries, in the report's order. */
export const PORTABLE_SECTIONS: readonly PortableSection[] =
  SECTIONS.filter(isPortable);
