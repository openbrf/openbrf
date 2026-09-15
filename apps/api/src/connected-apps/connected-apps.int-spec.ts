import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { BearerPrincipalService } from "../auth/bearer-principal.service";
import { hashOpaqueToken } from "../auth/opaque-token";
import { PROTECTED_RESOURCE } from "../auth/protected-resource.module";
import type { ProtectedResource } from "../auth/protected-resource";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";

/**
 * Connected apps against a real database.
 *
 * Four properties that only a real run can show, and each of them is a
 * statement the rest of the change rests on:
 *
 *   A token resolves to a person through the rows actually written, with the
 *   digest the options literal pinned rather than the library's default. A unit
 *   test asserting the digest proves the function; this proves that the column
 *   the resolver queries holds what that function produced.
 *
 *   A disconnect takes effect on the next call. Not eventually, not when the
 *   token expires - the very next request.
 *
 *   A token issued for another audience is refused. That is the one rule the
 *   protocol makes a MUST, and it cannot be seen without a row to point at.
 *
 *   Erasing a person takes their grants and tokens with them, through the
 *   cascade alone. The purge deletes one row; whether that is complete is a
 *   property of the schema, and the schema is only real here.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let resource: ProtectedResource;
let bearer: BearerPrincipalService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const member = {
  personId: `apps-member-${suffix}`,
  email: `apps-member-${suffix}@exempel.se`,
};
const board = {
  personId: `apps-board-${suffix}`,
  email: `apps-board-${suffix}@exempel.se`,
};
const personIds = [member.personId, board.personId];

const clientId = `https://klient-${suffix}.exempel.se/id`;
const otherClientId = `https://annan-${suffix}.exempel.se/id`;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.47.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.47.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": nextForwardedFor(),
        "accept-language": "sv-SE,sv;q=0.9",
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

async function accountIdFor(personId: string): Promise<string> {
  const account = await prisma.user.findUniqueOrThrow({
    where: { personId },
    select: { id: true },
  });
  return account.id;
}

/**
 * Writes the rows an authorization would have written.
 *
 * The flow itself needs a browser and a client that can be redirected to; what
 * this suite is about is what the rows mean once they exist. The one thing it
 * must not fake is the digest, because that is exactly what is being checked.
 */
async function grant(options: {
  personId: string;
  client: string;
  token: string;
  resources?: string[];
  scopes?: string[];
  expiresAt?: Date;
}): Promise<string> {
  const userId = await accountIdFor(options.personId);
  const now = new Date();

  await prisma.oauthConsent.create({
    data: {
      clientId: options.client,
      userId,
      resources: options.resources ?? [resource.url],
      requestedUserInfoClaims: [],
      scopes: options.scopes ?? ["mcp:read", "mcp:write"],
      createdAt: now,
      updatedAt: now,
    },
  });

  const accessToken = await prisma.oauthAccessToken.create({
    data: {
      token: hashOpaqueToken(options.token),
      clientId: options.client,
      userId,
      resources: options.resources ?? [resource.url],
      requestedUserInfoClaims: [],
      scopes: options.scopes ?? ["mcp:read", "mcp:write"],
      expiresAt: options.expiresAt ?? new Date(Date.now() + 900_000),
      createdAt: now,
    },
  });

  await prisma.oauthRefreshToken.create({
    data: {
      token: hashOpaqueToken(`refresh-${options.token}`),
      clientId: options.client,
      userId,
      resources: options.resources ?? [resource.url],
      requestedUserInfoClaims: [],
      scopes: options.scopes ?? ["mcp:read", "mcp:write"],
      expiresAt: new Date(Date.now() + 604_800_000),
      createdAt: now,
    },
  });

  return accessToken.id;
}

