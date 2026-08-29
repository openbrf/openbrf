import { apiRequest, type ApiResult } from "../api/client";

/**
 * The activation endpoint, as the browser sees it.
 *
 * The token is the whole credential, so this is the one write in the client
 * that is made without a session. Every refusal comes back as a `reason` the
 * screen turns into its own sentence - the endpoint answers in English, the
 * screen is Swedish by default, and how much a public endpoint explains is not
 * a decision for a translation file.
 */
export function acceptInvitation(input: {
  token: string;
  password: string;
}): Promise<ApiResult<{ personId: string; email: string }>> {
  return apiRequest("POST", "/api/invitations/accept", input);
}
