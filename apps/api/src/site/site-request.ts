import type { FastifyRequest } from "fastify";

import { AuthService } from "../auth/auth.service";

/**
 * What the public website is allowed to read off a request.
 *
 * Three things, and they are here rather than on a controller because more than
 * one controller answers on the website's behalf - the pages, the news, the
 * calendar, and whatever the association publishes next - and each of them has
 * to read a request the same way. A second copy of the session rule would be a
 * second place for the website to start setting a cookie.
 */

/** The Accept-Language header as one string, whatever shape Fastify parsed. */
export function acceptLanguage(request: FastifyRequest): string | undefined {
  const value = request.headers["accept-language"];
  return typeof value === "string" ? value : undefined;
}

/**
 * One query parameter as a single string, or nothing.
 *
 * A repeated parameter parses to an array, and taking neither of them is the
 * right answer: a caller sending the same name twice is not a browser following
 * a link this website printed. So is a query string that did not parse to an
 * object at all.
 *
 * The website's whole use of the query string goes through here - which form
 * was just submitted, and which month of the calendar is being read - and none
 * of it is ever printed back onto the page: what a parameter can produce is a
 * fixed translated sentence or a month the calendar clamps into its own range.
 */
export function queryValue(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const query = request.query;
  if (typeof query !== "object" || query === null) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Whether this request carries a valid session.
 *
 * Reads the cookie the browser sent and nothing else. Better Auth's session
 * lookup can produce response headers of its own - a refreshed cookie, most of
 * all - and none of them are copied onto the reply: the website never sets a
 * cookie, and a page that started setting one on a member's visit would have
 * quietly turned the association's public site into something that tracks its
 * readers.
 *
 * A lookup that fails is nobody. The alternative is a public page that stops
 * rendering because a session row was unreadable, which is the wrong failure
 * for the one surface that has to work for someone with no account at all.
 */
export async function hasSession(
  auth: AuthService,
  request: FastifyRequest,
): Promise<boolean> {
  return (await sessionPersonId(auth, request)) !== null;
}

/**
 * Who this request's session belongs to, or nobody.
 *
 * The same lookup hasSession makes, answering with the person rather than with
 * a boolean, because one thing on the website needs to know which reader it is
 * talking to: the archive's shelves are narrower than "signed in", and a
 * resident who is not a member sees the public one. Everything else on the
 * website - the menu, the news, whether a page opens at all - is decided by the
 * boolean, and that is deliberate: a session buys a member-only page, and
 * nothing on the site may start varying per person beyond what the archive
 * already decides.
 *
 * Read once per request and handed on, so the menu, the page and the archive
 * cannot reach two conclusions about who is asking.
 */
export async function sessionPersonId(
  auth: AuthService,
  request: FastifyRequest,
): Promise<string | null> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.append(name, value);
    }
  }

  try {
    return await auth.personIdFromHeaders(headers);
  } catch {
    return null;
  }
}
