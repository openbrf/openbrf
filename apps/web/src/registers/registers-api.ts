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
  fromName: string | null;
  toName: string;
  price: string | null;
  agreementReference: string | null;
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
}

export interface ApartmentRegisterExtract {
  housingCooperative: RegisterHousingCooperative;
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
