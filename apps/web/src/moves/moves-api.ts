import { apiRequest, type ApiResult } from "../api/client";

/**
 * The move flows, as the browser sees them.
 *
 * Mirrors `apps/api/src/moves/move.service.ts`. Both endpoints write the
 * statutory member register as a side effect, which is why the results say so
 * explicitly rather than leaving the screen to guess: a board member who moved
 * someone out should be told that the membership was closed in a register that
 * nobody can edit afterwards.
 */

export type MoveRole = "MEMBER" | "RESIDENT";

/**
 * The machine-readable reasons the move endpoints answer with.
 *
 * Mirrors `MoveErrorReason` in `apps/api/src/moves/move.service.ts`. Held here
 * so the message map can be keyed on the union rather than on `string`: a
 * reason added on the API and forgotten here would otherwise still compile,
 * and every board member would read the fallback instead of what went wrong.
 */
export type MoveErrorReason =
  | "person-not-found"
  | "apartment-not-found"
  | "residency-not-found"
  | "already-resident"
  | "already-moved-out"
  | "moved-out-before-moved-in"
  | "transfer-person-not-found"
  | "transfer-reference-required";

export interface TransferInput {
  /** ISO calendar date. */
  transferredOn: string;
  price?: string | null;
  /** Required: the apartment register extract states one for every transfer. */
  agreementReference: string;
}

export interface MoveInInput {
  personId: string;
  apartmentId: string;
  role: MoveRole;
  movedInOn: string;
  transfer?: TransferInput & { fromPersonId?: string | null };
}

export interface MoveInResult {
  residencyId: string;
  memberRegisterEntryRecorded: boolean;
  transferId: string | null;
  welcomeEmailSent: boolean;
}

export interface MoveOutInput {
  residencyId: string;
  movedOutOn: string;
  transfer?: TransferInput & { toPersonId: string };
}

export interface MoveOutResult {
  residencyId: string;
  movedOutOn: string;
  /** Derived from the retention policy; service data is erased on this date. */
  purgeOn: string;
  memberRegisterExitRecorded: boolean;
  transferId: string | null;
  boardReminderOn: string;
}

export function moveIn(input: MoveInInput): Promise<ApiResult<MoveInResult>> {
  return apiRequest("POST", "/api/moves/move-in", input);
}

export function moveOut(
  input: MoveOutInput,
): Promise<ApiResult<MoveOutResult>> {
  return apiRequest("POST", "/api/moves/move-out", input);
}
