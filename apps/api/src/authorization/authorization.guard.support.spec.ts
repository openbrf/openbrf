import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vite-plus/test";

import { isAuthenticatedRequest } from "../actions/authenticated-request";
import type {
  AuditEntryInput,
  AuditLogService,
} from "../audit/audit-log.service";
import type { AuthService } from "../auth/auth.service";
import { TokenRateLimitedError } from "../auth/bearer-errors";
import type { BearerPrincipalService } from "../auth/bearer-principal.service";
import type { ProtectedResource } from "../auth/protected-resource";
import type { Env } from "../config/env";
import type {
  SupportAccessService,
  SupportSessionContext,
} from "../support/support-access.service";
import { SUPPORT_CAPABILITIES } from "../support/support-capabilities";
import {
  SupportReadOnlyError,
  SupportRouteRefusedError,
  SupportSessionInvalidError,
} from "../support/support-errors";
import {
  AuthorizationGuard,
  type RequestWithPrincipal,
  SUPPORT_REQUESTS_PER_MINUTE,
} from "./authorization.guard";
import type { Capability } from "./capabilities";
import { CLOSED_TO_SUPPORT } from "./closed-to-support.decorator";
import { OPEN_TO_SUPPORT } from "./open-to-support.decorator";
import type { PrincipalService } from "./principal.service";
import { IS_PUBLIC_ROUTE } from "./public.decorator";

/**
 * The guard's support branch (ADR 0028): what a request carrying a support
 * session's cookie may do.
 *
 * The properties that matter most each have assertions of their own. The
 * cookie is the only credential considered, so an account session in the same
 * browser is never looked up, not even after the cookie fails. Nothing that
 * changes anything gets through, public routes included. The principal is the
 * administrator who opened the access, holding the support list and none of
 * their own roles. And every request let through is in the log.
 */

const RESOURCE = "/api/plugin/connector/mcp";
const COOKIE = "__Host-openbrf-support";

const SESSION: SupportSessionContext = {
  sessionId: "support-session-1",
  accessId: "support-access-1",
  openedById: "administrator-1",
  supporter: "Kim at the host",
  endsAt: new Date("2026-10-20T20:00:00.000Z"),
};

interface Options {
  appUrl?: string;
  resolved?: SupportSessionContext | null;
  isPublic?: boolean;
  openToSupport?: boolean;
  closedToSupport?: boolean;
  required?: Capability[];
  resource?: ProtectedResource;
}

function build(options: Options = {}) {
  const personIdFromHeaders = vi.fn().mockResolvedValue("person-1");
  const forPerson = vi.fn();
  const bearerResolve = vi.fn().mockResolvedValue(null);
  const resolve = vi
    .fn()
    .mockResolvedValue(
      options.resolved === undefined ? SESSION : options.resolved,
    );
  const recorded: AuditEntryInput[] = [];
  const record = vi.fn((entry: AuditEntryInput) => {
    recorded.push(entry);
    return Promise.resolve();
  });

  const reflector = {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_ROUTE) {
        return options.isPublic === true ? true : undefined;
      }
      if (key === OPEN_TO_SUPPORT) {
        return options.openToSupport === true ? true : undefined;
      }
      if (key === CLOSED_TO_SUPPORT) {
        return options.closedToSupport === true ? true : undefined;
      }
      return undefined;
    },
    getAllAndMerge: () => options.required ?? ["association:read"],
  } as unknown as Reflector;

  const guard = new AuthorizationGuard(
    { personIdFromHeaders } as unknown as AuthService,
    { forPerson } as unknown as PrincipalService,
    reflector,
    { resolve: bearerResolve } as unknown as BearerPrincipalService,
    {
      APP_URL: options.appUrl ?? "https://brf.example",
      OPENBRF_MCP_TOKEN_CALLS_PER_MINUTE: 60,
    } as Env,
    options.resource ?? {
      declared: true,
      path: RESOURCE,
      url: `https://brf.example${RESOURCE}`,
    },
    { resolve } as unknown as SupportAccessService,
    { record } as unknown as AuditLogService,
  );
  return {
    guard,
    personIdFromHeaders,
    forPerson,
    bearerResolve,
    resolve,
    record,
    recorded,
  };
}

