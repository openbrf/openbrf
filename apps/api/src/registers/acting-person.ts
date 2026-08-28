import type { RequestWithPrincipal } from "../authorization/authorization.guard";

/**
 * The acting person.
 *
 * The global guard attaches a principal to every non-public route or rejects
 * the request, so this narrows rather than defaults. It throws instead of
 * falling back to an empty id because every read in this module writes an audit
 * entry naming the actor, and an entry with an empty actor is worse than no
 * entry: it looks like evidence.
 */
export function actingPersonId(request: RequestWithPrincipal): string {
  const personId = request.principal?.personId;
  if (personId === undefined) {
    throw new Error(
      "No principal on the request. The authorization guard must run before " +
        "this controller.",
    );
  }
  return personId;
}
