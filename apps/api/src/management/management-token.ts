import { hashOpaqueToken, tokensMatch } from "../auth/opaque-token";

/**
 * The management API's credential (ADR 0021).
 *
 * Whoever hosts the instance mints the token - 32 random bytes, base64url -
 * and keeps it. The instance holds only its SHA-256 digest, in
 * OPENBRF_MANAGEMENT_TOKEN_DIGEST, so nothing in its environment, its database
 * or a backup of either can be presented as the token: ADR 0009's reason for
 * storing an access token as a digest, applied to a machine credential. A
 * digest rather than an encrypted copy, because the instance never needs the
 * value back.
 *
 * Two digests may be configured at once, which is how the token is rotated:
 * the host sets the new digest beside the old one, restarts the instance, moves
 * its own side to the new token and drops the old digest at the next restart.
 * Either side can go first.
 *
 * The token is never a person. It names no account and resolves to no
 * principal, and nothing it opens is on the listener that serves the
 * association: the main listener's guard never reads these digests, so the
 * token presented there is an anonymous request.
 */

/** Matched without regard to case, as RFC 9110 makes a scheme. */
const BEARER_SCHEME = "bearer ";

/**
 * The token a request presents, or null when it presents none it may.
 *
 * Read from the raw headers, which keep every header as it arrived. Node's
 * parsed headers keep only the first of two Authorization headers and drop the
 * second, so a request carrying two would authenticate on whichever came
 * first; here two is a refusal, which is what an ambiguous credential deserves
 * (ADR 0009 refuses it on the resource route for the same reason).
 */
export function presentedManagementToken(
  rawHeaders: readonly string[],
): string | null {
  let presented: string | null = null;
  let count = 0;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "authorization") {
      count += 1;
      presented = rawHeaders[index + 1] ?? null;
    }
  }
  if (count !== 1 || presented === null) {
    return null;
  }

  if (
    presented.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME
  ) {
    return null;
  }
  const token = presented.slice(BEARER_SCHEME.length).trim();
  return token === "" ? null : token;
}

/**
 * Which configured digest a token matches: its position in the list, or null.
 *
 * The position is what the rate limit is keyed on - "0" or "1" - rather than
 * anything the caller sent, so a request with a made-up token opens no
 * counter. Every digest is compared, in constant time, whether or not an
 * earlier one matched, so how long the answer takes says nothing about which
 * of the two was right. An empty list matches nothing.
 */
export function matchingManagementDigest(
  token: string,
  digests: readonly string[],
): number | null {
  const presented = hashOpaqueToken(token);
  let matched: number | null = null;
  for (const [position, expected] of digests.entries()) {
    const equal = tokensMatch(presented, expected);
    if (equal && matched === null) {
      matched = position;
    }
  }
  return matched;
}
