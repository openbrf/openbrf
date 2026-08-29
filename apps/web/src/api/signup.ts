import { apiRequest, type ApiResult } from "./client";

/**
 * Board-approved self-signup, one function per route.
 *
 * Two audiences share this module. The first two calls are made by a visitor
 * with no account, from a screen served before sign-in; the last three are made
 * by a board member from the settings screen. They sit together because they
 * are one flow - a request is asked for, and the same request is decided - and
 * splitting them by audience would hide that the queue is the other end of the
 * form.
 */

export interface SignupState {
  /** Whether the association is accepting requests at all. */
  enabled: boolean;
}

export interface SignupSubmission {
  firstName: string;
  lastName: string;
  email: string;
  /**
   * Omitted rather than sent blank. The endpoint takes the field as optional
   * and encrypts whatever arrives, so an empty string would be stored as a
   * phone number that is not one.
   */
  phone?: string;
  /**
   * As the visitor typed them. The form offers no pickers: it is served before
   * sign-in, and a picker would enumerate the association's addresses and
   * apartments to anyone who loaded the page (decision 28). Matching the claim
   * to a real apartment is the board's job, at approval time.
   */
  claimedAddress: string;
  claimedApartmentNumber: string;
  /**
   * The decoy field, sent only when something filled it in.
   *
   * No person can reach it - it is hidden from the screen, from the
   * accessibility tree and from the tab order - so a submission carrying it was
   * made by a script, and the endpoint drops it while answering exactly as it
   * answers a real one. Omitted when blank, like the phone number above, so an
   * ordinary submission carries nothing it does not mean.
   */
  website?: string;
}

export interface PendingSignupRequest {
  id: string;
  firstName: string;
  lastName: string;
  /** Decrypted for the board, so the claim can be judged against the register. */
  email: string;
  claimedAddress: string;
  claimedApartmentNumber: string;
  createdAt: string;
}

export function fetchSignupState(): Promise<ApiResult<SignupState>> {
  return apiRequest("GET", "/api/signup-requests/state");
}

export function submitSignupRequest(
  input: SignupSubmission,
): Promise<ApiResult<{ id: string }>> {
  return apiRequest("POST", "/api/signup-requests/submit", input);
}

export function fetchSignupRequests(): Promise<
  ApiResult<PendingSignupRequest[]>
> {
  return apiRequest("GET", "/api/signup-requests");
}

/**
 * Approves a request against one apartment.
 *
 * No role travels with it. The API defaults to a resident, and a self-signup
 * never grants membership: holding a tenant-ownership is a matter of record,
 * written by the move-in and register flows, not something granted by asking.
 */
export function approveSignupRequest(
  id: string,
  input: { apartmentId: string },
): Promise<ApiResult<{ personId: string }>> {
  return apiRequest(
    "POST",
    `/api/signup-requests/${encodeURIComponent(id)}/approve`,
    input,
  );
}

export function rejectSignupRequest(
  id: string,
  input: { reason?: string },
): Promise<ApiResult<undefined>> {
  return apiRequest(
    "POST",
    `/api/signup-requests/${encodeURIComponent(id)}/reject`,
    input,
  );
}
