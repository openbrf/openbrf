import type { ActionSummary } from "@openbrf/plugin-sdk";

import { apiRequest, type ApiResult } from "../api/client";

/**
 * What the consent screen asks the instance.
 *
 * Three calls, and each of them answers a different question a member has
 * before letting an external program act as them: who is asking, what that
 * program would be able to do, and - once they have said yes - recording it.
 */

/**
 * The publicly readable fields of a registered client.
 *
 * The sign-in library's own shape, in its own spelling, because this is the
 * library's endpoint rather than one of ours. It carries no redirect URI: what
 * the authorization request asks the code to be sent to is in the request
 * itself, which is signed, and reading it from there is what makes the host on
 * screen the host the code will actually go to.
 */
export interface OAuthClientDetails {
  client_id: string;
  client_name?: string | null;
  client_uri?: string | null;
}

/** What this caller may ask the platform to do, as the catalogue answers. */
export interface ActionCatalogue {
  ttlMs: number;
  cacheScope: string;
  actions: ActionSummary[];
}

/** What the sign-in library answers a recorded consent with. */
export interface ConsentGranted {
  redirect?: boolean;
  /** Where to hand the browser back to the app that asked. */
  url?: string;
}

/**
 * Who is asking.
 *
 * A client this instance does not know answers 404, which is the whole of what
 * the screen needs in order to say so: registering a client is an
 * administrator's act, and a member who reaches consent for an unregistered
 * one has nothing to decide.
 */
export function fetchOAuthClient(
  clientId: string,
): Promise<ApiResult<OAuthClientDetails>> {
  return apiRequest(
    "GET",
    `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
  );
}

/**
 * What a connected app could do as this person, right now.
 *
 * `surface=mcp` is the list as a connected app would be offered it: the
 * catalogue is already filtered to what this account's current capabilities
 * allow, and a plugin's action is in it only once an administrator has armed
 * it for this channel. Nothing is snapshotted from it - the list is what the
 * screen shows, never what a later call is checked against.
 */
export function fetchConnectedAppActions(): Promise<
  ApiResult<ActionCatalogue>
> {
  return apiRequest("GET", "/api/actions?surface=mcp");
}

/**
 * Records the consent.
 *
 * The authorization request goes as the bytes it arrived as. It is signed, and
 * the signature is over the parameters as written, so re-serialising it can
 * reorder or re-encode one and break it - and the refusal would read as a
 * consent the instance declined rather than as a request that was mangled on
 * the way. The one character removed is the leading "?", which is the
 * delimiter between a path and a query rather than part of the query.
 *
 * Accept only. There is no deny: declining cancels this one request, which is
 * not the same act as withdrawing a connection already granted, and a deny
 * button here would leave an earlier grant standing while appearing to end it.
 */
export function grantConsent(
  authorizationRequest: string,
): Promise<ApiResult<ConsentGranted>> {
  return apiRequest("POST", "/api/connected-apps/consent", {
    oauth_query: authorizationRequest.startsWith("?")
      ? authorizationRequest.slice(1)
      : authorizationRequest,
  });
}
