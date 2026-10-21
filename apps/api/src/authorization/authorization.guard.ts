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
import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import {
  type CheckedRoute,
  checkedRoute,
  fixedController,
} from "../plugins/plugin-module-seal";
import {
  SupportAccessService,
  type SupportSessionContext,
} from "../support/support-access.service";
import { supportCapabilities } from "../support/support-capabilities";
import {
  SupportReadOnlyError,
  SupportRouteRefusedError,
  SupportSessionInvalidError,
} from "../support/support-errors";
import { SupportSessionCookie } from "../support/support-session-cookie";
import type { Capability, Principal } from "./capabilities";
import { CLOSED_TO_SUPPORT } from "./closed-to-support.decorator";
import { OPEN_TO_SUPPORT } from "./open-to-support.decorator";
import { PrincipalService } from "./principal.service";
import { IS_PUBLIC_ROUTE } from "./public.decorator";
import { REQUIRED_CAPABILITIES } from "./require-capability.decorator";

/**
 * The authentication scheme the resource route accepts, already lower-cased
 * for the comparison. Only the scheme is case-insensitive; the credential
 * after it is not.
 */
const BEARER_SCHEME = "bearer ";

/** The methods that change something, which a page on another site can send. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The methods a support session may use: reads, named rather than derived by
 * leaving the changes out, so a route answering some other method is refused
 * to it until somebody decides otherwise (ADR 0028).
 */
const SUPPORT_METHODS = new Set(["GET", "HEAD"]);

/** Requests one support session may make in a minute (ADR 0028). */
export const SUPPORT_REQUESTS_PER_MINUTE = 120;

/**
 * The support session's own routes, which read its cookie themselves: signing
 * in with a new link and signing out. Every other route a support cookie comes
 * with is decided by the guard's support branch.
 */
const SUPPORT_SESSION_ROUTE = "/api/support/session";

/** Where the sign-in library's routes are mounted. */
const SIGN_IN_LIBRARY_PREFIX = "/api/auth/";

