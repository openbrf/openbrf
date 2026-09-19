import { apiRequest, type ApiResult } from "../api/client";

/**
 * The accounting basis: a period's fee notices and member charges in one file.
 *
 * The types are declared here and mirror `apps/api/src/accounting/`, rather
 * than being imported from it: neither application depends on the other, and
 * the wire is the contract between them. A field added on the server and
 * forgotten here is a field the screen does not show, which is what a review
 * catches; a shared type would hide the wire instead of describing it.
 */

export type AccountingBasisRowKind = "FEE_NOTICE" | "MEMBER_CHARGE";

/** The apartment on a row, or the statement that it is withheld. */
export type AccountingBasisApartment =
  { state: "visible"; label: string | null } | { state: "withheld" };

export interface AccountingBasisRow {
  kind: AccountingBasisRowKind;
  rowId: string;
  /** The period the row covers. A charge states its own day at both ends. */
  from: string;
  to: string;
  apartment: AccountingBasisApartment;
  /** The person charged. Null on a fee row, which names nobody. */
  name: string | null;
  /** Kronor, as the decimal column holds it: "3450.50". */
  amount: string;
  /** Null on a fee row, where the notice holds no treatment of its own. */
  vatTreatment: "EXEMPT" | "RATE" | null;
  vatRatePercent: number | null;
  reason: string | null;
  paymentReference: string | null;
}

export interface AccountingBasis {
  housingCooperative: { name: string; organizationNumber: string | null };
  from: string;
  to: string;
  generatedOn: string;
  rows: AccountingBasisRow[];
  /** The two halves apart, because they are posted to different accounts. */
  feeTotal: string;
  chargeTotal: string;
  total: string;
}

export interface AccountingBasisExport {
  basis: AccountingBasis;
  fileName: string;
  csv: string;
}

/**
 * Produces the period's basis.
 *
 * A POST because it is an audited disclosure: both halves of named apartments'
 * and named people's money leaving the association is an act somebody chose to
 * take, and not something a prefetch, a bookmark or a link checker could cause.
 * The period travels in the query, so this and the debiting list export are
 * asked the same question in the same words.
 */
export function exportAccountingBasis(period: {
  from: string;
  to: string;
}): Promise<ApiResult<AccountingBasisExport>> {
  const query = new URLSearchParams(period).toString();
  return apiRequest("POST", `/api/accounting-basis/export?${query}`, undefined);
}
