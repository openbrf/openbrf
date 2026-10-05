import { createHash, randomBytes } from "node:crypto";

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppModule } from "../app.module";
import { AuditLogService } from "../audit/audit-log.service";
import { AuthService } from "../auth/auth.service";
import { PROTECTED_RESOURCE } from "../auth/protected-resource.module";
import type { ProtectedResource } from "../auth/protected-resource";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";

/**
 * Who can register an OAuth client, against a real instance.
 *
 * A registered client is what a consent screen introduces to a member: its
 * name and host are what the member reads before letting it act as them, and
 * its redirect URIs are where their authorization code is sent. Registering one
 * is therefore an administrator's act, with one route - `POST
 * /api/oauth-clients`, which demands `association:manage` and writes an audit
 * entry.
 *
 * Three properties are held here, over HTTP and through the provider in this
 * process, because each closes a different door:
 *
 *   The provider's own client endpoints answer 404 to everybody, however the
 *   path is spelled, and leave the client table as it was.
 *
 *   The administrator's route registers a client, links it to the resource and
 *   records it, and refuses anybody else.
 *
 *   The provider refuses a client action to a person without
 *   `association:manage` even when it is called in-process, where a closed
 *   path is not consulted, and no client may be registered to act as itself.
 */

const env = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let auth: AuthService;
let resource: ProtectedResource;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const resident = {
  personId: `oauth-reg-resident-${suffix}`,
  email: `oauth-reg-resident-${suffix}@exempel.se`,
};
const admin = {
  personId: `oauth-reg-admin-${suffix}`,
  email: `oauth-reg-admin-${suffix}@exempel.se`,
};
const personIds = [resident.personId, admin.personId];
const addressId = `oauth-reg-address-${suffix}`;
const apartmentId = `oauth-reg-apartment-${suffix}`;

/** A client the resident registered while the provider's paths were open. */
const OWNED_CLIENT_ID = `oauth-reg-owned-${suffix}`;
const OWNED_REDIRECT = "https://klient.exempel.se/aterkoppling";

/** Every client name this suite asks for, so a row it made can be found. */
const NAME_PREFIX = `Brf Eksemplet ${suffix}`;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.67.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.67.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object | string;
  headers?: Record<string, string>;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": nextForwardedFor(),
        ...options.headers,
      },
    });
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

/** What a browser sends on a state-changing request, cookie optional. */
function browserHeaders(cookie: string | null): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: env.APP_URL,
    ...(cookie === null ? {} : { cookie }),
  };
}

/** A client body naming the association's own name and host. */
function clientBody(label: string): Record<string, unknown> {
  return {
    client_name: `${NAME_PREFIX} ${label}`,
    client_uri: "https://brf-eksemplet.se",
    redirect_uris: ["https://annan-vard.exempel.se/cb"],
    scope: "mcp:read mcp:write offline_access",
  };
}

async function clientsNamed(label: string): Promise<number> {
  return prisma.oauthClient.count({
    where: { name: `${NAME_PREFIX} ${label}` },
  });
}

/**
 * Writes the resident's client as the provider would have, or puts it back.
 *
 * Before every case that aims at it, so that each case starts from the same
 * row and a change one of them made cannot decide another's outcome.
 */
async function resetOwnedClient(): Promise<void> {
  const row = {
    clientSecret: "stored-secret",
    name: `${NAME_PREFIX} owned`,
    uri: "https://brf-eksemplet.se",
    userId: residentUserId,
    scopes: ["mcp:read", "mcp:write"],
    contacts: [],
    redirectUris: [OWNED_REDIRECT],
    postLogoutRedirectUris: [],
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "client_secret_basic",
    updatedAt: new Date(),
  };
  await prisma.oauthClient.upsert({
    where: { clientId: OWNED_CLIENT_ID },
    create: { clientId: OWNED_CLIENT_ID, createdAt: new Date(), ...row },
    update: row,
  });
}

/** Registers a client through the administrator's route. */
async function registerClient(
  label: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const registered = await inject({
    method: "POST",
    url: "/api/oauth-clients",
    payload: {
      clientName: `${NAME_PREFIX} ${label}`,
      redirectUris: [redirectUri],
    },
    headers: browserHeaders(adminCookie),
  });
  expect(registered.statusCode).toBe(201);
  return registered.json<{ clientId: string; clientSecret: string }>();
}

/** The administrator's browser starting an authorization for a client. */
function authorizeAsAdmin(clientId: string, redirectUri: string) {
  const verifier = randomBytes(32).toString("base64url");
  return inject({
    method: "GET",
    url: `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "mcp:read",
      state: "s",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: resource.url,
    }).toString()}`,
    headers: { cookie: adminCookie },
  });
}

