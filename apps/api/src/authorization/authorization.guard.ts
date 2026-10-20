import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import { markAuthenticated } from "../actions/authenticated-request";
import { AuthService } from "../auth/auth.service";
import {
  BearerUnauthorizedError,
  TokenRateLimitedError,
} from "../auth/bearer-errors";
import { BearerPrincipalService } from "../auth/bearer-principal.service";
import {
  isResourcePath,
  type ProtectedResource,
} from "../auth/protected-resource";
import { PROTECTED_RESOURCE } from "../auth/protected-resource.module";
import {
  resourceMetadataUrl,
  unauthorizedChallenge,
} from "../auth/resource-challenge";
import { TokenRateLimiter } from "../auth/token-rate-limit";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { markDeviceRequest } from "../devices/device-request";
import {
  type DeviceRoute,
  deviceRouteOfRequest,
  deviceRoutes,
  retiredDeviceRouteOfRequest,
} from "../devices/device-routes";
import { DeviceTokenResolver } from "../devices/device-token-resolver";
import {
  DeviceMethodNotAllowedError,
  DeviceRateLimitedError,
  DeviceTokenInvalidError,
} from "../devices/device-token.errors";
import { hasDeviceTokenForm } from "../devices/device-token";
import {
  clientAddressOf,
  TokenBuckets,
  trustedProxyList,
} from "../http/public-rate-limit.guard";
import { type CheckedRoute, checkedRoute } from "../plugins/plugin-module-seal";
import type { Capability, Principal } from "./capabilities";
import { PrincipalService } from "./principal.service";
import { IS_PUBLIC_ROUTE } from "./public.decorator";
import { REQUIRED_CAPABILITIES } from "./require-capability.decorator";

/**
 * The authentication scheme the resource route accepts, already lower-cased
 * for the comparison. Only the scheme is case-insensitive; the credential
 * after it is not.
 */
const BEARER_SCHEME = "bearer ";

/**
 * How many refused device requests one client address may make in a minute.
 *
 * A device token is 256 random bits, so this does not stand between a guesser
 * and a token. It bounds the lookups a stream of made-up tokens costs, as the
 * public forms bound what a stream of submissions costs, and leaves a building
 * of screens behind one address room to be refused after a revocation.
 */
const DEVICE_REFUSALS_PER_MINUTE = 30;

/** The methods a device route answers. A device reads. */
const DEVICE_METHODS = new Set(["GET", "HEAD"]);

/** The methods that change something, which a page on another site can send. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The bodies a page may send to another origin without the browser asking
 * that origin first (the Fetch standard's CORS-safelisted request types).
 */
const FORM_ENCODINGS = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
]);

/** Whether a request's body is one a form on another origin could send. */
function isFormEncoding(contentType: string | undefined): boolean {
  const essence = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  return essence !== undefined && FORM_ENCODINGS.has(essence);
}

/**
 * What a bearer token established about the caller.
 *
 * Present only on the resource route, and only from the guard: the caller
 * factory mints an action caller from this rather than from anything the
 * client sent in a body, so the connected app an action is attributed to comes
 * from an authenticated source.
 */
export interface RequestToken {
  clientId: string;
  clientHost: string | null;
  scopes: string[];
  tokenRowId: string;
}

/** The principal is attached here for controllers to read. */
export interface RequestWithPrincipal extends FastifyRequest {
  principal?: Principal;
  token?: RequestToken;
}

