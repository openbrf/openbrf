import type { FastifyRequest } from "fastify";

import { AuthService } from "../auth/auth.service";

/**
 * What the public website is allowed to read off a request.
 *
 * Two things, and they are here rather than on a controller because more than
 * one controller answers on the website's behalf - the pages, the news, and
 * whatever the association publishes next - and each of them has to read a
 * request the same way. A second copy of the session rule would be a second
 * place for the website to start setting a cookie.
 */

/** The Accept-Language header as one string, whatever shape Fastify parsed. */
export function acceptLanguage(request: FastifyRequest): string | undefined {
  const value = request.headers["accept-language"];
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
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.append(name, value);
    }
  }

  try {
    return (await auth.personIdFromHeaders(headers)) !== null;
  } catch {
    return false;
  }
}
