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
} from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import { factsCurrentUntil } from "../site/facts-currency";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import {
  BROKER_UPDATE_REQUEST_ABANDONED_QUEUE,
  BROKER_UPDATE_REQUEST_FANOUT_QUEUE,
  BROKER_UPDATE_REQUEST_NOTICE_QUEUE,
  BrokerUpdateRequestNoticeService,
} from "./broker-update-request-notice.service";
import { BrokerUpdateRequestPurgeService } from "./broker-update-request-purge.service";
import {
  type BrokerUpdateRequestInput,
  type BrokerUpdateRequestQueue,
  BrokerUpdateRequestService,
} from "./broker-update-request.service";

/**
 * A broker's update request, through the real routing, guards, lock and
 * database: from the form on the broker page to the board's queue, the
 * confirmation that answers it and the purge that deletes it.
 *
 * Every limit is asserted at its edge and one past it, and the limits the
 * database keeps are asserted with the in-memory buckets out of the way - the
 * earlier requests are put in through the service, and the one that is refused
 * arrives over HTTP from a fresh bucket - because surviving a restart is the
 * reason they are in the database at all.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let requests: BrokerUpdateRequestService;
let encryption: FieldEncryptionService;
let notices: BrokerUpdateRequestNoticeService;
let mail: MailService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";
const DAY = 24 * 60 * 60 * 1000;

const boardMember = {
  personId: `bur-board-${suffix}`,
  email: `bur-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `bur-resident-${suffix}`,
  email: `bur-resident-${suffix}@exempel.se`,
};
/** An administrator with no seat: holds site:manage all the same. */
const administrator = {
  personId: `bur-admin-${suffix}`,
  email: `bur-admin-${suffix}@exempel.se`,
};
const personIds = [
  boardMember.personId,
  resident.personId,
  administrator.personId,
];

/** References no other test in this file reuses: one per call. */
const REFERENCE_PREFIX = `R${suffix.slice(-8)}-`.toUpperCase();
let referenceCounter = 0;
function freshReference(): string {
  referenceCounter += 1;
  return `${REFERENCE_PREFIX}${String(referenceCounter)}`;
}

/**
 * Broker addresses no other run uses, remembered so this run's rows can be
 * found by their blind index: a request may name no apartment, and the address
 * is the one thing every request carries.
 */
const usedEmails = new Set<string>();
let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  const email = `broker-${String(emailCounter)}-${suffix}@maklarbyran.example`;
  usedEmails.add(email);
  return email;
}

/** Addresses no other suite uses: 10.91.0.0/16 is this one's. */
let ipCounter = 0;
function freshAddress(): string {
  ipCounter += 1;
  return `10.91.${String(Math.floor(ipCounter / 254) % 254)}.${String((ipCounter % 254) + 1)}`;
}

/** Captured in beforeAll and put back in afterAll: the row is a singleton. */
let factsBefore: Record<string, unknown> | null = null;
let setupCompletedBefore: Date | null | undefined;

let boardCookie: string;
let residentCookie: string;

function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
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
        "x-forwarded-for": freshAddress(),
        ...options.headers,
      },
    });
}

/** The broker's form, posted as a browser posts it. */
function send(fields: Record<string, string>, from: string = freshAddress()) {
  return inject({
    method: "POST",
    url: "/maklarinfo/uppdatering",
    payload: new URLSearchParams(fields).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": from,
    },
  });
}

function validFields(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    name: "Mia Mäklare",
    email: freshEmail(),
    brokerage: "Mäklarbyrån AB",
    apartment: freshReference(),
    note: "Säljstart nästa vecka.",
    // Every browser sends the decoy, empty.
    website: "",
    ...overrides,
  };
}

function viaService(
  overrides: Partial<BrokerUpdateRequestInput> = {},
  now?: Date,
) {
  return requests.submit(
    {
      name: "Mia Mäklare",
      email: freshEmail(),
      apartmentReference: freshReference(),
      ...overrides,
    },
    now,
  );
}

function answerOf(response: { statusCode: number; headers: object }): string {
  expect(response.statusCode).toBe(303);
  return String((response.headers as Record<string, unknown>).location);
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

/**
 * Facts confirmed the given number of days ago, under the given threshold.
 *
 * 95 days is past three calendar months whatever today is, and 85 days short
 * of them: three months are 89 to 92 days. The exact edge is the unit suite's
 * (facts-currency.spec.ts), which can name the day.
 */
async function factsConfirmed(
  daysAgo: number,
  staleAfterMonths = 3,
): Promise<Date> {
  const confirmedAt = new Date(Date.now() - daysAgo * DAY);
  await prisma.associationFacts.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      feePolicy: "Avgiften höjdes senast 2025.",
      confirmedAt,
      staleAfterMonths,
    },
    update: {
      feePolicy: "Avgiften höjdes senast 2025.",
      confirmedAt,
      staleAfterMonths,
    },
  });
  return confirmedAt;
}

