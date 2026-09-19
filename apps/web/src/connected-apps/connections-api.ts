import { apiRequest, type ApiResult } from "../api/client";

/**
 * Seeing and cutting connections, and registering a client by hand.
 *
 * The shapes mirror the API's responses rather than restating its types: these
 * are our own endpoints and their contract is declared on the server, so a
 * second definition here would only be a second thing to keep in step.
 *
 * Instants arrive as ISO strings, which is what JSON carries. Nothing here
 * turns them into `Date`: the surfaces format them in the association's zone
 * and the reader's locale, and a value parsed twice is a value that can differ.
 */

/** One connection, as the person who granted it reads it. */
export interface ConnectedApp {
  clientId: string;
  /** Null for a client that registered without naming itself. */
  clientName: string | null;
  /**
   * The host the app is reached at, never the whole URL. Null when the client
   * declared no address the server could parse one out of.
   */
  clientHost: string | null;
  scopes: string[];
  connectedAt: string;
  /**
   * When a token for this connection was last issued, or null once every token
   * has expired and been swept. Null is an ordinary state rather than a gap:
   * nothing records a call against a grant.
   */
  lastTokenIssuedAt: string | null;
  /**
   * Whether the person's standing has narrowed to nothing an app could use.
   *
   * Nothing revokes a token when a board term ends or a residency does: what a
   * grant is worth is decided per call, so a narrowed person's app is refused
   * at the moment it asks. Without this the row would keep reading as connected
   * while the connection could do nothing - and look fresher as it became more
   * useless, because the app goes on refreshing its token on schedule.
   */
  dormant: boolean;
}

/** The same connection, plus who granted it. The instance-wide view only. */
export interface ConnectedAppGrant extends ConnectedApp {
  personId: string;
  personName: string;
  /**
   * The account the grant hangs on.
   *
   * Carried beside the person because the instance-wide disconnect is keyed on
   * the account: `DELETE /api/connected-apps/:userId/:clientId` looks the
   * account up by this id. A person and their account are not interchangeable -
   * a person in the register may have no account at all.
   */
  userId: string;
}

/** What registering a client answers with. The secret is never sent again. */
export interface RegisteredClient {
  clientId: string;
  /** Null for a client the provider minted without one. */
  clientSecret: string | null;
}

/**
 * The resource document, which names the address a client binds its token to.
 *
 * Read from the discovery document rather than composed in the browser. Which
 * route is the resource depends on which connector plugin this instance runs,
 * so composing an address here would be a second answer to a question the
 * server already answers - one that would keep looking right while naming a
 * path nothing serves.
 *
 * `resource` is optional because this is the provider's document rather than
 * ours: one that answers without it is a document this client cannot use, and
 * the panel says the address could not be read rather than printing nothing.
 */
export interface ProtectedResourceDocument {
  resource?: string;
}

export function fetchMyConnectedApps(): Promise<
  ApiResult<{ connectedApps: ConnectedApp[] }>
> {
  return apiRequest("GET", "/api/connected-apps/mine");
}

export function disconnectMyConnectedApp(
  clientId: string,
): Promise<ApiResult<{ disconnected: true }>> {
  return apiRequest(
    "DELETE",
    `/api/connected-apps/mine/${encodeURIComponent(clientId)}`,
  );
}

export function fetchConnectedApps(): Promise<
  ApiResult<{ connectedApps: ConnectedAppGrant[] }>
> {
  return apiRequest("GET", "/api/connected-apps");
}

/**
 * Cuts somebody else's connection.
 *
 * A different capability from reading the list, and a different question:
 * seeing that a member has connected something is part of knowing what leaves
 * the association, and cutting it is acting on another person's data. The
 * server records it against both people.
 */
export function disconnectConnectedApp(
  userId: string,
  clientId: string,
): Promise<ApiResult<{ disconnected: true }>> {
  return apiRequest(
    "DELETE",
    `/api/connected-apps/${encodeURIComponent(userId)}/${encodeURIComponent(clientId)}`,
  );
}

/**
 * Registers a client by hand.
 *
 * For the app that cannot present a metadata document of its own, which is the
 * path every other client takes. Registering grants nothing: it makes the app
 * known to the instance so that a member can then be asked whether to let it
 * act for them.
 */
export function registerOAuthClient(input: {
  clientName: string;
  redirectUris: string[];
}): Promise<ApiResult<RegisteredClient>> {
  return apiRequest("POST", "/api/oauth-clients", input);
}

/**
 * The protected-resource document, at the fixed path RFC 9728 puts it at.
 *
 * At the root of the origin rather than under /api, because that is where the
 * specification puts it and where a client looks for it. Public, and
 * deliberately so: it says how a token may be obtained and has to be readable
 * before any token exists.
 */
export function fetchProtectedResource(): Promise<
  ApiResult<ProtectedResourceDocument>
> {
  return apiRequest("GET", "/.well-known/oauth-protected-resource");
}
