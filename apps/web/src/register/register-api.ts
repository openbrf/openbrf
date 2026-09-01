/**
 * The address book's HTTP contract, as the browser sees it.
 *
 * These types mirror `apps/api/src/address-book/address-book-view.ts`,
 * `address-book.service.ts` and `publication-consent.ts`. They are declared
 * here rather than imported, because a server type reaching the browser would
 * carry the shape of a query along with the shape of the answer: the wire
 * contract is what the two sides agree on, and it is written out on each side
 * so a change to either is visible as a change.
 *
 * One property of the contract is load-bearing and worth stating here, because
 * it is invisible in the types on their own: the resident-facing row has no
 * `contact` field at all. A resident does not receive masked contact data, or
 * empty contact data - the field does not exist in their response. Nothing on
 * this side may invent one.
 */

/** A sign on a row (skylt-chip). The label is an i18n key, never the API's. */
export type RegisterSign =
  | "CHAIR"
  | "BOARD_MEMBER"
  | "DEPUTY_BOARD_MEMBER"
  | "MEMBER"
  | "RESIDENT"
  | "PROTECTED"
  | "MOVED_OUT";

/** The two grants that are not tied to a residency or a seat. */
export type SystemRole = "ADMIN" | "PROPERTY_MANAGER";

/** The positions of trust the register knows, in seniority order. */
export type BoardPositionType =
  "CHAIR" | "BOARD_MEMBER" | "DEPUTY_BOARD_MEMBER";

export const BOARD_POSITION_TYPES: readonly BoardPositionType[] = [
  "CHAIR",
  "BOARD_MEMBER",
  "DEPUTY_BOARD_MEMBER",
];

/**
 * One term on the board, as the person payload carries it.
 *
 * The seat's own id travels because a person can hold the same position twice -
 * elected, stood down, elected again - so the position is not a name for either
 * row, and a screen ending a term has to say which one.
 */
export interface PersonBoardPosition {
  boardPositionId: string;
  position: BoardPositionType;
  electedOn: string | null;
  endedOn: string | null;
}

/** One term, as the endpoint that writes it answers. */
export interface BoardPositionView {
  boardPositionId: string;
  personId: string;
  position: BoardPositionType;
  electedOn: string;
  endedOn: string | null;
}

/** Every system role one person holds, after a grant or a revoke. */
export interface SystemRoleGrants {
  personId: string;
  roles: SystemRole[];
}

export type RegisterFilter =
  "all" | "members" | "residents" | "board" | "movedOut";

export const REGISTER_FILTERS: readonly RegisterFilter[] = [
  "all",
  "members",
  "residents",
  "board",
  "movedOut",
];

export interface RegisterApartment {
  id: string;
  addressId: string;
  number: string;
  floor: number | null;
}

export type RegisterContact =
  | { state: "visible"; email: string | null; phone: string | null }
  | { state: "masked"; hasEmail: boolean; hasPhone: boolean };

/** Common to both audiences. */
export interface DirectoryRow {
  key: string;
  personId: string;
  name: string;
  apartment: RegisterApartment | null;
  signs: RegisterSign[];
  movedInOn: string | null;
  movedOutOn: string | null;
}

/** The board's row: contact data, masked where the person is protected. */
export interface BoardRow extends DirectoryRow {
  contact: RegisterContact;
  purgeOn: string | null;
  protectedPersonalData: boolean;
}

export interface RegisterAddress {
  id: string;
  street: string;
  number: string;
  postalCode: string;
  city: string;
  apartments: number;
}

export interface RegisterPage<TRow> {
  rows: TRow[];
  addresses: RegisterAddress[];
  counts: Record<RegisterFilter, number>;
  total: number;
  page: number;
  pageSize: number;
  stats: { apartments: number; persons: number; members: number };
  generatedOn: string;
}

export type MaskableField =
  "email" | "phone" | "personalIdentityNumber" | "postalAddress";

