import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { decodedPathOf, pathOf } from "../http/request-path";
import { REPORTER_LINK_PATH } from "../issues/issue-reporter-link.service";

/**
 * The headers every answer on a reporter's private link carries, and what it
 * never carries (ADR 0055).
 *
 * The token is the whole address, so the address is a credential, and each of
 * these keeps it where it is:
 *
 * - `Referrer-Policy: no-referrer`, so following a link off the page sends the
 *   token to nobody. Stricter than the website's `same-origin`, which the
 *   forms there need to send a real `Origin`; this page's form is accepted
 *   with `Origin: null` instead (`SiteIssueLinkController`).
 * - `Cache-Control: no-store`, so no shared cache and no browser's back button
 *   keeps the conversation after the link is withdrawn.
 * - `X-Robots-Tag: noindex`, so a link pasted somewhere public is not listed.
 * - `X-Frame-Options: DENY` and `frame-ancestors 'none'`, because the
 *   application's own default is `SAMEORIGIN`.
 * - A content policy that loads nothing but the inline theme and this origin's
 *   own images and fonts, runs no script, and lets a form post only here.
 *
 * And never an `ETag`, a `Last-Modified`, a CORS header or a cookie: nothing
 * that would let a page elsewhere read the answer, or a later request be
 * answered from what an earlier one was.
 *
 * Hooks rather than headers set by the handler, because the answers that
 * matter as much as the page are the ones a handler never writes: the 429 the
 * rate limit guard throws before the handler runs, the 413 of a body too
 * large, and the 500 the exception filters build.
 */
export const REPORTER_LINK_HEADERS: Readonly<Record<string, string>> = {
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/** Headers an answer on a link's path never carries. */
const STRIPPED = [
  "etag",
  "last-modified",
  "set-cookie",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-expose-headers",
] as const;

/**
 * The most a message through the link can be sent as.
 *
 * The longest message (`ISSUE_CONVERSATION_LIMITS.body`, 4,000 characters) of
 * four-byte characters, each byte percent-encoded as three, and the field's
 * name: 48,000 bytes and change. Anything larger is not a message this form
 * sent, and is refused before it is read rather than after the application's
 * general limit of a mebibyte.
 */
export const REPORTER_LINK_BODY_LIMIT = 64 * 1024;

/** Whether a path, or a route's pattern, is on a reporter's link. */
export function isReporterLinkPath(url: string): boolean {
  const path = pathOf(url);
  return (
    path === REPORTER_LINK_PATH || path.startsWith(`${REPORTER_LINK_PATH}/`)
  );
}

/**
 * Whether a request is on a reporter's link, read as the router reads it.
 *
 * The router decodes a path before it matches one, so `/%61rende/<token>`
 * opens the page as `/arende/<token>` does, and the raw URL is not what decides
 * it. The route the router matched decides, which is the spelling the router
 * itself settled on: the link's own routes get the headers, and a website
 * route on an address below /arende does not (the forms of a page that kept
 * the slug `arende`, which answer as the website). Where no route of its own
 * made the answer (the router's 404, or the website's catch-all), the decoded
 * path decides, and decoding more than the router does only widens that.
 */
export function isReporterLinkRequest(request: FastifyRequest): boolean {
  const matched = (request as { routeOptions?: { url?: string } }).routeOptions
    ?.url;
  if (matched !== undefined && !matched.includes("*")) {
    return isReporterLinkPath(matched);
  }
  return isReporterLinkPath(decodedPathOf(request.url));
}

/**
 * Sets the headers on every answer under the link's path, and the body limit
 * on its routes. Called once the application is built and before its routes
 * are registered, as the other route hooks are (`bootstrap.ts`).
 */
export function registerReporterLinkHeaders(server: FastifyInstance): void {
  server.addHook("onRoute", (route) => {
    if (isReporterLinkPath(route.url)) {
      route.bodyLimit = REPORTER_LINK_BODY_LIMIT;
    }
  });

  server.addHook("onSend", async (request, reply, payload) => {
    if (isReporterLinkRequest(request)) {
      withLinkHeaders(reply);
    }
    return payload;
  });
}

function withLinkHeaders(reply: FastifyReply): void {
  for (const name of STRIPPED) {
    reply.removeHeader(name);
  }
  for (const [name, value] of Object.entries(REPORTER_LINK_HEADERS)) {
    void reply.header(name, value);
  }
}
