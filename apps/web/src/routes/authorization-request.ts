import {
  defaultParseSearch,
  defaultStringifySearch,
} from "@tanstack/react-router";

import { safeReturnTo } from "./return-to";

/**
 * The authorization request a connected app sends a member in with.
 *
 * A member who points a connected app at their own instance is sent here by
 * the sign-in library's authorize endpoint, which redirects the browser to the
 * sign-in screen and then to the consent screen carrying the whole request in
 * the query string. Nothing about it is held in a cookie: the request is
 * signed, and the signature covers every parameter except the signature
 * itself, so the query has to arrive at the consent screen as the same bytes
 * the provider wrote.
 *
 * Three separate things in the router would otherwise destroy it.
 *
 * A route sees only the parameters its own `validateSearch` declares, and the
 * address bar is rebuilt from them the next time the router builds a location.
 * A sign-in screen declaring nothing but `returnTo` therefore drops the
 * request on the floor and no consent can follow, which is why the whole set
 * is declared below.
 *
 * The router also parses a search string into an object and serialises it back
 * when it builds any location, and that round trip keeps one value per name.
 * `ba_param` appears once per signed parameter, so it survives the parse as an
 * array and comes back out as a single value holding a list - a different
 * query, and a signature that no longer verifies. That is why the hop to the
 * consent screen is built from the unparsed search string and taken as a
 * document navigation, and why the consent screen reads the same unparsed
 * string rather than anything the router has rebuilt.
 *
 * The third is the address bar itself. When the router mounts, and whenever it
 * resolves a location, it builds the address it would have written for the
 * page and replaces the history entry with that one if the two differ - which
 * for a signed request they always do, for the reason above. A screen would
 * then read a re-spelled request out of `window.location.search`, and a
 * reload of the sign-in or consent screen would load the re-spelled one. So
 * the router is given `stringifySearch` below, which keeps the address bar's
 * own spelling whenever what the router would write in its place means the
 * same to the router. The address bar then stays the request, on the first
 * load and on every reload, and the screens read it from there.
 */

/**
 * Writes a search string for the router, keeping the given spelling of it
 * when the router would mean the same by its own.
 *
 * "The same" is decided in the router's own terms: the search object, written
 * out the router's default way, against the given string parsed and written
 * out the same way. Two strings the router cannot tell apart are equal, so
 * nothing the router decides on changes - a route that asked for a different
 * search, or a validator that changed a value, still gets its own spelling.
 * What changes is only that a query nothing has touched is no longer
 * re-spelled, and a signed one is no longer spent by it.
 */
export function stringifyKeeping(
  spelled: string,
  search: Record<string, unknown>,
): string {
  const written = defaultStringifySearch(search);
  if (spelled === "" || spelled === written) {
    return written;
  }
  return written === canonical(spelled) ? spelled : written;
}

/** One string and how the router would write it. Asked on every link. */
let lastCanonical: { spelled: string; written: string } | null = null;

function canonical(spelled: string): string {
  if (lastCanonical?.spelled !== spelled) {
    lastCanonical = {
      spelled,
      written: defaultStringifySearch(defaultParseSearch(spelled)),
    };
  }
  return lastCanonical.written;
}

/**
 * The router's `stringifySearch`: the address bar's spelling, when it means
 * what the router is about to write.
 */
export function stringifySearch(search: Record<string, unknown>): string {
  return stringifyKeeping(window.location.search, search);
}

/**
 * Where this application is served.
 *
 * The router is given it as its basepath and applies it to every location it
 * builds. A document navigation is not one of those - the address is handed
 * straight to the browser - so the prefix has to be written onto it here, and
 * both uses read it from this one declaration.
 */
export const APP_BASE_PATH = "/app";

/** The consent screen, as a route path. */
export const CONSENT_PATH = "/oauth/consent";

/** The sign-in screen, as a route path. */
export const SIGN_IN_PATH = "/sign-in";

/**
 * One parameter, as the router hands it back.
 *
 * The router parses the search string before any route sees it: a value that
 * reads as a number or as a boolean arrives as one. Values are declared and
 * kept exactly as they arrive and are never re-typed, because what the router
 * writes back into the address bar is derived from them - turning the number
 * 1774295570 back into the string "1774295570" is what makes it reappear in
 * the URL quoted.
 */