export type MaskedPostalAddress =
  | {
      state: "visible";
      street: string | null;
      postalCode: string | null;
      city: string | null;
    }
  | { state: "masked"; alternativePostalAddress: string | null };

export interface PersonResidency {
  residencyId: string;
  apartmentId: string;
  apartmentNumber: string;
  addressId: string;
  addressLabel: string;
  role: "MEMBER" | "RESIDENT";
  movedInOn: string | null;
  movedOutOn: string | null;
  purgeOn: string | null;
}

/**
 * What a person may appear as on something the association publishes
 * (publiceringssamtycke). One consent covers one of these and no more.
 */
export type ConsentScope = "PHOTO" | "NAME_ON_SITE" | "BOARD_ROSTER";

export const CONSENT_SCOPES: readonly ConsentScope[] = [
  "PHOTO",
  "NAME_ON_SITE",
  "BOARD_ROSTER",
];

/**
 * Where one scope stands, with the dates that say when.
 *
 * Three states, not two: "never" says the board has a conversation to have,
 * "withdrawn" says it has had one and got an answer it has to honour.
 */
export interface PublicationConsent {
  scope: ConsentScope;
  state: "granted" | "withdrawn" | "never";
  grantedOn: string | null;
  withdrawnOn: string | null;
  note: string | null;
}

/**
 * A legal hold (rattsligt bevarandekrav) on one person's service data.
 *
 * Mirrors `apps/api/src/retention/legal-hold.service.ts`. Released rather than
 * deleted, so a hold that has been lifted still carries the dates it stood
 * between - which is what explains a gap in the erasure record.
 */
export interface LegalHold {
  holdId: string;
  reason: string;
  /** ISO instant: a hold is placed at a moment, not on a calendar day. */
  placedAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  placedByPersonId: string | null;
  releasedByPersonId: string | null;
}

export interface ReportPostalAddress {
  street: string | null;
  postalCode: string | null;
  city: string | null;
}

/**
 * On which ground a tenant-ownership ceased.
 *
 * Mirrors the TerminationKind enum in `apps/api/prisma/schema.prisma`. Spelled
 * out for the reason the audit actions below are: the report prints this to the
 * person it is about, so a value added on the API side has to be a build
 * failure here rather than an enum name on a statutory document.
 */
export type TerminationKind =
  "GENERAL_MEETING_DECISION" | "BUILDING_TRANSFERRED";

/**
 * Which register event a reporting obligation is about.
 *
 * Mirrors the RegisterReportKind enum in `apps/api/prisma/schema.prisma`,
 * spelled out for the reason the one above it is: the report prints this to the
 * person it is about.
 */
export type RegisterReportKind = "TRANSFER" | "TERMINATION";

/**
 * Every audit action an entry on the report can carry.
 *
 * Mirrors the AuditAction enum in `apps/api/prisma/schema.prisma`. Spelled out
 * rather than left as `string` because the report prints this column to the
 * person it is about: a total map from action to label is what makes an action
 * added on the API side a build failure here, instead of a system enum printed
 * onto a document in a language nobody asked for.
 */