/** Where this run's requests are: by their apartment, or by their address. */
async function ownWhere() {
  const indexes = await Promise.all(
    [...usedEmails].map((email) =>
      encryption.computeIndex("brokerUpdateRequest.email", email),
    ),
  );
  return {
    OR: [
      { apartmentReference: { startsWith: REFERENCE_PREFIX } },
      {
        emailIndex: {
          in: indexes.filter((index): index is string => index !== null),
        },
      },
    ],
  };
}

/** This run's requests, and only this run's. */
async function ownRequests() {
  return prisma.brokerUpdateRequest.findMany({ where: await ownWhere() });
}

/** The one stored request with this address. */
async function requestFrom(email: string) {
  const index = await encryption.computeIndex(
    "brokerUpdateRequest.email",
    email,
  );
  return prisma.brokerUpdateRequest.findMany({ where: { emailIndex: index } });
}

function receivedEntries(requestIds: readonly string[]) {
  return prisma.auditLogEntry.findMany({
    where: {
      action: "BROKER_UPDATE_REQUEST_RECEIVED",
      targetId: { in: [...requestIds] },
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
  requests = app.get(BrokerUpdateRequestService);
  encryption = app.get(FieldEncryptionService);
  notices = app.get(BrokerUpdateRequestNoticeService);
  mail = app.get(MailService);

  factsBefore = await prisma.associationFacts.findUnique({ where: { id: 1 } });

  // A claimed instance, or the endpoint answers with the website's 404.
  const association = await prisma.association.findUnique({
    where: { id: 1 },
    select: { setupCompletedAt: true },
  });
  setupCompletedBefore = association?.setupCompletedAt;
  if (association === null) {
    await prisma.association.create({
      data: { id: 1, name: "Brf Eksemplet", setupCompletedAt: new Date() },
    });
  } else if (association.setupCompletedAt === null) {
    await prisma.association.update({
      where: { id: 1 },
      data: { setupCompletedAt: new Date() },
    });
  }

  await prisma.person.createMany({
    data: [
      { id: boardMember.personId, firstName: "Bo", lastName: `Bur${suffix}` },
      { id: resident.personId, firstName: "Rut", lastName: `Bur${suffix}` },
      {
        id: administrator.personId,
        firstName: "Ada",
        lastName: `Bur${suffix}`,
      },
    ],
  });
  // Every one of them reachable, so who is told is decided by the capability
  // and not by who happens to have an address.
  for (const actor of [boardMember, resident, administrator]) {
    const email = await encryption.encrypt("person.email", actor.email);
    await prisma.person.update({
      where: { id: actor.personId },
      data: { emailCipher: email.cipher, emailIndex: email.index },
    });
  }
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });
  await prisma.boardPosition.create({
    data: {
      personId: boardMember.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });

  const auth = app.get(AuthService);
  for (const actor of [boardMember, resident]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
  boardCookie = await signIn(boardMember.email);
  residentCookie = await signIn(resident.email);
}, 180_000);

beforeEach(async () => {
  // Every test starts from stale facts and an empty queue of its own.
  await prisma.brokerUpdateRequest.deleteMany({ where: await ownWhere() });
  await factsConfirmed(95);
});

afterAll(async () => {
  if (prisma === undefined) {
    return;
  }
  const failures: unknown[] = [];
  const steps: (() => Promise<unknown>)[] = [
    async () =>
      prisma.brokerUpdateRequest.deleteMany({ where: await ownWhere() }),
    () =>
      factsBefore === null
        ? prisma.associationFacts.deleteMany({ where: { id: 1 } })
        : prisma.associationFacts.update({
            where: { id: 1 },
            data: factsBefore,
          }),
    () =>
      setupCompletedBefore === undefined
        ? prisma.association.deleteMany({ where: { id: 1 } })
        : prisma.association.update({
            where: { id: 1 },
            data: { setupCompletedAt: setupCompletedBefore },
          }),
    () =>
      prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      }),
    () =>
      prisma.session.deleteMany({
        where: { user: { personId: { in: personIds } } },
      }),
    () =>
      prisma.account.deleteMany({
        where: { user: { personId: { in: personIds } } },
      }),
    () => prisma.user.deleteMany({ where: { personId: { in: personIds } } }),
    () => prisma.person.deleteMany({ where: { id: { in: personIds } } }),
  ];
  for (const step of steps) {
    await step().catch((cause: unknown) => failures.push(cause));
  }
  await app.close();
  if (failures.length > 0) {
    throw new AggregateError(failures, "The suite could not clean up.");
  }
});

