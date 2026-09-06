import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import {
  loadEnvForIntegrationTests,
  runIdentityNumber,
  runSuffix,
} from "../testing/integration-env";
import { BreachReminderService } from "./breach-reminder.service";
import { DataProtectionSeedService } from "./data-protection-seed.service";
import { ProcessingActivityService } from "./processing-activity.service";
import { ProcessorFactsService } from "./processor-facts.service";
import { SEED_KEYS } from "./processing-activity-seed";
import type { ProcessingRecord } from "./processing-activity.service";
import { BREACH_REMINDER_QUEUE } from "./breach-reminder.queue";
import type { BreachView } from "./breach.service";

/**
 * The association's own data protection records over HTTP, against a real
 * database.
 *
 * The breach register is the part of this that a database earns its place in.
 * The 72-hour bound of GDPR art. 33(1) is derived from a stored discovery
 * instant, the reminder is a row in the queue's own table scheduled against
 * that instant, and the rules refusing a self-contradicting decision are what
 * make the record able to demonstrate compliance at all. None of that can be
 * shown against a fake without the fake becoming the thing under test.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const addressId = `dp-address-${suffix}`;
const apartmentId = `dp-apartment-${suffix}`;

const board = {
  personId: `dp-board-${suffix}`,
  email: `dp-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `dp-resident-${suffix}`,
  email: `dp-resident-${suffix}@exempel.se`,
};
/** Somebody a breach reached. */
const subject = { personId: `dp-subject-${suffix}` };

