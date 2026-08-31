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
  /**
   * The day the association decided on the acquirer's membership, or null.
   *
   * Personal data about the acquirer specifically - it is the day a decision
   * was taken about them - and on the report for that reason as much as for
   * completeness. Null where there was no such decision to date, which the
   * statute provides for, and on transfers recorded before the field existed.
   */
  membershipDecidedOn: string | null;
  price: string | null;
  agreementReference: string | null;
}

/**
 * A tenant-ownership this person held that has ceased to exist (upphorande).
 *
 * Statutory tier and exempt from the purge, like the member register entries
 * and the transfers above: exemption from erasure is not exemption from access.
 *
 * The second section of this report that is not keyed on a person column. A
 * termination names an apartment and a date, never a person - BRL 7 kap. 33 §
 * makes every tenant-ownership in a disposed building cease at once, whoever
 * holds them - so which of them are this person's is derived from the member
 * register. `terminationsDuringHolding` in `holding-periods.ts` is the rule,
 * and it closes both boundaries where the lien rule beside it leaves both open,
 * for reasons argued there.
 */
export interface ReportTermination {
  terminationId: string;
  apartment: string;
  /** Which ground in bostadsrattslagen the cessation rests on. */
  kind: "GENERAL_MEETING_DECISION" | "BUILDING_TRANSFERRED";
  tookEffectOn: string;
  /** The minute, deed or enforcement decision the board recorded. */
  reference: string;
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
 * A booking this person made.
 *
 * Unlike the issues and documents above, these are purged: a booking is erased
 * a year after the booked period ended, on its own clock rather than on the
 * residency one. So each row states when that window runs out, which is what
 * makes the retention answer on this document true of the bookings as well as
 * of the contact details.
 *
 * The apartment is the one the booking was made for, and may be absent - either
 * because none was recorded or because the apartment has since been corrected
 * out of the register, which a booking survives by design.
 */
export interface ReportBooking {
  bookingId: string;
  /** What the board calls the resource, read from the resource itself. */
  resourceName: string;
  status: "BOOKED" | "CANCELLED" | "RELEASED";
  /** ISO instants: the booked period. */
  startsAt: string;
  endsAt: string;
  apartment: string | null;
  /**
   * The earliest date the purge can reach this booking, derived from the
   * retention window and never stored.
   *
   * The earliest, and deliberately not "the date it is erased on". A legal
   * hold suspends every purge for the person it stands against, so while one
   * stands this date passes and the booking is kept - and a document that had
   * promised an erasure would be telling its subject something the association
   * is not going to do. `retention.onLegalHold` on this same report says
   * whether one stands, in the same place it says so for the contact details.
   * A hold can only defer this date, never bring it forward, so the earliest
   * is true either way.
   */
  erasableFrom: string | null;
}

/**
 * A motion this person put to the general meeting.
 *
 * Purged like the bookings above, and on a clock of its own: a motion is erased
 * two years after it was closed, so each row states when that window runs out
 * rather than leaving the date at the foot of the document to govern it.
 *
 * A motion still with the board states none. It has no closing date to count
 * from, and it is not held indefinitely by oversight: the association is still
 * processing it, so the purpose it is held for has not ended. Saying so per row is
 * the only place this document can say it.
 *
 * The body is carried in full. It is the person's own words and the most complete
 * answer art. 15 can give about them; a report that summarised what somebody
 * proposed would be the association paraphrasing them back to themselves.
 */
export interface ReportMotion {
  motionId: string;
  title: string;
  body: string;
  status: "SUBMITTED" | "ACKNOWLEDGED" | "WITHDRAWN";
  /** ISO instant. */
  submittedAt: string;
  /** ISO instant, or null while the motion is with the board. */
  closedAt: string | null;
  /**
   * The earliest date the purge can reach this motion, derived from the retention
   * window and never stored. Null while it is open.
   *
   * The earliest, and deliberately not "the date it is erased on", for the reason
   * {@link ReportBooking.erasableFrom} gives: a legal hold suspends every purge
   * for the person it stands against, and `retention.onLegalHold` on this same
   * report says whether one does.
   */
  erasableFrom: string | null;
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
  terminations: ReportTermination[];
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
  bookings: ReportBooking[];
  motions: ReportMotion[];
  auditEntries: ReportAuditEntry[];
  /** What the association keeps, and until when. */
  retention: {
    daysAfterMoveOut: number;
    /** The latest purge date across this person's residencies. */
    purgeOn: string | null;
    onLegalHold: boolean;
  };
}