describe("the broker page offers the request", () => {
  async function page(): Promise<string> {
    const response = await inject({ method: "GET", url: "/maklarinfo" });
    expect(response.statusCode).toBe(200);
    return response.body;
  }

  it("once the facts are older than three months, and not before", async () => {
    await factsConfirmed(85);
    expect(await page()).not.toContain('action="/maklarinfo/uppdatering"');

    await factsConfirmed(95);
    expect(await page()).toContain('action="/maklarinfo/uppdatering"');
  });

  it("under the board's own setting, which confirms nothing", async () => {
    const confirmedAt = await factsConfirmed(85);

    const shortened = await inject({
      method: "PUT",
      url: "/api/site/facts/stale-after-months",
      payload: { staleAfterMonths: 1 },
      headers: { cookie: boardCookie },
    });
    expect(shortened.statusCode).toBe(200);
    expect(await page()).toContain('action="/maklarinfo/uppdatering"');

    const lengthened = await inject({
      method: "PUT",
      url: "/api/site/facts/stale-after-months",
      payload: { staleAfterMonths: 6 },
      headers: { cookie: boardCookie },
    });
    expect(lengthened.statusCode).toBe(200);
    expect(await page()).not.toContain('action="/maklarinfo/uppdatering"');

    const row = await prisma.associationFacts.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(row.confirmedAt?.getTime()).toBe(confirmedAt.getTime());
  });

  it("over recorded facts the board has never confirmed", async () => {
    await prisma.associationFacts.update({
      where: { id: 1 },
      data: { confirmedAt: null },
    });

    const body = await page();
    expect(body).toContain('action="/maklarinfo/uppdatering"');
    expect(body).toContain("Styrelsen har inte bekräftat uppgifterna");

    const email = freshEmail();
    expect(answerOf(await send(validFields({ email })))).toBe(
      "/maklarinfo?uppdatering=skickad",
    );
    expect(await requestFrom(email)).toHaveLength(1);
  });

  it("from the instant the threshold has passed, at the endpoint too", async () => {
    const confirmedAt = await factsConfirmed(95);
    const deadline = factsCurrentUntil(confirmedAt, 3);

    expect(await viaService({}, deadline)).toBe("current");
    expect(await viaService({}, new Date(deadline.getTime() + 1))).toBe(
      "stored",
    );
  });

  it("is answered on the page with what became of it", async () => {
    const response = await inject({
      method: "GET",
      url: "/maklarinfo?uppdatering=skickad",
    });
    expect(response.body).toContain("Förfrågan har nått styrelsen");
    expect(response.body).not.toContain('action="/maklarinfo/uppdatering"');
  });
});

