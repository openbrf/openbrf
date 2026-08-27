import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "./auth.service";
import { MailService } from "../mail/mail.service";
import { PrismaService } from "../database/prisma.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";

/**
 * Exercises the real sign-in surface over HTTP, through the Fastify bridge.
 *
 * The bridge is the reason this is an integration test rather than a unit one:
 * the failure modes are cookie handling, body re-serialization and URL
 * reconstruction, none of which a mocked handler would exercise.
 */

// Also sets process.env.NODE_ENV, which the app reads directly to decide
// whether the job queue starts.
loadEnvForIntegrationTests();

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
    // TOTP entirely. Asserting on the response alone would not prove that:
    // it stays identical whatever happens, which is the point. What is
    // delivered is the property under test.
    const { delivered, restore } = captureMail();
    let enrolled;
    let unknown;
    try {
      enrolled = await inject({
        method: "POST",
        url: "/api/auth/sign-in/magic-link",
        payload: { email: withTotp.email },
      });
      unknown = await inject({
        method: "POST",
        url: "/api/auth/sign-in/magic-link",
        payload: { email: `nobody-${suffix}@exempel.se` },
      });
    } finally {
      restore();
    }

    // The enrolled address gets the explanation, never the link.
    expect(delivered.map(({ to, templateId }) => ({ to, templateId }))).toEqual(
      [{ to: withTotp.email, templateId: "magic-link-refused" }],
    );

    // The endpoint is public, so the refusal must be invisible from outside:
    // an error naming the reason would confirm both that the address has an
    // account and that the account has a second factor, which is an
    // enumeration oracle against a statutory register.
    expect(enrolled.statusCode).toBe(200);
    expect(enrolled.statusCode).toBe(unknown.statusCode);
    expect(enrolled.body).toBe(unknown.body);
    expect(enrolled.body).not.toContain("authenticator");
  });

  it("mails nothing to an address that has no account", async () => {
    // The plugin invokes the delivery callback before it checks whether the
    // user exists, so without the guard anyone could make this instance send
    // a sign-in email to an address of their choosing.
    const { delivered, restore } = captureMail();
    try {
      const response = await inject({
        method: "POST",
        url: "/api/auth/sign-in/magic-link",
        payload: { email: `stranger-${suffix}@exempel.se` },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      restore();
    }

    expect(delivered).toEqual([]);
  });

  it("stores the sign-in token hashed, so a leaked database yields no links", async () => {
    const { delivered, restore } = captureMail();
    try {
      await inject({
        method: "POST",
        url: "/api/auth/sign-in/magic-link",
        payload: { email: plain.email },
      });
    } finally {
      restore();
    }

    const props = delivered[0]?.props as { signInUrl: string } | undefined;
    const token = new URL(
      props?.signInUrl ?? "https://x.invalid",
    ).searchParams.get("token");
    expect(token).not.toBeNull();

    // The token in the email must not be what is stored: the plugin keeps it
    // in plain text unless told otherwise, and a magic link is a sign-in
    // credential in the same class as an invitation token, which this project
    // stores hashed for exactly this reason.
    const stored = await prisma.verification.findMany({
      where: { identifier: token ?? "" },
    });
    expect(stored).toEqual([]);
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

/**
 * Records what MailService would deliver, without sending anything.
 *
 * The magic-link policy is only observable in what arrives: every branch
 * answers the caller identically on purpose, so a test that reads the response
 * cannot tell a delivered link from a refusal.
 */
function captureMail(): {
  delivered: { to: string; templateId: string; props: unknown }[];
  restore: () => void;
} {
  const mail = app.get(MailService);
  const original = mail.send.bind(mail) as MailService["send"];
  const delivered: { to: string; templateId: string; props: unknown }[] = [];

  mail.send = ((input: {
    to: string;
    template: { id: string };
    props: unknown;
  }) => {
    delivered.push({
      to: input.to,
      templateId: input.template.id,
      props: input.props,
    });
    return Promise.resolve();
  }) as MailService["send"];

  return {
    delivered,
    restore: () => {
      mail.send = original;
    },
  };
}

function extractCookie(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}