let memberCookie: string;
let boardCookie: string;

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
  resource = app.get<ProtectedResource>(PROTECTED_RESOURCE);
  bearer = app.get(BearerPrincipalService);

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

  await prisma.person.createMany({
    data: [
      { id: member.personId, firstName: "Mia", lastName: `App${suffix}` },
      { id: board.personId, firstName: "Bo", lastName: `App${suffix}` },
    ],
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });

  for (const client of [clientId, otherClientId]) {
    await prisma.oauthClient.create({
      data: {
        clientId: client,
        name: `Klient ${client}`,
        clientDiscoveryId: client,
        scopes: ["mcp:read", "mcp:write"],
        contacts: [],
        redirectUris: [`${new URL(client).origin}/cb`],
        postLogoutRedirectUris: [],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  const auth = app.get(AuthService);
  for (const who of [member, board]) {
    await auth.createAccountForPerson({
      personId: who.personId,
      email: who.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  memberCookie = await signIn(member.email);
  boardCookie = await signIn(board.email);
});

afterAll(async () => {
  if (prisma !== undefined) {
    await prisma.oauthClient.deleteMany({
      where: { clientId: { in: [clientId, otherClientId] } },
    });
    await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.boardPosition.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  }
  await app?.close();
});

describe("the discovery documents on a bare instance", () => {
  /*
   * No connector plugin is installed here, which is the ordinary state of an
   * instance that has just been set up. Sign-in has to be discoverable anyway:
   * a client is given one address and finds everything else from it, so a
   * document that 404s until somebody installs a plugin would make the whole
   * arrangement undiagnosable.
   */
  it("serves the authorization server document at the root of the origin", async () => {
    const response = await inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });

    expect(response.statusCode).toBe(200);
    const document = response.json<{
      issuer?: string;
      token_endpoint?: string;
      scopes_supported?: string[];
    }>();
    expect(document.token_endpoint).toContain("/oauth2/token");
    // The two scopes this instance issues, and nothing that would yield the
    // person's identity.
    expect(document.scopes_supported).toEqual(["mcp:read", "mcp:write"]);
    for (const scope of ["openid", "profile", "email"]) {
      expect(document.scopes_supported).not.toContain(scope);
    }
  });

  it("serves it without a session", async () => {
    // A discovery document says how a token may be obtained. Requiring a token
    // to read it is a loop.
    const response = await inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });

    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).not.toBe(403);
  });

  it("serves the protected resource document at both the bare path and the sub-path", async () => {
    const bare = await inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    const subPath = await inject({
      method: "GET",
      url: `/.well-known/oauth-protected-resource${resource.path}`,
    });

    expect(bare.statusCode).toBe(200);
    expect(subPath.statusCode).toBe(200);
    // Both name the same resource: a client given only the origin and one
    // given the route must arrive at the same place.
    expect(bare.json<{ resource?: string }>().resource).toBe(resource.url);
    expect(subPath.json<{ resource?: string }>().resource).toBe(resource.url);
  });

  it("names the connector's own route as the resource, not a path under the sign-in base", async () => {
    const response = await inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });

    const named = response.json<{ resource?: string }>().resource ?? "";
    // The trap: omitting the resource makes the library advertise a path under
    // its own base that no plugin serves.
    expect(named).not.toContain("/api/auth");
    expect(named).toContain("/api/plugin/");
  });

  it("refuses the openid alias rather than advertising an identity layer", async () => {
    const response = await inject({
      method: "GET",
      url: "/.well-known/openid-configuration",
    });

    /*
     * This is an OAuth authorization server and not an OpenID provider: the
     * openid scope is not offered, no id token is issued, and a client learns
     * nothing about who it acts for. So the refusal is the correct answer.
     *
     * 404 and not 500, which is the part worth asserting: the library raises
     * the refusal by throwing, and an unhandled throw would make a deliberate
     * answer look like the server having broken. And a JSON body rather than
     * the association's own not-found page, which is what an unclaimed path
     * under the origin's root would otherwise render.
     */
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
  });
});

