import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";

/**
 * Where an administrator may point the SMS gateway and the SMTP server, through
 * the routes and against a real database.
 *
 * Both settings make the process holding the member register connect where an
 * administrator said, and beside it on the network are the database and, on a
 * hosting provider, the metadata service. What this holds the routes to is that
 * such an address is refused at the save, with a reason the screen translates,
 * and that what was stored before is left as it was.
 *
 * The instance is configured as one whose operator allowed no private hosts,
 * which is the default, whatever the developer's own environment says.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "integration-password-1";
const administrator = {
  personId: `outbound-admin-${suffix}`,
  email: `outbound-admin-${suffix}@exempel.se`,
};

const SETTINGS_COLUMNS = {
  smsDriver: true,
  smsGatewayUrl: true,
  smsGatewayTokenCipher: true,
  smsSenderName: true,
  smtpHost: true,
  smtpPort: true,
  smtpSecure: true,
  smtpRequireTls: true,
  smtpUser: true,
  smtpPasswordCipher: true,
  smtpFromAddress: true,
} as const;

/** What the row held before this suite, put back afterwards. */
let columnsBefore: Record<string, unknown> | null = null;
let associationCreated = false;
let administratorCookie: string;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.73.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.73.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PUT";
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

beforeAll(async () => {
  const env: Env = {
    ...baseEnv,
    OPENBRF_MAIL_DRIVER: "settings",
    OPENBRF_ALLOW_PRIVATE_HOSTS: false,
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);

  columnsBefore = await prisma.association.findUnique({
    where: { id: 1 },
    select: SETTINGS_COLUMNS,
  });
  if (columnsBefore === null) {
    associationCreated = true;
    await prisma.association.create({
      data: { id: 1, name: "Brf Eksemplet", setupCompletedAt: new Date() },
    });
  }
  // A gateway and a server on the internet, stored before the cases below try
  // to replace them.
  await prisma.association.update({
    where: { id: 1 },
    data: {
      smsDriver: "http-gateway",
      smsGatewayUrl: "https://sms.gateway.example/send",
      smtpHost: "smtp.eksemplet.example",
      smtpFromAddress: `kansliet-${suffix}@eksemplet.example`,
    },
  });

  await prisma.person.create({
    data: {
      id: administrator.personId,
      firstName: "Holger",
      lastName: `Utgående${suffix}`,
    },
  });
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });
  await app.get(AuthService).createAccountForPerson({
    personId: administrator.personId,
    email: administrator.email,
    name: "Test Person",
    password: PASSWORD,
  });
  administratorCookie = await signIn(administrator.email);
}, 180_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    await run().catch((cause: unknown) => failures.push(cause));
  };

  if (prisma !== undefined) {
    const personId = administrator.personId;
    await step(() => prisma.systemRole.deleteMany({ where: { personId } }));
    await step(() => prisma.user.deleteMany({ where: { personId } }));
    await step(() => prisma.person.deleteMany({ where: { id: personId } }));
    if (associationCreated) {
      await step(() => prisma.association.deleteMany({ where: { id: 1 } }));
    } else if (columnsBefore !== null) {
      const columns = columnsBefore;
      await step(() =>
        prisma.association.update({ where: { id: 1 }, data: columns }),
      );
    }
  }
  await app?.close();

  if (failures.length > 0) {
    throw new AggregateError(failures, "cleanup failed");
  }
});

async function stored(): Promise<{
  smsGatewayUrl: string | null;
  smtpHost: string | null;
}> {
  const row = await prisma.association.findUniqueOrThrow({
    where: { id: 1 },
    select: { smsGatewayUrl: true, smtpHost: true },
  });
  return row;
}

describe("an SMS gateway on a private network", () => {
  it.each([
    // The database's own port on loopback, and the metadata service.
    "http://127.0.0.1:5432/",
    "http://169.254.169.254/",
  ])("is refused at the save: %s", async (gatewayUrl) => {
    const response = await inject({
      method: "PUT",
      url: "/api/settings/sms",
      payload: { driver: "http-gateway", gatewayUrl, senderName: null },
      headers: { cookie: administratorCookie },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ reason: "host-not-public" });
    expect((await stored()).smsGatewayUrl).toBe(
      "https://sms.gateway.example/send",
    );
  });
});

describe("an SMTP server on a private network", () => {
  it.each(["127.0.0.1", "169.254.169.254"])(
    "is refused at the save: %s",
    async (host) => {
      const response = await inject({
        method: "PUT",
        url: "/api/settings/smtp",
        payload: {
          host,
          port: 5432,
          secure: false,
          user: null,
          fromAddress: `kansliet-${suffix}@eksemplet.example`,
        },
        headers: { cookie: administratorCookie },
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ reason: "host-not-public" });
      expect((await stored()).smtpHost).toBe("smtp.eksemplet.example");
    },
  );
});
