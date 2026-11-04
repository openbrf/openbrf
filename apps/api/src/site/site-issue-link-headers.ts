import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { decodedPathOf, pathOf } from "../http/request-path";
import { hasReporterLinkTokenForm } from "../issues/issue-reporter-link-token";
import { REPORTER_LINK_PATH } from "../issues/issue-reporter-link.service";
import { hasWorkOrderLinkTokenForm } from "../issues/work-order-link-token";
import {
  WORK_ORDER_LINK_PATH,
  WORK_ORDER_LINK_PHOTO_SEGMENT,
} from "../issues/work-order-link.service";

/**
 * The headers every answer on a link to an issue carries, a reporter's private
 * link and a contractor's link to a work order alike, and what it never
 * carries (ADR 0055).
 *
 * The token is the whole address, so the address is a credential, and each of
 * these keeps it where it is:
 *
 * - `Referrer-Policy: no-referrer`, so following a link off the page sends the
 *   token to nobody. Stricter than the website's `same-origin`, which the
 *   forms there need to send a real `Origin`; these pages' forms are accepted
 *   with `Origin: null` instead (`SiteIssueLinkController`).
 * - `Cache-Control: no-store`, so no shared cache and no browser's back button
 *   keeps the page after the link is withdrawn.
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
export const LINK_HEADERS: Readonly<Record<string, string>> = {
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
 * The most a text post through a link can be sent as.
 *
 * The longest message (`ISSUE_CONVERSATION_LIMITS.body`, 4,000 characters) of
 * four-byte characters, each byte percent-encoded as three, and the field's
 * name: 48,000 bytes and change. A contractor's note is shorter. Anything
 * larger is not a form these pages sent, and is refused before it is read
 * rather than after the application's general limit of a mebibyte.
 *
 * Not the contractor's photograph, whose route is bounded by the multipart
 * parser's per-file limit (`OPENBRF_MAX_UPLOAD_BYTES`) as every upload is.
 */
export const LINK_TEXT_BODY_LIMIT = 64 * 1024;

const LINK_PATHS = [REPORTER_LINK_PATH, WORK_ORDER_LINK_PATH] as const;

/** Whether a path, or a route's pattern, is on a link to an issue. */
export function isLinkPath(url: string): boolean {
  const path = pathOf(url);
  return LINK_PATHS.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
/**
 * Whether the decoded path is a token's own address: the one segment right
 * below /arende or /arbetsorder, in the form of that link's token.
 *
 * A segment of any other form is not a token, so `/arende/kontakt` stays the
 * website's.
 */
function isTokenAddress(decodedPath: string): boolean {
  const reporter = `${REPORTER_LINK_PATH}/`;
  if (decodedPath.startsWith(reporter)) {
    return hasReporterLinkTokenForm(decodedPath.slice(reporter.length));
  }
  const workOrder = `${WORK_ORDER_LINK_PATH}/`;
  return (
    decodedPath.startsWith(workOrder) &&
    hasWorkOrderLinkTokenForm(decodedPath.slice(workOrder.length))
  );
}

/**
 * Whether a request is on a link to an issue, read as the router reads it.
 *
 * The router decodes a path before it matches one, so `/%61rende/<token>`
 * opens the page as `/arende/<token>` does, and the raw URL is not what decides
 * it. Three things decide, in this order:
 *
 * 1. A decoded path that is a token's address (`/arende/<token>`,
 *    `/arbetsorder/<token>`) is on the link, whichever route the router
 *    matched. An escaped slash (`/arende%2F<token>`) is one segment to the
 *    router, so the website's `/:slug` route matches it, and its 404 still
 *    answers a request whose URL carries a live token.
 * 2. Otherwise the route the router matched decides, which is the spelling the
 *    router itself settled on: the links' own routes get the headers, and a
 *    website route on an address below /arende does not (the forms of a page
 *    that kept the slug `arende`, which answer as the website).
 * 3. Where no route of its own made the answer (the router's 404, or the
 *    website's catch-all), the decoded path decides, and decoding more than the
 *    router does only widens that.
 */
export function isLinkRequest(request: FastifyRequest): boolean {
  const decoded = decodedPathOf(request.url);
  if (isTokenAddress(decoded)) {
    return true;
  }
  const matched = (request as { routeOptions?: { url?: string } }).routeOptions
    ?.url;
  if (matched !== undefined && !matched.includes("*")) {
    return isLinkPath(matched);
  }
  return isLinkPath(decoded);
}

/**
 * Whether a route's pattern is the one a contractor's photograph is posted to,
 * which the multipart parser bounds rather than the text limit.
 */
function isPhotoUploadRoute(url: string, method: string | string[]): boolean {
  const methods = Array.isArray(method) ? method : [method];
  return (
    methods.includes("POST") &&
    pathOf(url).startsWith(`${WORK_ORDER_LINK_PATH}/`) &&
    pathOf(url).endsWith(`/${WORK_ORDER_LINK_PHOTO_SEGMENT}`)
  );
}

/**
 * Sets the headers on every answer under a link's path, and the body limit on
 * its routes. Called once the application is built and before its routes are
 * registered, as the other route hooks are (`bootstrap.ts`).
 */
export function registerLinkHeaders(server: FastifyInstance): void {
  server.addHook("onRoute", (route) => {
    if (isLinkPath(route.url) && !isPhotoUploadRoute(route.url, route.method)) {
      route.bodyLimit = LINK_TEXT_BODY_LIMIT;
    }
  });

  server.addHook("onSend", async (request, reply, payload) => {
    if (isLinkRequest(request)) {
      withLinkHeaders(reply);
    }
    return payload;
  });
}

function withLinkHeaders(reply: FastifyReply): void {
  for (const name of STRIPPED) {
    reply.removeHeader(name);
  }
  for (const [name, value] of Object.entries(LINK_HEADERS)) {
    void reply.header(name, value);
  }
}