export type ReportAuditAction =
  | "PROTECTED_DATA_REVEALED"
  | "PROTECTED_FLAG_CHANGED"
  | "MEMBER_REGISTER_EXTRACT_GENERATED"
  | "APARTMENT_REGISTER_EXTRACT_GENERATED"
  | "APARTMENT_REGISTER_LIEN_NOTED"
  | "APARTMENT_REGISTER_LIEN_RELEASED"
  | "APARTMENT_REGISTER_TERMINATION_RECORDED"
  | "APARTMENT_REGISTER_MEMBERSHIP_DECISION_RECORDED"
  | "ASSOCIATION_PROPERTY_DESIGNATION_RECORDED"
  | "DATA_EXPORTED"
  | "SYSTEM_ROLE_GRANTED"
  | "SYSTEM_ROLE_REVOKED"
  | "PLUGIN_INSTALLED"
  | "PLUGIN_REMOVED"
  | "THEME_INSTALLED"
  | "THEME_ACTIVATED"
  | "THEME_COMPOSED"
  | "MEDIA_UPLOADED"
  | "MEDIA_DELETED"
  | "MEDIA_ACCESSED"
  | "INVITATION_SENT"
  | "INVITATION_ACCEPTED"
  | "SIGNUP_REQUEST_APPROVED"
  | "SIGNUP_REQUEST_REJECTED"
  | "CONSENT_RECORDED"
  | "CONSENT_WITHDRAWN"
  | "PAGE_PUBLISHED"
  | "PAGE_VISIBILITY_CHANGED"
  | "NEWS_PUBLISHED"
  | "NEWS_EMAILED"
  | "NEWS_TEXTED"
  | "NEWS_COMMENT_POSTED"
  | "NEWS_COMMENT_HIDDEN"
  | "LEGAL_HOLD_PLACED"
  | "LEGAL_HOLD_RELEASED"
  | "SERVICE_DATA_PURGED"
  | "BOARD_POSITION_ELECTED"
  | "BOARD_POSITION_ENDED"
  | "BOOKING_RESOURCE_CREATED"
  | "BOOKING_RESOURCE_UPDATED"
  | "BOOKING_RESOURCE_DEACTIVATED"
  | "BOOKING_MADE"
  | "BOOKING_CANCELLED"
  | "EVENT_SERIES_CREATED"
  | "EVENT_SERIES_UPDATED"
  | "EVENT_SERIES_PUBLISHED"
  | "EVENT_OCCURRENCE_CANCELLED"
  | "EVENT_OCCURRENCE_REINSTATED"
  | "MOTION_SUBMITTED"
  | "MOTION_ACKNOWLEDGED"
  | "MOTION_WITHDRAWN"
  | "EVENT_SIGNUP_MADE"
  | "EVENT_SIGNUP_WITHDRAWN"
  | "REGISTER_REPORT_OBLIGATION_RECORDED";

/**
 * The data subject access report (registerutdrag, GDPR art. 15), as the
 * browser sees it.
 *
 * Mirrors `apps/api/src/retention/data-subject-report.ts`, section for section.
 * The list is the point rather than the convenience: the report is the
 * association's answer to "what do you hold about me", and a section missing
 * from this type is a section the document silently does not print.
 */
