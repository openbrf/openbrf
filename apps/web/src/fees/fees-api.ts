import { apiRequest, type ApiResult } from "../api/client";

/**
 * The fees the apartments pay, and the notices issued from them.
 *
 * The types are declared here and mirror `apps/api/src/fees/`, rather than
 * being imported from it: neither application depends on the other, and the
 * wire is the contract between them. A field added on the server and forgotten
 * here is a field the screen does not show, which is what a review catches; a
 * shared type would hide the wire instead of describing it.
 */

export type FeeKind = "ANNUAL_FEE" | "PARKING_SPACE" | "STORAGE_SPACE";

export type FeeVatTreatment = "EXEMPT" | "RATE";

export interface FeeRow {
  feeId: string;
  apartmentId: string;
  kind: FeeKind;
  appliesFrom: string;
  appliesUntil: string | null;
  /** Kronor per calendar month, as the decimal column holds it: "3450.50". */
  monthlyAmount: string;
  vatTreatment: FeeVatTreatment;
  vatRatePercent: number | null;
}

export interface FeeRegisterApartment {
  apartmentId: string;
  number: string;
  label: string;
  /** The andelstal as recorded. Used by the screen's aid and by nothing else. */
  participationShare: string | null;
  fees: FeeRow[];
  monthlyAmount: string;
}

export interface FeeRegister {
  housingCooperative: {
    name: string;
    organizationNumber: string | null;
    bankgiro: string | null;
    plusgiro: string | null;
  };
  on: string;
  apartments: FeeRegisterApartment[];
  monthlyTotal: string;
}

export interface FeeInput {
  apartmentId: string;
  kind: FeeKind;
  appliesFrom: string;
  monthlyAmount: string;
  vatTreatment: FeeVatTreatment;
  vatRatePercent?: number | null;
}

export interface FeeNotificationSummary {
  notificationId: string;
  from: string;
  to: string;
  dueOn: string;
  issuedOn: string;
  notices: number;
  total: string;
}

/** Who a notice names, or the statement that the names are withheld. */
export type FeeNoticeHolders =
  { state: "visible"; names: string[] } | { state: "withheld" };

export interface FeeNoticeRow {
  noticeId: string;
  apartment: string;
  apartmentNumber: string;
  holders: FeeNoticeHolders;
  amount: string;
  paymentReference: string;
}

export interface FeeNoticeDocument {
  housingCooperative: {
    name: string;
    organizationNumber: string | null;
    bankgiro: string | null;
    plusgiro: string | null;
  };
  notificationId: string;
  from: string;
  to: string;
  dueOn: string;
  issuedOn: string;
  generatedOn: string;
  rows: FeeNoticeRow[];
  total: string;
}

export interface FeeNoticeExport {
  document: FeeNoticeDocument;
  fileName: string;
  csv: string;
}

/** The fee register as it stands on a day. */
export function fetchFeeRegister(on: string): Promise<ApiResult<FeeRegister>> {
  return apiRequest("GET", `/api/fees?on=${encodeURIComponent(on)}`);
}

export function recordFee(input: FeeInput): Promise<ApiResult<FeeRow>> {
  return apiRequest("POST", "/api/fees", input);
}

export function removeFee(feeId: string): Promise<ApiResult<undefined>> {
  return apiRequest("DELETE", `/api/fees/${encodeURIComponent(feeId)}`);
}

export function fetchFeeNotifications(): Promise<
  ApiResult<FeeNotificationSummary[]>
> {
  return apiRequest("GET", "/api/fee-notifications");
}

export function issueFeeNotification(input: {
  from: string;
  to: string;
  dueOn: string;
}): Promise<ApiResult<FeeNotificationSummary>> {
  return apiRequest("POST", "/api/fee-notifications", input);
}

/**
 * Produces one run's document.
 *
 * A POST because it is an audited disclosure: named apartments' amounts leaving
 * the association is an act somebody chose to take, and not something a
 * prefetch, a bookmark or a link checker could cause.
 */
export function produceFeeNotices(
  notificationId: string,
): Promise<ApiResult<FeeNoticeExport>> {
  return apiRequest(
    "POST",
    `/api/fee-notifications/${encodeURIComponent(notificationId)}/document`,
    undefined,
  );
}