describe("a request", () => {
  it("is stored encrypted, and audited without what it says", async () => {
    const fields = validFields({ apartment: " lgh  1101 " });
    expect(answerOf(await send(fields))).toBe(
      "/maklarinfo?uppdatering=skickad",
    );

    const [row] = await requestFrom(fields.email ?? "");
    expect(row).toBeDefined();
    if (row === undefined) return;

    expect(row.answeredAt).toBeNull();
    expect(row.apartmentReference).toBe("LGH 1101");
    expect(row.nameCipher).not.toBeNull();
    expect(row.nameCipher).not.toContain("Mia");
    expect(row.emailCipher).not.toContain("maklarbyran");
    expect(
      await encryption.decrypt(
        "brokerUpdateRequest.name",
        row.nameCipher ?? "",
      ),
    ).toBe("Mia Mäklare");
    expect(
      await encryption.decrypt("brokerUpdateRequest.email", row.emailCipher),
    ).toBe(fields.email);
    expect(row.brokerage).toBe("Mäklarbyrån AB");
    expect(row.note).toBe("Säljstart nästa vecka.");
    // The client address is used for the route's limit and stored nowhere.
    expect(JSON.stringify(row)).not.toContain("10.91.");

    const entries = await receivedEntries([row.id]);
    expect(entries).toHaveLength(1);
    const entry = JSON.stringify(entries[0]);
    for (const secret of [
      "Mia",
      "maklarbyran",
      "1101",
      "Mäklarbyrån",
      "Säljstart",
    ]) {
      expect(entry).not.toContain(secret);
    }
    expect(entries[0]?.actorPersonId).toBeNull();
  });

  it("needs nothing but the address", async () => {
    const email = freshEmail();
    expect(answerOf(await send({ email, website: "" }))).toBe(
      "/maklarinfo?uppdatering=skickad",
    );
    const [row] = await requestFrom(email);
    expect(row).toMatchObject({
      nameCipher: null,
      brokerage: null,
      apartmentReference: null,
      note: null,
    });
  });

  it("is not taken over facts that are current, whatever the page said", async () => {
    await factsConfirmed(10);
    const fields = validFields();
    expect(answerOf(await send(fields))).toBe(
      "/maklarinfo?uppdatering=aktuell",
    );
    expect(await requestFrom(fields.email ?? "")).toHaveLength(0);
  });

  it("that fills the decoy is answered as sent and stored nowhere", async () => {
    const fields = validFields({ website: "https://spam.example" });
    expect(answerOf(await send(fields))).toBe(
      "/maklarinfo?uppdatering=skickad",
    );
    expect(await requestFrom(fields.email ?? "")).toHaveLength(0);
  });

  it.each([
    ["a name over 100 characters", { name: "N".repeat(101) }],
    ["a control character in the name", { name: "Mia\u0007" }],
    ["no address", { email: "" }],
    ["an address that is not one", { email: "mia-at-example" }],
    ["an address over 320 characters", { email: `${"m".repeat(320)}@x.se` }],
    ["a brokerage over 100 characters", { brokerage: "B".repeat(101) }],
    ["an apartment over 20 characters", { apartment: "1".repeat(21) }],
    ["markup for an apartment", { apartment: "<b>1101</b>" }],
    ["a note over 280 characters", { note: "n".repeat(281) }],
    [
      "a personal identity number in the note",
      { note: "Säljaren är 19811218-9876." },
    ],
    [
      "a personal identity number for an apartment",
      { apartment: "811218-9876" },
    ],
    ["a personal identity number in the name", { name: "Mia 811218-9876" }],
    [
      "a personal identity number in the brokerage",
      { brokerage: "Mäklarna 19811218-9876" },
    ],
  ])("with %s is refused and stored nowhere", async (_label, override) => {
    const before = await ownRequests();
    expect(answerOf(await send(validFields(override)))).toBe(
      "/maklarinfo?uppdatering=fel",
    );
    expect(await ownRequests()).toHaveLength(before.length);
  });

  it("takes each field at its limit", async () => {
    const fields = validFields({
      name: "N".repeat(100),
      brokerage: "B".repeat(100),
      apartment: freshReference().padEnd(20, "X"),
      note: "n".repeat(280),
    });
    expect(answerOf(await send(fields))).toBe(
      "/maklarinfo?uppdatering=skickad",
    );
    expect(await requestFrom(fields.email ?? "")).toHaveLength(1);
  });

  it("counts a note's line breaks as the form does", async () => {
    // 139 line breaks sent as CRLF: 419 characters on the wire, and 280 to
    // the form, which counts each line break as one.
    const fields = validFields({ note: "a\r\n".repeat(139) + "ab" });
    expect(answerOf(await send(fields))).toBe(
      "/maklarinfo?uppdatering=skickad",
    );
  });
});

