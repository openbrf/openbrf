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
 * The mark ends with the response. A plugin can keep the request object it was
 * handed, and without an end it could pass that object from a job or from
 * another person's request, long after, and the entry would name as the actor
 * somebody who was no longer there. A request whose response is sent, or whose
 * connection closed first, has nobody on the other end of it, so it no longer
 * speaks for anybody.
 *
 * `WeakSet` rather than `Set` so a request is collected when the response ends;
 * it is the same device `ActionCallerFactory` uses to hold what a caller handle
 * means. This file still imports nothing: the authorization guard writes the
 * mark and the caller factory reads it, and keeping the set in a file of its
 * own stops those two importing each other.
 */
const authenticated = new WeakSet<object>();
const answered = new WeakSet<object>();

/**
 * The response a mark lasts as long as: Node's `ServerResponse`, which emits
 * `finish` once the response is sent and `close` when its connection ends,
 * sent or not.
 *
 * The events only say what happens from now on, so the state the response is
 * already in is read as well: `writableFinished` once it is sent, `destroyed`
 * once its connection is gone.
 */
export interface MarkedResponse {
  readonly writableFinished: boolean;
  readonly destroyed: boolean;
  once(event: "finish" | "close", listener: () => void): unknown;
}

/**
 * Called by the guard once a request's person is established.
 *
 * The guard waits for the session or the token before it gets here, and the
 * person can hang up meanwhile. Their response then closed before there was a
 * listener to hear it and will not close again, so a mark added regardless
 * would never end. A response already over is recorded as answered straight
 * away, and the request is never marked.
 */
export function markAuthenticated(
  request: object,
  response: MarkedResponse,
): void {
  if (response.writableFinished || response.destroyed) {
    answered.add(request);
    return;
  }
  authenticated.add(request);
  const end = (): void => {
    authenticated.delete(request);
    answered.add(request);
  };
  response.once("finish", end);
  response.once("close", end);
}

/** Whether core put this request together and it is still being served. */
export function isAuthenticatedRequest(request: object): boolean {
  return authenticated.has(request);
}

/**
 * Whether core authenticated this request and its response has since ended.
 *
 * Read only to say why a request is refused: one that was real once is a
 * plugin keeping it too long, which is a different fault from a forgery.
 */
export function isAnsweredRequest(request: object): boolean {
  return answered.has(request);
}
