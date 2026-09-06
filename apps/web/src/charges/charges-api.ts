import { apiRequest, type ApiResult } from "../api/client";

/**
 * Charges to members (debiteringar mot medlem), as the browser sees them.
 *
 * Mirrors `apps/api/src/charges/*`. Declared here rather than imported from a
 * shared package for the reason the register's types are: neither app depends on
 * `@openbrf/shared` yet.
 *
 * There is no paid field, no balance and no status on any of these shapes, and
 * the absence is the module rather than an omission: Open BRF holds the basis
 * for a charge and the accounting system holds the debt.
 */

/** An apartment on the list, or the statement that it is withheld. */
export type ChargeApartment =
  { state: "visible"; label: string | null } | { state: "masked" };

export type ChargedParty =
  | {
      kind: "person";
      personId: string;
      name: string;
      protectedPersonalData: boolean;
      apartment: ChargeApartment;
    }
  | {
      kind: "apartment";
      apartmentId: string | null;
      apartment: ChargeApartment;
    };

export type VatTreatment = "EXEMPT" | "RATE";

export const VAT_TREATMENTS: readonly VatTreatment[] = ["EXEMPT", "RATE"];

export interface ChargeRow {
  chargeId: string;
  chargedOn: string;
  chargedTo: ChargedParty;
  amount: string;
  vatTreatment: VatTreatment;
  vatRatePercent: number | null;
  reason: string;
  handedToManagerOn: string | null;
}

export interface DebitingList {
  housingCooperative: { name: string; organizationNumber: string | null };
  from: string;
  to: string;
  generatedOn: string;
  rows: ChargeRow[];
  total: string;
}

export interface DebitingListExport {
  list: DebitingList;
  fileName: string;
  csv: string;
}

export interface ChargeInput {
  personId: string | null;
  apartmentId: string | null;
  chargedOn: string;
  amount: string;
  reason: string;
  vatTreatment: VatTreatment;
  vatRatePercent: number | null;
  handedToManagerOn: string | null;
}

/** What a correction may move. The charged party is deliberately not on it. */
export interface ChargeCorrection {
  chargedOn?: string;
  amount?: string;
  reason?: string;
  vatTreatment?: VatTreatment;
  vatRatePercent?: number | null;
  handedToManagerOn?: string | null;
}

function period(from: string, to: string): string {
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

export function fetchDebitingList(
  from: string,
  to: string,
): Promise<ApiResult<DebitingList>> {
  return apiRequest("GET", `/api/member-charges?${period(from, to)}`);
}

export function recordCharge(
  input: ChargeInput,
): Promise<ApiResult<ChargeRow>> {
  return apiRequest("POST", "/api/member-charges", input);
}

export function correctCharge(
  chargeId: string,
  input: ChargeCorrection,
): Promise<ApiResult<ChargeRow>> {
  return apiRequest(
    "POST",
    `/api/member-charges/${encodeURIComponent(chargeId)}/correct`,
    input,
  );
}

export function removeCharge(chargeId: string): Promise<ApiResult<undefined>> {
  return apiRequest(
    "DELETE",
    `/api/member-charges/${encodeURIComponent(chargeId)}`,
  );
}

/**
 * Produces the file.
 *
 * A POST, because producing it writes the audit entry that records the
 * disclosure. The server makes the same choice for the register supply and for
 * the same reason: an audited disclosure has to be an act somebody chose to
 * take, and a GET is something a prefetch or a link checker can do on its own.
 */
export function exportDebitingList(
  from: string,
  to: string,
): Promise<ApiResult<DebitingListExport>> {
  return apiRequest(
    "POST",
    `/api/member-charges/export?${period(from, to)}`,
    undefined,
  );
}