describe("the limits", () => {
  it("keep one open request per apartment, and answer the second as sent", async () => {
    const apartment = freshReference();
    expect(answerOf(await send(validFields({ apartment })))).toBe(
      "/maklarinfo?uppdatering=skickad",
    );
    expect(
      answerOf(
        await send(
          validFields({ apartment, email: `other-${suffix}@example.se` }),
        ),
      ),
    ).toBe("/maklarinfo?uppdatering=skickad");

    expect(
      await prisma.brokerUpdateRequest.count({
        where: { apartmentReference: apartment },
      }),
    ).toBe(1);
  });

  it("take three per apartment in thirty days, answered or not", async () => {
    const apartmentReference = freshReference();
    for (let sent = 0; sent < 3; sent += 1) {
      expect(await viaService({ apartmentReference })).toBe("stored");
      await prisma.brokerUpdateRequest.updateMany({
        where: { apartmentReference, answeredAt: null },
        data: { answeredAt: new Date() },
      });
    }
    expect(await viaService({ apartmentReference })).toBe("duplicate");

    // Out of the window, the oldest stops counting.
    const [oldest] = await prisma.brokerUpdateRequest.findMany({
      where: { apartmentReference },
      orderBy: { createdAt: "asc" },
      take: 1,
    });
    await prisma.brokerUpdateRequest.update({
      where: { id: oldest?.id ?? "" },
      data: { createdAt: new Date(Date.now() - 31 * DAY) },
    });
    expect(await viaService({ apartmentReference })).toBe("stored");
  });

  it("do not hold requests that name no apartment to one another", async () => {
    expect(await viaService({ apartmentReference: undefined })).toBe("stored");
    expect(await viaService({ apartmentReference: undefined })).toBe("stored");
  });

  it("take twenty a day from everybody together, counted in the database", async () => {
    // The table is this suite's alone in its worker's database, but a row an
    // earlier test left inside the day still counts, so the edge is reached
    // from wherever the day stands.
    const already = await prisma.brokerUpdateRequest.count({
      where: { createdAt: { gt: new Date(Date.now() - DAY) } },
    });
    for (let sent = already; sent < 20; sent += 1) {
      expect(await viaService()).toBe("stored");
    }

    // A client address the route's own limiter has never seen: only the
    // database remembers the twenty.
    const fields = validFields();
    expect(answerOf(await send(fields))).toBe(
      "/maklarinfo?uppdatering=for-manga",
    );
    expect(await requestFrom(fields.email ?? "")).toHaveLength(0);

    // A day on, the form is open again.
    await prisma.brokerUpdateRequest.updateMany({
      where: await ownWhere(),
      data: { createdAt: new Date(Date.now() - DAY - 60_000) },
    });
    expect(await viaService()).toBe("stored");
  });

  it("take five per broker address in a day, however it is spelled", async () => {
    const email = freshEmail();
    for (let sent = 0; sent < 5; sent += 1) {
      expect(await viaService({ email })).toBe("stored");
    }
    const fields = validFields({ email: email.toUpperCase() });
    expect(answerOf(await send(fields))).toBe(
      "/maklarinfo?uppdatering=for-manga",
    );
    expect(await requestFrom(email)).toHaveLength(5);
  });

  it("hold when requests for one apartment arrive at once", async () => {
    const apartmentReference = freshReference();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => viaService({ apartmentReference })),
    );
    expect(outcomes.filter((outcome) => outcome === "stored")).toHaveLength(1);
    expect(
      await prisma.brokerUpdateRequest.count({
        where: { apartmentReference },
      }),
    ).toBe(1);
  });

  it("turn a burst away at the route before the database is asked", async () => {
    const from = freshAddress();
    const statuses: number[] = [];
    for (let sent = 0; sent < 6; sent += 1) {
      // Refused bodies, so nothing is stored and only the route's budget is
      // spent.
      statuses.push((await send({ name: "" }, from)).statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([303, 303, 303, 303, 303]);
    expect(statuses[5]).toBe(429);
  });
});

