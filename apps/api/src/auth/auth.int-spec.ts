import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "./auth.service";
import { PrismaService } from "../database/prisma.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";

/**
 * Exercises the real sign-in surface over HTTP, through the Fastify bridge.
 *
 * The bridge is the reason this is an integration test rather than a unit one:
 * the failure modes are cookie handling, body re-serialization and URL
 * reconstruction, none of which a mocked handler would exercise.
 */

loadEnvForIntegrationTests();
// The app reads its own environment; the job queue skips startup under test.
process.env.NODE_ENV = "test";

let app: NestFastifyApplication;
let prisma: PrismaService;
let auth: AuthService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "correct-horse-battery-staple";

const plain = {
  personId: `auth-person-${suffix}`,
  email: `plain-${suffix}@exempel.se`,
};
const withTotp = {
  personId: `auth-totp-person-${suffix}`,
  email: `totp-${suffix}@exempel.se`,
};

let ipCounter = 0;

/**
 * Injects a request with a distinct client IP by default.
 *
 * Rate limiting is deliberately left enabled in these tests, so without a
 * fresh IP per call the suite would throttle itself and the failures would look
 * like auth bugs. Pass an explicit x-forwarded-for to share a bucket, which is
 * how the rate-limit test below hits the limit on purpose.
 */
function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  ipCounter += 1;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": `10.0.0.${String(ipCounter % 250)}`,
        ...options.headers,
      },
    });
}

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

  for (const person of [plain, withTotp]) {
    await prisma.person.create({
      data: {
        id: person.personId,
        firstName: "Test",
        lastName: "Person",
        preferredLocale: "sv",
      },
    });
    await auth.createAccountForPerson({
      personId: person.personId,
      email: person.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  // Enrol the second person in TOTP. Setting the flag directly is exactly what
  // the magic-link guard reads, and it keeps this test focused on the policy
  // rather than on the enrolment ceremony.
  await prisma.user.update({
    where: { email: withTotp.email },
    data: { twoFactorEnabled: true },
  });
}, 120_000);

afterAll(async () => {
  const personIds = [plain.personId, withTotp.personId];
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await app.close();
});

describe("password sign-in", () => {
  it("issues a session cookie for correct credentials", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: plain.email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const cookies = response.headers["set-cookie"];
    expect(cookies).toBeDefined();
    expect(JSON.stringify(cookies)).toContain("session_token");
  });

  it("rejects a wrong password", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: plain.email, password: "not-the-password" },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("returns the signed-in user for a session cookie", async () => {
    const signIn = await inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: plain.email, password: PASSWORD },
    });
    const cookie = extractCookie(signIn.headers["set-cookie"]);

    const session = await inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie },
    });

    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      user: { email: plain.email },
    });
  });

  it("refuses open registration", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        email: `intruder-${suffix}@exempel.se`,
        password: PASSWORD,
        name: "Intruder",
        personId: "does-not-exist",
      },
    });

    // An instance holding a statutory register has no open sign-up.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("magic link and the second-factor policy", () => {
  it("issues a magic link for an account without TOTP", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/auth/sign-in/magic-link",
      payload: { email: plain.email },
    });

    expect(response.statusCode).toBe(200);
  });

  it("sends no magic link for an account with TOTP enrolled, and says so only by mail", async () => {
    // Better Auth's second factor gates password sign-in only, so a magic
    // link would hand out a session with mailbox access alone and walk around
    // TOTP entirely. No link is issued.
    const enrolled = await inject({
      method: "POST",
      url: "/api/auth/sign-in/magic-link",
      payload: { email: withTotp.email },
    });
    // The endpoint is public, so the refusal must be invisible from outside:
    // an error naming the reason would confirm both that the address has an
    // account and that the account has a second factor, which is an
    // enumeration oracle against a statutory register. The reason goes to the
    // mailbox instead.
    const unknown = await inject({
      method: "POST",
      url: "/api/auth/sign-in/magic-link",
      payload: { email: `nobody-${suffix}@exempel.se` },
    });

    expect(enrolled.statusCode).toBe(200);
    expect(enrolled.statusCode).toBe(unknown.statusCode);
    expect(enrolled.body).toBe(unknown.body);
    expect(enrolled.body).not.toContain("authenticator");
  });

  it("still allows password sign-in for the TOTP account, with a challenge", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: withTotp.email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    // The plugin returns a challenge instead of a session.
    expect(response.json()).toMatchObject({ twoFactorRedirect: true });
  });
});

describe("rate limiting", () => {
  it("throttles repeated attempts from one address", async () => {
    const attacker = { "x-forwarded-for": "203.0.113.7" };
    let sawThrottling = false;

    // Deliberately share one bucket. The limit is 20 per minute.
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        payload: { email: plain.email, password: "wrong-password" },
        headers: attacker,
      });
      if (response.statusCode === 429) {
        sawThrottling = true;
        break;
      }
    }

    expect(sawThrottling).toBe(true);
  }, 60_000);

  it("does not let one throttled address lock out everyone else", async () => {
    // The previous test exhausted 203.0.113.7. A different resident must still
    // be able to sign in: a shared bucket would take the whole board down.
    const response = await inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: plain.email, password: PASSWORD },
      headers: { "x-forwarded-for": "198.51.100.42" },
    });

    expect(response.statusCode).toBe(200);
  }, 30_000);
});

describe("account creation invariants", () => {
  it("refuses a second account for the same person", async () => {
    await expect(
      auth.createAccountForPerson({
        personId: plain.personId,
        email: `duplicate-${suffix}@exempel.se`,
        name: "Duplicate",
        password: PASSWORD,
      }),
    ).rejects.toThrow(/at most one/i);
  });
});

function extractCookie(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}
