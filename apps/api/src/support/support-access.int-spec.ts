import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { hashOpaqueToken } from "../auth/opaque-token";
import { PrismaService } from "../database/prisma.service";
import { ManagementListener } from "../management/management-listener";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";
import { SupportAccessService } from "./support-access.service";
import { SUPPORT_CAPABILITIES } from "./support-capabilities";

/**
 * Support access against a real database and the whole application (ADR
 * 0028): an administrator opens it, the host asks the management listener for
 * a link, a supporter signs in with it, looks, and is refused everything else;
 * and the access ends every way it can - closed, lapsed with the grant,
 * reached its end - taking the session with it.
 *
 * Signing in is rate-limited per client address, and 10.75.0.0/16 is this
 * suite's.
 */

const env = loadEnvForIntegrationTests();

const suffix = runSuffix();
const TOKEN = `support-int-spec-token-${suffix}`;
const PASSWORD = "a-long-enough-password";
const SUPPORTER = "Kim at the host";

const administrator = `support-administrator-${suffix}`;
const secondAdministrator = `support-second-administrator-${suffix}`;
const member = `support-member-${suffix}`;
const personIds = [administrator, secondAdministrator, member];

const previous = {
  port: process.env.OPENBRF_MANAGEMENT_PORT,
  digest: process.env.OPENBRF_MANAGEMENT_TOKEN_DIGEST,
};

let app: NestFastifyApplication;
let prisma: PrismaService;
let listener: ManagementListener;
let administratorCookie: string;
let secondAdministratorCookie: string;

const supportCookieName =
  new URL(env.APP_URL).protocol === "https:"
    ? "__Host-openbrf-support"
    : "openbrf-support";

let address = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object;
  cookie?: string;
}) {
  address += 1;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        "x-forwarded-for": `10.75.0.${String((address % 254) + 1)}`,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      },
    });
}

function cookiesOf(setCookie: string | string[] | undefined): string[] {
  return Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
}

async function signIn(personId: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email: `${personId}@exempel.se`, password: PASSWORD },
  });
  expect(response.statusCode, response.body).toBe(200);
  return cookiesOf(response.headers["set-cookie"])
    .map((value) => value.split(";")[0])
    .join("; ");
}

async function open(
  cookie = administratorCookie,
  hours = 8,
): Promise<{ id: string }> {
  const response = await inject({
    method: "POST",
    url: "/api/support-access",
    payload: { hours, reason: "Invitations are not arriving." },
    cookie,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>();
}

async function close(id: string, cookie = administratorCookie) {
  return inject({
    method: "POST",
    url: `/api/support-access/${id}/close`,
    cookie,
  });
}

function askForLink(supporter = SUPPORTER) {
  return listener.server.inject({
    method: "POST",
    url: "/v1/support-sessions",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify({ supporter }),
  });
}

/** The token in a link the host was given: everything after the `#`. */
function tokenIn(signInUrl: string): string {
  const fragment = new URL(signInUrl).hash;
  return fragment.slice(1);
}

/** Uses a link, answering with the cookie the browser would keep. */
async function useLink(token: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/support/session",
    payload: { token },
  });
  expect(response.statusCode, response.body).toBe(201);
  const set = cookiesOf(response.headers["set-cookie"]).find((value) =>
    value.startsWith(`${supportCookieName}=`),
  );
  expect(set).toBeDefined();
  return (set ?? "").split(";")[0] ?? "";
}

/**
 * A supporter signed in under a freshly issued link.
 *
 * Issued through the service rather than the listener, whose budget of ten a
 * minute this suite would spend: "the host's key" below goes through the
 * listener itself.
 */
async function supporterSession(): Promise<string> {
  const issued = await app.get(SupportAccessService).issueSignIn(SUPPORTER);
  return useLink(tokenIn(issued.signInUrl));
}

/** Closes whatever access this suite left open, so the next test starts clean. */
async function closeEverything(): Promise<void> {
  await prisma.supportAccess.updateMany({
    where: { closedAt: null },
    data: { closedAt: new Date(), closedById: administrator },
  });
}