describe("the board's queue", () => {
  function queue(cookie?: string) {
    return inject({
      method: "GET",
      url: "/api/broker-update-requests",
      headers: cookie === undefined ? {} : { cookie },
    });
  }

  it("is read with site:manage, and by nobody else", async () => {
    expect((await queue()).statusCode).toBe(401);
    expect((await queue(residentCookie)).statusCode).toBe(403);
    expect((await queue(boardCookie)).statusCode).toBe(200);
  });

  it("shows open requests decrypted", async () => {
    const fields = validFields({ note: "Visning på söndag." });
    await send(fields);
    const body = (await queue(boardCookie)).json<BrokerUpdateRequestQueue>();
    const mine = body.open.find(
      (request) => request.apartmentReference === fields.apartment,
    );
    expect(mine).toMatchObject({
      name: "Mia Mäklare",
      email: fields.email,
      brokerage: "Mäklarbyrån AB",
      note: "Visning på söndag.",
      answeredAt: null,
    });
    expect(body.openTotal).toBeGreaterThanOrEqual(1);
  });

  it("is answered by a confirmation, in one entry naming nobody but the actor", async () => {
    const before = new Date();
    const apartment = freshReference();
    await send(validFields({ apartment }));

    const confirmed = await inject({
      method: "POST",
      url: "/api/site/facts/confirm",
      headers: { cookie: boardCookie },
    });
    expect(confirmed.statusCode).toBe(200);

    const [row] = await prisma.brokerUpdateRequest.findMany({
      where: { apartmentReference: apartment },
    });
    const facts = await prisma.associationFacts.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(row?.answeredAt?.getTime()).toBe(facts.confirmedAt?.getTime());

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "BROKER_UPDATE_REQUESTS_ANSWERED",
        actorPersonId: boardMember.personId,
        createdAt: { gte: before },
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.context).toMatchObject({ requests: expect.any(Number) });
    expect(JSON.stringify(entries[0])).not.toContain("Mia");

    // Answered, and so no longer an open request for that apartment: the page
    // has nothing to offer either, because the facts are current.
    const page = await inject({ method: "GET", url: "/maklarinfo" });
    expect(page.body).not.toContain('action="/maklarinfo/uppdatering"');
  });

  it("is answered by a save as well", async () => {
    const apartment = freshReference();
    await send(validFields({ apartment }));

    const saved = await inject({
      method: "PUT",
      url: "/api/site/facts",
      payload: { feePolicy: "Avgiften höjs den 1 januari." },
      headers: { cookie: boardCookie },
    });
    expect(saved.statusCode).toBe(200);

    const [row] = await prisma.brokerUpdateRequest.findMany({
      where: { apartmentReference: apartment },
    });
    expect(row?.answeredAt).not.toBeNull();
  });

  it("lets the board dismiss a request, which deletes it", async () => {
    const apartment = freshReference();
    await send(validFields({ apartment }));
    const [row] = await prisma.brokerUpdateRequest.findMany({
      where: { apartmentReference: apartment },
    });
    const id = row?.id ?? "";

    expect(
      (
        await inject({
          method: "DELETE",
          url: `/api/broker-update-requests/${id}`,
          headers: { cookie: residentCookie },
        })
      ).statusCode,
    ).toBe(403);

    const dismissed = await inject({
      method: "DELETE",
      url: `/api/broker-update-requests/${id}`,
      headers: { cookie: boardCookie },
    });
    expect(dismissed.statusCode).toBe(204);
    expect(
      await prisma.brokerUpdateRequest.findUnique({ where: { id } }),
    ).toBeNull();

    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "BROKER_UPDATE_REQUEST_DISMISSED", targetId: id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorPersonId).toBe(boardMember.personId);
    expect(JSON.stringify(entries[0])).not.toContain("Mia");

    const again = await inject({
      method: "DELETE",
      url: `/api/broker-update-requests/${id}`,
      headers: { cookie: boardCookie },
    });
    expect(again.statusCode).toBe(404);
  });
});

describe("the purge", () => {
  it("deletes a request 30 days after its answer, and any request 90 days after it arrived", async () => {
    const purge = app.get(BrokerUpdateRequestPurgeService);
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * DAY);

    const cases = {
      answeredLongAgo: { createdAt: at(40), answeredAt: at(30) },
      answeredRecently: { createdAt: at(40), answeredAt: at(29) },
      openOld: { createdAt: at(90), answeredAt: null },
      openYoung: { createdAt: at(89), answeredAt: null },
      answeredRecentlyButOld: { createdAt: at(91), answeredAt: at(5) },
    };
    const references = new Map<string, string>();
    for (const [name, dates] of Object.entries(cases)) {
      const apartmentReference = freshReference();
      references.set(name, apartmentReference);
      expect(await viaService({ apartmentReference })).toBe("stored");
      await prisma.brokerUpdateRequest.updateMany({
        where: { apartmentReference },
        data: dates,
      });
    }

    const summary = await purge.run(now);
    expect(summary.deleted).toBeGreaterThanOrEqual(3);

    const left = new Set(
      (await ownRequests()).map((row) => row.apartmentReference),
    );
    expect(left.has(references.get("answeredLongAgo") ?? "")).toBe(false);
    expect(left.has(references.get("openOld") ?? "")).toBe(false);
    expect(left.has(references.get("answeredRecentlyButOld") ?? "")).toBe(
      false,
    );
    expect(left.has(references.get("answeredRecently") ?? "")).toBe(true);
    expect(left.has(references.get("openYoung") ?? "")).toBe(true);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "brokerUpdateRequest",
        createdAt: { gte: now },
      },
    });
    expect(entry?.channel).toBe("SYSTEM");
    expect(entry?.actorPersonId).toBeNull();
    expect(entry?.context).toMatchObject({
      retentionDaysAfterAnswer: 30,
      retentionDaysAfterReceipt: 90,
    });
  });
});

