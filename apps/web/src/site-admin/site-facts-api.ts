import { apiRequest, type ApiResult } from "../api/client";

/**
 * The association's own facts, as the board's screen reads and writes them.
 *
 * The wire shapes are mirrored here rather than imported from the server,
 * which is the convention across the client: the two travel over HTTP, and a
 * shared type would hide the day the wire changed.
 *
 * There is no public read. The facts leave the instance as the rendered broker
 * page and in no other form, so these calls need site:manage the same way the
 * page editor's do.
 */

/**
 * A fact the board has not recorded is null, and null is an answer of its own.
 *
 * It is not the same as false. "The association owns the land" and "the board
 * has not said whether it does" are different things to tell a broker, and the
 * public page prints the first and omits the second.
 */
export interface AssociationFacts {
  propertyDesignation: string | null;
  buildYear: number | null;
  siteLeasehold: boolean | null;
  siteLeaseholdNote: string | null;
  feePolicy: string | null;
  feeIncludes: string | null;
  transferFeePolicy: string | null;
  pledgeFeePolicy: string | null;
  legalPersonOwners: boolean | null;
  legalPersonOwnersNote: string | null;
  parking: string | null;
  storage: string | null;
  renovations: string | null;
  /** ISO instant, or null while nothing has been recorded. */
  updatedAt: string | null;
}

/** What a save carries. Every field is written; an emptied one is cleared. */
export type AssociationFactsInput = Omit<AssociationFacts, "updatedAt">;

export function fetchAssociationFacts(): Promise<ApiResult<AssociationFacts>> {
  return apiRequest("GET", "/api/site/facts");
}

export function saveAssociationFacts(
  input: AssociationFactsInput,
): Promise<ApiResult<AssociationFacts>> {
  return apiRequest("PUT", "/api/site/facts", input);
}
