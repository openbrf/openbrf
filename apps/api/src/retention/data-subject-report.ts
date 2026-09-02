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
   *
   * Null as well on a `relinquished` transfer, whoever asked. This section
   * carries both directions, so the seller's own report lists the transfer they
   * sold on; the decision on that transfer was about the person taking over,
   * and stating it would answer one person's art. 15 request with another's
   * personal data. The value is on the acquirer's own report, where it belongs.
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
 * One of the two sections of this report that are not keyed on a person column;
 * `ReportLienNote` below is the other. A termination names an apartment and a
 * date, never a person - BRL 7 kap. 33 § makes every tenant-ownership in a
 * disposed building cease at once, whoever holds them - so which of them are
 * this person's is derived from the member register. `terminationsDuringHolding`
 * in `holding-periods.ts` is the rule, and it closes both boundaries where the
 * lien rule beside it leaves both open, for reasons argued there.
 */
export interface ReportTermination {
  terminationId: string;
  apartment: string;
  /** Which ground in bostadsrattslagen the termination rests on. */
  kind: "GENERAL_MEETING_DECISION" | "BUILDING_TRANSFERRED";
  tookEffectOn: string;
  /** The minute, deed or enforcement decision the board recorded. */
  reference: string;
}

/**
 * A duty to report one of this person's register events to the cooperative
 * housing register (bostadsrattsregistret).
 *
 * Statutory tier and exempt from the purge, like the three sections above it.
 * Here for GDPR art. 15(1)(c) rather than for the dates, which the transfer and
 * termination sections already carry: the row is the association's only record
 * that this person's data is to go to a recipient outside it, and that article
 * gives the data subject the recipients "to whom the personal data have been or
 * will be disclosed".
 *
 * Not keyed on a person, like the termination and lien note sections, and reached
 * one step further out than either: an obligation names a register event, and
 * which events are this person's is already answered by those sections. A
 * termination's obligation follows the terminations `terminationsDuringHolding`
 * selected; a transfer's follows the transfers, and only where this person
 * acquired. On a relinquished transfer it is withheld, because `dueOn` less
 * fourteen days is the day the association decided on the acquirer's membership -
 * the value {@link ReportTransfer.membershipDecidedOn} withholds from the seller
 * for that same reason, and a report stating a deadline instead would disclose it
 * by subtraction.
 */