interface QueuedJob {
  data: { requestId: string; personId?: string };
  retry_limit: number;
  retry_delay: number;
  retry_backoff: boolean;
  dead_letter: string | null;
}

/** The jobs queued on one queue for one request. */
function queuedFor(queue: string, requestId: string): Promise<QueuedJob[]> {
  return prisma.$queryRawUnsafe<QueuedJob[]>(
    "SELECT data, retry_limit, retry_delay, retry_backoff, dead_letter FROM pgboss.job WHERE name = $1 AND data->>'requestId' = $2",
    queue,
    requestId,
  );
}

/** The one request this address sent, through the form. */
async function storedVia(fields: Record<string, string>) {
  answerOf(await send(fields));
  const [row] = await requestFrom(fields.email ?? "");
  if (row === undefined) {
    throw new Error("The request was not stored.");
  }
  return row;
}

describe("telling the board", () => {
  it("queues one fan-out with the stored request, retried and then given up visibly", async () => {
    const row = await storedVia(validFields());

    const jobs = await queuedFor(BROKER_UPDATE_REQUEST_FANOUT_QUEUE, row.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      retry_limit: 5,
      retry_delay: 60,
      retry_backoff: true,
      dead_letter: BROKER_UPDATE_REQUEST_ABANDONED_QUEUE,
    });
    // The identifier and nothing the broker wrote.
    expect(Object.keys(jobs[0]?.data ?? {})).toEqual(["requestId"]);
  });

  it("queues nothing for a duplicate, which stores nothing", async () => {
    const apartment = freshReference();
    await storedVia(validFields({ apartment }));
    const email = freshEmail();
    answerOf(await send(validFields({ apartment, email })));

    expect(await requestFrom(email)).toHaveLength(0);
  });

  it("tells whoever holds site:manage with an address, once each, and nobody else", async () => {
    const row = await storedVia(validFields());

    const queued = await notices.fanOut(row.id);
    const jobs = await queuedFor(BROKER_UPDATE_REQUEST_NOTICE_QUEUE, row.id);
    expect(jobs).toHaveLength(queued);
    const recipients = jobs.map((job) => job.data.personId);
    // Other suites elect people into this database too, so the list is
    // asserted by who is in it rather than by its length.
    expect(new Set(recipients).size).toBe(recipients.length);
    expect(recipients).toContain(boardMember.personId);
    expect(recipients).toContain(administrator.personId);
    expect(recipients).not.toContain(resident.personId);
  });

  it("does not tell anybody twice when the fan-out runs again", async () => {
    const row = await storedVia(validFields());

    const first = await notices.fanOut(row.id);
    expect(first).toBeGreaterThan(0);
    expect(await notices.fanOut(row.id)).toBe(0);
    expect(
      await queuedFor(BROKER_UPDATE_REQUEST_NOTICE_QUEUE, row.id),
    ).toHaveLength(first);
  });

  it("does not tell anybody about a request already answered or gone", async () => {
    const answered = await storedVia(validFields());
    await prisma.brokerUpdateRequest.update({
      where: { id: answered.id },
      data: { answeredAt: new Date() },
    });
    expect(await notices.fanOut(answered.id)).toBe(0);

    const dismissed = await storedVia(validFields());
    await requests.dismiss(dismissed.id, {
      personId: boardMember.personId,
      channel: "WEB",
    });
    expect(await notices.fanOut(dismissed.id)).toBe(0);
  });

  it("mails a notice that names the apartment and nothing about the broker", async () => {
    const mailed = vi
      .spyOn(mail, "send")
      .mockResolvedValue({ messageId: null });
    try {
      const fields = validFields();
      const row = await storedVia(fields);
      await notices.fanOut(row.id);

      expect(await notices.notify(row.id, boardMember.personId)).toBe(true);
      // Not somebody who cannot read the queue, whatever a job says.
      expect(await notices.notify(row.id, resident.personId)).toBe(false);

      expect(mailed).toHaveBeenCalledOnce();
      const sent = mailed.mock.calls[0]?.[0];
      expect(sent?.to).toBe(boardMember.email);
      expect(sent?.template.id).toBe("broker-update-request-notice");
      expect(sent?.props).toMatchObject({
        apartmentReference: fields.apartment,
      });
      const carried = JSON.stringify(sent?.props);
      for (const contact of [
        fields.email,
        fields.name,
        fields.brokerage,
        fields.note,
      ]) {
        expect(carried).not.toContain(contact);
      }
    } finally {
      mailed.mockRestore();
    }
  });
});

