/**
 * The mark core puts on a request it has authenticated.
 *
 * A plugin dispatches by handing back the request its own route received, and
 * the registry reads the person from that request. Without a mark, a plugin
 * could hand over an object it built itself, carrying any person it liked, and
 * the capability check would faithfully answer the question for somebody who
 * never asked it.
 *
 * The mark is a module-level symbol. It is not exported from @openbrf/plugin-sdk
 * and a plugin has no way to obtain it, so an object a plugin constructed
 * cannot carry it. That is the whole mechanism, and it is why this file imports
 * nothing: the authorization guard writes the mark and the caller factory reads
 * it, and a symbol in a file of its own keeps those two from importing each
 * other.
 */
const AUTHENTICATED = Symbol("openbrf.authenticatedRequest");

/** Called by the guard once a request's person is established. */
export function markAuthenticated(request: object): void {
  (request as Record<symbol, unknown>)[AUTHENTICATED] = true;
}

/** Whether core put this request together. */
export function isAuthenticatedRequest(request: object): boolean {
  return (request as Record<symbol, unknown>)[AUTHENTICATED] === true;
}
