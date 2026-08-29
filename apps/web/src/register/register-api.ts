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
  boardPositions: {
    position: "CHAIR" | "BOARD_MEMBER" | "DEPUTY_BOARD_MEMBER";
    electedOn: string | null;
    endedOn: string | null;
  }[];
  systemRoles: ("ADMIN" | "PROPERTY_MANAGER")[];
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