type SearchValue = string | number | boolean;

/**
 * Everything the sign-in and consent routes declare.
 *
 * The OAuth parameters are the authorization request; `returnTo` is this
 * application's own and is the address a guarded route was asked for. They
 * never travel together: the request arrives from the provider's own redirect
 * and carries no `returnTo`, and adding one would put an unsigned parameter
 * into a query whose signature is computed over everything in it.
 */
export interface AuthorizationSearch {
  returnTo?: string;
  response_type?: SearchValue;
  client_id?: SearchValue;
  redirect_uri?: SearchValue;
  scope?: SearchValue;
  state?: SearchValue;
  code_challenge?: SearchValue;
  code_challenge_method?: SearchValue;
  resource?: SearchValue;
  prompt?: SearchValue;
  exp?: SearchValue;
  ba_iat?: SearchValue;
  /** Repeated once per signed parameter name, so it is normally a list. */
  ba_param?: string | string[];
  sig?: SearchValue;
}

function scalar(value: unknown): SearchValue | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : undefined;
}

/** The repeated parameter, kept repeated. A single occurrence is a string. */
function names(value: unknown): string | string[] | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return undefined;
}

/**
 * What the sign-in and consent routes accept in their query string.
 *
 * Coerced rather than rejected, like the activation route's token: a member
 * arrives here from a redirect somebody else's program composed, and a
 * malformed parameter should reach a screen that says the request cannot be
 * used rather than throw a router error at somebody who only pressed connect.
 *
 * `returnTo` is the one value validated instead of coerced, because it is the
 * only one that decides where the browser goes next.
 */
export function validateAuthorizationSearch(
  search: Record<string, unknown>,
): AuthorizationSearch {
  const returnTo = safeReturnTo(search["returnTo"]);
  return {
    ...(returnTo === null ? {} : { returnTo }),
    response_type: scalar(search["response_type"]),
    client_id: scalar(search["client_id"]),
    redirect_uri: scalar(search["redirect_uri"]),
    scope: scalar(search["scope"]),
    state: scalar(search["state"]),
    code_challenge: scalar(search["code_challenge"]),
    code_challenge_method: scalar(search["code_challenge_method"]),
    resource: scalar(search["resource"]),
    prompt: scalar(search["prompt"]),
    exp: scalar(search["exp"]),
    ba_iat: scalar(search["ba_iat"]),
    ba_param: names(search["ba_param"]),
    sig: scalar(search["sig"]),
  };
}

/**
 * The authorization request in a search string, or null when there is none.
 *
 * The string is returned exactly as it was given, including its leading "?".
 * It is read to decide whether a request is there and never rebuilt: what is
 * signed is the sequence of parameters as written, so the only safe thing to
 * do with it is pass it on.
 *
 * A client id and a signature are what make it a request. Either one missing
 * means the visitor is at the sign-in screen for the ordinary reason, and the
 * consent screen has nothing to ask about.
 */
export function authorizationRequestIn(search: string): string | null {
  const params = new URLSearchParams(search);
  const clientId = params.get("client_id");
  const signature = params.get("sig");
  if (
    clientId === null ||
    clientId === "" ||
    signature === null ||
    signature === ""
  ) {
    return null;
  }
  return search;
}

/**
 * The address of a screen in this application, carrying the request unchanged.
 *
 * Whole and absolute, because it is handed to the browser rather than to the
 * router: the basepath is written on here, and the search string is appended
 * as it stands.
 */
function hrefCarrying(path: string, request: string): string {
  const query = request.startsWith("?") ? request : `?${request}`;
  return `${APP_BASE_PATH}${path}${query}`;
}

/** The consent screen, carrying the request unchanged. */
export function consentHref(request: string): string {
  return hrefCarrying(CONSENT_PATH, request);
}

/**
 * The sign-in screen, carrying the request unchanged.
 *
 * For somebody who reached the consent screen without a session - the sign-in
 * that was meant to come first has lapsed, or the address was opened on its
 * own. The request goes with them rather than a `returnTo` pointing back here:
 * a returnTo is composed by the router and would arrive re-spelled, which is
 * the one thing a signed request does not survive.
 */
export function signInHref(request: string): string {
  return hrefCarrying(SIGN_IN_PATH, request);
}
