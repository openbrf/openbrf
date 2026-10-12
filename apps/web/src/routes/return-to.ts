/**
 * Where signing in sends somebody back to.
 *
 * A guarded route turns an unauthenticated visitor away before its screen
 * renders, so the address they actually asked for has to travel with them or
 * it is lost: they sign in and land at the start, with whatever they had
 * followed - a document, a booking, a thread - left behind in a link they now
 * have to find again.
 *
 * It travels in the query string, which means the value is chosen by whoever
 * wrote the link rather than by this application. A value taken from there and
 * navigated to is an open redirect: an address on somebody else's host,
 * reached through this cooperative's own sign-in screen, is a credible place
 * to ask a member for the password they have just typed once already.
 *
 * So nothing here is repaired or normalised. A value either is a path inside
 * this application or it is refused outright, and the caller falls back to the
 * start.
 */

/**
 * Characters a path may not contain, whatever else it looks like.
 *
 * Everything up to and including the space, plus DEL, plus the backslash. Two
 * separate escapes are behind that one rule:
 *
 *   A browser strips a tab, a newline and a carriage return out of a URL
 *   before parsing it, so "/&#9;/example.test" is followed as "//example.test"
 *   and has left the origin. The space is refused with them because a path
 *   carrying one has not been encoded, and a trailing one hides whatever
 *   follows it from a reader.
 *
 *   A browser normalises the backslash to a forward slash, so
 *   "/\example.test" is read as "//example.test" - the protocol-relative form
 *   below, reached by another road.
 */
function hasRefusedCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || character === "\\") {
      return true;
    }
  }
  return false;
}

/** An origin nothing can be served from, to resolve a path against. */
const PROBE_ORIGIN = "https://return-to.invalid";

/**
 * Whether a browser following this value stays on the origin it started from.
 *
 * Resolved by the URL parser rather than matched by pattern, because the
 * parser is what the browser uses: it reads "%2e%2e" as a ".." segment just as
 * it reads the literal one, so "/%2e%2e/%2e%2e//example.test" collapses into
 * the path "//example.test" with no literal dot in sight. A path that starts
 * with "//" is refused even on this origin, since anything that later re-reads
 * it as an address takes it for another host.
 */
function resolvesHere(value: string): boolean {
  try {
    const resolved = new URL(value, PROBE_ORIGIN);
    return (
      resolved.origin === PROBE_ORIGIN && !resolved.pathname.startsWith("//")
    );
  } catch {
    return false;
  }
}

/**
 * A path inside this application, or null.
 *
 * Accepted only when it begins with exactly one "/" and survives the character
 * rule above and the traversal rule below. One leading slash is what makes it
 * a path: two are a URL with the scheme left off, so "//example.test" is
 * another host, and a value that does not begin with a slash can carry a
 * scheme of its own. A ".." is refused because a traversal can collapse two
 * segments into a leading "//" and arrive at the same place.
 *
 * The value must then resolve to this origin both as written and decoded once
 * more. Not every reader stops at one decode: Better Auth's magic-link verify
 * decodes the address it lands on a second time, so "/%2e%2e%2f%2fexample.test"
 * reaches the browser there as "/..//example.test". A value whose second
 * decode fails is refused too, because that reader fails on it.
 *
 * `unknown` rather than `string`, because every caller reads this out of a
 * query string, where the value's type is not something the caller knows.
 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  if (hasRefusedCharacter(value) || value.includes("..")) {
    return null;
  }
  if (!resolvesHere(value)) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return resolvesHere(decoded) ? value : null;
}