export interface DataSubjectReport {
  /** ISO date the report was produced, for the document stamp. */
  generatedOn: string;
  housingCooperative: { name: string; organizationNumber: string | null };
  person: {
    personId: string;
    firstName: string;
    lastName: string;
    postalAddress: ReportPostalAddress;
    alternativePostalAddress: string | null;
    email: string | null;
    phone: string | null;
    /** Decrypted here and on no other payload in the product. */
    personalIdentityNumber: string | null;
    protectedPersonalData: boolean;
    preferredLocale: string;
    recordedAt: string;
  };
  residencies: {
    residencyId: string;
    apartmentNumber: string;
    addressLabel: string;
    role: "MEMBER" | "RESIDENT";
    movedInOn: string | null;
    movedOutOn: string | null;
    purgeOn: string | null;
  }[];
  boardPositions: {
    position: "CHAIR" | "BOARD_MEMBER" | "DEPUTY_BOARD_MEMBER";
    electedOn: string | null;
    endedOn: string | null;
  }[];
  systemRoles: ("ADMIN" | "PROPERTY_MANAGER")[];
  account: {
    email: string;
    twoFactorEnabled: boolean;
    createdAt: string;
  } | null;
  memberRegisterEntries: {
    entryId: string;
    eventType: "ENTRY" | "EXIT" | "CORRECTION";
    eventOn: string;
    apartment: string | null;
    recordedName: string;
    recordedPostalAddress: ReportPostalAddress;
    note: string | null;
  }[];
  transfers: {
    transferId: string;
    apartment: string;
    direction: "acquired" | "relinquished";
    transferredOn: string;
    /** The day the association decided on the acquirer's membership, or null. */
    membershipDecidedOn: string | null;
    price: string | null;
    agreementReference: string | null;
  }[];
  /**
   * Tenant-ownerships this person held that have ceased to exist.
   *
   * Not keyed on a person column: a termination names an apartment and a date,
   * so the API derives whose it is from the member register, on a boundary rule
   * of its own. See `apps/api/src/retention/holding-periods.ts`.
   */
  terminations: {
    terminationId: string;
    apartment: string;
    kind: TerminationKind;
    tookEffectOn: string;
    reference: string;
  }[];
  /**
   * Lien notes that stood against a tenant-ownership this person held.
   *
   * Not keyed on a person column either: a lien note names an apartment and a
   * creditor and never a person, so the API derives whose it is from the member
   * register. See `apps/api/src/retention/holding-periods.ts`.
   */
  lienNotes: {
    lienNoteId: string;
    apartment: string;
    creditor: string;
    amount: string | null;
    notedOn: string;
    releasedOn: string | null;
  }[];
  /**
   * Duties to report one of this person's register events to the cooperative
   * housing register.
   *
   * Keyed on neither a person nor an apartment but on the register event, so the
   * API reaches these through the transfers and terminations above rather than
   * through a derivation of its own - and a transfer's duty reaches the acquirer
   * alone, because the due date less fourteen days is the membership decision
   * date the transfer section withholds from the seller.
   */
  registerReportObligations: {
    obligationId: string;
    kind: RegisterReportKind;
    apartment: string;
    triggeredOn: string;
    dueOn: string;
  }[];
  publicationConsents: {
    scope: ConsentScope;
    grantedOn: string;
    withdrawnOn: string | null;
    note: string | null;
  }[];
  legalHolds: {
    holdId: string;
    reason: string;
    placedAt: string;
    releasedAt: string | null;
    releaseReason: string | null;
  }[];
  issues: {
    issueId: string;
    typeName: string;
    status: "NEW" | "IN_PROGRESS" | "DONE";
    location: string | null;
    description: string;
    reportedAt: string;
    photographs: number;
  }[];
  documents: {
    documentId: string;
    title: string;
    category: string;
    audience: "BOARD" | "MEMBER" | "PUBLIC";
    filedAt: string;
  }[];
  /**
   * Bookings this person made.
   *
   * One of the four sections that state a retention date per row: a booking is
   * purged a year after the booked period ended, on its own clock rather than
   * the residency one, so the date at the foot of the document does not govern
   * it.
   *
   * `erasableFrom` is the earliest date the purge can reach the row, not a
   * promise that it will. A legal hold suspends every purge for the person it
   * stands against, and whether one does is what `retention.onLegalHold`
   * answers.
   */
  bookings: {
    bookingId: string;
    resourceName: string;
    status: "BOOKED" | "CANCELLED" | "RELEASED";
    startsAt: string;
    endsAt: string;
    apartment: string | null;
    erasableFrom: string | null;
  }[];