/**
 * Resolves the session, builds the principal, and enforces the capabilities a
 * route declares.
 *
 * Registered globally, so a route with no declared capability still requires a
 * valid session and a route that declares nothing at all is still protected.
 * Public routes opt out explicitly with @Public(); forgetting that decorator
 * locks a route down rather than exposing it.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  /**
   * One limiter for the process, held on the guard because the guard is a
   * singleton. It is per process by design; token-rate-limit.ts says why.
   */
  private readonly tokens: TokenRateLimiter;
  /** The same, per device token, on its own budget (ADR 0031). */
  private readonly deviceTokens: TokenRateLimiter;
  /** Refused device requests, per client address. */
  private readonly deviceRefusals = new TokenBuckets();
  private readonly trustedProxies: ReturnType<typeof trustedProxyList>;
  /** Where this application's own pages are served from. */
  private readonly appOrigin: string;

  constructor(
    private readonly auth: AuthService,
    private readonly principals: PrincipalService,
    private readonly reflector: Reflector,
    private readonly bearer: BearerPrincipalService,
    @Inject(ENV) private readonly env: Env,
    @Inject(PROTECTED_RESOURCE) private readonly resource: ProtectedResource,
    private readonly devices: DeviceTokenResolver,
  ) {
    this.tokens = new TokenRateLimiter(env.OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE);
    this.deviceTokens = new TokenRateLimiter(
      env.OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE,
    );
    this.trustedProxies = trustedProxyList(env.TRUSTED_PROXIES);
    this.appOrigin = new URL(env.APP_URL).origin;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    refuseFormBody(context.switchToHttp().getRequest<FastifyRequest>());

    /*
     * A route of a plugin's that the seal checked is authorized by what the
     * seal recorded of it, held apart from the class's metadata: never public,
     * and needing the capabilities the seal wrote onto it. Any other request
     * to a plugin's controller is answered as not installed by the plugin
     * serving guard, whatever this one decides.
     */
    const checked = checkedRoute(context);
    if (checked === undefined && this.isPublic(context)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();

    /*
     * The resource route, and every path beneath it, is Bearer-only.
     *
     * An explicit return rather than a fall-through: what follows accepts the
     * browser's session cookie, and this route must not. MCP is explicit that
     * a server must not accept a token that was not issued for it, and the
     * same rule rules out a credential that is not a token at all - which also
     * removes CSRF from this route by construction, since nothing it accepts
     * is sent by a browser automatically.
     *
     * Guarded on `declared` so that an instance with no connector installed
     * leaves this branch uninstalled entirely. The default resource path is
     * advertised so sign-in is discoverable on a bare instance, and nothing is
     * mounted on it; arming the branch anyway would turn a real route
     * Bearer-only the moment any plugin took that id and served that path.
     */
    if (
      this.resource.declared &&
      isResourceRequest(request, this.resource.path)
    ) {
      return await this.bearerOnly(request, context, checked);
    }

    /*
     * A device route, and every path beneath it, answers to a device token
     * and to nothing else (ADR 0031). An explicit return, as above: the cookie
     * is not read here at all, so a board member's browser that opens one is
     * refused like anyone else, and no person is put on the request.
     *
     * A plugin that is not serving, and a request that reached no route the
     * seal checked, were answered 404 by the plugin serving guard before this
     * ran, so the token of a switched-off plugin is never read.
     */
    const device = deviceRouteOfRequest(deviceRoutes(), request);
    if (device !== null) {
      return await this.deviceOnly(request, device);
    }

    /*
     * A path a device may still be asking that the version serving no longer
     * declares: its tokens were revoked as that version started serving, and
     * whatever the plugin mounts there now is an ordinary route the seal did
     * not hold to the device route rules, so no token opens it. A request that
     * presents one is refused as a device's, with the challenge that tells the
     * device its token is gone; one without is a person's, as anywhere else.
     * Where the path is now the protected resource, the branch above answered
     * and refused a device's token with this same challenge. A request no
     * handler matched never reaches a guard, and the hook
     * `registerRetiredDevicePathRefusal` refuses it with `retiredPathRefusal`.
     */
    if (
      request.headers.authorization !== undefined &&
      retiredDeviceRouteOfRequest(request) !== null
    ) {
      throw this.deviceRefusal(request)();
    }

    this.refuseForeignOrigin(request);

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        headers.append(name, value);
      }
    }

    const personId = await this.auth.personIdFromHeaders(headers);
    if (personId === null) {
      throw new UnauthorizedException("Sign in to continue.");
    }

    const principal = await this.principals.forPerson(personId);
    if (principal === null) {
      // An account whose person is gone must not act.
      throw new UnauthorizedException(
        "This account is not linked to a person.",
      );
    }
    request.principal = principal;
    /*
     * The mark a plugin cannot forge. A plugin dispatches an action by handing
     * back the request its own route received, and the registry reads the
     * person from it; without this, an object the plugin built itself would do
     * just as well and could name anybody.
     */
    markAuthenticated(request);

    const missing = this.required(context, checked).filter(
      (capability) => !principal.capabilities.has(capability),
    );
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing required permission: ${missing.join(", ")}`,
      );
    }

    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  /** The capabilities a request needs: the route's and its class's. */
  private required(
    context: ExecutionContext,
    checked: CheckedRoute | undefined,
  ): readonly Capability[] {
    return (
      checked?.capabilities ??
      this.reflector.getAllAndMerge<Capability[]>(REQUIRED_CAPABILITIES, [
        context.getHandler(),
        context.getClass(),
      ])
    );
  }

  /**
   * Refuses a change sent with the session cookie from a page on another
   * origin.
   *
   * The cookie is SameSite=Lax, which keeps it off a cross-site form post but
   * not off one from a same-site page: a sibling subdomain under the same
   * registrable domain, which is how instances are often hosted. A browser
   * names where a request came from in `Origin` on every POST, PUT, PATCH and
   * DELETE, and in `Sec-Fetch-Site`, so a change whose page was not this
   * application is refused here.
   *
   * A change that carries the cookie and neither header is refused too when
   * it is in one of the encodings an HTML form sends. Every browser in use
   * sends `Origin` on these methods, but one old enough not to would send the
   * cookie with a sibling's form and nothing here to tell where it came from,
   * and `Referer` is no help, since the page that posts the form decides
   * whether it is sent. A page on another origin can send no other body
   * without asking first, and this application answers no such question, so
   * a JSON change that names no origin was not sent by a page.
   *
   * Reads are left alone: they change nothing, and the answer is not readable
   * across origins. The sign-in routes under /api/auth are the library's own,
   * with an origin check of their own, and the resource route takes no cookie.
   */
  private refuseForeignOrigin(request: RequestWithPrincipal): void {
    if (!UNSAFE_METHODS.has(request.method)) {
      return;
    }
    const origin = request.headers.origin;
    const site = request.headers["sec-fetch-site"];
    const foreignOrigin = origin !== undefined && origin !== this.appOrigin;
    const foreignSite =
      site !== undefined && site !== "same-origin" && site !== "none";
    const unnamed =
      origin === undefined &&
      site === undefined &&
      request.headers.cookie !== undefined &&
      isFormEncoding(request.headers["content-type"]);
    if (foreignOrigin || foreignSite || unnamed) {
      throw new ForbiddenException(
        "A change has to be made from this application's own pages.",
      );
    }
  }

  /**
   * The whole of what the resource route accepts.
   *
   * No session lookup runs here at all - not as a fallback, not after a failed
   * token. A cookie is not a credential on this route.
   */
  private async bearerOnly(
    request: RequestWithPrincipal,
    context: ExecutionContext,
    checked: CheckedRoute | undefined,
  ): Promise<boolean> {
    const metadataUrl = resourceMetadataUrl(this.resource, this.env.APP_URL);
    const refusal = (): BearerUnauthorizedError =>
      new BearerUnauthorizedError(unauthorizedChallenge(metadataUrl));

    const token = bearerTokenOf(request);
    if (token === null) {
      throw refusal();
    }

    const identity = await this.bearer.resolve(token);
    if (identity === null) {
      throw this.retiredDeviceTokenRefusal(request, token) ?? refusal();
    }

    /*
     * The budget is taken in the guard rather than at dispatch, so it covers
     * every request on this route - session setup, a tool listing, a malformed
     * or oversized body - and not only the calls that reach a handler.
     *
     * It is taken after the token has resolved, and that is forced by the key:
     * the budget is counted against the access-token row, which does not exist
     * as an id until the row has been read. So the reads that resolution makes
     * - the token, the account, the person's capabilities and the client - are
     * paid on a request this then refuses. That is a deliberate ordering and
     * not an oversight: keying on something cheaper, the presented value or
     * its digest, would let anything at all open a counter and make the map a
     * place to put unbounded rubbish, which is a worse failure than paying for
     * four indexed reads. What this bounds is the work behind the route, not
     * the cost of finding out whose budget to charge.
     */
    const verdict = this.tokens.take(identity.tokenRowId);
    if (!verdict.allowed) {
      throw new TokenRateLimitedError(verdict.retryAfter);
    }

    request.principal = identity.principal;
    request.token = {
      clientId: identity.clientId,
      clientHost: identity.clientHost,
      scopes: identity.scopes,
      tokenRowId: identity.tokenRowId,
    };
    // The same mark the cookie path sets: this request's person was
    // established by core, so an action dispatched from it may be trusted to
    // be acting for them.
    markAuthenticated(request);

    const missing = this.required(context, checked).filter(
      (capability) => !identity.principal.capabilities.has(capability),
    );
    if (missing.length > 0) {
      // A capability refusal, not a scope one: the person this token acts for
      // may not do this, and asking for a wider scope would not change that.
      throw new ForbiddenException(
        `Missing required permission: ${missing.join(", ")}`,
      );
    }

    return true;
  }

  /**
   * The whole of what a device route accepts.
   *
   * GET and HEAD, with `Authorization: Bearer <device token>` for this route
   * of this plugin, live, and within its budget. Every refusal of the token is
   * the same 401, whatever the cause. No principal is attached and the request
   * is not marked authenticated, so the action registry refuses it; there is
   * no capability floor, because there is no person to hold one. What stands
   * in for the floor is the manifest rule that a plugin with a device route
   * reads nothing from the register.
   */
  private async deviceOnly(
    request: RequestWithPrincipal,
    route: DeviceRoute,
  ): Promise<boolean> {
    /*
     * The seal refuses a plugin that declares any other method under a device
     * route. This holds the line for a route it could not read so plainly.
     */
    if (!DEVICE_METHODS.has(request.method)) {
      throw new DeviceMethodNotAllowedError();
    }

    const refusal = this.deviceRefusal(request);

    // Read as on the protected resource. A token in the query string is never
    // read: query strings are written into request logs.
    const token = bearerTokenOf(request);
    if (token === null) {
      throw refusal();
    }

    const device = await this.devices.resolve(token, route);
    if (device === null) {
      throw refusal();
    }

    // Keyed on the token's row, never its value, for the reason the
    // connected app's budget is.
    const verdict = this.deviceTokens.take(device.id);
    if (!verdict.allowed) {
      throw new DeviceRateLimitedError(verdict.retryAfter);
    }

    markDeviceRequest(request, { pluginId: route.pluginId, device });
    return true;
  }

  /**
   * The refusal of a credential presented on a path a device may still be
   * asking that no current device route covers and no handler matched
   * (ADR 0031): the device route 401, so the device reads that its token is
   * gone, on the budget every refused device request spends. Throws the 429
   * itself once that is spent.
   *
   * Null where the path is now the protected resource and the credential is
   * not a device's: a connected app's request there is answered by the router
   * as anywhere else on the resource, not as a device's.
   */
  retiredPathRefusal(request: FastifyRequest): DeviceTokenInvalidError | null {
    if (
      this.resource.declared &&
      isResourceRequest(request, this.resource.path)
    ) {
      const token = bearerTokenOf(request);
      return token === null
        ? null
        : this.retiredDeviceTokenRefusal(request, token);
    }
    return this.deviceRefusal(request)();
  }

  /**
   * The device's refusal of a token the protected resource refused, where the
   * resource is a path a device may still be asking, or null.
   *
   * A later version may declare as its protected resource the path of a device
   * route it dropped. The tokens issued for that route were revoked, and the
   * devices given them go on asking the path; the resource's own challenge
   * would tell them nothing, and they would keep the token and ask with it for
   * ever. So a token of a device's form is refused there with the device's
   * 401, and anything else with the resource's. Read only once the
   * connected-app lookup has found nothing, so no token the resource accepts
   * is ever refused this way.
   */
  private retiredDeviceTokenRefusal(
    request: FastifyRequest,
    token: string,
  ): DeviceTokenInvalidError | null {
    if (
      !hasDeviceTokenForm(token) ||
      retiredDeviceRouteOfRequest(request) === null
    ) {
      return null;
    }
    return this.deviceRefusal(request)();
  }

  /**
   * The refusal of a device's token, spending the client address's budget.
   *
   * The budget is looked at before the token is: an address that has spent it
   * is answered 429 here, without a lookup at all.
   */
  private deviceRefusal(
    request: FastifyRequest,
  ): () => DeviceTokenInvalidError {
    const address = clientAddressOf(request, this.trustedProxies);
    const spent = this.deviceRefusals.peek(address, DEVICE_REFUSALS_PER_MINUTE);
    if (!spent.allowed) {
      throw new DeviceRateLimitedError(spent.retryAfterSeconds);
    }
    return () => {
      this.deviceRefusals.take(address, DEVICE_REFUSALS_PER_MINUTE);
      return new DeviceTokenInvalidError();
    };
  }
}

/**
 * Refuses a form-encoded body on the application's own API.
 *
 * Every client of /api writes JSON, or multipart for an upload, and a form
 * encoding is what an HTML form on any page can send without the preflight a
 * JSON body needs. Turning it away here leaves a page elsewhere no body it can
 * post that a route would read, on top of the origin check below. Two kinds of
 * route keep it, and are not under this prefix or are named: the sign-in
 * library's own paths, where the OAuth token endpoint is form-encoded by RFC
 * 6749, and the public site's forms, which are ordinary HTML forms at the
 * root of the origin.
 *
 * Read from the route the router matched rather than from the URL, so the
 * answer cannot depend on how the path was spelled. Before the public check,
 * because an anonymous route is as much a part of the API as any other.
 */
function refuseFormBody(request: FastifyRequest): void {
  const route =
    (request as { routeOptions?: { url?: string } }).routeOptions?.url ?? "";
  const type = request.headers["content-type"]?.trim().toLowerCase() ?? "";
  if (
    route.startsWith("/api/") &&
    !route.startsWith("/api/auth/") &&
    type.startsWith("application/x-www-form-urlencoded")
  ) {
    throw new UnsupportedMediaTypeException("Send the body as JSON.");
  }
}

/**
 * The token of an `Authorization: Bearer` header, or null when there is none
 * to read.
 *
 * Read straight off the raw headers rather than through a Headers copy. Two
 * Authorization headers arrive as an array, and the copy the cookie path
 * builds keeps only string values - so an array would be dropped and the
 * request would authenticate as nobody rather than be refused. Here it is
 * null, which every caller refuses, as an ambiguous credential deserves.
 *
 * The scheme is matched without regard to case, because RFC 9110 makes an
 * authentication scheme case-insensitive, and a conforming client that sends
 * `bearer` would otherwise be refused with a 401 it could do nothing about.
 * The credential after the scheme is not case-folded and is left exactly as
 * it arrived - only the scheme is.
 */
function bearerTokenOf(request: FastifyRequest): string | null {
  const presented = request.headers.authorization;
  if (
    typeof presented !== "string" ||
    presented.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME
  ) {
    return null;
  }
  const token = presented.slice(BEARER_SCHEME.length).trim();
  return token === "" ? null : token;
}

/** The path alone, with any query string dropped. */
function pathOf(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/**
 * Whether a request reaches the resource, read as the router reads it.
 *
 * The router matches the path after decoding its percent-escapes, so the raw
 * URL is not what decides which handler runs: `/mcp` spelled with an escaped
 * letter reaches the resource's handler while the raw text names another path.
 * The decoded path is compared, and so is the route the router matched, so
 * either spelling of the resource is Bearer-only. Decoding more than the router
 * does (an escaped slash) only widens the match, which is the conservative
 * direction: a 401 on a path that could have been allowed.
 */
function isResourceRequest(request: FastifyRequest, base: string): boolean {
  const matched = (request as { routeOptions?: { url?: string } }).routeOptions
    ?.url;
  return (
    isResourcePath(decodedPathOf(request.url), base) ||
    (matched !== undefined && isResourcePath(matched, base))
  );
}

function decodedPathOf(url: string): string {
  const path = pathOf(url);
  try {
    return decodeURIComponent(path);
  } catch {
    // A malformed escape is refused by the router before any guard runs.
    return path;
  }
}