describe("resolving a token", () => {
  it("reaches the person through the digest the options literal pinned", async () => {
    const token = `token-resolve-${suffix}`;
    await grant({ personId: member.personId, client: clientId, token });

    const identity = await bearer.resolve(token);

    // The unit spec proves the digest function. This proves the column the
    // resolver queries holds what that function produced - the two halves are
    // only connected by a real row.
    expect(identity?.principal.personId).toBe(member.personId);
    expect(identity?.clientId).toBe(clientId);
    expect(identity?.clientHost).toBe(new URL(clientId).host);

    await disconnectAll(member.personId);
  });

  it("refuses a token issued for another audience", async () => {
    const token = `token-audience-${suffix}`;
    await grant({
      personId: member.personId,
      client: clientId,
      token,
      // Minted by this same instance, for something else. The one rule the
      // protocol makes a MUST: a server must not accept a token that was not
      // issued for it.
      resources: ["https://brf.example/nagon-annan-resurs"],
    });

    expect(await bearer.resolve(token)).toBeNull();

    await disconnectAll(member.personId);
  });

  it("refuses an expired token, and one that was revoked", async () => {
    const expired = `token-expired-${suffix}`;
    await grant({
      personId: member.personId,
      client: clientId,
      token: expired,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await bearer.resolve(expired)).toBeNull();
    await disconnectAll(member.personId);

    const revoked = `token-revoked-${suffix}`;
    await grant({
      personId: member.personId,
      client: clientId,
      token: revoked,
    });
    await prisma.oauthAccessToken.updateMany({
      where: { token: hashOpaqueToken(revoked) },
      data: { revoked: new Date() },
    });
    expect(await bearer.resolve(revoked)).toBeNull();
    await disconnectAll(member.personId);
  });

  it("stops resolving the moment the connection is cut", async () => {
    const token = `token-cutoff-${suffix}`;
    await grant({ personId: member.personId, client: clientId, token });
    expect(await bearer.resolve(token)).not.toBeNull();

    await inject({
      method: "DELETE",
      url: `/api/connected-apps/mine/${encodeURIComponent(clientId)}`,
      headers: { cookie: memberCookie },
    });

    // Not eventually, and not when the token would have expired. The very next
    // resolution, because nothing in the path caches anything.
    expect(await bearer.resolve(token)).toBeNull();

    await disconnectAll(member.personId);
  });
});

describe("a member's own connections", () => {
  it("lists what they granted, with the app named and the token never shown", async () => {
    const token = `token-list-${suffix}`;
    await grant({ personId: member.personId, client: clientId, token });

    const response = await inject({
      method: "GET",
      url: "/api/connected-apps/mine",
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      connectedApps: { clientId: string; clientHost: string | null }[];
    }>();
    const listed = body.connectedApps.find((row) => row.clientId === clientId);
    expect(listed?.clientHost).toBe(new URL(clientId).host);
    // Neither the value nor its digest may reach a response body.
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain(hashOpaqueToken(token));

    await disconnectAll(member.personId);
  });

  it("does not show one member another member's connections", async () => {
    await grant({
      personId: board.personId,
      client: clientId,
      token: `token-other-${suffix}`,
    });

    const response = await inject({
      method: "GET",
      url: "/api/connected-apps/mine",
      headers: { cookie: memberCookie },
    });

    expect(response.json<{ connectedApps: unknown[] }>().connectedApps).toEqual(
      [],
    );

    await disconnectAll(board.personId);
  });
});

describe("cutting a connection", () => {
  it("deletes the tokens and the consent in one go", async () => {
    const token = `token-cut-${suffix}`;
    await grant({ personId: member.personId, client: clientId, token });

    const response = await inject({
      method: "DELETE",
      url: `/api/connected-apps/mine/${encodeURIComponent(clientId)}`,
      headers: { cookie: memberCookie },
    });
    expect(response.statusCode).toBe(200);

    const userId = await accountIdFor(member.personId);
    // The access row is gone, which is what makes the next call fail rather
    // than the one after the token would have expired.
    expect(
      await prisma.oauthAccessToken.count({ where: { userId, clientId } }),
    ).toBe(0);
    expect(
      await prisma.oauthConsent.count({ where: { userId, clientId } }),
    ).toBe(0);

    // The refresh row stays, revoked. Deleting it would throw away the signal
    // that a later use is a replay rather than an ordinary miss.
    const refresh = await prisma.oauthRefreshToken.findFirst({
      where: { userId, clientId },
      select: { revoked: true },
    });
    expect(refresh?.revoked).not.toBeNull();

    await disconnectAll(member.personId);
  });

  it("records nothing when a person cuts their own, and records it when somebody else does", async () => {
    const token = `token-audit-${suffix}`;
    await grant({ personId: member.personId, client: clientId, token });
    const userId = await accountIdFor(member.personId);
    const before = await disconnectionsRecordedFor(member.personId);

    await inject({
      method: "DELETE",
      url: `/api/connected-apps/mine/${encodeURIComponent(clientId)}`,
      headers: { cookie: memberCookie },
    });
    // Their own: nothing recorded, the way removing one's own passkey records
    // nothing.
    expect(await disconnectionsRecordedFor(member.personId)).toBe(before);

    await grant({
      personId: member.personId,
      client: otherClientId,
      token: `token-audit2-${suffix}`,
    });
    const onBehalf = await inject({
      method: "DELETE",
      url: `/api/connected-apps/${userId}/${encodeURIComponent(otherClientId)}`,
      headers: { cookie: boardCookie },
    });
    expect(onBehalf.statusCode).toBe(200);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "CONNECTED_APP_DISCONNECTED",
        targetPersonId: member.personId,
      },
      select: { actorPersonId: true, targetId: true, channel: true },
    });
    // Against both: the board member who acted, and the member whose grant it
    // was.
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.targetId).toBe(otherClientId);
    expect(entry?.channel).toBe("WEB");

    await disconnectAll(member.personId);
  });

  it("refuses a member cutting somebody else's", async () => {
    const userId = await accountIdFor(board.personId);

    const response = await inject({
      method: "DELETE",
      url: `/api/connected-apps/${userId}/${encodeURIComponent(clientId)}`,
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("the board's view", () => {
  it("is refused to a member with no capability", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/connected-apps",
      headers: { cookie: memberCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("shows the board who connected what", async () => {
    await grant({
      personId: member.personId,
      client: clientId,
      token: `token-board-${suffix}`,
    });

    const response = await inject({
      method: "GET",
      url: "/api/connected-apps",
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json<{
      connectedApps: {
        personId: string;
        userId: string;
        clientId: string;
        lastTokenIssuedAt: string | null;
      }[];
    }>().connectedApps;
    const listed = rows.find(
      (row) => row.personId === member.personId && row.clientId === clientId,
    );
    expect(listed).toBeDefined();
    // The grant hangs off the account, and cutting one is addressed by
    // account. Without this on the row the board's own disconnect has nothing
    // to send, and the screen would be a list with a button that cannot work.
    expect(listed?.userId).toBe(await accountIdFor(member.personId));
    expect(listed?.lastTokenIssuedAt).not.toBeNull();

    await disconnectAll(member.personId);
  });

  it("gives the board a row it can actually cut", async () => {
    await grant({
      personId: member.personId,
      client: clientId,
      token: `token-cut-board-${suffix}`,
    });

    const listed = await inject({
      method: "GET",
      url: "/api/connected-apps",
      headers: { cookie: boardCookie },
    });
    const row = listed
      .json<{ connectedApps: { userId: string; clientId: string }[] }>()
      .connectedApps.find((each) => each.clientId === clientId);

    // The id the list gave, used exactly as the screen would use it. A row
    // carrying the person's id instead would 404 here.
    const cut = await inject({
      method: "DELETE",
      url: `/api/connected-apps/${row?.userId ?? ""}/${encodeURIComponent(clientId)}`,
      headers: { cookie: boardCookie },
    });

    expect(cut.statusCode).toBe(200);

    await disconnectAll(member.personId);
  });
});

describe("erasing a person", () => {
  it("takes their grants and tokens with them, through the cascade alone", async () => {
    const token = `token-purge-${suffix}`;
    await grant({ personId: member.personId, client: clientId, token });
    const userId = await accountIdFor(member.personId);

    // The single statement the purge runs. Whether it is complete is a
    // property of the schema rather than of the service, so this is the only
    // place it can be shown.
    await prisma.user.deleteMany({ where: { personId: member.personId } });

    expect(await prisma.oauthConsent.count({ where: { userId } })).toBe(0);
    expect(await prisma.oauthAccessToken.count({ where: { userId } })).toBe(0);
    expect(await prisma.oauthRefreshToken.count({ where: { userId } })).toBe(0);
    // The client itself survives: it is not this person's, and other members
    // may hold connections to it.
    expect(
      await prisma.oauthClient.count({ where: { clientId } }),
    ).toBeGreaterThan(0);

    // Put the account back for the suites after this one.
    const auth = app.get(AuthService);
    await auth.createAccountForPerson({
      personId: member.personId,
      email: member.email,
      name: "Test Person",
      password: PASSWORD,
    });
    memberCookie = await signIn(member.email);
  });
});

/** Clears every grant a person holds, between cases. */
async function disconnectAll(personId: string): Promise<void> {
  const userId = await accountIdFor(personId);
  await prisma.oauthAccessToken.deleteMany({ where: { userId } });
  await prisma.oauthRefreshToken.deleteMany({ where: { userId } });
  await prisma.oauthConsent.deleteMany({ where: { userId } });
  // The audit entries are deliberately not cleared. The table is append-only
  // and DELETE is revoked from the application's own role, so a suite that
  // tidied up after itself here would be asserting against a guarantee the
  // product makes - the assertions below count instead.
}

/** How many disconnections are recorded against one person right now. */
async function disconnectionsRecordedFor(personId: string): Promise<number> {
  return prisma.auditLogEntry.count({
    where: { action: "CONNECTED_APP_DISCONNECTED", targetPersonId: personId },
  });
}