describe("a broker asking what is held about them", () => {
  function ask(payload: object | string, cookie?: string) {
    return inject({
      method: "POST",
      url: "/api/broker-update-requests/access-reports",
      payload,
      headers: cookie === undefined ? {} : { cookie },
    });
  }

  it("is answered for by site:manage, and by nobody else", async () => {
    const email = freshEmail();
    expect((await ask({ email })).statusCode).toBe(401);
    expect((await ask({ email }, residentCookie)).statusCode).toBe(403);
  });

  it("is mailed every request under the address to that address, and nobody else's", async () => {
    const mailed = vi
      .spyOn(mail, "send")
      .mockResolvedValue({ messageId: null });
    try {
      const email = freshEmail();
      await viaService({ email, name: "Mia Mäklare", note: "Första." });
      // The same address as somebody else might type it.
      await viaService({ email: `  ${email.toUpperCase()} `, note: "Andra." });
      const other = freshEmail();
      await viaService({ email: other, name: "Per Annan" });
      const [first] = await requestFrom(email);
      await prisma.brokerUpdateRequest.update({
        where: { id: first?.id ?? "" },
        data: { answeredAt: new Date() },
      });

      const response = await ask({ email: email.toUpperCase() }, boardCookie);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toStrictEqual({ requests: 2 });
      expect(mailed).toHaveBeenCalledOnce();
      const sent = mailed.mock.calls[0]?.[0];
      // To the address as the requests hold it, and never to the board.
      expect(sent?.to).toBe(email);
      expect(sent?.template.id).toBe("broker-update-request-access-report");
      const props = sent?.props as {
        requests: { name: string | null; note: string | null }[];
      };
      const notes = props.requests.map((request) => request.note);
      expect(notes).toHaveLength(2);
      expect(notes).toEqual(expect.arrayContaining(["Andra.", "Första."]));
      expect(props.requests.map((request) => request.name)).toContain(
        "Mia Mäklare",
      );
      expect(JSON.stringify(props)).not.toContain(other);
      expect(JSON.stringify(props)).not.toContain("Per Annan");
    } finally {
      mailed.mockRestore();
    }
  });

  it("is told so when nothing is held under the address", async () => {
    const mailed = vi
      .spyOn(mail, "send")
      .mockResolvedValue({ messageId: null });
    try {
      const email = freshEmail();
      const response = await ask({ email }, boardCookie);

      expect(response.json()).toStrictEqual({ requests: 0 });
      expect(mailed.mock.calls[0]?.[0].to).toBe(email);
      expect(mailed.mock.calls[0]?.[0].props).toMatchObject({ requests: [] });
    } finally {
      mailed.mockRestore();
    }
  });

  it("is audited with how many and never the address, once it has gone", async () => {
    const mailed = vi
      .spyOn(mail, "send")
      .mockResolvedValue({ messageId: null });
    try {
      const email = freshEmail();
      await viaService({ email });
      const before = new Date();

      await ask({ email }, boardCookie);

      const entries = await prisma.auditLogEntry.findMany({
        where: {
          action: "BROKER_UPDATE_REQUEST_ACCESS_REPORT_SENT",
          actorPersonId: boardMember.personId,
          createdAt: { gte: before },
        },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.context).toStrictEqual({ requests: 1 });
      expect(JSON.stringify(entries)).not.toContain(email);
    } finally {
      mailed.mockRestore();
    }
  });

  it("says so, and records nothing, when the instance cannot send mail", async () => {
    const mailed = vi
      .spyOn(mail, "send")
      .mockRejectedValue(new MailNotConfiguredError());
    try {
      const before = new Date();
      const response = await ask({ email: freshEmail() }, boardCookie);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ reason: "mail-not-configured" });
      expect(
        await prisma.auditLogEntry.count({
          where: {
            action: "BROKER_UPDATE_REQUEST_ACCESS_REPORT_SENT",
            actorPersonId: boardMember.personId,
            createdAt: { gte: before },
          },
        }),
      ).toBe(0);
    } finally {
      mailed.mockRestore();
    }
  });

  it("refuses what is not an address, and anything beside it", async () => {
    const mailed = vi.spyOn(mail, "send");
    try {
      expect(
        (await ask({ email: "inte-en-adress" }, boardCookie)).statusCode,
      ).toBe(400);
      expect(
        (await ask({ email: freshEmail(), extra: "x" }, boardCookie))
          .statusCode,
      ).toBe(400);
      expect(mailed).not.toHaveBeenCalled();
    } finally {
      mailed.mockRestore();
    }
  });
});
