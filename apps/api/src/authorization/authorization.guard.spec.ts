import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { isAuthenticatedRequest } from "../actions/authenticated-request";
import type { AuthService } from "../auth/auth.service";
import {
  BearerUnauthorizedError,
  TokenRateLimitedError,
} from "../auth/bearer-errors";
import type {
  BearerIdentity,
  BearerPrincipalService,
} from "../auth/bearer-principal.service";
import type { ProtectedResource } from "../auth/protected-resource";
import type { Env } from "../config/env";
import {
  AuthorizationGuard,
  type RequestWithPrincipal,
} from "./authorization.guard";
import type { Capability, Principal } from "./capabilities";
import type { PrincipalService } from "./principal.service";

/**
 * The Bearer branch, which is the whole of what the resource route accepts.
 *
 * Two properties matter more than the rest and each has assertions of its own.
 * The first is that a session cookie is never consulted on this route - not as
 * a fallback and not after a token fails - because the seal makes every plugin
 * controller an ordinary cookie-authenticated route, so a fall-through would
 * make the connector's endpoint reachable with the browser's own cookie. The
 * second is that the branch is not installed at all when no plugin declares a
 * resource, because the default path is advertised on a bare instance and
 * arming it would convert a real route the moment a plugin took that id.
 */

const RESOURCE = "/api/plugin/connector/mcp";

const DECLARED: ProtectedResource = {
  declared: true,
  path: RESOURCE,
  url: `https://brf.example${RESOURCE}`,
};

const UNDECLARED: ProtectedResource = {
  declared: false,
  path: "/api/plugin/mcp-connector/mcp",
  url: "https://brf.example/api/plugin/mcp-connector/mcp",
};

function principal(capabilities: Capability[] = []): Principal {
  return {
    personId: "person-1",
    isAdmin: false,
    isPropertyManager: false,
    isBoardMember: true,
    isResident: true,
    isMember: true,
    capabilities: new Set(capabilities),
  };
}

function identity(overrides: Partial<BearerIdentity> = {}): BearerIdentity {
  return {
    principal: principal(["site:manage"]),
    tokenRowId: "token-row-1",
    clientId: "https://client.example/id",
    clientHost: "client.example",
    scopes: ["mcp:read", "mcp:write"],
    ...overrides,
  };
}

interface Built {
  guard: AuthorizationGuard;
  personIdFromHeaders: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  forPerson: ReturnType<typeof vi.fn>;
}

function build(options: {
  resource?: ProtectedResource;
  resolved?: BearerIdentity | null;
  required?: Capability[];
  callsPerMinute?: number;
}): Built {
  const personIdFromHeaders = vi.fn().mockResolvedValue("person-1");
  const forPerson = vi.fn().mockResolvedValue(principal(["site:manage"]));
  const resolve = vi
    .fn()
    .mockResolvedValue(
      options.resolved === undefined ? identity() : options.resolved,
    );

  const guard = new AuthorizationGuard(
    { personIdFromHeaders } as unknown as AuthService,
    { forPerson } as unknown as PrincipalService,
    {
      getAllAndOverride: () => undefined,
      getAllAndMerge: () => options.required ?? [],
    } as unknown as Reflector,
    { resolve } as unknown as BearerPrincipalService,
    {
      APP_URL: "https://brf.example",
      OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE: options.callsPerMinute ?? 60,
    } as Env,
    options.resource ?? DECLARED,
  );

  return { guard, personIdFromHeaders, resolve, forPerson };
}

function contextFor(request: RequestWithPrincipal): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function requestAt(
  url: string,
  headers: Record<string, unknown> = {},
): RequestWithPrincipal {
  return { url, headers } as unknown as RequestWithPrincipal;
}