async function entries(action: string) {
  return prisma.auditLogEntry.findMany({
    where: {
      action: action as never,
      OR: [
        { actorPersonId: { in: personIds } },
        { actorPersonId: null, createdAt: { gte: startedAt } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
}

let startedAt: Date;

beforeAll(async () => {
  process.env.OPENBRF_MANAGEMENT_PORT = "3902";
  process.env.OPENBRF_MANAGEMENT_TOKEN_DIGEST = hashOpaqueToken(TOKEN);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  prisma = app.get(PrismaService);
  listener = app.get(ManagementListener);
  startedAt = new Date();

  await prisma.person.createMany({
    data: personIds.map((id) => ({
      id,
      firstName: "Test",
      lastName: `Support${suffix}`,
    })),
  });
  await prisma.systemRole.createMany({
    data: [
      { personId: administrator, role: "ADMIN" },
      { personId: secondAdministrator, role: "ADMIN" },
    ],
  });
  for (const id of personIds) {
    await app.get(AuthService).createAccountForPerson({
      personId: id,
      email: `${id}@exempel.se`,
      name: "Test Person",
      password: PASSWORD,
    });
  }
  administratorCookie = await signIn(administrator);
  secondAdministratorCookie = await signIn(secondAdministrator);
  await closeEverything();
});

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await prisma.supportSession.deleteMany({
        where: { access: { openedById: { in: personIds } } },
      });
      await prisma.supportAccess.deleteMany({
        where: { openedById: { in: personIds } },
      });
      await prisma.session.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.account.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
      await prisma.systemRole.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    }
  } finally {
    await app?.close();
    restoreEnvironmentVariable("OPENBRF_MANAGEMENT_PORT", previous.port);
    restoreEnvironmentVariable(
      "OPENBRF_MANAGEMENT_TOKEN_DIGEST",
      previous.digest,
    );
  }
});

describe("opening and closing", () => {
  it("opens for the hours chosen, and writes the reason to the log alone", async () => {
    const before = Date.now();
    const access = await open();

    const row = await prisma.supportAccess.findUniqueOrThrow({
      where: { id: access.id },
    });
    expect(row.openedById).toBe(administrator);
    expect(row.endsAt.getTime() - row.openedAt.getTime()).toBe(
      8 * 60 * 60 * 1000,
    );
    expect(row.openedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

    const [opened] = await entries("SUPPORT_ACCESS_OPENED");
    expect(opened).toMatchObject({
      channel: "WEB",
      actorPersonId: administrator,
      targetKind: "supportAccess",
      targetId: access.id,
      context: {
        hours: 8,
        reason: "Invitations are not arriving.",
        endsAt: row.endsAt.toISOString(),
      },
    });
    await closeEverything();
  });

  it("refuses a second access while one is open", async () => {
    await open();

    const second = await inject({
      method: "POST",
      url: "/api/support-access",
      payload: { hours: 1, reason: "Again." },
      cookie: secondAdministratorCookie,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ reason: "support-access-open" });
    await closeEverything();
  });

  it("opens one access when two administrators open at once", async () => {
    const [first, second] = await Promise.all(
      [administratorCookie, secondAdministratorCookie].map((cookie) =>
        inject({
          method: "POST",
          url: "/api/support-access",
          payload: { hours: 1, reason: "At the same moment." },
          cookie,
        }),
      ),
    );

    expect(
      [first?.statusCode ?? 0, second?.statusCode ?? 0].sort((a, b) => a - b),
    ).toEqual([201, 409]);
    await closeEverything();
  });

  it.each([
    ["hours it does not offer", { hours: 2, reason: "Why." }],
    ["more than seven days", { hours: 169, reason: "Why." }],
    ["no reason", { hours: 1, reason: "   " }],
    ["a reason over 500 characters", { hours: 1, reason: "x".repeat(501) }],
  ])("refuses %s", async (_what, payload) => {
    const response = await inject({
      method: "POST",
      url: "/api/support-access",
      payload,
      cookie: administratorCookie,
    });

    expect(response.statusCode).toBe(400);
  });

  it("is opened and closed by an administrator, and read by nobody without association:read", async () => {
    const memberCookie = await signIn(member);

    const opening = await inject({
      method: "POST",
      url: "/api/support-access",
      payload: { hours: 1, reason: "Why." },
      cookie: memberCookie,
    });
    const reading = await inject({
      method: "GET",
      url: "/api/support-access",
      cookie: memberCookie,
    });

    expect(opening.statusCode).toBe(403);
    expect(reading.statusCode).toBe(403);
  });

  it("is closed by any administrator, and the log says who", async () => {
    const access = await open();

    const closed = await close(access.id, secondAdministratorCookie);
    expect(closed.statusCode).toBe(204);
    const again = await close(access.id, administratorCookie);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ reason: "support-access-closed" });

    const row = await prisma.supportAccess.findUniqueOrThrow({
      where: { id: access.id },
    });
    expect(row.closedById).toBe(secondAdministrator);
    const closings = await entries("SUPPORT_ACCESS_CLOSED");
    expect(closings.at(-1)).toMatchObject({
      channel: "WEB",
      actorPersonId: secondAdministrator,
      targetId: access.id,
    });
  });
});

