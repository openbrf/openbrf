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

  constructor(
    private readonly auth: AuthService,
    private readonly principals: PrincipalService,
    private readonly reflector: Reflector,
    private readonly bearer: BearerPrincipalService,
    @Inject(ENV) private readonly env: Env,
    @Inject(PROTECTED_RESOURCE) private readonly resource: ProtectedResource,
  ) {
    this.tokens = new TokenRateLimiter(env.OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE);
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
      isResourcePath(pathOf(request.url), this.resource.path)
    ) {
      return await this.bearerOnly(request, context);
    }

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
