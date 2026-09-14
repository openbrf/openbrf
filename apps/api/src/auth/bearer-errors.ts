import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * The resource route refused a request.
 *
 * One error for every way a token can fail to be accepted - absent,
 * malformed, presented twice, unknown, expired, revoked, issued for another
 * audience, or belonging to somebody no longer in the register. Which of those
 * it was never reaches the caller: the difference between "expired" and "was
 * never yours" is information about somebody else's connection, and a caller
 * holding a token needs to know only that it is not accepted and where a new
 * one comes from.
 *
 * The challenge is the whole remedy, so it travels as a header rather than as
 * prose in the body.
 */
export class BearerUnauthorizedError extends DomainError {
  readonly status = HttpStatus.UNAUTHORIZED;
  readonly reason = "bearer-unauthorized";

  constructor(private readonly challenge: string) {
    super("A bearer token issued for this resource is required.");
  }

  override headers(): Record<string, string> {
    return { "www-authenticate": this.challenge };
  }
}

/*
 * There is no insufficient-scope error here.
 *
 * A scope is a ceiling on what an action may do, and which action is being
 * performed is not known at the route - so the refusal belongs where the scope
 * is actually checked, which is the action registry's own dispatch. It raises
 * an ActionError carrying the same challenge, built by
 * insufficientScopeChallenge in resource-challenge.ts. A second error class
 * here would be a second place a 403 could be decided.
 */

/**
 * This token has spent its budget for the minute.
 *
 * Retry-After is the point of the answer: a client that backs off by the named
 * delay recovers on its own, and one that does not is throttled anyway.
 */
export class TokenRateLimitedError extends DomainError {
  readonly status = HttpStatus.TOO_MANY_REQUESTS;
  readonly reason = "rate-limited";

  constructor(private readonly retryAfter: number) {
    super("Too many calls on this connection. Try again shortly.");
  }

  override headers(): Record<string, string> {
    return { "retry-after": String(this.retryAfter) };
  }
}
