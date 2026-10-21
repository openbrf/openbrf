import type { RequestWithPrincipal } from "./authorization.guard";
import type { Principal } from "./capabilities";

/**
 * The acting principal, or a fault.
 *
 * The global guard attaches a principal to every non-public route or rejects
 * it, so reaching the throw means the guard stopped doing that, and a 500
 * naming the guard is the honest answer. Not a default such as `?? ""`: an
 * empty id would be used as a database key and the caller told "person not
 * found", which describes the register rather than the request that is broken.
 */
export function requirePrincipal(request: RequestWithPrincipal): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

/** The acting person's id, or a fault, as {@link requirePrincipal}. */
export function requirePersonId(request: RequestWithPrincipal): string {
  return requirePrincipal(request).personId;
}
