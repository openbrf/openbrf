import { SetMetadata } from "@nestjs/common";

export const CLOSED_TO_SUPPORT = "openbrf:closed-to-support";

/**
 * Closes a route to a support session whatever capabilities it declares (ADR
 * 0028).
 *
 * A capability is a support session's or it is not, and that settles most
 * routes. A few share a capability with a screen a supporter is meant to see
 * while answering with what ADR 0028 withholds as correspondence: the contact
 * form's messages are read under `signupRequest:decide`, beside the account
 * requests a supporter helps with. Such a route says so here, and the guard
 * refuses it to a support session with 403 `support-access-refused`.
 *
 * It narrows and never widens. An account is unaffected.
 */
export function ClosedToSupport(): MethodDecorator & ClassDecorator {
  return SetMetadata(CLOSED_TO_SUPPORT, true);
}