  /**
   * Motions this person put to the general meeting.
   *
   * The second of those four: a motion is purged two years after it was closed,
   * on its own clock rather than the residency one.
   *
   * A motion still with the board states none, and that absence is information
   * rather than a gap: it has no closing date to count from, and the association
   * is still processing it, so the purpose it is held for has not ended.
   */
  motions: {
    motionId: string;
    title: string;
    body: string;
    status: "SUBMITTED" | "ACKNOWLEDGED" | "WITHDRAWN";
    submittedAt: string;
    closedAt: string | null;
    erasableFrom: string | null;
  }[];
  /**
   * Sign-ups (anmalan) this person made to dates in the association's calendar,
   * the ones they stood down from included.
   *
   * The third of those four: a sign-up is purged a year after the date it was
   * for ended. `withdrawnOn` is what makes a withdrawal readable as one - a
   * report listing only the standing sign-ups would be silent about a row the
   * association is still holding.
   *
   * `on` is the local date the event falls on, stated by the server on the
   * association's own clock rather than derived here from the instant, so a
   * document printed abroad names the same day as the notice in the stairwell.
   */
  eventSignups: {
    signupId: string;
    eventTitle: string;
    startsAt: string;
    endsAt: string;
    on: string;
    signedUpAt: string;
    withdrawnOn: string | null;
    calledOff: boolean;
    erasableFrom: string | null;
  }[];
  /**
   * Comments this person wrote under the association's news.
   *
   * The body in full, whether or not the comment is hidden: what somebody wrote
   * is the personal data this section is about, and a report naming a date and a
   * news item without the sentence would tell its subject that they commented
   * without telling them what they said. `hidden` says the board struck it
   * through.
   *
   * The fourth of those four states its date here too: `erasableFrom` is the
   * earliest date the purge can reach the row, on the same terms as the bookings
   * above - a comment goes a year after it was written, and a legal hold defers
   * that date without ever advancing it.
   */
  newsComments: {
    commentId: string;
    newsTitle: string;
    newsSlug: string;
    body: string;
    hidden: boolean;
    writtenAt: string;
    erasableFrom: string | null;
  }[];
  auditEntries: {
    entryId: string;
    role: "subject" | "actor";
    action: ReportAuditAction;
    at: string;
    targetKind: string | null;
    targetId: string | null;
    /** Field names, identifiers and counts. Never a value. */
    context: Record<string, unknown> | null;
  }[];
  retention: {
    daysAfterMoveOut: number;
    purgeOn: string | null;
    onLegalHold: boolean;
  };
}

export interface PersonDetail {
  personId: string;
  firstName: string;
  lastName: string;
  postalAddress: MaskedPostalAddress;
  contact: RegisterContact;
  hasPersonalIdentityNumber: boolean;
  protectedPersonalData: boolean;
  preferredLocale: string;
  isMember: boolean;
  residencies: PersonResidency[];
  boardPositions: PersonBoardPosition[];
  systemRoles: SystemRole[];
  account: {
    state: "active" | "invited" | "none";
    twoFactorEnabled: boolean;
    invitationExpiresAt: string | null;
  };
  /**
   * One entry per scope, always. The board's payload carries this and the
   * resident-facing one has no person view at all, which is what keeps a
   * consent a board instrument.
   */
  publicationConsents: PublicationConsent[];
  /**
   * The hold that stands today, or null.
   *
   * Beside the purge date on each residency on purpose: the date is what the
   * retention policy promises, and the hold is the reason it is not going to
   * happen.
   */
  legalHold: LegalHold | null;
}

export interface RevealedFields {
  email?: string | null;
  phone?: string | null;
  personalIdentityNumber?: string | null;
  postalAddress?: {
    street: string | null;
    postalCode: string | null;
    city: string | null;
  } | null;
}

export interface ApartmentResidency {
  residencyId: string;
  personId: string;
  name: string;
  protectedPersonalData: boolean;
  role: "MEMBER" | "RESIDENT" | null;
  movedInOn: string | null;
  movedOutOn: string | null;
}

export interface ApartmentDetail {
  id: string;
  number: string;
  floor: number | null;
  participationShare: string | null;
  address: {
    id: string;
    street: string;
    number: string;
    postalCode: string;
    city: string;
  };
  residents: ApartmentResidency[];
  history: ApartmentResidency[];
}

export interface CreatePersonInput {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  postalStreet?: string;
  postalCode?: string;
  postalCity?: string;
  protectedPersonalData?: boolean;
}

/**
 * A request that failed for a reason the interface should name.
 *
 * The API answers with a machine-readable `reason`, so the screen can choose its
 * own wording rather than displaying server prose - which would be in the wrong
 * language and untranslatable.
 */
export class RegisterRequestError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
  ) {
    super(`Register request failed with ${String(status)}`);
    this.name = "RegisterRequestError";
  }
}

