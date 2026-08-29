/**
 * The shape of a data subject access report (registerutdrag, GDPR art. 15).
 *
 * A type of its own rather than a projection of the address book's, because
 * the two answer different questions. The address book payload is what a board
 * member works in - masked, paged, filtered by capability. This is everything
 * the association holds about one person, decrypted, on one document, and the
 * only correct way to build it is to name every section it must contain and
 * fail to compile when a new store of personal data has no section here.
 *
 * Which is the point of writing it out: the list below is the audit checklist.
 * A module that starts holding personal data about a person adds a section, and
 * a reviewer can read this file to see whether the report is still complete.
 */

/** ISO calendar date (YYYY-MM-DD) or instant, as each field documents. */
export interface ReportPostalAddress {
  street: string | null;
  postalCode: string | null;
  city: string | null;
}

export interface ReportPerson {
  personId: string;
  firstName: string;
  lastName: string;
  postalAddress: ReportPostalAddress;
  alternativePostalAddress: string | null;
  /** Decrypted. Null when the register holds none. */
  email: string | null;
  phone: string | null;
  /**
   * Decrypted, and the reason this endpoint is gated on protectedData:reveal.
   * It appears on no other payload in the product.
   */
  personalIdentityNumber: string | null;
  protectedPersonalData: boolean;
  preferredLocale: string;
  /** ISO instant the person record was created. */
  recordedAt: string;
}

export interface ReportResidency {
  residencyId: string;
  apartmentNumber: string;
  addressLabel: string;
  role: "MEMBER" | "RESIDENT";
  movedInOn: string | null;
  movedOutOn: string | null;
  /** Derived from the retention policy, never stored. */
  purgeOn: string | null;
}

export interface ReportBoardPosition {
  position: "CHAIR" | "BOARD_MEMBER" | "DEPUTY_BOARD_MEMBER";
  electedOn: string | null;
  endedOn: string | null;
}

export interface ReportAccount {
  /** The address the account signs in with, which may differ from the register's. */
  email: string;
  twoFactorEnabled: boolean;
  createdAt: string;
}

/** Statutory tier: exempt from the purge, listed here because it is theirs. */
export interface ReportMemberRegisterEntry {
  entryId: string;
  eventType: "ENTRY" | "EXIT" | "CORRECTION";
  eventOn: string;
  apartment: string | null;
  recordedName: string;
  recordedPostalAddress: ReportPostalAddress;
  note: string | null;
}

export interface ReportTransfer {
  transferId: string;
  apartment: string;
  /** Whether this person acquired the tenant-ownership or gave it up. */
  direction: "acquired" | "relinquished";
  transferredOn: string;
  price: string | null;
  agreementReference: string | null;
}

export interface ReportPublicationConsent {
  scope: "PHOTO" | "NAME_ON_SITE" | "BOARD_ROSTER";
  grantedOn: string;
  withdrawnOn: string | null;
  note: string | null;
}

/**
 * An issue this person reported.
 *
 * Listed rather than purged: issue retention has its own decisions to make and
 * this train did not make them. A report that omitted them while the rows
 * existed would be an incomplete answer to an access request, which is the one
 * failure this document cannot have.
 */
export interface ReportIssue {
  issueId: string;
  typeName: string;
  status: "NEW" | "IN_PROGRESS" | "DONE";
  location: string | null;
  description: string;
  reportedAt: string;
  photographs: number;
}

/** A document this person put into the association's archive. */
export interface ReportDocument {
  documentId: string;
  title: string;
  category: string;
  audience: "BOARD" | "MEMBER" | "PUBLIC";
  filedAt: string;
}

/**
 * A lien note (pantnotering) that stood against a tenant-ownership this person
 * held.
 *
 * The one section of this report that is not keyed on a person column. A lien
 * note names an apartment and a creditor, never a person, so which of them are
 * this person's is derived from the member register - see `holding-periods.ts`
 * for the rule and for why it errs towards leaving a note out.
 */
export interface ReportLienNote {
  lienNoteId: string;
  apartment: string;
  creditor: string;
  /** Decimal as written, or null where none was recorded. */
  amount: string | null;
  notedOn: string;
  /** Null while the pledge still stands. */
  releasedOn: string | null;
}

/**
 * One audit entry naming this person.
 *
 * `role` says which way round: "subject" is something done to them, "actor" is
 * something they did. Both are personal data about them, and a report that
 * carried only the first would leave a board member unable to see their own
 * accesses - which is exactly what an access request from a board member asks
 * for.
 */
export interface ReportAuditEntry {
  entryId: string;
  role: "subject" | "actor";
  action: string;
  at: string;
  targetKind: string | null;
  targetId: string | null;
  /** Field names, identifiers and counts. Never a value: see AuditLogService. */
  context: Record<string, unknown> | null;
}

export interface DataSubjectReport {
  /** ISO date the report was produced, for the document stamp. */
  generatedOn: string;
  housingCooperative: { name: string; organizationNumber: string | null };
  person: ReportPerson;
  residencies: ReportResidency[];
  boardPositions: ReportBoardPosition[];
  systemRoles: ("ADMIN" | "PROPERTY_MANAGER")[];
  account: ReportAccount | null;
  memberRegisterEntries: ReportMemberRegisterEntry[];
  transfers: ReportTransfer[];
  lienNotes: ReportLienNote[];
  publicationConsents: ReportPublicationConsent[];
  legalHolds: {
    holdId: string;
    reason: string;
    placedAt: string;
    releasedAt: string | null;
    releaseReason: string | null;
  }[];
  issues: ReportIssue[];
  documents: ReportDocument[];
  auditEntries: ReportAuditEntry[];
  /** What the association keeps, and until when. */
  retention: {
    daysAfterMoveOut: number;
    /** The latest purge date across this person's residencies. */
    purgeOn: string | null;
    onLegalHold: boolean;
  };
}