export interface ReportRegisterReportObligation {
  obligationId: string;
  /** Which register event the report is about. */
  kind: "TRANSFER" | "TERMINATION";
  apartment: string;
  /** The day the statutory two-week window opened. */
  triggeredOn: string;
  /** The day the report falls due: fourteen days after the day above. */
  dueOn: string;
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
 * A sign-up (anmalan) this person made to one date in the association's
 * calendar.
 *
 * Purged, like the bookings above and on the same reading: the purpose the row is
 * held for is running the date it names, so it is erased a year after that date
 * ended rather than on the residency clock. So each row states when that window
 * runs out.
 *
 * The withdrawn ones are here too, with the date they were withdrawn on. A report
 * that listed only the standing ones would be an incomplete answer: the
 * association is still holding a row saying this person had put their name down
 * and then stood down, and that row is what the section is for.
 *
 * The event is named because a person is entitled to know which of the
 * association's dates the association holds a record of them for; the date it
 * falls on is stated on the association's own clock rather than as a slice of an
 * instant, so a document produced abroad does not move it.
 */
export interface ReportEventSignup {
  signupId: string;
  /** What the board calls the event, read from the event itself. */
  eventTitle: string;
  /** ISO instants: the date signed up to. */
  startsAt: string;
  endsAt: string;
  /** "YYYY-MM-DD" on the association's own clock. */
  on: string;
  /** ISO instant the sign-up that stands now was made. */
  signedUpAt: string;
  /** ISO instant they stood down, or null while they are expected. */
  withdrawnOn: string | null;
  /** Whether the board has called that date off. */
  calledOff: boolean;
  /**
   * The earliest date the purge can reach this sign-up, derived from the
   * retention window and never stored.
   *
   * The earliest, and deliberately not "the date it is erased on", for the reason
   * the booking section gives: a legal hold suspends every purge for the person it
   * stands against, and `retention.onLegalHold` on this same report says whether
   * one does.
   */
  erasableFrom: string | null;
}

/**
 * A comment this person wrote on one of the association's news items.
 *
 * Purged, like the bookings above and on the same shape of clock: a comment is
 * erased a year after it was written, on its own window rather than the
 * residency one, so each row states when that runs out.
 *
 * The body is carried in full. Art. 15 asks for the personal data, and what
 * somebody wrote is the personal data here - a report naming a date and a news
 * item without the sentence would be telling its subject that they commented
 * without telling them what they said. It is carried whether or not the comment
 * is hidden, for the same reason: a person is entitled to read the words the
 * board struck through, and `hidden` is what says the board did.
 */
export interface ReportNewsComment {
  commentId: string;
  /** The news item it was written under, as the board titled it. */
  newsTitle: string;
  /** The item's address under /nyheter, which is how a reader would find it. */
  newsSlug: string;
  body: string;
  /**
   * Whether a moderator struck it through.
   *
   * A boolean rather than the date and whoever decided it. Both are in the audit
   * entry for the hide, which this same report carries; repeating the actor here
   * would put a board member's identifier on a document handed to the person
   * they moderated, in a section that is about what the person themselves wrote.
   */
  hidden: boolean;
  /** ISO instant it was written. */
  writtenAt: string;
  /**
   * The earliest date the purge can reach this comment, derived from the
   * retention window and never stored.
   *
   * The earliest, and deliberately not "the date it is erased on", for the
   * reason the booking above gives: a legal hold suspends every purge for the
   * person it stands against, and `retention.onLegalHold` on this same report is
   * what says whether one does.
   */
  erasableFrom: string | null;
}

/**
 * One general meeting (foreningsstamma) this person was recorded as present at,
 * and in what capacity.
 *
 * ## No erasure date, and why that is an answer rather than a gap
 *
 * Every other person-linked section whose module purges states the earliest day
 * the purge can reach its rows. This one states none, and neither does the
 * proxy authorisation below it, because nothing purges either: the voting
 * register (rostlangd) is taken into or appended to the protokoll (EFL 6 kap.
 * 39 §) and 40 § has the protokoll kept safely, so a line erased on a clock of
 * its own would take part of the association's minutes with it. That puts these
 * two with the statutory register sections rather than with the bookings and
 * the motions - kept because the law requires the record, and on the report
 * because exemption from erasure has never been exemption from access.
 *
 * ## The capacity is the substance
 *
 * "Present" is the smaller half of what this says about somebody. EFL 6 kap. 27
 * § has the list cover the members, proxy holders and assistants present, and
 * the three are different facts about a person: that they voted their own
 * share, that they carried somebody else's, or that they came with a member and
 * could speak but not vote (6 kap. 7 §). A section recording only attendance
 * would leave its subject unable to see which of those the association wrote
 * down about them.
 */
export interface ReportMeetingAttendance {
  attendanceId: string;
  /** "YYYY-MM-DD": the day the meeting was held. */
  meetingHeldOn: string;
  meetingKind: "ORDINARY" | "EXTRAORDINARY";
  capacity: "MEMBER" | "PROXY_HOLDER" | "ASSISTANT";
  mode: "IN_PERSON" | "REMOTE";
  /**
   * The member or proxy holder this person came with, where they came as an
   * assistant. Null in every other capacity.
   *
   * An identifier and never a name, which is the audit log's own choice for its
   * two person columns and rests on the same reading of GDPR art. 15(4): the
   * other person is a third party on a document the association hands over, and
   * naming them here would disclose that they were at the meeting to somebody
   * who asked about themselves. The association can say who it was on request.
   */
  onBehalfOfPersonId: string | null;
  /**
   * ISO instant the board struck the line off the list, or null while the person
   * stands on it.
   *
   * Carried rather than the line being left out, because "was recorded as present
   * and struck off again" is a different fact about somebody from never having
   * been recorded - and it is the fact a person would be asking about.
   */
  withdrawnAt: string | null;
}

/**
 * One proxy authorisation (fullmakt) naming this person, on
 * either side of it.
 *
 * ## Both roles, one section
 *
 * An authorisation names two people: the member whose voting right it is, and
 * the proxy holder authorised to exercise that right on their behalf. The right
 * is not transferred and the meeting's powers are not delegated - the member
 * remains the one who has the vote, and the authorisation says who may exercise
 * it in the room. Both are facts about the
 * person concerned, and they are different facts - "I authorised somebody to
 * exercise my vote" and "somebody authorised me to exercise theirs" - so `role`
 * says which side this row reached
 * the report from. That is the audit log's own pattern rather than a new one:
 * {@link ReportAuditEntry} carries the same discriminator over the log's two
 * person columns, for the same reason. A report answering for only one of the
 * two roles would leave a proxy holder unable to see that the association holds
 * a record of them having carried a neighbour's vote.
 *
 * States no erasure date, for the reason {@link ReportMeetingAttendance} gives.
 */
export interface ReportProxyAuthorisation {
  authorisationId: string;
  /** "YYYY-MM-DD": the day of the meeting the authority was for. */
  meetingHeldOn: string;
  meetingKind: "ORDINARY" | "EXTRAORDINARY";
  /**
   * Which side of the authorisation this person is on: the member who gave the
   * authority, or the proxy holder who held it.
   */
  role: "member" | "proxyHolder";
  /**
   * The other person named on it, as an identifier and never a name, for the
   * reason {@link ReportMeetingAttendance.onBehalfOfPersonId} gives.
   */
  counterpartPersonId: string;
  /**
   * What made the proxy holder eligible: another member, the member's spouse or
   * cohabitant, or a clause in the bylaws (BRL 9 kap. 14 § 4).
   *
   * Personal data about both of them: on the member's report it is the ground
   * they stated, and on the proxy holder's it is what the association recorded
   * about their relationship to the member.
   */
  ground: "MEMBER" | "SPOUSE_OR_COHABITANT" | "BYLAWS";
  /**
   * "YYYY-MM-DD": the day the member signed the proxy authorisation, as the
   * board read it off the paper. EFL 6 kap. 4 § holds an authority good for at
   * most a year from that day.
   */
  authorisedOn: string;
  /** ISO instant the authority was taken back, or null while it stands. */
  withdrawnAt: string | null;
}

/**
 * A lien note (pantnotering) that stood against a tenant-ownership this person
 * held.
 *
 * One of the two sections of this report that are not keyed on a person column;
 * `ReportTermination` above is the other. A lien note names an apartment and a
 * creditor, never a person, so which of them are this person's is derived from
 * the member register - see `holding-periods.ts` for the rule and for why it
 * errs towards leaving a note out.
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
  registerReportObligations: ReportRegisterReportObligation[];
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
  eventSignups: ReportEventSignup[];
  newsComments: ReportNewsComment[];
  meetingAttendances: ReportMeetingAttendance[];
  proxyAuthorisations: ReportProxyAuthorisation[];
  auditEntries: ReportAuditEntry[];
  /** What the association keeps, and until when. */
  retention: {
    daysAfterMoveOut: number;
    /** The latest purge date across this person's residencies. */
    purgeOn: string | null;
    onLegalHold: boolean;
  };
}