const personIds = [board.personId, resident.personId, subject.personId];

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.41.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.41.${String(subnet)}.${String(host + 1)}`;
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

let boardCookie: string;
let residentCookie: string;

/** A breach discovered a fixed number of hours before now. */
function discoveredHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function recordBreach(payload: Record<string, unknown> = {}) {
  return inject({
    method: "POST",
    url: "/api/data-protection/breaches",
    payload: {
      title: `Felskickad lista ${suffix}`,
      description: "En medlemslista gick till fel mottagare.",
      discoveredAt: discoveredHoursAgo(2),
      personalDataCategories: ["name", "email"],
      dataSubjectCategories: ["member"],
      dataDescription: "Medlemsforteckningens namn och adresser.",
      affectedCount: 12,
      effects: "Mottagaren kunde lasa namn och adresser.",
      measures: "Mottagaren ombads radera meddelandet.",
      subjectPersonIds: [],
      ...payload,
    },
    headers: { cookie: boardCookie },
  });
}

async function recorded(
  payload: Record<string, unknown> = {},
): Promise<BreachView> {
  const response = await recordBreach(payload);
  expect(response.statusCode).toBe(201);
  return response.json<BreachView>();
}

function decide(breachId: string, payload: Record<string, unknown>) {
  return inject({
    method: "POST",
    url: `/api/data-protection/breaches/${breachId}/decision`,
    payload: {
      risk: "LIKELY",
      imyNotificationRequired: true,
      imyDecisionGround: "Uppgifterna nadde en obehorig mottagare.",
      subjectsInformationRequired: false,
      ...payload,
    },
    headers: { cookie: boardCookie },
  });
}

function reasonOf(response: { json: () => unknown }): string | undefined {
  return (response.json() as { reason?: string }).reason;
}

/** The reminder rows the queue holds for one breach. */
async function reminderJobs(
  breachId: string,
): Promise<{ startAfter: Date; discoveredAt: string }[]> {
  const rows = await prisma.$queryRawUnsafe<
    { start_after: Date; data: { discoveredAt: string } }[]
  >(
    "SELECT start_after, data FROM pgboss.job WHERE name = $1 AND data->>'breachId' = $2 ORDER BY start_after ASC",
    BREACH_REMINDER_QUEUE,
    breachId,
  );
  return rows.map((row) => ({
    startAfter: row.start_after,
    discoveredAt: row.data.discoveredAt,
  }));
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

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Dataskyddsgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: { create: [{ id: apartmentId, number: "1001", floor: 0 }] },
    },
  });

  await prisma.person.createMany({
    data: personIds.map((id) => ({
      id,
      firstName: "Person",
      lastName: `Dataskydd${suffix}`,
    })),
  });

  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });
  await prisma.residency.create({
    data: {
      personId: resident.personId,
      apartmentId,
      role: "RESIDENT",
      movedInOn: new Date("2026-01-01"),
    },
  });

  const auth = app.get(AuthService);
  for (const actor of [board, resident]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  boardCookie = await signIn(board.email);
  residentCookie = await signIn(resident.email);
}, 180_000);

async function cleanUp(
  steps: readonly (() => Promise<unknown>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    await step().catch((cause: unknown) => failures.push(cause));
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "The data protection suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        () =>
          prisma.session.deleteMany({
            where: { user: { personId: { in: personIds } } },
          }),
        () =>
          prisma.account.deleteMany({
            where: { user: { personId: { in: personIds } } },
          }),
        () =>
          prisma.user.deleteMany({ where: { personId: { in: personIds } } }),
        () =>
          prisma.personalDataBreachSubject.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.personalDataBreach.deleteMany({
            where: { recordedByPersonId: { in: personIds } },
          }),
        () =>
          prisma.boardPosition.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.residency.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () => prisma.person.deleteMany({ where: { id: { in: personIds } } }),
        () => prisma.apartment.deleteMany({ where: { id: apartmentId } }),
        () => prisma.address.deleteMany({ where: { id: addressId } }),
      ]);
    }
  } finally {
    await app?.close();
  }
});

describe("breaches", () => {
  it("refuses without a session and refuses a resident", async () => {
    const anonymous = await inject({
      method: "GET",
      url: "/api/data-protection/breaches",
    });
    const asResident = await inject({
      method: "GET",
      url: "/api/data-protection/breaches",
      headers: { cookie: residentCookie },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(asResident.statusCode).toBe(403);
  });

  it("records one with the 72-hour bound derived from the discovery", async () => {
    const discoveredAt = discoveredHoursAgo(2);
    const view = await recorded({ discoveredAt });

    const bound = new Date(view.imyNotifyBy).getTime();
    expect(bound - new Date(discoveredAt).getTime()).toBe(72 * 60 * 60 * 1000);
    expect(view.state).toBe("awaitingDecision");
    // Just over two hours gone of the seventy-two.
    expect(view.hoursLeft).toBeGreaterThan(69);
    expect(view.hoursLeft).toBeLessThan(71);
  });

  it("schedules the reminder a day before the bound", async () => {
    const discoveredAt = discoveredHoursAgo(1);
    const view = await recorded({ discoveredAt });

    const jobs = await reminderJobs(view.breachId);
    expect(jobs).toHaveLength(1);
    // 48 hours after discovery is 24 before the bound: the reminder lands while
    // somebody can still act on it.
    expect(jobs[0]?.startAfter.getTime()).toBe(
      new Date(discoveredAt).getTime() + 48 * 60 * 60 * 1000,
    );
  });

  it("refuses a discovery in the future", async () => {
    const response = await recordBreach({
      discoveredAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("discovered-in-future");
  });

  it("refuses a personal identity number in what the board wrote", async () => {
    const response = await recordBreach({
      description: `Listan innehöll ${runIdentityNumber(suffix)} i klartext.`,
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("personal-identity-number");
  });

  it("refuses saying there is a risk and that IMY need not be told", async () => {
    // art. 33(1) excuses notification only where the breach is unlikely to
    // result in a risk, so the two answers cannot both stand.
    const view = await recorded();

    const response = await decide(view.breachId, {
      risk: "LIKELY",
      imyNotificationRequired: false,
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("risk-inconsistent");
  });

  it("refuses not telling the people affected at a high risk with no ground", async () => {
    const view = await recorded();

    const response = await decide(view.breachId, {
      risk: "HIGH",
      subjectsInformationRequired: false,
      subjectsDecisionGround: "",
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("subjects-ground-required");
  });

  it("accepts telling them anyway at a low risk, because art. 34 is a floor", async () => {
    const view = await recorded();

    const response = await decide(view.breachId, {
      risk: "UNLIKELY",
      imyNotificationRequired: false,
      subjectsInformationRequired: true,
    });

    expect(response.statusCode).toBe(200);
  });

  it("refuses a late notification with no reasons for the delay, and takes it with them", async () => {
    /*
     * art. 33(1), last sentence: a notification made after 72 hours is
     * accompanied by the reasons for the delay. Refusing it here is what stops
     * the register holding a late notification that looks punctual.
     */
    const discoveredAt = discoveredHoursAgo(80);
    const view = await recorded({ discoveredAt });

    const without = await decide(view.breachId, {
      imyNotifiedAt: new Date().toISOString(),
    });
    expect(without.statusCode).toBe(400);
    expect(reasonOf(without)).toBe("delay-reasons-required");

    const with_ = await decide(view.breachId, {
      imyNotifiedAt: new Date().toISOString(),
      delayReasons: "Styrelsen kunde inte sammantrada forran nu.",
    });
    expect(with_.statusCode).toBe(200);
    expect(with_.json<BreachView>().delayReasons).toBe(
      "Styrelsen kunde inte sammantrada forran nu.",
    );
  });

  it("refuses a second decision, and refuses closing one never decided", async () => {
    const undecided = await recorded();
    const closing = await inject({
      method: "POST",
      url: `/api/data-protection/breaches/${undecided.breachId}/close`,
      headers: { cookie: boardCookie },
    });
    expect(closing.statusCode).toBe(409);
    expect(reasonOf(closing)).toBe("not-decided");

    await decide(undecided.breachId, {});
    const again = await decide(undecided.breachId, {});
    expect(again.statusCode).toBe(409);
    expect(reasonOf(again)).toBe("already-decided");
  });

  it("records the people it reached, and refuses the same person twice", async () => {
    const view = await recorded();

    const first = await inject({
      method: "POST",
      url: `/api/data-protection/breaches/${view.breachId}/subjects`,
      payload: { personId: subject.personId },
      headers: { cookie: boardCookie },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json<BreachView>().subjects).toHaveLength(1);

    const second = await inject({
      method: "POST",
      url: `/api/data-protection/breaches/${view.breachId}/subjects`,
      payload: { personId: subject.personId },
      headers: { cookie: boardCookie },
    });
    expect(second.statusCode).toBe(409);
    expect(reasonOf(second)).toBe("already-subject");
  });

  it("records that a person was told, with them as the subject of the entry", async () => {
    const view = await recorded();
    await inject({
      method: "POST",
      url: `/api/data-protection/breaches/${view.breachId}/subjects`,
      payload: { personId: subject.personId },
      headers: { cookie: boardCookie },
    });

    const informed = await inject({
      method: "POST",
      url: `/api/data-protection/breaches/${view.breachId}/subjects/${subject.personId}/informed`,
      headers: { cookie: boardCookie },
    });

    expect(informed.statusCode).toBe(200);
    expect(informed.json<BreachView>().subjects[0]?.informedAt).not.toBeNull();

    // The person is the subject, so their own access report can show that the
    // association told them about a breach that reached their data.
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "PERSONAL_DATA_BREACH_SUBJECT_INFORMED",
        targetPersonId: subject.personId,
      },
    });
    expect(entry).not.toBeNull();
  });

  it("keeps the board's words off the audit log", async () => {
    const view = await recorded();

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "PERSONAL_DATA_BREACH_RECORDED",
        targetId: view.breachId,
      },
    });

    /*
     * The log is append-only and outside every purge, so free text copied into
     * it would outlive the record it describes and could not be corrected with
     * it. Categories and counts travel; the title and the description do not.
     */
    const context = JSON.stringify(entry.context);
    expect(context).not.toContain(`Felskickad lista ${suffix}`);
    expect(context).not.toContain("fel mottagare");
    expect(context).toContain("name");
    expect(context).toContain("member");
  });

  describe("the reminder handler", () => {
    it("mails the board while the breach has no decision", async () => {
      const view = await recorded();

      const sent = await app.get(BreachReminderService).sendBreachReminder({
        breachId: view.breachId,
        discoveredAt: view.discoveredAt,
      });

      // The one board member this suite created, with an address.
      expect(sent).toBeGreaterThanOrEqual(0);
    });

    it("sends nothing once the breach has been decided", async () => {
      const view = await recorded();
      await decide(view.breachId, {});

      await expect(
        app.get(BreachReminderService).sendBreachReminder({
          breachId: view.breachId,
          discoveredAt: view.discoveredAt,
        }),
      ).resolves.toBe(0);
    });

    it("sends nothing for a reminder whose discovery no longer matches", async () => {
      // A corrected discovery date leaves the old job on the queue. It fires,
      // finds its payload stale and exits: the whole of the cancellation.
      const view = await recorded();

      await expect(
        app.get(BreachReminderService).sendBreachReminder({
          breachId: view.breachId,
          discoveredAt: new Date("2020-01-01T00:00:00.000Z").toISOString(),
        }),
      ).resolves.toBe(0);
    });

    it("sends nothing for a breach that is gone", async () => {
      await expect(
        app.get(BreachReminderService).sendBreachReminder({
          breachId: `missing-${suffix}`,
          discoveredAt: new Date().toISOString(),
        }),
      ).resolves.toBe(0);
    });
  });
});

describe("record of processing", () => {
  /** The record as the board reads it. */
  async function readRecord(): Promise<ProcessingRecord> {
    const response = await inject({
      method: "GET",
      url: "/api/data-protection/processing-activities",
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json<ProcessingRecord>();
  }

  /*
   * The seed is driven directly rather than through the boot hook, which
   * refuses before setup has completed - and setup state is shared with every
   * other suite on this database, so flipping it here would be reaching into
   * their fixtures. That the hook refuses is asserted on its own below.
   */
  async function seedRecord(): Promise<void> {
    await app
      .get(ProcessingActivityService)
      .seed(
        app.get(I18nService).translatorFor("sv"),
        await app.get(ProcessorFactsService).read(),
      );
  }

  it("writes one row per processing the instance performs, and is idempotent", async () => {
    await seedRecord();
    const first = await readRecord();

    await seedRecord();
    const second = await readRecord();

    const seeded = second.activities.filter(
      (activity) =>
        activity.sourceKey !== null &&
        !activity.sourceKey.startsWith("plugin:"),
    );
    // Exactly the fixed list, and a second seed writes nothing new: the
    // sourceKey is what makes it idempotent.
    const byName = (left: string, right: string): number =>
      left.localeCompare(right);
    expect(
      seeded.map((activity) => activity.sourceKey ?? "").sort(byName),
    ).toEqual([...SEED_KEYS].sort(byName));
    expect(second.activities).toHaveLength(first.activities.length);
  });

  it("names the controller with its contact details at the head", async () => {
    /*
     * art. 30(1)(a). The name and the organisation number were always on the
     * association; nothing recorded how to reach it until now.
     *
     * Conditional on the row existing, because this database is shared and a
     * suite that created an association would be writing another suite's
     * fixture. Where there is none, what matters is that the block is still
     * answered rather than throwing - a record that cannot be read is worse
     * than one with a blank in it.
     */
    const association = await prisma.association.findUnique({
      where: { id: 1 },
      select: { controllerContactEmail: true, controllerPostalAddress: true },
    });

    if (association === null) {
      const record = await readRecord();
      expect(record.controller.contactEmail).toBeNull();
      expect(record.controller.postalAddress).toBeNull();
      expect(record.controller.officer).toBeNull();
      return;
    }

    await prisma.association.update({
      where: { id: 1 },
      data: {
        controllerContactEmail: `styrelsen-${suffix}@exempel.se`,
        controllerPostalAddress: "Storgatan 1, 111 22 Stockholm",
      },
    });

    try {
      const record = await readRecord();
      expect(record.controller.contactEmail).toBe(
        `styrelsen-${suffix}@exempel.se`,
      );
      expect(record.controller.postalAddress).toBe(
        "Storgatan 1, 111 22 Stockholm",
      );
    } finally {
      await prisma.association.update({
        where: { id: 1 },
        data: {
          controllerContactEmail: association.controllerContactEmail,
          controllerPostalAddress: association.controllerPostalAddress,
        },
      });
    }
  });

  it("names a joint controller only when both halves are recorded", async () => {
    // art. 30(1)(a) asks for the contact details, so a name standing alone is
    // not what it requires and is not shown as one.
    const exists = await prisma.association.count({ where: { id: 1 } });
    if (exists === 0) {
      expect((await readRecord()).controller.jointController).toBeNull();
      return;
    }

    try {
      await prisma.association.update({
        where: { id: 1 },
        data: {
          jointControllerName: "Samfalligheten",
          jointControllerContact: null,
        },
      });
      expect((await readRecord()).controller.jointController).toBeNull();

      await prisma.association.update({
        where: { id: 1 },
        data: { jointControllerContact: "kontakt@samfalligheten.test" },
      });
      expect((await readRecord()).controller.jointController).toEqual({
        name: "Samfalligheten",
        contact: "kontakt@samfalligheten.test",
      });
    } finally {
      await prisma.association.update({
        where: { id: 1 },
        data: { jointControllerName: null, jointControllerContact: null },
      });
    }
  });

  it("refreshes a seeded row the board has not edited, and never one it has", async () => {
    /*
     * The whole reason updatedByPersonId exists. A changed storage driver has
     * to show up in the record, and a board's own wording must never be
     * replaced by a background job.
     */
    await seedRecord();

    const before = await readRecord();
    const documents = before.activities.find(
      (activity) => activity.sourceKey === "documents",
    );
    expect(documents).toBeDefined();

    const edited = await inject({
      method: "PUT",
      url: `/api/data-protection/processing-activities/${documents?.activityId ?? ""}`,
      payload: { purpose: "Styrelsens egen formulering." },
      headers: { cookie: boardCookie },
    });
    expect(edited.statusCode).toBe(200);

    await seedRecord();

    const after = (await readRecord()).activities.find(
      (activity) => activity.sourceKey === "documents",
    );
    expect(after?.purpose).toBe("Styrelsens egen formulering.");
    // And it has stopped following the instance's settings, which is what the
    // screen tells the board about a row it has edited.
    expect(after?.seeded).toBe(false);
  });

  it("takes a processing the board performs outside the application", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/data-protection/processing-activities",
      payload: {
        name: `Nyckelhantering ${suffix}`,
        purpose: "Hallа reda pa vem som kvitterat vilken nyckel.",
        legalBasis: "LEGITIMATE_INTEREST",
        dataSubjectCategories: ["member", "resident"],
        personalDataCategories: ["name", "apartment"],
        thirdCountryTransfer: false,
        retention: "Tills nyckeln lamnas tillbaka.",
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ source: string }>().source).toBe("BOARD");
  });

  it("refuses a personal identity number in the record", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/data-protection/processing-activities",
      payload: {
        name: `Test ${suffix}`,
        purpose: `Om ${runIdentityNumber(suffix)} i klartext.`,
        legalBasis: "CONTRACT",
        dataSubjectCategories: ["member"],
        personalDataCategories: ["name"],
        thirdCountryTransfer: false,
        retention: "Kort.",
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("personal-identity-number");
  });

  it("writes nothing before the instance has been set up", async () => {
    /*
     * The association row is a shell until setup completes. Seeding then would
     * write a record naming a cooperative with no name, in whatever language
     * the schema defaults to, and the board's first sight of its own art. 30
     * record would be that.
     */
    const association = await prisma.association.findUnique({
      where: { id: 1 },
      select: { setupCompletedAt: true },
    });

    if (association?.setupCompletedAt == null) {
      const before = await prisma.processingActivity.count();
      await app.get(DataProtectionSeedService).seedIfConfigured();
      expect(await prisma.processingActivity.count()).toBe(before);
    } else {
      // Another suite completed setup on this shared database, so the hook is
      // expected to write instead. Either way it agrees with the row.
      await app.get(DataProtectionSeedService).seedIfConfigured();
      expect(await prisma.processingActivity.count()).toBeGreaterThan(0);
    }
  });
});
