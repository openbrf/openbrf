import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";

import type { AuditEntryInput } from "../audit/audit-log.service";
import { AuditLogService } from "../audit/audit-log.service";
import type { AuthService } from "../auth/auth.service";
import type { ProtectedResource } from "../auth/protected-resource";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { ConnectedAppsService } from "./connected-apps.service";
import {
  applicationTypeFor,
  InvalidRedirectUriError,
  OAuthClientsController,
} from "./oauth-clients.controller";

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
  discarded: string[];
}

function build(
  create: (call: Call) => Promise<unknown> = () =>
    Promise.resolve({ client_id: "client-1", client_secret: "secret-1" }),
  failing: { link?: Error; record?: Error } = {},
): Built {
  const created: Call[] = [];
  const linked: Call[] = [];
  const auth = {
    instance: {
      api: {
        adminCreateOAuthClient: (call: Call) => {
          created.push(call);
          return create(call);
        },
        adminLinkClientResource: (call: Call) => {
          linked.push(call);
          return failing.link === undefined
            ? Promise.resolve({ linked: true })
            : Promise.reject(failing.link);
        },
      },
    },
  } as unknown as AuthService;

  const recorded: AuditEntryInput[] = [];
  const audit = {
    record: (entry: AuditEntryInput) => {
      if (failing.record !== undefined) {
        return Promise.reject(failing.record);
      }
      recorded.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditLogService;

  const discarded: string[] = [];
  const apps = {
    discardClient: (clientId: string) => {
      discarded.push(clientId);
      return Promise.resolve();
    },
  } as unknown as ConnectedAppsService;

  return {
    controller: new OAuthClientsController(auth, audit, apps, RESOURCE),
    created,
    linked,
    recorded,
    discarded,
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

describe("a registration that fails after the client was created", () => {
  it("removes the client when the resource link fails", async () => {
    const failure = new Error("link failed");
    const { controller, recorded, discarded } = build(undefined, {
      link: failure,
    });

    await expect(controller.register(request(), BODY)).rejects.toBe(failure);
    expect(discarded).toEqual(["client-1"]);
    expect(recorded).toHaveLength(0);
  });

  it("removes the client when the audit entry cannot be written", async () => {
    const failure = new Error("audit failed");
    const { controller, discarded } = build(undefined, { record: failure });

    await expect(controller.register(request(), BODY)).rejects.toBe(failure);
    expect(discarded).toEqual(["client-1"]);
  });

  it("keeps a client whose registration finished", async () => {
    const { controller, discarded } = build();

    await controller.register(request(), BODY);

    expect(discarded).toHaveLength(0);
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
    "myapp://callback",
    "http://localhost.evil.com/cb",
    "http://localhost@evil.com/cb",
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

describe("the kind of client the addresses describe", () => {
  it("is a web client for https addresses", () => {
    expect(applicationTypeFor(["https://app.exempel.se/cb"])).toBe("web");
  });

  it.each([
    "http://localhost:8123/cb",
    "http://127.0.0.1:8123/cb",
    "http://[::1]:8123/cb",
  ])(
    "is a native client for %s, which the provider refuses to a web client",
    (uri) => {
      expect(applicationTypeFor([uri])).toBe("native");
    },
  );

  it("is a native client when any address is on this machine", () => {
    expect(
      applicationTypeFor(["https://app.exempel.se/cb", "http://localhost/cb"]),
    ).toBe("native");
  });

  it("hands the provider the kind it registers", async () => {
    const web = build();
    await web.controller.register(request(), BODY);
    expect(web.created[0]?.body).toMatchObject({ application_type: "web" });

    const native = build();
    await native.controller.register(request(), {
      ...BODY,
      redirectUris: ["http://127.0.0.1:8123/cb"],
    });
    expect(native.created[0]?.body).toMatchObject({
      application_type: "native",
    });
  });
});

describe("a redirect URI the provider refuses", () => {
  const refusal = (code: string, description: string): Error =>
    new APIError("BAD_REQUEST", {
      error: code,
      error_description: description,
    });

  it("answers 400 with the reason the form has a sentence for", async () => {
    const { controller, linked, recorded } = build(() =>
      Promise.reject(
        refusal(
          "invalid_redirect_uri",
          "native clients must not use https loopback redirect URIs",
        ),
      ),
    );

    const failure: unknown = await controller
      .register(request(), {
        ...BODY,
        redirectUris: ["https://localhost:8123/cb"],
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InvalidRedirectUriError);
    expect(failure).toMatchObject({
      status: 400,
      reason: "invalid-redirect-uri",
    });
    expect((failure as Error).message).not.toContain("https loopback");
    expect(linked).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("leaves every other failure as it was", async () => {
    const other = refusal("invalid_client_metadata", "something else");
    const { controller } = build(() => Promise.reject(other));

    await expect(controller.register(request(), BODY)).rejects.toBe(other);
  });
});
