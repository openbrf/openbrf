import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
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
  /** Where this application's own pages are served from. */
  private readonly appOrigin: string;

  constructor(
    private readonly auth: AuthService,
    private readonly principals: PrincipalService,
    private readonly reflector: Reflector,
    private readonly bearer: BearerPrincipalService,
    @Inject(ENV) private readonly env: Env,
    @Inject(PROTECTED_RESOURCE) private readonly resource: ProtectedResource,
  ) {
    this.tokens = new TokenRateLimiter(env.OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE);
    this.appOrigin = new URL(env.APP_URL).origin;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_ROUTE,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic === true) {
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
      return await this.bearerOnly(request, context);
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

    const required = this.reflector.getAllAndMerge<Capability[]>(
      REQUIRED_CAPABILITIES,
      [context.getHandler(), context.getClass()],
    );

    const missing = required.filter(
      (capability) => !principal.capabilities.has(capability),
    );
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing required permission: ${missing.join(", ")}`,
      );
    }

    return true;
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
    // be acting for them.
    markAuthenticated(request);

    const required = this.reflector.getAllAndMerge<Capability[]>(
      REQUIRED_CAPABILITIES,
      [context.getHandler(), context.getClass()],
    );
    const missing = required.filter(
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
