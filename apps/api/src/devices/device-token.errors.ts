import { HttpStatus } from "@nestjs/common";

import { DomainError } from "../http/domain-error";

/**
 * The refusals a device route and the device token calls answer with
 * (ADR 0031).
 */

/** The challenge every refused device request carries. */
export const DEVICE_CHALLENGE = 'Bearer realm="device"';

/**
 * A device route refused the token, or found none.
 *
 * One error for every way a token can fail - absent, malformed, presented
 * twice, unknown, revoked, or issued for another plugin or another of its
 * routes - so the answer does not say whether a token ever existed. The
 * challenge is how a device tells that its token is gone, and only this answer
 * may make it forget the token.
 */
export class DeviceTokenInvalidError extends DomainError {
  readonly status = HttpStatus.UNAUTHORIZED;
  readonly reason = "device-token-invalid";

  constructor() {
    super("A device token issued for this route is required.");
  }

  override headers(): Record<string, string> {
    return { "www-authenticate": DEVICE_CHALLENGE };
  }
}

/**
 * Too many calls with one token, or too many refused ones from one address.
 *
 * Its own reason rather than the connected app's, because a device reads the
 * answer: a 429 is "slow down" and never "forget the token".
 */
export class DeviceRateLimitedError extends DomainError {
  readonly status = HttpStatus.TOO_MANY_REQUESTS;
  readonly reason = "device-rate-limited";

  constructor(private readonly retryAfter: number) {
    super("Too many calls on this device route. Try again shortly.");
  }

  override headers(): Record<string, string> {
    return { "retry-after": String(this.retryAfter) };
  }
}

/** A device route reads; it answers GET and HEAD and nothing else. */
export class DeviceMethodNotAllowedError extends DomainError {
  readonly status = HttpStatus.METHOD_NOT_ALLOWED;
  readonly reason = "device-method-not-allowed";

  constructor() {
    super("A device route answers GET and HEAD only.");
  }

  override headers(): Record<string, string> {
    return { allow: "GET, HEAD" };
  }
}

/**
 * Issuing was refused: the request was not a board member's own, in the web
 * interface, holding `site:manage` now.
 *
 * Reaches the plugin's route as a 403, through the plugin error interceptor,
 * which lets a domain error through as it is.
 */
export class DeviceTokenIssueRefusedError extends DomainError {
  readonly status = HttpStatus.FORBIDDEN;
  readonly reason = "device-token-issue-refused";

  constructor() {
    super(
      "A device token is issued only on a request from the web interface by a person who manages the website.",
    );
  }
}

/** The plugin already holds as many live tokens as it may. */
export class DeviceTokenLimitError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "device-token-limit";

  constructor(limit: number) {
    super(
      `A plugin holds at most ${String(limit)} live device tokens. Revoke one first.`,
    );
  }
}

/** No token by this id, for this caller. */
export class DeviceTokenNotFoundError extends DomainError {
  readonly status = HttpStatus.NOT_FOUND;
  readonly reason = "device-token-not-found";

  constructor() {
    super("No such device token.");
  }
}