/**
 * One request.
 *
 * Deliberately narrower than RequestInit: a JSON body and an abort signal are
 * all this client sends, and the narrower type is what lets the content type be
 * set from the presence of a body rather than merged with whatever a caller
 * passed.
 */
interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  /** Already serialised JSON. */
  body?: string;
  signal?: AbortSignal;
}

async function request<T>(path: string, options?: RequestOptions): Promise<T> {
  const response = await fetch(path, {
    method: options?.method ?? "GET",
    body: options?.body,
    signal: options?.signal,
    headers:
      options?.body === undefined
        ? undefined
        : { "content-type": "application/json" },
    // Sessions are http-only cookies on the same origin.
    credentials: "same-origin",
  });

  if (!response.ok) {
    let reason: string | null = null;
    try {
      const body = (await response.json()) as { reason?: string };
      reason = body.reason ?? null;
    } catch {
      // A non-JSON error body carries nothing the interface can use.
      reason = null;
    }
    throw new RegisterRequestError(response.status, reason);
  }

  return (await response.json()) as T;
}

export interface RegisterQuery {
  addressId?: string;
  filter: RegisterFilter;
  search?: string;
  page: number;
}

function queryString(query: RegisterQuery): string {
  const params = new URLSearchParams();
  if (query.addressId !== undefined) {
    params.set("addressId", query.addressId);
  }
  params.set("filter", query.filter);
  if (query.search !== undefined && query.search.trim() !== "") {
    params.set("search", query.search.trim());
  }
  params.set("page", String(query.page));
  return params.toString();
}

export function fetchBoardRegister(
  query: RegisterQuery,
  signal: AbortSignal,
): Promise<RegisterPage<BoardRow>> {
  return request(`/api/address-book?${queryString(query)}`, { signal });
}

export function fetchResidentDirectory(
  query: RegisterQuery,
  signal: AbortSignal,
): Promise<RegisterPage<DirectoryRow>> {
  return request(`/api/resident-directory?${queryString(query)}`, { signal });
}

export function fetchPerson(
  personId: string,
  signal: AbortSignal,
): Promise<PersonDetail> {
  return request(`/api/address-book/persons/${encodeURIComponent(personId)}`, {
    signal,
  });
}

export function fetchApartment(
  apartmentId: string,
  signal: AbortSignal,
): Promise<ApartmentDetail> {
  return request(
    `/api/address-book/apartments/${encodeURIComponent(apartmentId)}`,
    { signal },
  );
}

/**
 * Reveals masked fields on one person.
 *
 * Every call writes an audit entry naming the caller and the fields, so this is
 * never fired speculatively or on hover: only in response to a deliberate
 * action.
 */
export function revealFields(
  personId: string,
  fields: readonly MaskableField[],
): Promise<RevealedFields> {
  return request(
    `/api/address-book/persons/${encodeURIComponent(personId)}/reveal`,
    { method: "POST", body: JSON.stringify({ fields }) },
  );
}

