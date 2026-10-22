import type { ExecutionContext, Type } from "@nestjs/common";
import {
  Controller,
  ForbiddenException,
  Get,
  Module,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { ModulesContainer, NestFactory, Reflector } from "@nestjs/core";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { DeviceTokenSummary } from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import {
  authenticatedFacts,
  isAnsweredRequest,
  isAuthenticatedRequest,
  type MarkedResponse,
} from "../actions/authenticated-request";
import { LiveResponse } from "../actions/testing/live-response";
import type { AuditLogService } from "../audit/audit-log.service";
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
import { deviceRequestOf } from "../devices/device-request";
import { resolveDeviceRoutes, setDeviceRoutes } from "../devices/device-routes";
import type { DeviceTokenResolver } from "../devices/device-token-resolver";
import {
  DeviceMethodNotAllowedError,
  DeviceRateLimitedError,
  DeviceTokenInvalidError,
} from "../devices/device-token.errors";
import type { SupportAccessService } from "../support/support-access.service";
import {
  hostModules,
  sealModuleInstances,
  sealPluginModule,
} from "../plugins/plugin-module-seal";
import {
  AuthorizationGuard,
  type RequestWithPrincipal,
} from "./authorization.guard";
import type { Capability, Principal } from "./capabilities";
import type { PrincipalService } from "./principal.service";
import { IS_PUBLIC_ROUTE } from "./public.decorator";
import { REQUIRED_CAPABILITIES } from "./require-capability.decorator";

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

/*
 * The support branch is never entered here; authorization.guard.support.spec.ts
 * covers it. One request to a device route carries a support session's cookie,
 * to show that the branch leaves device routes alone.
 */
const NO_SUPPORT = {
  resolve: () => {
    throw new Error("No request in this file carries a support cookie.");
  },
} as unknown as SupportAccessService;

const NO_AUDIT = {
  record: () => {
    throw new Error("No request in this file is a support session's.");
  },
} as unknown as AuditLogService;

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
  resolveDevice: ReturnType<typeof vi.fn>;
}

function build(options: {
  resource?: ProtectedResource;
  resolved?: BearerIdentity | null;
  required?: Capability[];
  callsPerMinute?: number;
  reflector?: Reflector;
  device?: DeviceTokenSummary | null;
  deviceCallsPerMinute?: number;
}): Built {
  const personIdFromHeaders = vi.fn().mockResolvedValue("person-1");
  const forPerson = vi.fn().mockResolvedValue(principal(["site:manage"]));
  const resolve = vi
    .fn()
    .mockResolvedValue(
      options.resolved === undefined ? identity() : options.resolved,
    );
  const resolveDevice = vi.fn().mockResolvedValue(options.device ?? null);

  const guard = new AuthorizationGuard(
    { personIdFromHeaders } as unknown as AuthService,
    { forPerson } as unknown as PrincipalService,
    options.reflector ??
      ({
        getAllAndOverride: () => undefined,
        getAllAndMerge: () => options.required ?? [],
      } as unknown as Reflector),
    { resolve } as unknown as BearerPrincipalService,
    {
      APP_URL: "https://brf.example",
      OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE: options.callsPerMinute ?? 60,
      OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE:
        options.deviceCallsPerMinute ?? 120,
      TRUSTED_PROXIES: [],
    } as unknown as Env,
    options.resource ?? DECLARED,
    { resolve: resolveDevice } as unknown as DeviceTokenResolver,
    NO_SUPPORT,
    NO_AUDIT,
  );

  return { guard, personIdFromHeaders, resolve, forPerson, resolveDevice };
}

function contextFor(
  request: RequestWithPrincipal,
  response: MarkedResponse = new LiveResponse(),
): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ raw: response }),
    }),
  } as unknown as ExecutionContext;
}

function requestAt(
  url: string,
  headers: Record<string, unknown> = {},
): RequestWithPrincipal {
  return { id: "req-1", url, headers } as unknown as RequestWithPrincipal;
}

interface Connection {
  /** Node's own response for the request the client sent. */
  response: ServerResponse;
  /** Drops the client's end and settles once the response has closed. */
  hangUp: () => Promise<void>;
  stop: () => Promise<void>;
}