describe("the resource route is Bearer-only", () => {
  it("never consults the session on the resource route", async () => {
    const { guard, personIdFromHeaders } = build({});
    const request = requestAt(RESOURCE, {
      authorization: "Bearer abc",
      // A browser cookie on this route buys nothing. Presenting one alongside
      // a valid token must not change how the request is authenticated.
      cookie: "better-auth.session_token=whatever",
    });

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(personIdFromHeaders).not.toHaveBeenCalled();
  });

  it("does not fall back to the session when the token is refused", async () => {
    const { guard, personIdFromHeaders } = build({ resolved: null });
    const request = requestAt(RESOURCE, {
      authorization: "Bearer stale",
      cookie: "better-auth.session_token=a-valid-session",
    });

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      BearerUnauthorizedError,
    );
    expect(personIdFromHeaders).not.toHaveBeenCalled();
  });

  it("covers every path beneath the resource", async () => {
    const { guard, personIdFromHeaders } = build({});
    const request = requestAt(`${RESOURCE}/messages`, {
      authorization: "Bearer abc",
    });

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(personIdFromHeaders).not.toHaveBeenCalled();
  });

  it("leaves a sibling route that merely starts the same alone", async () => {
    const { guard, personIdFromHeaders, resolve } = build({});
    // /api/plugin/connector/mcpx is a different route on the same plugin. A
    // prefix match without the separator would make it Bearer-only.
    const request = requestAt(`${RESOURCE}x`, {});

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(personIdFromHeaders).toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("matches on the path with the query string dropped", async () => {
    const { guard, personIdFromHeaders } = build({});
    const request = requestAt(`${RESOURCE}?sessionId=1`, {
      authorization: "Bearer abc",
    });

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(personIdFromHeaders).not.toHaveBeenCalled();
  });

  it("is reached only for a route that is not public", async () => {
    /*
     * The public check runs before this branch, so a route on the resource
     * path that declared itself public would be served to anybody. That is
     * safe only because of something in another file: the module seal defines
     * IS_PUBLIC_ROUTE false on every plugin handler it mounts - false rather
     * than deleted, so a controller extending a public base cannot inherit the
     * opt-out - and the resource is always a plugin's route.
     *
     * This asserts the ordering deliberately, so that the coupling has
     * something to break if the seal ever stops doing that.
     */
    const { personIdFromHeaders, resolve } = build({});
    const reflector = {
      getAllAndOverride: () => true,
      getAllAndMerge: () => [],
    } as unknown as Reflector;
    const asPublic = new AuthorizationGuard(
      { personIdFromHeaders } as unknown as AuthService,
      {} as unknown as PrincipalService,
      reflector,
      { resolve } as unknown as BearerPrincipalService,
      {
        APP_URL: "https://brf.example",
        OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE: 60,
      } as Env,
      DECLARED,
    );

    await expect(
      asPublic.canActivate(contextFor(requestAt(RESOURCE, {}))),
    ).resolves.toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("is not installed at all when no plugin declares a resource", async () => {
    const { guard, personIdFromHeaders, resolve } = build({
      resource: UNDECLARED,
    });
    // The advertised default path on a bare instance. Nothing serves it, and
    // the branch must not arm on it: a plugin later taking that id and serving
    // that path would otherwise have a real route silently turned Bearer-only.
    const request = requestAt(UNDECLARED.path, {
      authorization: "Bearer abc",
    });

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(personIdFromHeaders).toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("what the resource route refuses", () => {
  it("refuses a request with no credential", async () => {
    const { guard } = build({});

    await expect(
      guard.canActivate(contextFor(requestAt(RESOURCE, {}))),
    ).rejects.toThrow(BearerUnauthorizedError);
  });

  it("refuses two Authorization headers rather than ignoring them", async () => {
    const { guard, resolve } = build({});
    // Fastify hands repeated headers over as an array. The cookie path's
    // Headers copy keeps only string values, so an array would be dropped
    // there and the request would authenticate as nobody; here an ambiguous
    // credential is refused.
    const request = requestAt(RESOURCE, {
      authorization: ["Bearer one", "Bearer two"],
    });

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      BearerUnauthorizedError,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a credential that is not a Bearer token", async () => {
    const { guard, resolve } = build({});
    const request = requestAt(RESOURCE, {
      authorization: "Basic YWRtaW46aHVudGVyMg==",
    });

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      BearerUnauthorizedError,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("accepts the scheme in any case, and leaves the credential alone", async () => {
    // RFC 9110 makes an authentication scheme case-insensitive, so a
    // conforming client sending "bearer" is not presenting a broken
    // credential. Only the scheme is folded: the token is looked up exactly as
    // it arrived, or a value differing only in case would resolve to somebody
    // else's row.
    const { guard, resolve } = build({});
    const request = requestAt(RESOURCE, { authorization: "bEaReR AbC" });

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledWith("AbC");
  });

  it("refuses an empty Bearer value without a lookup", async () => {
    const { guard, resolve } = build({});
    const request = requestAt(RESOURCE, { authorization: "Bearer    " });

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      BearerUnauthorizedError,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("says where a token comes from when it refuses", async () => {
    const { guard } = build({ resolved: null });
    const request = requestAt(RESOURCE, { authorization: "Bearer no" });

    const error = await guard
      .canActivate(contextFor(request))
      .then(() => null)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BearerUnauthorizedError);
    // The pointer names the sub-path form, which is the route the connector
    // actually serves. Without it a refused client has an address and nothing
    // to do about it.
    expect((error as BearerUnauthorizedError).headers()).toEqual({
      "www-authenticate": `Bearer resource_metadata="https://brf.example/.well-known/oauth-protected-resource${RESOURCE}"`,
    });
  });

  it("tells a refused caller nothing about why", async () => {
    const { guard } = build({ resolved: null });
    const request = requestAt(RESOURCE, { authorization: "Bearer no" });

    const error = await guard
      .canActivate(contextFor(request))
      .then(() => null)
      .catch((cause: unknown) => cause);

    // Expired, revoked and never-existed are one answer: the difference is
    // information about somebody else's connection.
    const message = (error as Error).message;
    for (const leak of ["expired", "revoked", "unknown", "audience"]) {
      expect(message.toLowerCase()).not.toContain(leak);
    }
  });

  it("refuses on a capability the person does not hold", async () => {
    const { guard } = build({
      resolved: identity({ principal: principal([]) }),
      required: ["site:manage"],
    });
    const request = requestAt(RESOURCE, { authorization: "Bearer abc" });

    // A capability refusal, not a scope one: a wider scope would not help,
    // because the person themselves may not do this.
    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe("what the resource route establishes", () => {
  it("attaches the principal and the client the token acts for", async () => {
    const { guard } = build({});
    const request = requestAt(RESOURCE, { authorization: "Bearer abc" });

    await guard.canActivate(contextFor(request));

    expect(request.principal?.personId).toBe("person-1");
    expect(request.token).toEqual({
      clientId: "https://client.example/id",
      clientHost: "client.example",
      scopes: ["mcp:read", "mcp:write"],
      tokenRowId: "token-row-1",
    });
  });

  it("marks the request as one the platform authenticated", async () => {
    const { guard } = build({});
    const request = requestAt(RESOURCE, { authorization: "Bearer abc" });

    await guard.canActivate(contextFor(request));

    // Without the mark the action registry refuses to dispatch from this
    // request at all, so a connected app could reach no action.
    expect(isAuthenticatedRequest(request)).toBe(true);
  });

  it("passes the token value to the resolver and holds only the row id", async () => {
    const { guard, resolve } = build({});
    const request = requestAt(RESOURCE, {
      authorization: "Bearer the-secret-value",
    });

    await guard.canActivate(contextFor(request));

    expect(resolve).toHaveBeenCalledWith("the-secret-value");
    // The bearer value is a credential. Nothing downstream may hold it.
    expect(JSON.stringify(request.token)).not.toContain("the-secret-value");
  });
});

describe("the per-token budget", () => {
  it("refuses once the token has spent its minute", async () => {
    const { guard } = build({ callsPerMinute: 2 });
    const send = async () =>
      guard.canActivate(
        contextFor(requestAt(RESOURCE, { authorization: "Bearer abc" })),
      );

    await expect(send()).resolves.toBe(true);
    await expect(send()).resolves.toBe(true);
    await expect(send()).rejects.toThrow(TokenRateLimitedError);
  });

  it("names a delay the caller can act on", async () => {
    const { guard } = build({ callsPerMinute: 1 });
    const send = async () =>
      guard.canActivate(
        contextFor(requestAt(RESOURCE, { authorization: "Bearer abc" })),
      );

    await send();
    const error = await send()
      .then(() => null)
      .catch((cause: unknown) => cause);

    const retryAfter = Number(
      (error as TokenRateLimitedError).headers()["retry-after"],
    );
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("counts per token rather than per route", async () => {
    const { guard, resolve } = build({ callsPerMinute: 1 });
    const send = async () =>
      guard.canActivate(
        contextFor(requestAt(RESOURCE, { authorization: "Bearer abc" })),
      );

    await send();
    // A second connection is a second budget. Keying on the route, or on the
    // client address, would let one connected app throttle the whole
    // cooperative.
    resolve.mockResolvedValue(identity({ tokenRowId: "token-row-2" }));
    await expect(send()).resolves.toBe(true);
  });

  it("is charged before the route runs, so a refused call still costs", async () => {
    const { guard } = build({
      callsPerMinute: 1,
      resolved: identity({ principal: principal([]) }),
      required: ["site:manage"],
    });
    const send = async () =>
      guard.canActivate(
        contextFor(requestAt(RESOURCE, { authorization: "Bearer abc" })),
      );

    // The budget is taken before the capability check, so a call refused on
    // capabilities has still been counted and a client cannot use refusals as
    // an unlimited probe. The same holds for a malformed body or a tool
    // listing, which is why it is charged in the guard and not at dispatch.
    await expect(send()).rejects.toThrow(ForbiddenException);
    await expect(send()).rejects.toThrow(TokenRateLimitedError);
  });
});