let residentCookie: string;
let adminCookie: string;
let residentUserId: string;
let adminUserId: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  auth = app.get(AuthService);
  resource = app.get<ProtectedResource>(PROTECTED_RESOURCE);

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Klientgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1001", floor: 1 },
  });
  await prisma.person.createMany({
    data: [
      { id: resident.personId, firstName: "Rut", lastName: `Reg${suffix}` },
      { id: admin.personId, firstName: "Adam", lastName: `Reg${suffix}` },
    ],
  });
  await prisma.residency.create({
    data: {
      personId: resident.personId,
      apartmentId,
      role: "MEMBER",
      movedInOn: new Date("2024-01-01"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: admin.personId, role: "ADMIN" },
  });

  for (const who of [resident, admin]) {
    await auth.createAccountForPerson({
      personId: who.personId,
      email: who.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
  residentCookie = await signIn(resident.email);
  adminCookie = await signIn(admin.email);

  residentUserId = (
    await prisma.user.findUniqueOrThrow({
      where: { personId: resident.personId },
    })
  ).id;
  adminUserId = (
    await prisma.user.findUniqueOrThrow({ where: { personId: admin.personId } })
  ).id;
});

afterAll(async () => {
  if (prisma !== undefined) {
    // Before the accounts: the registrant column is set to null rather than
    // cascaded, so these rows would otherwise outlive the suite.
    await prisma.oauthClient.deleteMany({
      where: {
        OR: [
          { name: { startsWith: NAME_PREFIX } },
          { userId: { in: [residentUserId, adminUserId] } },
        ],
      },
    });
    await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.residency.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.systemRole.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.apartment.deleteMany({ where: { id: apartmentId } });
    await prisma.address.deleteMany({ where: { id: addressId } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  }
  await app?.close();
});

describe("the provider's own client endpoints, over HTTP", () => {
  it.each([
    ["nobody signed in", () => null],
    ["a resident", () => residentCookie],
    ["an administrator", () => adminCookie],
  ])(
    "answer 404 to %s asking to create a client, and create none",
    async (label, cookie) => {
      const response = await inject({
        method: "POST",
        url: "/api/auth/oauth2/create-client",
        payload: clientBody(label),
        headers: browserHeaders(cookie()),
      });

      expect(response.statusCode).toBe(404);
      expect(await clientsNamed(label)).toBe(0);
    },
  );

  it.each([
    ["with a dot segment", "/api/auth/./oauth2/create-client"],
    ["with a query string", "/api/auth/oauth2/create-client?via=query"],
  ])("answer 404 to the same path %s", async (label, url) => {
    const response = await inject({
      method: "POST",
      url,
      payload: clientBody(label),
      headers: browserHeaders(residentCookie),
    });

    expect(response.statusCode).toBe(404);
    expect(await clientsNamed(label)).toBe(0);
  });

  describe("aimed at a client a resident registered", () => {
    beforeEach(resetOwnedClient);

    it.each([
      [
        "change its name and redirect",
        "POST",
        "/api/auth/oauth2/update-client",
        {
          client_id: OWNED_CLIENT_ID,
          update: {
            client_name: "Styrelsen",
            redirect_uris: ["https://annan-vard.exempel.se/cb"],
          },
        },
      ],
      [
        "rotate its secret",
        "POST",
        "/api/auth/oauth2/client/rotate-secret",
        { client_id: OWNED_CLIENT_ID },
      ],
      [
        "delete it",
        "POST",
        "/api/auth/oauth2/delete-client",
        { client_id: OWNED_CLIENT_ID },
      ],
      [
        "read it",
        "GET",
        `/api/auth/oauth2/get-client?client_id=${OWNED_CLIENT_ID}`,
        undefined,
      ],
      ["list it", "GET", "/api/auth/oauth2/get-clients", undefined],
    ] as const)(
      "answer 404 to the client's own registrant asking to %s",
      async (_label, method, url, payload) => {
        const response = await inject({
          method,
          url,
          ...(payload === undefined ? {} : { payload }),
          headers: browserHeaders(residentCookie),
        });

        expect(response.statusCode).toBe(404);
        const row = await prisma.oauthClient.findUnique({
          where: { clientId: OWNED_CLIENT_ID },
        });
        expect(row).toMatchObject({
          name: `${NAME_PREFIX} owned`,
          redirectUris: [OWNED_REDIRECT],
          clientSecret: "stored-secret",
        });
      },
    );

    it("still answer the public read the consent screen makes", async () => {
      const response = await inject({
        method: "GET",
        url: `/api/auth/oauth2/public-client?client_id=${OWNED_CLIENT_ID}`,
        headers: { cookie: residentCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(
        response.json<{ client_id?: string; client_name?: string }>(),
      ).toMatchObject({
        client_id: OWNED_CLIENT_ID,
        client_name: `${NAME_PREFIX} owned`,
      });
    });
  });
});

describe("registering through the administrator's route", () => {
  const REGISTERED_NAME = `${NAME_PREFIX} registered`;

  it("registers, links and records a client for an administrator", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/oauth-clients",
      payload: {
        clientName: REGISTERED_NAME,
        redirectUris: ["https://app.exempel.se/cb"],
      },
      headers: browserHeaders(adminCookie),
    });

    expect(response.statusCode).toBe(201);
    const { clientId, clientSecret } = response.json<{
      clientId: string;
      clientSecret: string | null;
    }>();
    expect(clientSecret).toEqual(expect.any(String));

    const row = await prisma.oauthClient.findUniqueOrThrow({
      where: { clientId },
    });
    expect(row).toMatchObject({
      name: REGISTERED_NAME,
      userId: adminUserId,
      redirectUris: ["https://app.exempel.se/cb"],
      grantTypes: ["authorization_code", "refresh_token"],
      skipConsent: false,
      requirePKCE: true,
    });
    expect(
      await prisma.oauthClientResource.count({
        where: { clientId, resourceId: resource.url },
      }),
    ).toBe(1);

    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "OAUTH_CLIENT_REGISTERED", targetId: clientId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorPersonId: admin.personId,
      channel: "WEB",
      targetKind: "oauthClient",
      context: { redirectHosts: ["app.exempel.se"] },
    });
  });

  it.each([
    "http://localhost:8123/cb",
    "http://127.0.0.1:8123/cb",
    "http://[::1]:8123/cb",
  ])("registers a client on this machine at %s", async (redirectUri) => {
    const response = await inject({
      method: "POST",
      url: "/api/oauth-clients",
      payload: {
        clientName: `${NAME_PREFIX} loopback`,
        redirectUris: [redirectUri],
      },
      headers: browserHeaders(adminCookie),
    });

    expect(response.statusCode).toBe(201);
    const { clientId } = response.json<{ clientId: string }>();
    expect(
      await prisma.oauthClient.findUniqueOrThrow({ where: { clientId } }),
    ).toMatchObject({
      applicationType: "native",
      redirectUris: [redirectUri],
      skipConsent: false,
      requirePKCE: true,
    });
  });

  it("takes a client on this machine through authorization code and PKCE", async () => {
    const redirectUri = "http://127.0.0.1:8123/cb";
    const registered = await inject({
      method: "POST",
      url: "/api/oauth-clients",
      payload: {
        clientName: `${NAME_PREFIX} loopback flow`,
        redirectUris: [redirectUri],
      },
      headers: browserHeaders(adminCookie),
    });
    expect(registered.statusCode).toBe(201);
    const { clientId, clientSecret } = registered.json<{
      clientId: string;
      clientSecret: string;
    }>();

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await inject({
      method: "GET",
      url: `/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "mcp:read",
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: resource.url,
      }).toString()}`,
      headers: { cookie: adminCookie },
    });
    // Sent to the consent screen: signed in, and no consent given yet.
    expect(authorize.statusCode).toBe(302);
    const consentUrl = new URL(String(authorize.headers.location), env.APP_URL);
    expect(consentUrl.pathname).toBe("/app/oauth/consent");

    const consent = await inject({
      method: "POST",
      url: "/api/connected-apps/consent",
      payload: { oauth_query: consentUrl.search.slice(1) },
      headers: browserHeaders(adminCookie),
    });
    expect(consent.statusCode).toBe(200);
    const { url: callback } = consent.json<{ url: string }>();
    const back = new URL(callback);
    expect(`${back.origin}${back.pathname}`).toBe("http://127.0.0.1:8123/cb");
    expect(back.searchParams.get("state")).toBe("s");
    const code = back.searchParams.get("code");
    expect(code).toEqual(expect.any(String));

    const token = await inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
        resource: resource.url,
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(token.statusCode).toBe(200);
    expect(token.json<{ access_token?: string }>().access_token).toEqual(
      expect.any(String),
    );
  });

  it("withdraws a consent the audit log could not record", async () => {
    const redirectUri = "http://127.0.0.1:8124/cb";
    const { clientId } = await registerClient(
      "unrecorded consent",
      redirectUri,
    );
    const authorize = await authorizeAsAdmin(clientId, redirectUri);
    const consentUrl = new URL(String(authorize.headers.location), env.APP_URL);
    expect(consentUrl.pathname).toBe("/app/oauth/consent");

    const record = vi
      .spyOn(app.get(AuditLogService), "record")
      .mockRejectedValueOnce(new Error("the audit log is unavailable"));
    try {
      const consent = await inject({
        method: "POST",
        url: "/api/connected-apps/consent",
        payload: { oauth_query: consentUrl.search.slice(1) },
        headers: browserHeaders(adminCookie),
      });
      expect(consent.statusCode).toBe(500);
      expect(record).toHaveBeenCalledTimes(1);
    } finally {
      record.mockRestore();
    }

    expect(
      await prisma.oauthConsent.count({
        where: { clientId, userId: adminUserId },
      }),
    ).toBe(0);
    // And the next authorization asks again rather than issuing a code on a
    // grant nobody recorded.
    const again = await authorizeAsAdmin(clientId, redirectUri);
    expect(new URL(String(again.headers.location), env.APP_URL).pathname).toBe(
      "/app/oauth/consent",
    );
  });

  it.each(["https://localhost:8123/cb", "http://127.1/cb"])(
    "answers 400, not 500, when the provider refuses %s",
    async (redirectUri) => {
      const response = await inject({
        method: "POST",
        url: "/api/oauth-clients",
        payload: {
          clientName: `${NAME_PREFIX} refused by the provider`,
          redirectUris: [redirectUri],
        },
        headers: browserHeaders(adminCookie),
      });

      expect(response.statusCode).toBe(400);
      expect(await clientsNamed("refused by the provider")).toBe(0);
    },
  );

  it("answers 400 with a reason the form can translate when only the provider objects", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/oauth-clients",
      payload: {
        clientName: `${NAME_PREFIX} refused by the provider`,
        redirectUris: ["https://localhost:8123/cb"],
      },
      headers: browserHeaders(adminCookie),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ reason?: string }>().reason).toBe(
      "invalid-redirect-uri",
    );
  });

  it("leaves no client behind when the registration cannot be recorded", async () => {
    const record = vi
      .spyOn(app.get(AuditLogService), "record")
      .mockRejectedValueOnce(new Error("the audit log is unavailable"));
    try {
      const response = await inject({
        method: "POST",
        url: "/api/oauth-clients",
        payload: {
          clientName: `${NAME_PREFIX} unrecorded`,
          redirectUris: ["https://app.exempel.se/cb"],
        },
        headers: browserHeaders(adminCookie),
      });

      expect(response.statusCode).toBe(500);
      expect(record).toHaveBeenCalledTimes(1);
      // Created by the provider and linked before the entry failed, and gone
      // again, with its resource link by the cascade.
      expect(await clientsNamed("unrecorded")).toBe(0);
    } finally {
      record.mockRestore();
    }
  });

  it("refuses a resident, naming the capability", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/oauth-clients",
      payload: {
        clientName: `${NAME_PREFIX} by a resident`,
        redirectUris: ["https://app.exempel.se/cb"],
      },
      headers: browserHeaders(residentCookie),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ message?: string }>().message).toContain(
      "association:manage",
    );
    expect(await clientsNamed("by a resident")).toBe(0);
  });

  it("refuses somebody who is not signed in", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/oauth-clients",
      payload: {
        clientName: `${NAME_PREFIX} by nobody`,
        redirectUris: ["https://app.exempel.se/cb"],
      },
      headers: browserHeaders(null),
    });

    expect(response.statusCode).toBe(401);
    expect(await clientsNamed("by nobody")).toBe(0);
  });
});

