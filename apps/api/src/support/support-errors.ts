import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * A support access is already open, so another cannot be opened beside it.
 *
 * One at a time, and the end of the open one is never moved: somebody who needs
 * more time closes it and opens a new one, and the log shows both.
 */
export class SupportAccessOpenError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "support-access-open";

  constructor() {
    super("Support access is already open. Close it before opening another.");
  }
}

/**
 * No support access is open: none was opened, it was closed, it reached its
 * end, or whoever opened it no longer holds the administrator grant.
 *
 * Which of those it was is not said. The management API's caller learns only
 * whether a link can be had, and an administrator closing an access somebody
 * else closed a moment ago needs to know only that it is closed.
 */
export class SupportAccessClosedError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "support-access-closed";

  constructor() {
    super("No support access is open.");
  }
}

/**
 * A sign-in link that does not work: no such token, used already, older than
 * ten minutes, or issued under an access that is no longer open.
 *
 * One answer for all of them, for the reason `BearerUnauthorizedError` gives:
 * the difference is information about somebody else's link.
 */
export class SupportSignInInvalidError extends DomainError {
  readonly status = HttpStatus.UNAUTHORIZED;
  readonly reason = "support-sign-in-invalid";

  constructor() {
    super("This support sign-in link does not work.");
  }
}

/**
 * The support session the request carries has ended, expired, was never
 * started, or its access is no longer open.
 *
 * Answered without falling back to an account session in the same browser:
 * when a request carries the support cookie, it is the only credential
 * considered (ADR 0028).
 */
export class SupportSessionInvalidError extends DomainError {
  readonly status = HttpStatus.UNAUTHORIZED;
  readonly reason = "support-session-invalid";

  constructor(private readonly clearCookie: string) {
    super("This support session has ended.");
  }

  /** The cookie goes with the session, so the next request carries neither. */
  override headers(): Record<string, string> {
    return { "set-cookie": this.clearCookie };
  }
}

/** A support session asked to change something. It changes nothing. */
export class SupportReadOnlyError extends DomainError {
  readonly status = HttpStatus.FORBIDDEN;
  readonly reason = "support-access-read-only";

  constructor() {
    super("Support access is read-only.");
  }
}

/**
 * A support session reached a route that is not a supporter's whatever the
 * method: a plugin's, whose reads core cannot vouch for, the sign-in library's,
 * which are about accounts and a supporter has none, or one that declares no
 * capability and was not opened to support sessions by name.
 */
export class SupportRouteRefusedError extends DomainError {
  readonly status = HttpStatus.FORBIDDEN;
  readonly reason = "support-access-refused";

  constructor() {
    super("This is not open to a support session.");
  }
}
