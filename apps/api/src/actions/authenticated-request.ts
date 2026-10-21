/**
 * The mark core puts on a request it has authenticated, and what it found.
 *
 * A plugin dispatches by handing back the request its own route received, and
 * the caller factory derives the caller from it. Without a mark, a plugin
 * could hand over an object it built itself, carrying any person it liked, and
 * the capability check would faithfully answer the question for somebody who
 * never asked it.
 *
 * The mark is an entry in a map this module owns, and the map is the whole
 * mechanism. It is not a property of the request, and the difference is the
 * point: a plugin is handed the real request, so anything stored ON it is
 * readable and therefore copyable. A symbol key is no exception -
 * `Object.getOwnPropertySymbols` returns it to any holder, and a forged object
 * carrying the copied key would have passed. Membership cannot be copied,
 * because the map answers for the identity of the object rather than for
 * anything the object carries.
 *
 * Nor is it only a mark. What the guard established - the person, the token's
 * client and scopes, the request's id - is held in the entry, copied and
 * frozen when the guard wrote it. `request.principal` and `request.token` are
 * for controllers to read, and a plugin holding the real request can write
 * them as easily: adding a token to a session request, removing a real one or
 * widening its scopes would otherwise move the dispatch onto another channel
 * and name a connected app that never called. The caller factory reads only
 * the entry.
 *
 * The mark ends with the response. A plugin can keep the request object it was
 * handed, and without an end it could pass that object from a job or from
 * another person's request, long after, and the entry would name as the actor
 * somebody who was no longer there. A request whose response is sent, or whose
 * connection closed first, has nobody on the other end of it, so it no longer
 * speaks for anybody.
 *
 * `WeakMap` rather than `Map` so a request is collected when the response
 * ends; it is the same device `ActionCallerFactory` uses to hold what a caller
 * handle means. This file still imports nothing: the authorization guard
 * writes the mark and the caller factory reads it, and keeping the map in a
 * file of its own stops those two importing each other.
 */

/** What a bearer token established, as the guard resolved it. */
export interface AuthenticatedToken {
  readonly clientId: string;
  readonly clientHost: string | null;
  readonly scopes: readonly string[];
}

/** What the guard established about a request, and nothing else. */
export interface AuthenticatedFacts {
  readonly personId: string;
  /** The token the request presented; null for a signed-in session. */
  readonly token: AuthenticatedToken | null;
  readonly requestId: string;
}

const authenticated = new WeakMap<object, AuthenticatedFacts>();
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
 * The facts are copied here, so nothing the guard or anybody else does to the
 * objects it passed can change them afterwards.
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
  facts: AuthenticatedFacts,
): void {
  if (response.writableFinished || response.destroyed) {
    answered.add(request);
    return;
  }
  const token = facts.token;
  authenticated.set(
    request,
    Object.freeze({
      personId: facts.personId,
      token:
        token === null
          ? null
          : Object.freeze({
              clientId: token.clientId,
              clientHost: token.clientHost,
              scopes: Object.freeze([...token.scopes]),
            }),
      requestId: facts.requestId,
    }),
  );
  const end = (): void => {
    authenticated.delete(request);
    answered.add(request);
  };
  response.once("finish", end);
  response.once("close", end);
}

/**
 * What the guard established, for a request core put together and is still
 * serving.
 */
export function authenticatedFacts(
  request: object,
): AuthenticatedFacts | undefined {
  return authenticated.get(request);
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
