import { describe, expect, it } from "vitest";

import type { AuditEntryInput } from "../audit/audit-log.service";
import { AuditLogService } from "../audit/audit-log.service";
import type { AuthService } from "../auth/auth.service";
import type { ProtectedResource } from "../auth/protected-resource";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { OAuthClientsController } from "./oauth-clients.controller";

/**
 * Registering a client by hand, against the provider's calls.
 *
 * The provider resolves the session from the headers each call carries and
 * asks its clientPrivileges hook whether that person may manage clients. A call
 * made without the administrator's headers therefore has no session, and the
 * provider refuses it as unauthenticated. The provider is stubbed here, so what
 * is asserted is what each call is handed; oauth-client-registration.int-spec.ts
 * holds the same route against the real provider.
 */

const RESOURCE: ProtectedResource = {
  declared: true,
  path: "/api/plugin/mcp-connector/mcp",
  url: "https://brf.example/api/plugin/mcp-connector/mcp",
};

const ADMIN_COOKIE = "better-auth.session_token=admin-session";

interface Call {
  headers?: Headers;
  body?: unknown;
  params?: unknown;
}

interface Built {
  controller: OAuthClientsController;
  created: Call[];
  linked: Call[];
  recorded: AuditEntryInput[];
}

function build(): Built {
  const created: Call[] = [];
  const linked: Call[] = [];
  const auth = {
    instance: {
      api: {
        adminCreateOAuthClient: (call: Call) => {
          created.push(call);
          return Promise.resolve({
            client_id: "client-1",
            client_secret: "secret-1",
          });
        },
        adminLinkClientResource: (call: Call) => {
          linked.push(call);
          return Promise.resolve({ linked: true });
        },
      },
    },
  } as unknown as AuthService;

  const recorded: AuditEntryInput[] = [];
  const audit = {
    record: (entry: AuditEntryInput) => {
      recorded.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditLogService;

  return {
    controller: new OAuthClientsController(auth, audit, RESOURCE),
    created,
    linked,
    recorded,
  };
}

function request(): RequestWithPrincipal {
  return {
    method: "POST",
    url: "/api/oauth-clients",
    protocol: "https",
    id: "req-1",
    principal: { personId: "admin-person" },
    headers: {
      host: "brf.example",
      cookie: ADMIN_COOKIE,
      origin: "https://brf.example",
      "content-type": "application/json",
      "content-length": "80",
    },
  } as unknown as RequestWithPrincipal;
}

const BODY = {
  clientName: "Föreningens egen app",
  redirectUris: ["https://app.exempel.se/cb"],
};

describe("registering a client by hand", () => {
  it("creates the client with the administrator's own session", async () => {
    const { controller, created } = build();

    await controller.register(request(), BODY);

    expect(created).toHaveLength(1);
    expect(created[0]?.headers?.get("cookie")).toBe(ADMIN_COOKIE);
  });

  it("links the client to the resource with the same session", async () => {
    const { controller, linked } = build();

    await controller.register(request(), BODY);

    expect(linked).toHaveLength(1);
    expect(linked[0]?.headers?.get("cookie")).toBe(ADMIN_COOKIE);
    expect(linked[0]?.params).toEqual({
      identifier: RESOURCE.url,
      client_id: "client-1",
    });
  });

  it("records the registration against the administrator, without the secret", async () => {
    const { controller, recorded } = build();

    const answer = await controller.register(request(), BODY);

    expect(answer).toEqual({ clientId: "client-1", clientSecret: "secret-1" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      action: "OAUTH_CLIENT_REGISTERED",
      actorPersonId: "admin-person",
      targetKind: "oauthClient",
      targetId: "client-1",
      context: { redirectHosts: ["app.exempel.se"] },
    });
    expect(JSON.stringify(recorded[0])).not.toContain("secret-1");
  });
});

describe("the redirect URIs a client may name", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "http://app.exempel.se/cb",
    "ftp://app.exempel.se/cb",
    "https://user:pass@app.exempel.se/cb",
    "https://app.exempel.se/cb#fragment",
  ])("refuses %s, and registers nothing", async (redirectUri) => {
    const { controller, created } = build();

    await expect(
      controller.register(request(), { ...BODY, redirectUris: [redirectUri] }),
    ).rejects.toThrow();
    expect(created).toHaveLength(0);
  });

  it.each([
    "https://app.exempel.se/cb",
    "http://127.0.0.1:8123/callback",
    "http://localhost:8123/callback",
    "http://[::1]:8123/callback",
  ])("takes %s", async (redirectUri) => {
    const { controller, created } = build();

    await controller.register(request(), {
      ...BODY,
      redirectUris: [redirectUri],
    });

    expect(created).toHaveLength(1);
  });
});