/** Where a plugin's routes are mounted (plugin-module-seal.ts). */
const PLUGIN_ROUTE_PREFIX = "/api/plugin/";

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
  /**
   * The support session the request was made under (ADR 0028), set by the
   * guard alone. When it is set, `principal` is the administrator who opened
   * the access, narrowed to the support capabilities, and nothing about the
   * request is anybody's own.
   */
  support?: SupportSessionContext;
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
  /** Where this application's own pages are served from. */
  private readonly appOrigin: string;
  /** The support session's cookie, and the budget each session spends. */
  private readonly supportCookie: SupportSessionCookie;
  private readonly supportBudget = new TokenRateLimiter(
    SUPPORT_REQUESTS_PER_MINUTE,
  );

  constructor(
    private readonly auth: AuthService,
    private readonly principals: PrincipalService,
    private readonly reflector: Reflector,
    private readonly bearer: BearerPrincipalService,
    @Inject(ENV) private readonly env: Env,
    @Inject(PROTECTED_RESOURCE) private readonly resource: ProtectedResource,
    private readonly support: SupportAccessService,
    private readonly audit: AuditLogService,
  ) {
    this.tokens = new TokenRateLimiter(env.OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE);
    this.appOrigin = new URL(env.APP_URL).origin;
    this.supportCookie = new SupportSessionCookie(env.APP_URL);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    refuseFormBody(request);

    /*
     * A support session's cookie, when the request carries one, is the only
     * credential considered (ADR 0028) - ahead of the public routes, so a
     * supporter cannot post a public form either, and ahead of the sign-in
     * library's session, so a browser holding both is never the account. The
     * resource route takes no cookie at all and is left to its own branch, and
     * the support session's own two routes read the cookie themselves.
     */
    const presented = this.supportCookie.presented(request.headers.cookie);
    if (
      presented.kind !== "none" &&
      routeOf(request) !== SUPPORT_SESSION_ROUTE &&
      !(
        this.resource.declared && isResourceRequest(request, this.resource.path)
      )
    ) {
      return await this.supportOnly(
        request,
        context,
        presented.kind === "token" ? presented.token : null,
      );
    }

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
     * just as well and could name anybody. The mark holds what was found
     * here, so a plugin that writes a token onto the request afterwards does
     * not turn this session into a connected app.
     */
    markAuthenticated(request, {
      personId: principal.personId,
      token: null,
      requestId: request.id,
    });

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
   * The whole of what a request carrying a support session's cookie may do.
   *
   * No account session is looked up here, not as a fallback and not after the
   * cookie fails: a cookie that does not resolve is a 401 that clears it.
   * Then, in this order, and before any capability is read:
   *
   * - anything but a read (GET or HEAD) is refused. A supporter looks and the
   *   association acts;
   * - a plugin's route is refused whatever its method, because core cannot
   *   vouch for what a plugin does on a GET, and so is the sign-in library's,
   *   which is about accounts and a supporter has none, and any route closed
   *   to support sessions by name;
   * - the session's budget is spent, 120 requests a minute, which bounds the
   *   entries a runaway tab can write.
   *
   * The principal is the administrator who opened the access, holding the
   * support capabilities rather than their own and none of their roles: the
   * entries name them as the person on whose instruction the request was made,
   * and nothing is answered from their own record. A route that declares no
   * capability is refused unless it says it is open to a support session.
   *
   * Every request let through is an entry on SUPPORT, written before the
   * handler runs: the method, the route as the router matched it and its path
   * parameters, never the query string.
   */
  private async supportOnly(
    request: RequestWithPrincipal,
    context: ExecutionContext,
    token: string | null,
  ): Promise<boolean> {
    const session = token === null ? null : await this.support.resolve(token);
    if (session === null) {
      throw new SupportSessionInvalidError(this.supportCookie.clear());
    }

    if (!SUPPORT_METHODS.has(request.method)) {
      throw new SupportReadOnlyError();
    }

    const route = routeOf(request);
    if (
      fixedController(context.getClass()) !== undefined ||
      route.startsWith(PLUGIN_ROUTE_PREFIX) ||
      route.startsWith(SIGN_IN_LIBRARY_PREFIX) ||
      this.flagged(context, CLOSED_TO_SUPPORT)
    ) {
      throw new SupportRouteRefusedError();
    }

    const verdict = this.supportBudget.take(session.sessionId);
    if (!verdict.allowed) {
      throw new TokenRateLimitedError(verdict.retryAfter);
    }

    const principal: Principal = {
      personId: session.openedById,
      isAdmin: false,
      isBoardMember: false,
      isPropertyManager: false,
      isResident: false,
      isMember: false,
      capabilities: supportCapabilities(),
      supportSessionId: session.sessionId,
    };
    request.principal = principal;
    request.support = session;

    if (!this.isPublic(context)) {
      const required = this.required(context, undefined);
      if (required.length === 0 && !this.flagged(context, OPEN_TO_SUPPORT)) {
        throw new SupportRouteRefusedError();
      }
      const missing = required.filter(
        (capability) => !principal.capabilities.has(capability),
      );
      if (missing.length > 0) {
        throw new ForbiddenException(
          `Missing required permission: ${missing.join(", ")}`,
        );
      }
    }

    await this.audit.record({
      action: "SUPPORT_REQUEST",
      channel: "SUPPORT",
      supportSessionId: session.sessionId,
      actorPersonId: session.openedById,
      context: {
        method: request.method,
        route,
        params: pathParameters(request),
      },
    });
    return true;
  }

  /** Whether the route or its class carries a support decorator. */
  private flagged(context: ExecutionContext, key: string): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(key, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
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

    /*
     * Read straight off the raw headers rather than through a Headers copy.
     * Two Authorization headers arrive as an array, and the copy the cookie
     * path builds keeps only string values - so an array would be dropped and
     * the request would authenticate as nobody rather than be refused. Here it
     * is a refusal, which is what an ambiguous credential deserves.
     */
    const presented = request.headers.authorization;
    if (typeof presented !== "string") {
      throw refusal();
    }

    /*
     * The scheme is matched without regard to case, because RFC 9110 makes an
     * authentication scheme case-insensitive. A conforming client that sends
     * `bearer` was refused here with a 401 it could do nothing about. The
     * credential after the scheme is not case-folded and is left exactly as it
     * arrived - only the scheme is.
     */
    if (
      presented.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME
    ) {
      throw refusal();
    }

    const token = presented.slice(BEARER_SCHEME.length).trim();
    if (token === "") {
      throw refusal();
    }

    const identity = await this.bearer.resolve(token);
    if (identity === null) {
      throw refusal();
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
    // be acting for them. The mark keeps its own copy of the token's client
    // and scopes; `request.token` is what controllers read, and changing it
    // changes nothing an action is decided on.
    markAuthenticated(request, {
      personId: identity.principal.personId,
      token: {
        clientId: identity.clientId,
        clientHost: identity.clientHost,
        scopes: identity.scopes,
      },
      requestId: request.id,
    });

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
  const route = routeOf(request);
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
 * The route the router matched, as it spells it: `/api/documents/:id`, never
 * the path the request named. Empty when the router matched nothing.
 */
function routeOf(request: FastifyRequest): string {
  return (
    (request as { routeOptions?: { url?: string } }).routeOptions?.url ?? ""
  );
}

/**
 * The path parameters the router read, as strings. Identifiers, which are
 * what lets the association answer whose record a supporter opened; the query
 * string is never read, because a search box can put a name there.
 */
function pathParameters(request: FastifyRequest): Record<string, string> {
  const params = request.params;
  if (typeof params !== "object" || params === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
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
function isResourceRequest(
  request: RequestWithPrincipal,
  base: string,
): boolean {
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
