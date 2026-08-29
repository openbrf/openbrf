import { SetMetadata } from "@nestjs/common";

export const PUBLIC_RATE_LIMIT = "openbrf:public-rate-limit";

export interface PublicRateLimitOptions {
  /**
   * Requests one client address may make to this route in a minute.
   *
   * A budget is spent by every request, refused ones included: a limit that
   * only counted the requests that succeeded would count nothing at all on the
   * endpoints this decorator exists for, where guessing is the attack.
   */
  perMinute: number;
}

/**
 * Puts a route behind a per-client-address budget.
 *
 * For unauthenticated mutation endpoints, and for those only. A public form is
 * reachable by anyone, so the cost of submitting one is the only thing standing
 * between the board's queue and a script; a signed-in surface already has an
 * account behind it and an audit trail over it, and a GET is a read the
 * interface makes many of - limiting either buys nothing and breaks something.
 *
 * The budget belongs at the route because only the route knows what an honest
 * caller needs. Set it for the most demanding legitimate use of the form and no
 * tighter: one client address is a household, an office, or a whole building
 * behind one connection, and a limit that turns a resident away is a worse
 * failure than a limit a script takes a minute longer to exhaust.
 *
 * The guard that reads this is registered globally, so a route needs nothing
 * but this decorator - and a later public endpoint registers itself here rather
 * than growing a limiter of its own.
 */
export function PublicRateLimit(
  options: PublicRateLimitOptions,
): MethodDecorator & ClassDecorator {
  return SetMetadata(PUBLIC_RATE_LIMIT, options);
}