export function createPerson(
  input: CreatePersonInput,
): Promise<{ personId: string }> {
  return request("/api/address-book/persons", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Invites a person to activate an account, and re-invites one already invited.
 *
 * The same endpoint does both: the API deletes any outstanding invitation for
 * the person and mails a fresh link, so the previous one stops working. That is
 * what makes "send again" safe to offer for an invitation that has not expired
 * yet - a lost email is the ordinary case, and the board has nothing else to
 * offer the person waiting for it.
 */
export function sendInvitation(
  personId: string,
): Promise<{ expiresAt: string }> {
  return request("/api/invitations", {
    method: "POST",
    body: JSON.stringify({ personId }),
  });
}

/**
 * Records or withdraws one publication consent.
 *
 * The board writes down what the person told them, so this is not the person
 * consenting: it is the record of a conversation that happened elsewhere. A
 * withdrawal closes the standing consent with a date and leaves it on file.
 */
export function setPublicationConsent(
  personId: string,
  scope: ConsentScope,
  granted: boolean,
): Promise<PublicationConsent> {
  return request(
    `/api/address-book/persons/${encodeURIComponent(
      personId,
    )}/publication-consent`,
    { method: "PATCH", body: JSON.stringify({ scope, granted }) },
  );
}

/**
 * Records an election to a position of trust.
 *
 * The date is the day the general meeting elected them, not today: the row is
 * written afterwards from the minutes, and a register that stamped the day
 * somebody got round to typing it in would record the typing.
 *
 * A person already holding the position is refused rather than merged. A
 * re-election is two acts - end the term, then record the new election - so the
 * register carries both periods with their own dates.
 */
export function electToBoardPosition(
  personId: string,
  position: BoardPositionType,
  electedOn: string,
): Promise<BoardPositionView> {
  return request(
    `/api/board-positions/persons/${encodeURIComponent(personId)}`,
    { method: "POST", body: JSON.stringify({ position, electedOn }) },
  );
}

/**
 * Ends a term, by writing the date it ended onto the seat.
 *
 * Never a delete. Who answered for the association between two dates is the
 * question a board seat exists to answer, and it survives the term.
 */
export function endBoardTerm(
  boardPositionId: string,
  endedOn: string,
): Promise<BoardPositionView> {
  return request(
    `/api/board-positions/${encodeURIComponent(boardPositionId)}/end`,
    { method: "POST", body: JSON.stringify({ endedOn }) },
  );
}

/**
 * Grants or revokes one system role.
 *
 * An administrator's endpoint, and only an administrator's: a board seat does
 * not reach it, which is what stops a seat from becoming a way to grant oneself
 * administrator rights. The last administrator cannot be revoked, including by
 * themselves, and the API answers that with `last-administrator`.
 */
export function setSystemRole(
  personId: string,
  role: SystemRole,
  granted: boolean,
): Promise<SystemRoleGrants> {
  return request(`/api/system-roles/persons/${encodeURIComponent(personId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role, granted }),
  });
}

export function setProtectedPersonalData(
  personId: string,
  protectedPersonalData: boolean,
): Promise<{ protectedPersonalData: boolean }> {
  return request(
    `/api/address-book/persons/${encodeURIComponent(
      personId,
    )}/protected-personal-data`,
    { method: "PATCH", body: JSON.stringify({ protectedPersonalData }) },
  );
}

/**
 * Places a legal hold, so the purge stops reaching this person's service data.
 *
 * The reason is required by the API as well as by the form: an exception to the
 * association's own retention promise that nobody wrote a reason for cannot be
 * reviewed by the board that inherits it.
 */
export function placeLegalHold(
  personId: string,
  reason: string,
): Promise<LegalHold> {
  return request(`/api/legal-holds/persons/${encodeURIComponent(personId)}`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/**
 * Releases the standing hold.
 *
 * Nothing is deleted and nothing is erased: the hold row keeps its dates, and
 * the person becomes reachable by the purge again, which runs in its own time.
 */
export function releaseLegalHold(
  personId: string,
  reason?: string,
): Promise<LegalHold> {
  return request(
    `/api/legal-holds/persons/${encodeURIComponent(personId)}/release`,
    {
      method: "POST",
      body: JSON.stringify(reason === undefined ? {} : { reason }),
    },
  );
}

/**
 * Produces the data subject access report (registerutdrag, GDPR art. 15).
 *
 * A POST although it reads, for the reason the reveal gives: it writes an audit
 * entry, and the answer carries a decrypted personal identity number that must
 * not sit in a URL, a proxy log or the browser's history. Never fired on a
 * render - only in answer to a deliberate action.
 */
export function fetchDataSubjectReport(
  personId: string,
  signal: AbortSignal,
): Promise<DataSubjectReport> {
  return request(
    `/api/data-subject-reports/persons/${encodeURIComponent(personId)}`,
    // An empty JSON body rather than none: the route takes no input, and a
    // POST with no content type at all is a shape the server framework treats
    // differently from an empty object.
    { method: "POST", body: "{}", signal },
  );
}