describe("the host's key", () => {
  it("gets nothing while no access is open", async () => {
    await closeEverything();

    const response = await askForLink();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ reason: "support-access-closed" });
  });

  it("gets a single-use link while one is, keeping only its digest", async () => {
    const access = await open();

    const response = await askForLink();

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<{
      signInUrl: string;
      expiresAt: string;
      accessEndsAt: string;
    }>();
    expect(body.signInUrl).toMatch(
      new RegExp(`^${env.APP_URL.replace(/\/+$/, "")}/app/support#[\\w-]{43}$`),
    );
    const row = await prisma.supportSession.findFirstOrThrow({
      where: { accessId: access.id },
    });
    expect(row.supporter).toBe(SUPPORTER);
    expect(row.signInTokenHash).toBe(hashOpaqueToken(tokenIn(body.signInUrl)));
    expect(row.signInExpiresAt.toISOString()).toBe(body.expiresAt);
    expect(row.signInExpiresAt.getTime() - row.issuedAt.getTime()).toBe(
      10 * 60 * 1000,
    );

    const [issued] = (await entries("SUPPORT_SESSION_ISSUED")).filter(
      (entry) => entry.targetId === row.id,
    );
    expect(issued).toMatchObject({
      channel: "MANAGEMENT",
      actorPersonId: null,
      targetKind: "supportSession",
      context: { access: access.id, supporter: SUPPORTER },
    });

    const first = await inject({
      method: "POST",
      url: "/api/support/session",
      payload: { token: tokenIn(body.signInUrl) },
    });
    const second = await inject({
      method: "POST",
      url: "/api/support/session",
      payload: { token: tokenIn(body.signInUrl) },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(401);
    expect(second.json()).toMatchObject({ reason: "support-sign-in-invalid" });
    await closeEverything();
  });

  it("starts one session when the same link is used twice at once", async () => {
    await open();
    const issued = await app.get(SupportAccessService).issueSignIn(SUPPORTER);
    const token = tokenIn(issued.signInUrl);

    const answers = await Promise.all(
      [1, 2].map(() =>
        inject({
          method: "POST",
          url: "/api/support/session",
          payload: { token },
        }),
      ),
    );

    expect(
      answers.map((answer) => answer.statusCode).sort((a, b) => a - b),
    ).toEqual([201, 401]);
    await closeEverything();
  });

  it("refuses a link older than ten minutes", async () => {
    const access = await open();
    const issued = await askForLink();
    const token = tokenIn(issued.json<{ signInUrl: string }>().signInUrl);
    await prisma.supportSession.updateMany({
      where: { accessId: access.id },
      data: { signInExpiresAt: new Date(Date.now() - 1000) },
    });

    const response = await inject({
      method: "POST",
      url: "/api/support/session",
      payload: { token },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      reason: "support-sign-in-invalid",
    });
    await closeEverything();
  });

  it("refuses a link whose access was closed before it was used", async () => {
    const access = await open();
    const issued = await askForLink();
    await close(access.id);

    const response = await inject({
      method: "POST",
      url: "/api/support/session",
      payload: {
        token: tokenIn(issued.json<{ signInUrl: string }>().signInUrl),
      },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("what a supporter reaches", () => {
  let cookie: string;
  let accessId: string;

  beforeAll(async () => {
    accessId = (await open(administratorCookie, 168)).id;
    cookie = await supporterSession();
  });

  afterAll(async () => {
    await closeEverything();
  });

  it("starts with an entry on SUPPORT naming the administrator", async () => {
    const started = (await entries("SUPPORT_SESSION_STARTED")).at(-1);
    const session = await prisma.supportSession.findFirstOrThrow({
      where: { accessId, startedAt: { not: null } },
    });

    expect(started).toMatchObject({
      channel: "SUPPORT",
      actorPersonId: administrator,
      targetId: session.id,
      context: { support: { session: session.id } },
    });
    expect(session.expiresAt?.getTime()).toBe(
      (session.startedAt?.getTime() ?? 0) + 8 * 60 * 60 * 1000,
    );
  });

  it("is told who it is, what it may reach and when it ends", async () => {
    const response = await inject({ method: "GET", url: "/api/me", cookie });

    expect(response.statusCode, response.body).toBe(200);
    const viewer = response.json<{
      personId: string;
      capabilities: string[];
      support: { supporter: string; endsAt: string } | null;
    }>();
    expect(viewer.personId).toBe(administrator);
    expect([...viewer.capabilities].sort()).toEqual(
      [...SUPPORT_CAPABILITIES].sort(),
    );
    expect(viewer.support?.supporter).toBe(SUPPORTER);
  });

  it("reads the address book, and the request is in the log", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/address-book/persons/${member}?search=Astrid`,
      cookie,
    });

    expect(response.statusCode, response.body).toBe(200);
    const request = (await entries("SUPPORT_REQUEST")).at(-1);
    expect(request).toMatchObject({
      channel: "SUPPORT",
      actorPersonId: administrator,
      context: {
        method: "GET",
        route: "/api/address-book/persons/:id",
        params: { id: member },
      },
    });
    expect(JSON.stringify(request?.context)).not.toContain("Astrid");
  });

  it("writes an audited read on SUPPORT, though its call site says WEB", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/member-register",
      cookie,
    });

    expect(response.statusCode, response.body).toBe(200);
    const extract = (await entries("MEMBER_REGISTER_EXTRACT_GENERATED")).at(-1);
    expect(extract).toMatchObject({
      channel: "SUPPORT",
      actorPersonId: administrator,
    });
    const context = extract?.context as
      { support?: { session?: string } } | undefined;
    expect(context?.support?.session).toBeDefined();
  });

  it.each([
    ["the apartment register", "GET", "/api/apartment-register", 403],
    ["the admin's own connected apps", "GET", "/api/connected-apps/mine", 403],
    ["the sign-in library", "GET", "/api/auth/get-session", 403],
    ["a change to the settings", "PUT", "/api/settings/self-signup", 403],
    ["opening support access itself", "POST", "/api/support-access", 403],
  ] as const)("is refused %s", async (_what, method, url, status) => {
    const response = await inject({
      method,
      url,
      cookie,
      ...(method === "GET" ? {} : { payload: { enabled: true } }),
    });

    expect(response.statusCode, response.body).toBe(status);
  });

  it("is the support session even in a browser holding an account session", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/apartment-register",
      cookie: `${administratorCookie}; ${cookie}`,
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("how a support session ends", () => {
  it("ends when an administrator closes the access, and the cookie goes with it", async () => {
    const access = await open();
    const cookie = await supporterSession();
    expect(
      (await inject({ method: "GET", url: "/api/me", cookie })).statusCode,
    ).toBe(200);

    await close(access.id);
    const after = await inject({ method: "GET", url: "/api/me", cookie });

    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ reason: "support-session-invalid" });
    expect(cookiesOf(after.headers["set-cookie"]).join()).toContain(
      `${supportCookieName}=;`,
    );
  });

  it("ends when the access reaches its end, though nobody closed it", async () => {
    const access = await open();
    const cookie = await supporterSession();
    await prisma.supportAccess.update({
      where: { id: access.id },
      data: { endsAt: new Date(Date.now() - 1000) },
    });

    const after = await inject({ method: "GET", url: "/api/me", cookie });

    expect(after.statusCode).toBe(401);
    await closeEverything();
  });

  it("ends eight hours after it started, whatever the access says", async () => {
    const access = await open(administratorCookie, 168);
    const cookie = await supporterSession();
    await prisma.supportSession.updateMany({
      where: { accessId: access.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const after = await inject({ method: "GET", url: "/api/me", cookie });

    expect(after.statusCode).toBe(401);
    await closeEverything();
  });

  it("lapses with the opener's grant, and a new grant does not revive it", async () => {
    const access = await open();
    const cookie = await supporterSession();

    await prisma.systemRole.deleteMany({
      where: { personId: administrator, role: "ADMIN" },
    });
    const lapsed = await inject({ method: "GET", url: "/api/me", cookie });
    await prisma.systemRole.create({
      data: { personId: administrator, role: "ADMIN" },
    });
    const regranted = await inject({ method: "GET", url: "/api/me", cookie });

    expect(lapsed.statusCode).toBe(401);
    expect(regranted.statusCode).toBe(401);
    const overview = await inject({
      method: "GET",
      url: "/api/support-access",
      cookie: secondAdministratorCookie,
    });
    const listed = overview
      .json<{ open: unknown; accesses: { id: string; state: string }[] }>()
      .accesses.find((entry) => entry.id === access.id);
    expect(listed?.state).toBe("lapsed");

    // A lapsed access is not open, so a new one may be opened beside it.
    await open(secondAdministratorCookie);
    await closeEverything();
  });

  it("ends the earlier session when the same browser signs in again", async () => {
    const access = await open();
    const first = await supporterSession();
    const issued = await app.get(SupportAccessService).issueSignIn(SUPPORTER);

    const second = await inject({
      method: "POST",
      url: "/api/support/session",
      payload: { token: tokenIn(issued.signInUrl) },
      cookie: first,
    });
    const earlier = await inject({
      method: "GET",
      url: "/api/me",
      cookie: first,
    });

    expect(second.statusCode).toBe(201);
    expect(earlier.statusCode).toBe(401);
    const sessions = await prisma.supportSession.findMany({
      where: { accessId: access.id },
      orderBy: { issuedAt: "asc" },
    });
    expect(sessions.map((session) => session.endedAt !== null)).toEqual([
      true,
      false,
    ]);
    await closeEverything();
  });

  it("is refused the contact inbox, though it holds the capability that opens it", async () => {
    await open();
    const cookie = await supporterSession();

    const inbox = await inject({
      method: "GET",
      url: "/api/contact-submissions",
      cookie,
    });

    expect(inbox.statusCode).toBe(403);
    expect(inbox.json()).toMatchObject({ reason: "support-access-refused" });
    await closeEverything();
  });

  it("reads a person without the data protection casework about them", async () => {
    await open();
    const cookie = await supporterSession();
    await prisma.legalHold.create({
      data: {
        personId: member,
        reason: "Tvist om avgift",
        placedByPersonId: administrator,
      },
    });

    const asSupporter = await inject({
      method: "GET",
      url: `/api/address-book/persons/${member}`,
      cookie,
    });
    const asAdministrator = await inject({
      method: "GET",
      url: `/api/address-book/persons/${member}`,
      cookie: administratorCookie,
    });

    expect(asSupporter.json()).toMatchObject({
      legalHold: null,
      dataSubjectRequests: [],
    });
    expect(asSupporter.body).not.toContain("Tvist om avgift");
    expect(asAdministrator.body).toContain("Tvist om avgift");
    await prisma.legalHold.deleteMany({ where: { personId: member } });
    await closeEverything();
  });

  it("ends when the supporter signs out", async () => {
    await open();
    const cookie = await supporterSession();

    const signedOut = await inject({
      method: "DELETE",
      url: "/api/support/session",
      cookie,
    });
    const after = await inject({ method: "GET", url: "/api/me", cookie });

    expect(signedOut.statusCode).toBe(204);
    expect(cookiesOf(signedOut.headers["set-cookie"]).join()).toContain(
      `${supportCookieName}=;`,
    );
    expect(after.statusCode).toBe(401);
    expect((await entries("SUPPORT_SESSION_ENDED")).at(-1)).toMatchObject({
      channel: "SUPPORT",
      actorPersonId: administrator,
    });
    await closeEverything();
  });
});

describe("what the settings screen is shown", () => {
  it("lists the open access with its sessions and the supporter's name", async () => {
    const access = await open();
    await supporterSession();

    const response = await inject({
      method: "GET",
      url: "/api/support-access",
      cookie: administratorCookie,
    });

    expect(response.statusCode).toBe(200);
    const overview = response.json<{
      open: {
        id: string;
        state: string;
        openedBy: { personId: string; name: string | null };
        sessions: { supporter: string; startedAt: string | null }[];
      } | null;
    }>();
    expect(overview.open?.id).toBe(access.id);
    expect(overview.open?.state).toBe("open");
    expect(overview.open?.openedBy).toEqual({
      personId: administrator,
      name: `Test Support${suffix}`,
    });
    expect(overview.open?.sessions).toEqual([
      expect.objectContaining({
        supporter: SUPPORTER,
        startedAt: expect.any(String),
      }),
    ]);
    await closeEverything();
  });
});