function request(
  options: {
    method?: string;
    url?: string;
    route?: string;
    cookie?: string;
    params?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): RequestWithPrincipal {
  const url = options.url ?? "/api/settings";
  return {
    method: options.method ?? "GET",
    url,
    routeOptions: { url: options.route ?? url.split("?")[0] },
    params: options.params ?? {},
    headers: {
      cookie: options.cookie ?? `${COOKIE}=the-session-token`,
      ...options.headers,
    },
  } as unknown as RequestWithPrincipal;
}

function contextFor(target: RequestWithPrincipal): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    getType: () => "http",
    switchToHttp: () => ({
      getRequest: () => target,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe("the support cookie is the only credential considered", () => {
  it("resolves the session from the cookie and never asks for an account", async () => {
    const { guard, resolve, personIdFromHeaders, forPerson } = build();
    const incoming = request({
      cookie: `better-auth.session_token=an-account; ${COOKIE}=the-session-token`,
    });

    await expect(guard.canActivate(contextFor(incoming))).resolves.toBe(true);

    expect(resolve).toHaveBeenCalledWith("the-session-token");
    expect(personIdFromHeaders).not.toHaveBeenCalled();
    expect(forPerson).not.toHaveBeenCalled();
  });

  it("refuses a cookie that does not resolve, clears it, and does not fall back", async () => {
    const { guard, personIdFromHeaders, record } = build({ resolved: null });
    const incoming = request({
      cookie: `better-auth.session_token=an-account; ${COOKIE}=an-ended-session`,
    });

    const refusal = await guard
      .canActivate(contextFor(incoming))
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(SupportSessionInvalidError);
    const headers = (refusal as SupportSessionInvalidError).headers();
    expect(headers["set-cookie"]).toMatch(
      new RegExp(
        `^${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure$`,
      ),
    );
    expect(personIdFromHeaders).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses two support cookies without looking either up", async () => {
    const { guard, resolve } = build();
    const incoming = request({
      cookie: `${COOKIE}=one; ${COOKIE}=two`,
    });

    await expect(guard.canActivate(contextFor(incoming))).rejects.toThrow(
      SupportSessionInvalidError,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("ignores an unprefixed cookie on an instance served over https", async () => {
    const { guard, resolve, personIdFromHeaders } = build();
    const incoming = request({
      cookie: "openbrf-support=planted-by-a-sibling",
    });

    await guard.canActivate(contextFor(incoming)).catch(() => undefined);

    expect(resolve).not.toHaveBeenCalled();
    expect(personIdFromHeaders).toHaveBeenCalled();
  });

  it("reads the unprefixed cookie on an instance served over http", async () => {
    const { guard, resolve } = build({ appUrl: "http://localhost:3000" });
    const incoming = request({ cookie: "openbrf-support=the-session-token" });

    await expect(guard.canActivate(contextFor(incoming))).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledWith("the-session-token");
  });

  it("leaves the support session's own routes to read the cookie themselves", async () => {
    const { guard, resolve } = build({ isPublic: true });
    for (const method of ["POST", "DELETE"]) {
      const incoming = request({ method, url: "/api/support/session" });

      await expect(guard.canActivate(contextFor(incoming))).resolves.toBe(true);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("leaves the resource route Bearer-only", async () => {
    const { guard, resolve, bearerResolve } = build();
    const incoming = request({
      url: RESOURCE,
      headers: { authorization: "Bearer a-token" },
    });

    await guard.canActivate(contextFor(incoming)).catch(() => undefined);

    expect(resolve).not.toHaveBeenCalled();
    expect(bearerResolve).toHaveBeenCalledWith("a-token");
  });
});

describe("what a support session is", () => {
  it("is the administrator who opened the access, holding the support list and no role", async () => {
    const { guard } = build();
    const incoming = request();

    await guard.canActivate(contextFor(incoming));

    expect(incoming.principal).toEqual({
      personId: "administrator-1",
      isAdmin: false,
      isBoardMember: false,
      isPropertyManager: false,
      isResident: false,
      isMember: false,
      capabilities: new Set(SUPPORT_CAPABILITIES),
      supportSessionId: "support-session-1",
    });
    expect(incoming.support).toBe(SESSION);
  });

  it("is not marked as a request a plugin may dispatch an action from", async () => {
    const { guard } = build();
    const incoming = request();

    await guard.canActivate(contextFor(incoming));

    expect(isAuthenticatedRequest(incoming)).toBe(false);
  });
});

describe("a support session changes nothing", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "SEARCH"])(
    "refuses %s before any capability is read",
    async (method) => {
      const { guard, record } = build({ required: [] });
      const incoming = request({ method });

      await expect(guard.canActivate(contextFor(incoming))).rejects.toThrow(
        SupportReadOnlyError,
      );
      expect(incoming.principal).toBeUndefined();
      expect(record).not.toHaveBeenCalled();
    },
  );

  it("refuses a change on a public route too", async () => {
    const { guard } = build({ isPublic: true });
    const incoming = request({ method: "POST", url: "/api/signup-requests" });

    await expect(guard.canActivate(contextFor(incoming))).rejects.toThrow(
      SupportReadOnlyError,
    );
  });

  it.each(["GET", "HEAD"])("lets %s through", async (method) => {
    const { guard } = build();

    await expect(
      guard.canActivate(contextFor(request({ method }))),
    ).resolves.toBe(true);
  });
});

describe("the routes a support session is refused whatever the method", () => {
  it.each([
    ["a plugin's route", "/api/plugin/example/things"],
    ["the sign-in library's", "/api/auth/get-session"],
  ])("refuses %s", async (_what, url) => {
    const { guard, record } = build({ isPublic: true });

    await expect(
      guard.canActivate(contextFor(request({ url }))),
    ).rejects.toThrow(SupportRouteRefusedError);
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses a route closed to support by name, though it holds the capability", async () => {
    const { guard, record } = build({
      required: ["signupRequest:decide"],
      closedToSupport: true,
    });

    await expect(
      guard.canActivate(
        contextFor(request({ url: "/api/contact-submissions" })),
      ),
    ).rejects.toThrow(SupportRouteRefusedError);
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses a route that declares no capability", async () => {
    const { guard } = build({ required: [] });

    await expect(
      guard.canActivate(
        contextFor(request({ url: "/api/connected-apps/mine" })),
      ),
    ).rejects.toThrow(SupportRouteRefusedError);
  });

  it("lets through one that declares none and is opened to support by name", async () => {
    const { guard } = build({ required: [], openToSupport: true });

    await expect(
      guard.canActivate(contextFor(request({ url: "/api/me" }))),
    ).resolves.toBe(true);
  });

  it("refuses a capability that is withheld from support", async () => {
    const { guard } = build({
      required: ["apartmentRegister:read", "protectedData:reveal"],
    });

    await expect(
      guard.canActivate(
        contextFor(request({ url: "/api/apartment-register" })),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("refuses a route needing a support capability and a withheld one", async () => {
    const { guard } = build({
      required: ["addressBook:read", "addressBook:write"],
    });

    await expect(guard.canActivate(contextFor(request()))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("lets through a route needing only support capabilities", async () => {
    const { guard } = build({
      required: ["association:read", "association:manage"],
    });

    await expect(guard.canActivate(contextFor(request()))).resolves.toBe(true);
  });

  it("lets through a public read, and still records it", async () => {
    const { guard, recorded } = build({ isPublic: true });

    await expect(
      guard.canActivate(contextFor(request({ url: "/api/setup/state" }))),
    ).resolves.toBe(true);
    expect(recorded.map((entry) => entry.action)).toEqual(["SUPPORT_REQUEST"]);
  });
});

describe("every request let through is in the log", () => {
  it("records the method, the matched route and its parameters, never the query", async () => {
    const { guard, recorded } = build({ required: ["addressBook:read"] });
    const incoming = request({
      url: "/api/address-book/persons/person-42?search=Astrid%20Lindqvist",
      route: "/api/address-book/persons/:id",
      params: { id: "person-42" },
    });

    await guard.canActivate(contextFor(incoming));

    expect(recorded).toEqual([
      {
        action: "SUPPORT_REQUEST",
        channel: "SUPPORT",
        supportSessionId: "support-session-1",
        actorPersonId: "administrator-1",
        context: {
          method: "GET",
          route: "/api/address-book/persons/:id",
          params: { id: "person-42" },
        },
      },
    ]);
    expect(JSON.stringify(recorded)).not.toContain("Astrid");
  });

  it("records nothing for a request it refuses on a capability", async () => {
    const { guard, record } = build({ required: ["protectedData:reveal"] });

    await guard.canActivate(contextFor(request())).catch(() => undefined);

    expect(record).not.toHaveBeenCalled();
  });
});

describe("the per-session budget", () => {
  it("refuses the request past the minute's budget with Retry-After", async () => {
    const { guard } = build();

    for (let call = 0; call < SUPPORT_REQUESTS_PER_MINUTE; call += 1) {
      await guard.canActivate(contextFor(request()));
    }
    const refusal = await guard
      .canActivate(contextFor(request()))
      .catch((error: unknown) => error);

    expect(SUPPORT_REQUESTS_PER_MINUTE).toBe(120);
    expect(refusal).toBeInstanceOf(TokenRateLimitedError);
    expect(
      Number((refusal as TokenRateLimitedError).headers()["retry-after"]),
    ).toBeGreaterThanOrEqual(1);
  });
});
