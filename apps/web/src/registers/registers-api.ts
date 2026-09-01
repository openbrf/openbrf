import { apiRequest, type ApiResult } from "../api/client";

/**
 * The two statutory registers, as the browser sees them.
 *
 * Two sets of types and two sets of functions, with nothing shared between
 * them. That is the point: the member register extract is public on request and
 * never carries a personal identity number, while the apartment register is
 * confidential and carries one by statute. A shared type would be one place
 * where the wrong field could reach the wrong document.
 *
 * These mirror `apps/api/src/registers/*.service.ts`. They are declared here
 * rather than imported from a shared package for the same reason the address
 * book's are: neither app depends on `@openbrf/shared` yet.
 */

export interface RegisterHousingCooperative {
  name: string;
  organizationNumber: string | null;
}

// --- The member register (medlemsforteckning, EFL 5 kap.) -------------------

export type MemberRegisterScope = "current" | "all";

export type RegisterPostalAddress =
  | {
      state: "visible";
      street: string | null;
      postalCode: string | null;
      city: string | null;
    }
  | { state: "masked"; alternativePostalAddress: string | null };

export interface MemberRegisterApartment {
  id: string;
  number: string;
  addressLabel: string;
}

export interface MemberRegisterRow {
  key: string;
  personId: string;
  name: string;
  postalAddress: RegisterPostalAddress;
  protectedPersonalData: boolean;
  enteredOn: string | null;
  exitedOn: string | null;
  apartments: MemberRegisterApartment[];
}

export interface MemberRegisterExtract {
  housingCooperative: RegisterHousingCooperative;
  scope: MemberRegisterScope;
  generatedOn: string;
  rows: MemberRegisterRow[];
}

export function fetchMemberRegister(
  scope: MemberRegisterScope,
): Promise<ApiResult<MemberRegisterExtract>> {
  return apiRequest(
    "GET",
    `/api/member-register?scope=${encodeURIComponent(scope)}`,
  );
}

// --- The apartment register (lagenhetsforteckning, BRL 9 kap.) --------------

export type RegisterIdentityNumber =
  | { state: "masked"; hasValue: boolean }
  | { state: "visible"; value: string | null };

export interface ApartmentRegisterHolder {
  personId: string;
  name: string;
  protectedPersonalData: boolean;
  personalIdentityNumber: RegisterIdentityNumber;
  heldFrom: string;
  heldUntil: string | null;
}

export interface ApartmentRegisterLien {
  id: string;
  creditor: string;
  notedOn: string;
  releasedOn: string | null;
  amount: string | null;
}

export interface ApartmentRegisterTransfer {
  id: string;
  transferredOn: string;
  /**
   * The day the association decided on the acquirer's membership, or null.
   *
   * The day the cooperative housing register's two-week reporting window opens
   * for this transfer (Lag (2026:484) 3 kap. 3 §). Null means no such decision
   * was recorded - which the statute provides for, since a transfer to a
   * sitting member has none - so the screen offers to record one and never
   * asserts that a deadline has been missed.
   */
  membershipDecidedOn: string | null;
  fromName: string | null;
  toName: string;
  price: string | null;
  agreementReference: string | null;
}

/**
 * On which ground a tenant-ownership ceased.
 *
 * Mirrors the TerminationKind enum in `apps/api/prisma/schema.prisma`: a
 * general meeting deciding that one held by the association should cease
 * (BRL 6 kap. 11 §), or the building being transferred or sold executively
 * (BRL 7 kap. 33 §).
 */
export type TerminationKind =
  "GENERAL_MEETING_DECISION" | "BUILDING_TRANSFERRED";

export interface ApartmentRegisterTermination {
  id: string;
  kind: TerminationKind;
  tookEffectOn: string;
  reference: string;
}

export interface ApartmentRegisterRow {
  apartmentId: string;
  designation: string;
  number: string;
  addressLabel: string;
  initialShareCapital: string | null;
  participationShare: string | null;
  holders: ApartmentRegisterHolder[];
  liens: ApartmentRegisterLien[];
  transfers: ApartmentRegisterTransfer[];
  terminations: ApartmentRegisterTermination[];
}

/**
 * The association as the apartment register names it.
 *
 * One field more than the member register's, and the extra field is why this is
 * a separate type rather than the shared one widened. The property designation
 * is apartment register content - it names the property the apartments are in -
 * and the member register extract is public on request, so nothing on it should
 * grow by accident.
 */
export interface ApartmentRegisterHousingCooperative extends RegisterHousingCooperative {
  propertyDesignation: string | null;
}

export interface ApartmentRegisterExtract {
  housingCooperative: ApartmentRegisterHousingCooperative;
  generatedOn: string;
  identityNumbersIncluded: boolean;
  audience: "board" | "holder";
  rows: ApartmentRegisterRow[];
}

export function fetchApartmentRegister(): Promise<
  ApiResult<ApartmentRegisterExtract>
> {
  return apiRequest("GET", "/api/apartment-register");
}

/**
 * The full statutory extract, personal identity numbers included.
 *
 * A POST although it reads: it writes an audit entry naming everyone whose
 * number the copy disclosed, and those numbers must not travel in a URL.
 */
export function revealApartmentRegister(): Promise<
  ApiResult<ApartmentRegisterExtract>
> {
  return apiRequest("POST", "/api/apartment-register/reveal", {});
}

/** A tenant-owner's own entry, and only theirs. */
export function fetchOwnApartmentRegister(): Promise<
  ApiResult<ApartmentRegisterExtract>
> {
  return apiRequest("GET", "/api/apartment-register/mine");
}

export function revealOwnApartmentRegister(): Promise<
  ApiResult<ApartmentRegisterExtract>
> {
  return apiRequest("POST", "/api/apartment-register/mine/reveal", {});
}

export function noteLien(input: {
  apartmentId: string;
  creditor: string;
  notedOn: string;
  amount?: string | null;
}): Promise<ApiResult<ApartmentRegisterLien>> {
  return apiRequest("POST", "/api/apartment-register/liens", input);
}

export function releaseLien(input: {
  lienId: string;
  releasedOn: string;
}): Promise<ApiResult<ApartmentRegisterLien>> {
  return apiRequest("POST", "/api/apartment-register/liens/release", input);
}

/**
 * Records that a tenant-ownership has ceased (upphorande).
 *
 * The event the association reports to the cooperative housing register within
 * two weeks of the day it ceased (Lag (2026:484) 3 kap. 4 §).
 */
export function recordTermination(input: {
  apartmentId: string;
  kind: TerminationKind;
  tookEffectOn: string;
  reference: string;
}): Promise<ApiResult<ApartmentRegisterTermination>> {
  return apiRequest("POST", "/api/apartment-register/terminations", input);
}

/** Records the day the association decided on an acquirer's membership. */
export function recordMembershipDecision(input: {
  transferId: string;
  membershipDecidedOn: string;
}): Promise<ApiResult<ApartmentRegisterTransfer>> {
  return apiRequest(
    "POST",
    "/api/apartment-register/membership-decision",
    input,
  );
}

/** Records the association's authoritative property designation. */
export function recordPropertyDesignation(input: {
  propertyDesignation: string | null;
}): Promise<ApiResult<{ propertyDesignation: string | null }>> {
  return apiRequest(
    "POST",
    "/api/apartment-register/property-designation",
    input,
  );
}
