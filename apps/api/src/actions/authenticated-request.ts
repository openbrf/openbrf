/**
 * The mark core puts on a request it has authenticated.
 *
 * A plugin dispatches by handing back the request its own route received, and
 * the registry reads the person from that request. Without a mark, a plugin
 * could hand over an object it built itself, carrying any person it liked, and
 * the capability check would faithfully answer the question for somebody who
 * never asked it.
 *
 * The mark is membership of a set this module owns, and the set is the whole
 * mechanism. It is not a property of the request, and the difference is the
 * point: a plugin is handed the real request, so anything stored ON it is
 * readable and therefore copyable. A symbol key is no exception -
 * `Object.getOwnPropertySymbols` returns it to any holder, and a forged object
 * carrying the copied key would have passed. Membership cannot be copied,
 * because the set answers for the identity of the object rather than for
 * anything the object carries.
 *
 * `WeakSet` rather than `Set` so a request is collected when the response ends;
 * it is the same device `ActionCallerFactory` uses to hold what a caller handle
 * means. This file still imports nothing: the authorization guard writes the
 * mark and the caller factory reads it, and keeping the set in a file of its
 * own stops those two importing each other.
 */
const authenticated = new WeakSet<object>();

/** Called by the guard once a request's person is established. */
export function markAuthenticated(request: object): void {
  authenticated.add(request);
}

/** Whether core put this request together. */
export function isAuthenticatedRequest(request: object): boolean {
  return authenticated.has(request);
}
