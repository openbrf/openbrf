import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { PurgeService } from "../retention/purge.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { AuditLogService } from "./audit-log.service";

/**
 * The channel, against a real database.
 *
 * Three properties that only this suite can show. The nightly job's own writes
 * say SYSTEM, which is the value that replaces the inference that an entry
 * without an actor was the system's - and the purge is the exact write that
 * inference was made for. The column reaches the data subject access report,
 * which is the document the whole change is for. And the column is inside the
 * append-only guarantee: a channel written wrongly cannot be tidied up
 * afterwards, which is why the writer requires it rather than defaulting it.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let audit: AuditLogService;
let purge: PurgeService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const board = {
  personId: `audit-channel-board-${suffix}`,
  email: `audit-channel-board-${suffix}@exempel.se`,
};
const subject = { personId: `audit-channel-subject-${suffix}` };
const leaver = { personId: `audit-channel-leaver-${suffix}` };
const personIds = [board.personId, subject.personId, leaver.personId];

const addressId = `audit-channel-address-${suffix}`;
const apartmentId = `audit-channel-apartment-${suffix}`;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.45.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.45.${String(subnet)}.${String(host + 1)}`;
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
  audit = app.get(AuditLogService);
  purge = app.get(PurgeService);

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
      { id: board.personId, firstName: "Bo", lastName: `Kanal${suffix}` },
      { id: subject.personId, firstName: "Siv", lastName: `Kanal${suffix}` },
      {
        id: leaver.personId,
        firstName: "Lars",
        lastName: `Kanal${suffix}`,
        // Something for the purge to clear: it deliberately writes no entry
        // for an erasure that erased nothing, and this suite is about the
        // entry.
        preferredLocale: "en",
      },
    ],
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });
  await prisma.address.create({
    data: {
      id: addressId,
      street: `Kanalgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: { create: [{ id: apartmentId, number: "1001", floor: 0 }] },
    },
  });
  // Moved out long ago, so the purge has somebody to reach.
  await prisma.residency.create({
    data: {
      personId: leaver.personId,
      apartmentId,
      role: "RESIDENT",
      movedInOn: new Date("2020-01-01"),
      movedOutOn: new Date("2020-12-31"),
    },
  });

  const auth = app.get(AuthService);
  await auth.createAccountForPerson({
    personId: board.personId,
    email: board.email,
    name: "Test Person",
    password: PASSWORD,
  });

  boardCookie = await signIn(board.email);
});

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      /*
       * The entries this suite wrote stay. The log is append-only and outlives
       * what it describes, which is the property under test here, and every
       * other suite leaves its own entries for the same reason.
       */
      await prisma.residency.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.apartment.deleteMany({ where: { id: apartmentId } });
      await prisma.address.deleteMany({ where: { id: addressId } });
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.session.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.account.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    }
  } finally {
    await app?.close();
  }
});

describe("what the nightly job says about itself", () => {
  it("writes SYSTEM rather than leaving the actor empty and hoping", async () => {
    /*
     * The write the old inference was made for. An entry with no actor used to
     * be read as the system's, which held only while every other writer had
     * one; once a token can write without a person, the job has to say so.
     */
    const outcome = await purge.purgePerson(leaver.personId, new Date(), 0);
    expect(outcome).not.toBeNull();

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        targetPersonId: leaver.personId,
        action: "SERVICE_DATA_PURGED",
      },
      select: { channel: true, actorPersonId: true },
    });
    expect(entry.channel).toBe("SYSTEM");
    expect(entry.actorPersonId).toBeNull();
  });
});

describe("what the log keeps about a connected app", () => {
  it("records which app acted, beside the person it acted as", async () => {
    await audit.record({
      action: "NEWS_PUBLISHED",
      channel: "MCP",
      actorPersonId: board.personId,
      clientId: `client-${suffix}`,
      clientHost: "claude.ai",
      targetKind: "news",
      targetId: `news-${suffix}`,
      context: { slug: `arsstamma-${suffix}` },
    });

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { actorPersonId: board.personId, action: "NEWS_PUBLISHED" },
      select: { channel: true, context: true },
    });
    expect(entry.channel).toBe("MCP");
    // Under the writer's own key, so a call site cannot record the act and
    // lose which app made it.
    expect(entry.context).toMatchObject({
      slug: `arsstamma-${suffix}`,
      client: { id: `client-${suffix}`, host: "claude.ai" },
    });
  });
});

describe("the column and the append-only guarantee", () => {
  it("refuses to have the channel corrected afterwards", async () => {
    // Which is the whole reason the writer requires a channel instead of
    // defaulting one: a row that says the wrong thing stays wrong for good.
    await audit.record({
      action: "PROTECTED_FLAG_CHANGED",
      channel: "WEB",
      actorPersonId: board.personId,
      targetPersonId: subject.personId,
      context: { protectedPersonalData: true, atCreation: false },
    });

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        actorPersonId: board.personId,
        action: "PROTECTED_FLAG_CHANGED",
      },
      select: { id: true },
    });

    await expect(
      prisma.auditLogEntry.update({
        where: { id: entry.id },
        data: { channel: "MCP" },
      }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });

  it("holds a row that names no channel at all", async () => {
    /*
     * Every row written before the migration looks like this, and none of them
     * can be repaired: the column is nullable for that reason and carries no
     * default. Written straight to the table rather than through the service,
     * because the service is exactly what will not let a channel be omitted -
     * which is the state of affairs this row predates. The trigger permits it:
     * it fires BEFORE UPDATE OR DELETE, and this is an insert.
     */
    const entry = await prisma.auditLogEntry.create({
      data: {
        action: "CONSENT_RECORDED",
        actorPersonId: board.personId,
        targetPersonId: subject.personId,
        context: { scope: "RESIDENT_DIRECTORY" },
      },
      select: { id: true, channel: true },
    });

    expect(entry.channel).toBeNull();
  });
});

describe("the channel on the data subject access report", () => {
  it("carries the channel of every entry naming the person", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${subject.personId}`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode, response.body).toBe(200);
    const report = JSON.parse(response.body) as {
      auditEntries: { action: string; channel: string | null }[];
    };

    const flag = report.auditEntries.find(
      (entry) => entry.action === "PROTECTED_FLAG_CHANGED",
    );
    expect(flag?.channel).toBe("WEB");

    // And the one whose channel was cleared above reaches the document as
    // null rather than as a channel nobody recorded.
    const consent = report.auditEntries.find(
      (entry) => entry.action === "CONSENT_RECORDED",
    );
    expect(consent).toBeDefined();
    expect(consent?.channel).toBeNull();
  });
});