describe("the provider, called in this process", () => {
  it("refuses a resident's session creating a client, where no path is closed", async () => {
    await expect(
      auth.instance.api.createOAuthClient({
        headers: new Headers({ cookie: residentCookie }),
        body: clientBody("in process"),
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(await clientsNamed("in process")).toBe(0);
  });

  it("refuses a client that would act as itself, even for an administrator", async () => {
    await expect(
      auth.instance.api.adminCreateOAuthClient({
        headers: new Headers({ cookie: adminCookie }),
        body: {
          client_name: `${NAME_PREFIX} acting as itself`,
          grant_types: ["client_credentials"],
          token_endpoint_auth_method: "client_secret_basic",
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      body: { error: "invalid_client_metadata" },
    });
    expect(await clientsNamed("acting as itself")).toBe(0);
  });

  it("answers the client_credentials grant as unsupported at the token endpoint", async () => {
    await resetOwnedClient();
    const response = await inject({
      method: "POST",
      url: "/api/auth/oauth2/token",
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: OWNED_CLIENT_ID,
        client_secret: "stored-secret",
        resource: resource.url,
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error?: string }>().error).toBe(
      "unsupported_grant_type",
    );
  });

  it("does not advertise the client_credentials grant", async () => {
    const response = await inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ grant_types_supported?: string[] }>()
        .grant_types_supported,
    ).toEqual(["authorization_code", "refresh_token"]);
  });
});