/** A real connection whose client the test can hang up on. */
async function connection(): Promise<Connection> {
  const server = createServer();
  const arrived = once(server, "request") as Promise<[unknown, ServerResponse]>;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = server.address() as AddressInfo;
  const client = httpRequest({ host: "127.0.0.1", port });
  client.on("error", () => undefined);
  client.end();
  const [, response] = await arrived;

  return {
    response,
    hangUp: async () => {
      const closed = once(response, "close");
      client.destroy();
      await closed;
    },
    stop: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
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

  it.each([
    "/api/plugin/connector/%6Dcp",
    "/api/plugin/connector/m%63p",
    "/api/plugin/connector/%6D%63%70/messages",
    "/api/plugin/connector%2Fmcp",
  ])(
    "reads %s as the router does, and refuses the session there",
    async (url) => {
      const { guard, personIdFromHeaders } = build({ resolved: null });
      const request = requestAt(url, {
        cookie: "better-auth.session_token=a-valid-session",
      });

      await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
        BearerUnauthorizedError,
      );
      expect(personIdFromHeaders).not.toHaveBeenCalled();
    },
  );

  it("reads the route the router matched as well as the path", async () => {
    const { guard, personIdFromHeaders } = build({ resolved: null });
    const request = {
      ...requestAt("/api/plugin/connector/elsewhere", {
        cookie: "better-auth.session_token=a-valid-session",
      }),
      routeOptions: { url: `${RESOURCE}/*` },
    } as unknown as RequestWithPrincipal;

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      BearerUnauthorizedError,
    );
    expect(personIdFromHeaders).not.toHaveBeenCalled();
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
        OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE: 120,
        TRUSTED_PROXIES: [],
      } as unknown as Env,
      DECLARED,
      { resolve: async () => null } as unknown as DeviceTokenResolver,
      NO_SUPPORT,
      NO_AUDIT,
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

describe("what a signed-in session establishes", () => {
  it("records the person and no token", async () => {
    // A session is the web interface, so the mark holds no token for the
    // caller factory to read a connected app from, and a token written onto
    // the request afterwards does not add one.
    const { guard } = build({});
    const request = requestAt("/api/news", { cookie: "session=abc" });

    await guard.canActivate(contextFor(request));
    request.token = {
      clientId: "invented-app",
      clientHost: "invented.example",
      scopes: ["mcp:read", "mcp:write"],
      tokenRowId: "not-a-real-token",
    };

    expect(authenticatedFacts(request)).toEqual({
      personId: "person-1",
      token: null,
      requestId: "req-1",
    });
  });
});

describe("a route naming several capabilities", () => {
  it("requires every one of them, not any one", async () => {
    // The accounting basis names two, and no role holds exactly one, so this
    // is where "both" rather than "either" is held.
    const required: Capability[] = ["fees:manage", "memberCharges:manage"];
    const { guard, forPerson } = build({ required });
    const request = requestAt("/api/accounting-basis/export", {
      cookie: "session=abc",
    });

    for (const held of [["fees:manage"], ["memberCharges:manage"]] as const) {
      forPerson.mockResolvedValueOnce(principal([...held]));
      await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
        ForbiddenException,
      );
    }

    forPerson.mockResolvedValueOnce(principal(required));
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
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
    expect(authenticatedFacts(request)).toEqual({
      personId: "person-1",
      token: {
        clientId: "https://client.example/id",
        clientHost: "client.example",
        scopes: ["mcp:read", "mcp:write"],
      },
      requestId: "req-1",
    });
  });

  it("keeps what it established apart from what the request carries", async () => {
    // A plugin's route holds this request and can write on it. What the mark
    // holds was copied when the guard wrote it, and stays as it was.
    const { guard } = build({});
    const request = requestAt(RESOURCE, { authorization: "Bearer abc" });
    await guard.canActivate(contextFor(request));
    const established = structuredClone(authenticatedFacts(request));

    request.token?.scopes.push("mcp:admin");
    Object.assign(request.token ?? {}, { clientId: "invented-app" });
    delete request.token;
    Object.assign(request, {
      id: "req-2",
      principal: { personId: "somebody-else" },
    });

    expect(authenticatedFacts(request)).toEqual(established);
    expect(Object.isFrozen(authenticatedFacts(request)?.token?.scopes)).toBe(
      true,
    );
  });

  it("ends the mark once the response is sent", async () => {
    // A plugin can keep the request it was handed. Once the response is out,
    // the person who made it is not on the other end of it any more, and an
    // action or audit entry taken on it later must not name them.
    const { guard } = build({});
    const request = requestAt(RESOURCE, { authorization: "Bearer abc" });
    const response = new LiveResponse();

    await guard.canActivate(contextFor(request, response));
    response.emit("finish");

    expect(isAuthenticatedRequest(request)).toBe(false);
    expect(isAnsweredRequest(request)).toBe(true);
  });

  it("ends the mark on a session request whose connection closed first", async () => {
    // A client that hung up never sees a `finish`, and nobody is on the other
    // end of that request either.
    const { guard } = build({});
    const request = requestAt("/api/news", { cookie: "session=abc" });
    const response = new LiveResponse();

    await guard.canActivate(contextFor(request, response));
    expect(isAuthenticatedRequest(request)).toBe(true);
    response.emit("close");

    expect(isAuthenticatedRequest(request)).toBe(false);
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

describe("a request whose person hung up while it was authenticated", () => {
  /*
   * The guard waits on the session or the token before it marks the request,
   * and the client can go in that wait. Its response has then closed before
   * anything listened for it, and closes no second time, so a mark added
   * regardless would last for good: a plugin keeping the request could act as
   * that person whenever it liked. Against Node's own response, because what
   * is being settled is the state a real one is in by then.
   */
  it.each([
    { credential: "a session", url: "/api/news", cookie: "session=abc" },
    { credential: "a token", url: RESOURCE, authorization: "Bearer abc" },
  ])("is never marked, on $credential", async ({ url, ...headers }) => {
    const { guard, personIdFromHeaders, resolve } = build({});
    let resume = (): void => undefined;
    const suspended = new Promise<void>((resumed) => {
      resume = resumed;
    });
    personIdFromHeaders.mockReturnValue(suspended.then(() => "person-1"));
    resolve.mockReturnValue(suspended.then(() => identity()));
    const { response, hangUp, stop } = await connection();

    try {
      const request = requestAt(url, headers);
      const checking = guard.canActivate(contextFor(request, response));
      await hangUp();
      resume();
      await checking;

      expect(isAuthenticatedRequest(request)).toBe(false);
      expect(isAnsweredRequest(request)).toBe(true);
      const callers = new ActionCallerFactory();
      expect(() =>
        callers.forRequest(request as unknown as RequestWithToken),
      ).toThrow(/has been answered/i);
      expect(() =>
        callers.forPlugin(request as unknown as RequestWithToken, {
          id: "parking",
          ai: false,
        }),
      ).toThrow(/has been answered/i);
    } finally {
      await stop();
    }
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

describe("a change sent with the session cookie", () => {
  const change = (headers: Record<string, unknown>, method = "POST") =>
    ({
      url: "/api/invitations",
      method,
      headers: {
        cookie: "better-auth.session_token=a-valid-session",
        ...headers,
      },
    }) as unknown as RequestWithPrincipal;

  it.each([
    ["another origin", { origin: "https://evil.example" }],
    ["a sibling site", { "sec-fetch-site": "same-site" }],
    ["another site", { "sec-fetch-site": "cross-site" }],
    // A browser too old to send either header, posting a sibling's form.
    [
      "a form that names no origin",
      { "content-type": "application/x-www-form-urlencoded" },
    ],
    [
      "an upload that names no origin",
      { "content-type": "multipart/form-data; boundary=x" },
    ],
    ["plain text that names no origin", { "content-type": "Text/Plain" }],
  ])(
    "is refused from %s, before the session is read",
    async (_name, headers) => {
      const { guard, personIdFromHeaders } = build({});

      await expect(
        guard.canActivate(contextFor(change(headers))),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(personIdFromHeaders).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "this application's own pages",
      { origin: "https://brf.example", "sec-fetch-site": "same-origin" },
    ],
    [
      "this application's own pages, by Origin alone",
      { origin: "https://brf.example" },
    ],
    // A client that is not a browser names no origin. A page cannot send JSON
    // to another origin without a preflight, which this server never answers,
    // so only the form encodings above are refused for naming none.
    [
      "a client that is not a browser, sending JSON",
      { "content-type": "application/json" },
    ],
    ["a client that is not a browser, sending no body", {}],
  ])("is accepted from %s", async (_name, headers) => {
    const { guard } = build({});

    await expect(guard.canActivate(contextFor(change(headers)))).resolves.toBe(
      true,
    );
  });

  it("leaves a change without the cookie to the sign-in check", async () => {
    const { guard, personIdFromHeaders } = build({});
    const request = {
      url: "/api/invitations",
      method: "POST",
      headers: {},
    } as unknown as RequestWithPrincipal;

    // Nothing a browser sends on its own, so nothing a page could forge: it
    // gets the answer anybody signed out gets, not a refusal of its origin.
    await guard.canActivate(contextFor(request)).catch(() => undefined);
    expect(personIdFromHeaders).toHaveBeenCalled();
  });

  it("leaves a read from another origin alone", async () => {
    const { guard } = build({});

    await expect(
      guard.canActivate(
        contextFor(change({ origin: "https://evil.example" }, "GET")),
      ),
    ).resolves.toBe(true);
  });
});

describe("a form-encoded body", () => {
  const posted = (route: string, contentType: string) =>
    ({
      url: route,
      method: "POST",
      routeOptions: { url: route },
      headers: {
        cookie: "better-auth.session_token=a-valid-session",
        origin: "https://brf.example",
        "content-type": contentType,
      },
    }) as unknown as RequestWithPrincipal;

  it.each([
    "application/x-www-form-urlencoded",
    "Application/X-WWW-Form-Urlencoded; charset=UTF-8",
  ])(
    "is refused on the API as %s, before the session is read",
    async (contentType) => {
      const { guard, personIdFromHeaders } = build({});

      await expect(
        guard.canActivate(contextFor(posted("/api/invitations", contentType))),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(personIdFromHeaders).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["the sign-in library's own paths", "/api/auth/*"],
    ["the public site's forms", "/:slug/kontakt"],
  ])("is left to %s", async (_name, route) => {
    const { guard } = build({});

    await expect(
      guard.canActivate(
        contextFor(posted(route, "application/x-www-form-urlencoded")),
      ),
    ).resolves.toBe(true);
  });

  it("leaves a JSON body on the API alone", async () => {
    const { guard } = build({});

    await expect(
      guard.canActivate(
        contextFor(posted("/api/invitations", "application/json")),
      ),
    ).resolves.toBe(true);
  });
});

/**
 * A plugin's route is authorized by what the seal checked of it, not by its
 * metadata, which the plugin's own code can write again once it is checked.
 */
describe("a route of a plugin's the seal checked", () => {
  const PLUGIN_ID = "occupancy";
  const MOUNTED = `/api/plugin/${PLUGIN_ID}/reports`;

  /** A plugin controller, sealed and built as a boot seals and builds it. */
  async function checkedReports(): Promise<{
    controller: Type;
    handler: unknown;
  }> {
    @Controller("reports")
    class Reports {
      @Get()
      index(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}
    const sealed = sealPluginModule(
      { module: PluginModule, controllers: [Reports] },
      { pluginId: PLUGIN_ID, floor: ["addressBook:read"], source: "" },
    );
    if (!sealed.ok) {
      throw new Error(`The module was refused: ${sealed.log}`);
    }
    const context = await NestFactory.createApplicationContext(sealed.module, {
      logger: false,
      abortOnError: false,
    });
    const modules = [...context.get(ModulesContainer).values()];
    const host = await hostModules([], context);
    await context.close();
    const refusal = sealModuleInstances(sealed.module, modules, host);
    if (refusal !== null) {
      throw new Error(`The build was refused: ${refusal}`);
    }
    return {
      controller: Reports,
      handler: Reflect.get(Reports.prototype, "index"),
    };
  }

  /** The guard reading real metadata, as the application's does. */
  function guardFor(): Built {
    return build({ reflector: new Reflector() });
  }

  function reached(
    controller: Type,
    handler: unknown,
    url = MOUNTED,
  ): ExecutionContext {
    const request = {
      url,
      method: "GET",
      routeOptions: { url },
      headers: { cookie: "session=abc" },
    } as unknown as RequestWithPrincipal;
    return {
      getHandler: () => handler,
      getClass: () => controller,
      getType: () => "http",
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ raw: new LiveResponse() }),
      }),
    } as unknown as ExecutionContext;
  }

  it("is not public, whatever its metadata says afterwards", async () => {
    const { controller, handler } = await checkedReports();
    Reflect.defineMetadata(IS_PUBLIC_ROUTE, true, handler as object);
    Reflect.defineMetadata(IS_PUBLIC_ROUTE, true, controller);
    const { guard, personIdFromHeaders } = guardFor();
    personIdFromHeaders.mockResolvedValueOnce(null);

    await expect(
      guard.canActivate(reached(controller, handler)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("needs the capabilities it was checked with, whatever its metadata says afterwards", async () => {
    const { controller, handler } = await checkedReports();
    Reflect.defineMetadata(REQUIRED_CAPABILITIES, [], handler as object);
    Reflect.defineMetadata(REQUIRED_CAPABILITIES, [], controller);
    const { guard, forPerson } = guardFor();

    forPerson.mockResolvedValueOnce(principal(["site:manage"]));
    await expect(
      guard.canActivate(reached(controller, handler)),
    ).rejects.toBeInstanceOf(ForbiddenException);

    forPerson.mockResolvedValueOnce(principal(["addressBook:read"]));
    await expect(guard.canActivate(reached(controller, handler))).resolves.toBe(
      true,
    );
  });

  it("leaves a request that reached it some other way to its metadata", async () => {
    // The plugin serving guard answers it as not installed.
    const { controller, handler } = await checkedReports();
    Reflect.defineMetadata(IS_PUBLIC_ROUTE, true, handler as object);
    const { guard, personIdFromHeaders } = guardFor();

    await expect(
      guard.canActivate(reached(controller, handler, "/api/elsewhere")),
    ).resolves.toBe(true);
    expect(personIdFromHeaders).not.toHaveBeenCalled();
  });
});

/**
 * A device route, which answers to a device token and to nothing else
 * (ADR 0031).
 *
 * The properties that matter most are the ones the resource route has, for the
 * same reason: the session cookie is never read here, and every refusal is the
 * same 401. Beside them, a device request carries no person, so nothing a
 * plugin does with it can reach the action registry, and refusals are
 * budgeted per address before any lookup.
 */
describe("a device route", () => {
  const PLUGIN_ID = "signage";
  const SCREEN = `/api/plugin/${PLUGIN_ID}/screen`;
  const DEVICE: DeviceTokenSummary = {
    id: "device-token-1",
    route: "screen",
    subject: "scr_1",
    label: "Entrance B",
    issuedAt: "2026-10-20T08:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  };

  /** A route the board consented to that the version serving dropped. */
  const MENU = `/api/plugin/${PLUGIN_ID}/menu`;

  beforeAll(() => {
    const current = resolveDeviceRoutes([
      { id: PLUGIN_ID, deviceRoutes: [{ id: "screen", path: "screen" }] },
    ]);
    setDeviceRoutes({
      current,
      asked: [
        ...current,
        ...resolveDeviceRoutes([
          { id: PLUGIN_ID, deviceRoutes: [{ id: "menu", path: "menu" }] },
        ]),
      ],
    });
  });
  afterAll(() => {
    setDeviceRoutes({ current: [], asked: [] });
  });

  /** The plugin's device route controller, sealed and built as a boot does. */
  async function checkedScreen(): Promise<{
    controller: Type;
    handler: unknown;
  }> {
    @Controller("screen")
    class Screen {
      @Get("content")
      content(): string {
        return "";
      }
    }
    @Module({})
    class PluginModule {}
    const sealed = sealPluginModule(
      { module: PluginModule, controllers: [Screen] },
      {
        pluginId: PLUGIN_ID,
        floor: ["self:manage"],
        deviceRoutes: [SCREEN],
        source: "",
      },
    );
    if (!sealed.ok) {
      throw new Error(`The module was refused: ${sealed.log}`);
    }
    const context = await NestFactory.createApplicationContext(sealed.module, {
      logger: false,
      abortOnError: false,
    });
    const modules = [...context.get(ModulesContainer).values()];
    const host = await hostModules([], context);
    await context.close();
    const refusal = sealModuleInstances(sealed.module, modules, host);
    if (refusal !== null) {
      throw new Error(`The build was refused: ${refusal}`);
    }
    return {
      controller: Screen,
      handler: Reflect.get(Screen.prototype, "content"),
    };
  }

  function reached(
    route: { controller: Type; handler: unknown },
    headers: Record<string, unknown>,
    options: { method?: string; ip?: string } = {},
  ): { context: ExecutionContext; request: RequestWithPrincipal } {
    const url = `${SCREEN}/content`;
    const request = {
      url,
      method: options.method ?? "GET",
      ip: options.ip ?? "192.0.2.10",
      routeOptions: { url },
      headers,
    } as unknown as RequestWithPrincipal;
    return {
      request,
      context: {
        getHandler: () => route.handler,
        getClass: () => route.controller,
        getType: () => "http",
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({ raw: new LiveResponse() }),
        }),
      } as unknown as ExecutionContext,
    };
  }

  it("accepts a live token for the route, and puts no person on the request", async () => {
    const route = await checkedScreen();
    const { guard, personIdFromHeaders, resolveDevice } = build({
      reflector: new Reflector(),
      device: DEVICE,
    });
    const { context, request } = reached(route, {
      authorization: "Bearer obrf_dt_live",
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolveDevice).toHaveBeenCalledWith("obrf_dt_live", {
      pluginId: PLUGIN_ID,
      routeId: "screen",
      path: SCREEN,
    });
    expect(personIdFromHeaders).not.toHaveBeenCalled();
    expect(request.principal).toBeUndefined();
    // Not marked: the action registry refuses a request it cannot read a
    // person from, so a plugin cannot turn a screen into a caller.
    expect(authenticatedFacts(request)).toBeUndefined();
    expect(deviceRequestOf(request)).toEqual({
      pluginId: PLUGIN_ID,
      device: DEVICE,
    });
  });

  it("never reads the session, so a board member's browser is refused like anyone", async () => {
    const route = await checkedScreen();
    const { guard, personIdFromHeaders, resolveDevice } = build({
      reflector: new Reflector(),
      device: DEVICE,
    });
    const { context } = reached(route, {
      cookie: "better-auth.session_token=a-valid-session",
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      DeviceTokenInvalidError,
    );
    expect(personIdFromHeaders).not.toHaveBeenCalled();
    expect(resolveDevice).not.toHaveBeenCalled();
  });

  it("never reads a support session's cookie either, and answers to the token alone", async () => {
    const route = await checkedScreen();
    const { guard, resolveDevice } = build({
      reflector: new Reflector(),
      device: DEVICE,
    });
    // NO_SUPPORT throws if the support branch looks the cookie up.
    const { context, request } = reached(route, {
      cookie: "__Host-openbrf-support=a-support-session",
      authorization: "Bearer obrf_dt_live",
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolveDevice).toHaveBeenCalledOnce();
    expect(request.principal).toBeUndefined();
    expect(request.support).toBeUndefined();
  });

  it("refuses a token the store does not find for this route, with the device challenge", async () => {
    // The store answers null for a token that is unknown, revoked or issued
    // for another plugin or route; the guard cannot tell them apart and
    // neither can the caller.
    const route = await checkedScreen();
    const { guard } = build({ reflector: new Reflector(), device: null });
    const { context } = reached(route, { authorization: "Bearer obrf_dt_x" });

    const refusal = await guard.canActivate(context).catch((error) => error);
    expect(refusal).toBeInstanceOf(DeviceTokenInvalidError);
    expect((refusal as DeviceTokenInvalidError).status).toBe(401);
    expect((refusal as DeviceTokenInvalidError).reason).toBe(
      "device-token-invalid",
    );
    expect((refusal as DeviceTokenInvalidError).headers()).toEqual({
      "www-authenticate": 'Bearer realm="device"',
    });
  });

  it.each([
    ["two Authorization headers", ["Bearer a", "Bearer b"]],
    ["another scheme", "Basic dXNlcjpwYXNz"],
    ["an empty token", "Bearer   "],
  ])("refuses %s without a lookup", async (_, authorization) => {
    const route = await checkedScreen();
    const { guard, resolveDevice } = build({
      reflector: new Reflector(),
      device: DEVICE,
    });
    const { context } = reached(route, { authorization });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      DeviceTokenInvalidError,
    );
    expect(resolveDevice).not.toHaveBeenCalled();
  });

  it("answers only GET and HEAD", async () => {
    const route = await checkedScreen();
    const { guard, resolveDevice } = build({
      reflector: new Reflector(),
      device: DEVICE,
    });
    const { context } = reached(
      route,
      { authorization: "Bearer obrf_dt_live" },
      { method: "POST" },
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      DeviceMethodNotAllowedError,
    );
    expect(resolveDevice).not.toHaveBeenCalled();
  });

  it("limits one token's calls in a minute, and says when to try again", async () => {
    const route = await checkedScreen();
    const { guard } = build({
      reflector: new Reflector(),
      device: DEVICE,
      deviceCallsPerMinute: 2,
    });
    const call = () =>
      guard.canActivate(
        reached(route, { authorization: "Bearer obrf_dt_live" }).context,
      );

    await expect(call()).resolves.toBe(true);
    await expect(call()).resolves.toBe(true);
    const refusal = await call().catch((error) => error);
    expect(refusal).toBeInstanceOf(DeviceRateLimitedError);
    expect((refusal as DeviceRateLimitedError).status).toBe(429);
    expect(
      Number((refusal as DeviceRateLimitedError).headers()["retry-after"]),
    ).toBeGreaterThan(0);
  });

  it("limits refusals per address, without looking the token up once spent", async () => {
    const route = await checkedScreen();
    const { guard, resolveDevice } = build({
      reflector: new Reflector(),
      device: null,
    });
    const attempt = (ip: string) =>
      guard
        .canActivate(
          reached(route, { authorization: "Bearer obrf_dt_guess" }, { ip })
            .context,
        )
        .catch((error: unknown) => error);

    for (let index = 0; index < 30; index += 1) {
      expect(await attempt("192.0.2.66")).toBeInstanceOf(
        DeviceTokenInvalidError,
      );
    }
    expect(resolveDevice).toHaveBeenCalledTimes(30);

    expect(await attempt("192.0.2.66")).toBeInstanceOf(DeviceRateLimitedError);
    expect(resolveDevice).toHaveBeenCalledTimes(30);
    // Another address has its own budget.
    expect(await attempt("192.0.2.67")).toBeInstanceOf(DeviceTokenInvalidError);
  });

  /** A request that reached an ordinary route of the plugin's on `url`. */
  function ordinary(
    route: { controller: Type; handler: unknown },
    url: string,
    headers: Record<string, unknown>,
  ): ExecutionContext {
    const request = {
      url,
      method: "GET",
      ip: "192.0.2.20",
      routeOptions: { url },
      headers,
    } as unknown as RequestWithPrincipal;
    return {
      getHandler: () => route.handler,
      getClass: () => route.controller,
      getType: () => "http",
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ raw: new LiveResponse() }),
      }),
    } as unknown as ExecutionContext;
  }

  it("leaves a request outside the device route to the session", async () => {
    const route = await checkedScreen();
    const { guard, personIdFromHeaders, resolveDevice } = build({
      reflector: new Reflector(),
    });
    const context = ordinary(route, `/api/plugin/${PLUGIN_ID}/screens`, {
      cookie: "session=abc",
    });

    // A sibling path that merely starts the same: the session path takes it.
    await guard.canActivate(context).catch(() => undefined);
    expect(resolveDevice).not.toHaveBeenCalled();
    expect(personIdFromHeaders).toHaveBeenCalled();
  });

  it("refuses a token on a route the version serving dropped, and opens nothing with it", async () => {
    // What the plugin mounts on the old path now is an ordinary route the
    // seal never held to the device route rules: no token may open it, even
    // one the store would still find.
    const route = await checkedScreen();
    const { guard, personIdFromHeaders, resolveDevice } = build({
      reflector: new Reflector(),
      device: DEVICE,
    });
    const context = ordinary(route, `${MENU}/today`, {
      authorization: "Bearer obrf_dt_live",
      cookie: "better-auth.session_token=a-valid-session",
    });

    const refusal = await guard.canActivate(context).catch((error) => error);
    expect(refusal).toBeInstanceOf(DeviceTokenInvalidError);
    // The challenge that tells the device its token is gone.
    expect((refusal as DeviceTokenInvalidError).headers()).toEqual({
      "www-authenticate": 'Bearer realm="device"',
    });
    expect(resolveDevice).not.toHaveBeenCalled();
    expect(personIdFromHeaders).not.toHaveBeenCalled();
  });

  it("leaves a person's request on a route the version serving dropped to the session", async () => {
    const route = await checkedScreen();
    const { guard, personIdFromHeaders, resolveDevice, forPerson } = build({
      reflector: new Reflector(),
    });
    // The plugin's floor.
    forPerson.mockResolvedValueOnce(principal(["self:manage"]));
    const context = ordinary(route, `${MENU}/today`, {
      cookie: "better-auth.session_token=a-valid-session",
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(personIdFromHeaders).toHaveBeenCalled();
    expect(resolveDevice).not.toHaveBeenCalled();
  });

  /** The version serving declares the dropped route's path its resource. */
  const MENU_RESOURCE: ProtectedResource = {
    declared: true,
    path: MENU,
    url: `https://brf.example${MENU}`,
  };

  it("refuses a device's token with the device challenge where a dropped route's path is now the protected resource", async () => {
    const route = await checkedScreen();
    const { guard, resolve, resolveDevice, personIdFromHeaders } = build({
      reflector: new Reflector(),
      resource: MENU_RESOURCE,
      resolved: null,
      device: DEVICE,
    });
    const context = ordinary(route, `${MENU}/today`, {
      authorization: "Bearer obrf_dt_revoked",
    });

    const refusal = await guard.canActivate(context).catch((error) => error);
    expect(refusal).toBeInstanceOf(DeviceTokenInvalidError);
    expect((refusal as DeviceTokenInvalidError).headers()).toEqual({
      "www-authenticate": 'Bearer realm="device"',
    });
    // Asked of the resource first, so nothing it accepts is refused this way,
    // and never opened as a device's.
    expect(resolve).toHaveBeenCalledWith("obrf_dt_revoked");
    expect(resolveDevice).not.toHaveBeenCalled();
    expect(personIdFromHeaders).not.toHaveBeenCalled();
  });

  it("still answers a connected app on a dropped route's path that is now the protected resource", async () => {
    const route = await checkedScreen();
    const accepted = build({
      reflector: new Reflector(),
      resource: MENU_RESOURCE,
      // The plugin's floor.
      resolved: identity({ principal: principal(["self:manage"]) }),
    });
    const request = ordinary(route, `${MENU}/today`, {
      authorization: "Bearer an-access-token",
    });
    await expect(accepted.guard.canActivate(request)).resolves.toBe(true);
    expect(accepted.resolve).toHaveBeenCalledWith("an-access-token");

    // A refused one is told where a token comes from, as on any resource.
    const refused = build({
      reflector: new Reflector(),
      resource: MENU_RESOURCE,
      resolved: null,
    });
    const refusal = await refused.guard
      .canActivate(
        ordinary(route, `${MENU}/today`, {
          authorization: "Bearer an-expired-token",
        }),
      )
      .catch((error) => error);
    expect(refusal).toBeInstanceOf(BearerUnauthorizedError);
    expect((refusal as BearerUnauthorizedError).headers()).toEqual({
      "www-authenticate": `Bearer resource_metadata="https://brf.example/.well-known/oauth-protected-resource${MENU}"`,
    });
  });

  it("answers a device's token on a protected resource no device route ever had as the resource does", async () => {
    const route = await checkedScreen();
    const { guard } = build({
      reflector: new Reflector(),
      resource: {
        declared: true,
        path: `/api/plugin/${PLUGIN_ID}/mcp`,
        url: `https://brf.example/api/plugin/${PLUGIN_ID}/mcp`,
      },
      resolved: null,
    });
    const refusal = await guard
      .canActivate(
        ordinary(route, `/api/plugin/${PLUGIN_ID}/mcp`, {
          authorization: "Bearer obrf_dt_live",
        }),
      )
      .catch((error) => error);
    expect(refusal).toBeInstanceOf(BearerUnauthorizedError);
  });

  it("refuses on a dropped route's path no handler matched only what is a device's where it is now the protected resource", () => {
    const unmatched = (url: string, authorization: string) =>
      ({
        url,
        method: "GET",
        ip: "192.0.2.30",
        headers: { authorization },
      }) as unknown as RequestWithPrincipal;

    const { guard } = build({ resource: MENU_RESOURCE });
    expect(
      guard.retiredPathRefusal(
        unmatched(`${MENU}/nowhere`, "Bearer obrf_dt_revoked"),
      ),
    ).toBeInstanceOf(DeviceTokenInvalidError);
    // The router's 404 for a connected app, as anywhere on the resource.
    expect(
      guard.retiredPathRefusal(
        unmatched(`${MENU}/nowhere`, "Bearer an-access-token"),
      ),
    ).toBeNull();

    // Anywhere else on a dropped route's path, any credential is a device's.
    const elsewhere = build({ resource: DECLARED });
    expect(
      elsewhere.guard.retiredPathRefusal(
        unmatched(`${MENU}/nowhere`, "Bearer an-access-token"),
      ),
    ).toBeInstanceOf(DeviceTokenInvalidError);
  });
});
