import { SetMetadata } from "@nestjs/common";

export const OPEN_TO_SUPPORT = "openbrf:open-to-support";

/**
 * Opens a route that declares no capability to a support session (ADR 0028).
 *
 * A support session reaches a route through the capabilities it declares, all
 * of which have to be in SUPPORT_CAPABILITIES. A route that declares none
 * would let it through on the session alone, and such routes are the ones
 * that answer from the caller's own record - the apps they connected, the
 * actions their whole grant allows - which for a support session is the
 * administrator who opened it. So a route declaring nothing is refused to a
 * support session unless it says here that what it answers is not anybody's
 * own: the viewer endpoint, which answers for the support session itself, and
 * the document shelf, whose audience is read from the capabilities.
 *
 * It widens nothing else. A route that declares a capability is decided by the
 * capability, and every write is refused to a support session before this is
 * read.
 */
export function OpenToSupport(): MethodDecorator & ClassDecorator {
  return SetMetadata(OPEN_TO_SUPPORT, true);
}
