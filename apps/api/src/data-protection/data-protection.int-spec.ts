import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { PagesService, PRIVACY_NOTICE_SLUG } from "../site/pages.service";
import { I18nService } from "../i18n/i18n.service";
import {
  loadEnvForIntegrationTests,
  runIdentityNumber,
  runSuffix,
} from "../testing/integration-env";
import { BreachReminderService } from "./breach-reminder.service";
import { DataProtectionSeedService } from "./data-protection-seed.service";
import { ProcessingActivityService } from "./processing-activity.service";
import type { DataProtectionOverview } from "./data-protection-overview.service";
import type { PrivacyNoticeCoverage } from "./privacy-notice.service";
import { ProcessorAgreementService } from "./processor-agreement.service";
import { ProcessorFactsService } from "./processor-facts.service";
import type { ProcessorView } from "./processor-agreement.service";
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

  /*
   * With an address recorded, because the breach reminder is addressed to the
   * board members the register can reach: a person row with no cipher is not
   * somebody this channel reaches, and the reminder case below asserts that one
   * actually goes out.
   */
  const encryption = app.get(FieldEncryptionService);
  for (const actor of [board, resident]) {
    const email = await encryption.encrypt("person.email", actor.email);
    await prisma.person.create({
      data: {
        id: actor.personId,
        firstName: "Person",
        lastName: `Dataskydd${suffix}`,
        emailCipher: email.cipher,
        emailIndex: email.index,
      },
    });
  }
  await prisma.person.createMany({
    data: personIds
      .filter((id) => id !== board.personId && id !== resident.personId)
      .map((id) => ({
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
        /*
         * Service tier, and none of the six append-only statutory tables, so
         * the suite deletes its own rows. `processorKey` is derived from the
         * instance's configuration and carries no run suffix, so a row left
         * open here would make the second run against the same database read
         * "hosting" as already recorded.
         */
        () =>
          prisma.processorAgreement.deleteMany({
            where: {
              OR: [
                { recordedByPersonId: { in: personIds } },
                { endedByPersonId: { in: personIds } },
              ],
            },
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

  it("holds the delay-reasons rule across two corrections arriving together", async () => {
    /*
     * The rule spans three columns - the discovery instant the bound is counted
     * from, the instant IMY was notified, and the reasons - so neither writer
     * has to be wrong on its own for the pair of them to break it.
     *
     * One moves the discovery date back, which turns a punctual notification
     * into a late one and leaves the reasons standing. The other clears the
     * reasons, having read the discovery date as it was. Validated before the
     * writes, both pass; the row then says the association told the authority
     * after the bound and declines to say why, on the register it would produce
     * to demonstrate that it did not.
     *
     * Serialised on the row's own lock, one of them has to lose. Which one is
     * not the property under test and depends on who takes the lock first: what
     * has to hold is that the row is never left in that state.
     */
    const view = await recorded({ discoveredAt: discoveredHoursAgo(2) });

    const notifiedAt = new Date().toISOString();
    const withReasons = await inject({
      method: "PUT",
      url: `/api/data-protection/breaches/${view.breachId}`,
      payload: {
        imyNotifiedAt: notifiedAt,
        delayReasons: "Styrelsen kunde inte sammantrada forran nu.",
      },
      headers: { cookie: boardCookie },
    });
    expect(withReasons.statusCode).toBe(200);

    const [movedBack, cleared] = await Promise.all([
      inject({
        method: "PUT",
        url: `/api/data-protection/breaches/${view.breachId}`,
        payload: { discoveredAt: discoveredHoursAgo(100) },
        headers: { cookie: boardCookie },
      }),
      inject({
        method: "PUT",
        url: `/api/data-protection/breaches/${view.breachId}`,
        payload: { delayReasons: "   " },
        headers: { cookie: boardCookie },
      }),
    ]);

    /*
     * Exactly one, in either order. Whoever takes the lock first reads a state
     * that passes; whoever takes it second reads what the first committed and
     * meets the rule. If `cleared` went first the reasons are blank and the
     * discovery date is about to move back, and if `movedBack` went first the
     * notification is already late - so the second is refused either way.
     *
     * Asserted as a count rather than as a loop over whatever was refused: the
     * interleaving this guards against is the one where both writers validate
     * against the row as it was, and that interleaving is two 200s. A loop over
     * an empty list is what a regression would look like.
     */
    const refused = [movedBack, cleared].filter(
      (response) => response.statusCode !== 200,
    );
    expect(refused).toHaveLength(1);
    const loser = refused[0];
    if (loser === undefined) {
      throw new Error("The length assertion above guarantees one.");
    }
    expect(reasonOf(loser)).toBe("delay-reasons-required");

    // And the state neither order may leave behind, asserted whatever the row
    // ended up holding rather than only where it is already wrong.
    const row = await prisma.personalDataBreach.findUniqueOrThrow({
      where: { id: view.breachId },
      select: {
        discoveredAt: true,
        imyNotifiedAt: true,
        delayReasons: true,
      },
    });
    const late =
      row.imyNotifiedAt !== null &&
      row.imyNotifiedAt.getTime() >
        row.discoveredAt.getTime() + 72 * 60 * 60 * 1000;
    expect(late && (row.delayReasons ?? "").trim() === "").toBe(false);
  });

  it("records the notification instant the row holds, not the one the decision omitted", async () => {
    /*
     * A notification recorded on the row before the decision, and a decision
     * that says nothing about it. Prisma leaves the instant in place, so the
     * audit entry has to describe that instant rather than the absence of one
     * in the decision's own payload.
     *
     * It matters because the entry is the evidence of when IMY was told and
     * whether that was inside the 72 hours. The log is append-only and outside
     * every purge, so an entry saying no notification was made outlives the
     * row that proves one was.
     */
    const discoveredAt = discoveredHoursAgo(10);
    const view = await recorded({ discoveredAt });

    const notifiedAt = new Date(
      new Date(discoveredAt).getTime() + 4 * 60 * 60 * 1000,
    ).toISOString();
    const updated = await inject({
      method: "PUT",
      url: `/api/data-protection/breaches/${view.breachId}`,
      payload: { imyNotifiedAt: notifiedAt },
      headers: { cookie: boardCookie },
    });
    expect(updated.statusCode).toBe(200);

    // The decision says nothing about the notification.
    const decided = await decide(view.breachId, {});
    expect(decided.statusCode).toBe(200);

    // The row keeps it. Omitting a field is not clearing it, and this is the
    // half that loses data rather than merely misreporting it: the instant IMY
    // was told is the association's evidence that it met the bound.
    expect(decided.json<BreachView>().imyNotifiedAt).toBe(notifiedAt);

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        action: "PERSONAL_DATA_BREACH_DECIDED",
        targetId: view.breachId,
      },
      select: { context: true },
    });
    expect(entry?.context).toMatchObject({
      // Four hours after discovery, and well inside the bound.
      hoursAfterDiscovery: 4,
      notifiedWithinDeadline: true,
    });
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

      /*
       * At least the one board member this suite created, who has an address.
       * The two cases beside this one assert zero, so a reminder that reached
       * nobody would otherwise pass all three and the board would lose its
       * 72-hour warning with every test still green. Not an exact count: the
       * predicate reads every active board position in the database, and this
       * suite does not own them all.
       */
      expect(sent).toBeGreaterThanOrEqual(1);
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

  it("carries a corrected wording into a row it already wrote", async () => {
    /*
     * The record is persisted rather than rendered, so a value fixed only in
     * the locale file repairs nothing already written. The authority's name was
     * seeded misspelled into this record once; the correction had to reach the
     * rows that carried it.
     *
     * The old value is put back on a seeded row here rather than waited for,
     * because what is being tested is that the next seed repairs a row holding
     * text the product no longer uses.
     */
    await seedRecord();
    const key = "cooperativeHousingRegisterReporting";

    await prisma.processingActivity.updateMany({
      where: { sourceKey: key, updatedByPersonId: null },
      data: { purpose: "Anmala till Lantmateriet." },
    });

    await seedRecord();

    const row = await prisma.processingActivity.findFirst({
      where: { sourceKey: key },
      select: { purpose: true },
    });
    expect(row?.purpose).not.toBe("Anmala till Lantmateriet.");
    expect(row?.purpose).toContain("Lantmäteriet");
  });

  it("leaves every word of a row the board has edited", async () => {
    /*
     * The other half, and the one that decides whether widening the refresh was
     * safe: `updatedByPersonId` is what protects the board's own words, and it
     * is set by any edit that changes something. A row carrying it must come
     * out of a seed exactly as the board left it, text and derived fields
     * alike - the board is answerable for the record under art. 5(2), and a
     * background job rewriting its account of its own processing would be the
     * association contradicting itself.
     */
    await seedRecord();
    const before = await readRecord();
    const target = before.activities.find(
      (activity) => activity.sourceKey === "issues",
    );
    if (target === undefined) {
      throw new Error("the seed did not write the issues row");
    }

    const edited = await inject({
      method: "PUT",
      url: `/api/data-protection/processing-activities/${target.activityId}`,
      payload: {
        name: "Felanmalningar, som styrelsen beskriver dem",
        purpose: "Styrelsens egen beskrivning av vad den gor med anmalningar.",
        legalBasis: target.legalBasis,
        dataSubjectCategories: target.dataSubjectCategories,
        personalDataCategories: target.personalDataCategories,
        thirdCountryTransfer: target.thirdCountryTransfer,
        retention: "Sa lange styrelsen har beslutat.",
      },
      headers: { cookie: boardCookie },
    });
    expect(edited.statusCode).toBe(200);

    await seedRecord();

    const row = await prisma.processingActivity.findFirst({
      where: { sourceKey: "issues" },
      select: { name: true, purpose: true, retention: true },
    });
    expect(row?.name).toBe("Felanmalningar, som styrelsen beskriver dem");
    expect(row?.purpose).toBe(
      "Styrelsens egen beskrivning av vad den gor med anmalningar.",
    );
    expect(row?.retention).toBe("Sa lange styrelsen har beslutat.");
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

  it("leaves a seeded row following the instance when a save repeats what it says", async () => {
    /*
     * Detaching a row is what stops the seed refreshing it, and the seed now
     * refreshes every field it wrote, so a detached row misses corrections to
     * the product's own wording as well as changes to the configuration. A
     * save that alters nothing must therefore leave it attached: a client
     * sending the whole row back unchanged has not written the board's words.
     *
     * The row is asserted seeded before the save, so the case cannot pass on a
     * row something else had already detached. The category lists go back in
     * reverse order, because their order carries no meaning and a different
     * order is not a different processing.
     */
    await seedRecord();
    const target = (await readRecord()).activities.find(
      (activity) => activity.sourceKey === "bookings",
    );
    if (target === undefined) {
      throw new Error("the seed did not write the bookings row");
    }
    expect(target.seeded).toBe(true);

    const saved = await inject({
      method: "PUT",
      url: `/api/data-protection/processing-activities/${target.activityId}`,
      payload: {
        name: target.name,
        purpose: target.purpose,
        legalBasis: target.legalBasis,
        legalBasisNote: target.legalBasisNote,
        dataSubjectCategories: [...target.dataSubjectCategories].reverse(),
        personalDataCategories: [...target.personalDataCategories].reverse(),
        recipients: target.recipients,
        thirdCountryTransfer: target.thirdCountryTransfer,
        thirdCountrySafeguards: target.thirdCountrySafeguards,
        retention: target.retention,
        securityMeasures: target.securityMeasures,
      },
      headers: { cookie: boardCookie },
    });
    expect(saved.statusCode).toBe(200);

    const after = (await readRecord()).activities.find(
      (activity) => activity.sourceKey === "bookings",
    );
    expect(after?.seeded).toBe(true);
  });

  it("accounts in the audit log for every change when two saves overlap", async () => {
    /*
     * Two saves of one seeded row run together: one sends its purpose back
     * unchanged, the other changes it. Serialised, they leave one of two
     * states. The change lands last, and one entry names `purpose`. Or the
     * resend lands last, putting the seeded purpose back over the change, and
     * two entries name it - one for each save that moved it.
     *
     * Unserialised, the resend compares its payload against the row it read
     * before the change committed, finds nothing different, and writes the
     * seeded purpose back over the change with an entry naming no field. The
     * row ends at the seeded purpose with a single entry naming `purpose`, and
     * the log no longer accounts for the save that undid the change.
     *
     * Which interleaving occurs is not in the test's control, so the pair runs
     * repeatedly and the invariant is asserted on every round. Each round's
     * entries are told apart by id rather than by time, because the entries are
     * stamped by the database's clock and a filter would be read against this
     * process's.
     */
    await seedRecord();
    const initial = (await readRecord()).activities.find(
      (activity) => activity.sourceKey === "motions",
    );
    if (initial === undefined) {
      throw new Error("the seed did not write the motions row");
    }
    const seededPurpose = initial.purpose;
    const changedPurpose = "Styrelsens egen beskrivning av motionerna.";
    const url = `/api/data-protection/processing-activities/${initial.activityId}`;
    const where = {
      action: "PROCESSING_ACTIVITY_UPDATED" as const,
      targetId: initial.activityId,
    };

    for (let round = 0; round < 15; round += 1) {
      await prisma.processingActivity.update({
        where: { id: initial.activityId },
        data: { purpose: seededPurpose, updatedByPersonId: null },
      });
      const before = new Set(
        (
          await prisma.auditLogEntry.findMany({ where, select: { id: true } })
        ).map((entry) => entry.id),
      );

      const responses = await Promise.all([
        inject({
          method: "PUT",
          url,
          payload: { purpose: seededPurpose },
          headers: { cookie: boardCookie },
        }),
        inject({
          method: "PUT",
          url,
          payload: { purpose: changedPurpose },
          headers: { cookie: boardCookie },
        }),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([
        200, 200,
      ]);

      const row = await prisma.processingActivity.findUniqueOrThrow({
        where: { id: initial.activityId },
        select: { purpose: true },
      });
      const namingPurpose = (
        await prisma.auditLogEntry.findMany({
          where,
          select: { id: true, context: true },
        })
      ).filter(
        (entry) =>
          !before.has(entry.id) &&
          (
            (entry.context as { fields?: string[] } | null)?.fields ?? []
          ).includes("purpose"),
      ).length;

      expect({ round, purpose: row.purpose, namingPurpose }).toEqual({
        round,
        purpose: row.purpose,
        namingPurpose: row.purpose === seededPurpose ? 2 : 1,
      });
    }
  });

  it("takes a processing the board performs outside the application", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/data-protection/processing-activities",
      payload: {
        name: `Nyckelhantering ${suffix}`,
        purpose: "Halla reda pa vem som kvitterat vilken nyckel.",
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

describe("processors", () => {
  async function listProcessors(): Promise<ProcessorView[]> {
    const response = await inject({
      method: "GET",
      url: "/api/data-protection/processors",
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json<ProcessorView[]>();
  }

  function classify(processorKey: string, payload: Record<string, unknown>) {
    return inject({
      method: "PUT",
      url: `/api/data-protection/processor-agreements/${processorKey}`,
      payload,
      headers: { cookie: boardCookie },
    });
  }

  it("lists what the instance hands data to, unclassified until the board says", async () => {
    const processors = await listProcessors();
    const keys = processors.map((processor) => processor.processorKey);

    // Storage and hosting always exist. Hosting because somebody runs the
    // machine and the instance cannot see who; storage because there is always
    // somewhere the files go.
    expect(keys).toContain("storage");
    expect(keys).toContain("hosting");

    const hosting = processors.find((p) => p.processorKey === "hosting");
    // Not recorded is the absence of a row: a question the screen asks rather
    // than a gap it hides.
    expect(hosting?.state).toBe("notRecorded");
    expect(hosting?.agreement).toBeNull();
  });

  it("suggests that the association's own disk is no processor", async () => {
    const processors = await listProcessors();
    const storage = processors.find((p) => p.processorKey === "storage");

    // Under the local driver only. Asking a board to research its own hard
    // drive would be asking it to answer a question already answered.
    expect(storage?.seededClassification).toBe("NOT_A_PROCESSOR");
  });

  it("refuses an agreement in place without the art. 28(3) terms confirmed", async () => {
    /*
     * art. 28(3) lists what the contract must set out. An agreement without
     * them is not one the article recognises, so it cannot be recorded as in
     * place - which is the difference between a record that demonstrates
     * compliance and one that merely has rows in it.
     */
    const response = await classify("hosting", {
      classification: "PROCESSOR",
      status: "IN_PLACE",
      counterparty: "Driftleverantoren AB",
      signedOn: "2026-02-01",
      termsConfirmed: false,
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("terms-required");
  });

  it("refuses a processor with nobody named, and a non-processor with no reason", async () => {
    const nameless = await classify("hosting", {
      classification: "PROCESSOR",
      status: "PENDING",
    });
    expect(nameless.statusCode).toBe(400);
    expect(reasonOf(nameless)).toBe("counterparty-required");

    const unexplained = await classify("hosting", {
      classification: "NOT_A_PROCESSOR",
    });
    expect(unexplained.statusCode).toBe(400);
    expect(reasonOf(unexplained)).toBe("note-required");
  });

  it("refuses the agreement fields on a classification that has no agreement", async () => {
    const response = await classify("hosting", {
      classification: "INDEPENDENT_CONTROLLER",
      counterparty: "Nagon annan",
      note: "Bestammer sina egna andamal.",
      termsConfirmed: true,
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("classification-inconsistent");
  });

  it("refuses a recipient this instance hands nothing to", async () => {
    // No SMS provider is configured, so an agreement about an SMS gateway
    // would be a false entry in a statutory record.
    const response = await classify("sms", {
      classification: "PROCESSOR",
      status: "PENDING",
      counterparty: "Nagon operator",
    });

    expect(response.statusCode).toBe(404);
    expect(reasonOf(response)).toBe("processor-not-found");
  });

  it("records one, and replaces it by closing the row it stood on", async () => {
    const first = await classify("hosting", {
      classification: "PROCESSOR",
      status: "PENDING",
      counterparty: "Driftleverantoren AB",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<ProcessorView>().state).toBe("pending");
    const firstId = first.json<ProcessorView>().agreement?.agreementId ?? "";

    const second = await classify("hosting", {
      classification: "PROCESSOR",
      status: "IN_PLACE",
      counterparty: "Driftleverantoren AB",
      signedOn: "2026-02-01",
      termsConfirmed: true,
      subProcessorsAuthorised: true,
      subProcessorNote: "Underbitraden enligt bilaga 2.",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<ProcessorView>().state).toBe("inPlace");

    /*
     * Dated rows rather than an edit in place: how a recipient was classified,
     * and which agreement covered it, is a fact about a period.
     */
    const replaced = await prisma.processorAgreement.findUniqueOrThrow({
      where: { id: firstId },
      select: { endedAt: true, endReason: true },
    });
    expect(replaced.endedAt).not.toBeNull();
    expect(replaced.endReason).toBe("replaced");
  });

  it("keeps the counterparty out of the audit log", async () => {
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "PROCESSOR_AGREEMENT_RECORDED" },
      orderBy: [{ createdAt: "desc" }],
    });

    const context = JSON.stringify(entry.context);
    expect(context).not.toContain("Driftleverantoren");
    expect(context).toContain("PROCESSOR");
  });

  it("answers the plugin views from the same rows", async () => {
    const states = await app.get(ProcessorAgreementService).forPlugins();

    // Nothing is installed in this suite, so the map is empty rather than
    // absent: a plugin with no classification reads as not recorded.
    expect(states.size).toBe(0);
  });
});

describe("privacy notice", () => {
  async function coverage(): Promise<PrivacyNoticeCoverage> {
    const response = await inject({
      method: "GET",
      url: "/api/data-protection/privacy-notice",
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json<PrivacyNoticeCoverage>();
  }

  /** The page as stored, so an append can be compared block for block. */
  async function storedBlocks(): Promise<unknown[]> {
    const page = await prisma.page.findUnique({
      where: { slug: PRIVACY_NOTICE_SLUG },
      select: { content: true },
    });
    return (page?.content as { blocks?: unknown[] } | null)?.blocks ?? [];
  }

  it("seeds a notice carrying every art. 13 heading", async () => {
    await app
      .get(PagesService)
      .seedPrivacyNotice(app.get(I18nService).translatorFor("sv"));

    const state = await coverage();

    expect(state.exists).toBe(true);
    // Fifteen, because that is what art. 13(1) and (2) require between them.
    expect(state.sections).toHaveLength(15);
  });

  it("names the headings a notice does not answer", async () => {
    /*
     * The check is a check and not a rewrite. A notice is the association's own
     * account in its own words, so what the product does is compare the
     * headings against the article and say which questions are unanswered.
     */
    const page = await prisma.page.findUnique({
      where: { slug: PRIVACY_NOTICE_SLUG },
      select: { id: true, content: true },
    });
    if (page === null) {
      return;
    }
    const original = page.content;

    await prisma.page.update({
      where: { id: page.id },
      data: {
        content: {
          version: 1,
          blocks: [
            { type: "paragraph", runs: [{ text: "Styrelsen skriver." }] },
          ],
        },
      },
    });

    try {
      const state = await coverage();
      expect(state.sections.every((section) => !section.present)).toBe(true);
      expect(state.controllerContactBlock).toBe(false);
    } finally {
      await prisma.page.update({
        where: { id: page.id },
        data: { content: original ?? {} },
      });
    }
  });

  it("appends what is missing and leaves every existing block byte-identical", async () => {
    const page = await prisma.page.findUnique({
      where: { slug: PRIVACY_NOTICE_SLUG },
      select: { id: true, content: true },
    });
    if (page === null) {
      return;
    }
    const original = page.content;

    // A notice the board has spent an evening on: its own prose, and one of the
    // fifteen headings answered.
    await prisma.page.update({
      where: { id: page.id },
      data: {
        content: {
          version: 1,
          blocks: [
            { type: "paragraph", runs: [{ text: "Styrelsens egen ingress." }] },
            {
              type: "heading",
              level: 2,
              runs: [{ text: "Vem som är personuppgiftsansvarig" }],
            },
            { type: "paragraph", runs: [{ text: "Föreningen, se nedan." }] },
          ],
        },
      },
    });

    try {
      const before = await storedBlocks();

      const appended = await inject({
        method: "POST",
        url: "/api/data-protection/privacy-notice/headings",
        headers: { cookie: boardCookie },
      });
      expect(appended.statusCode).toBe(200);

      const after = await storedBlocks();

      /*
       * The whole promise of the append: the board's own blocks are untouched,
       * in their order, and what was added went on the end. Reordering the page
       * to match the article would move text the board wrote under headings it
       * did not intend.
       */
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.length).toBeGreaterThan(before.length);

      const state = appended.json<PrivacyNoticeCoverage>();
      // Named rather than counted, so a failure says which question is still
      // unanswered instead of only that one is.
      expect(
        state.sections
          .filter((section) => !section.present)
          .map((section) => section.section),
      ).toEqual([]);
      expect(state.controllerContactBlock).toBe(true);

      // And it wrote no text: every added block is a heading or the contact
      // block, because the answer under a heading is the board's to write.
      const added = after.slice(before.length) as { type: string }[];
      expect(
        added.every(
          (block) =>
            block.type === "heading" || block.type === "controllerContact",
        ),
      ).toBe(true);
    } finally {
      await prisma.page.update({
        where: { id: page.id },
        data: { content: original ?? {} },
      });
    }
  });

  it("records which questions were added and no text", async () => {
    const entry = await prisma.auditLogEntry.findFirst({
      where: { action: "PRIVACY_NOTICE_HEADINGS_ADDED" },
      orderBy: [{ createdAt: "desc" }],
    });

    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry?.context)).not.toContain("Styrelsens egen");
  });
});

describe("overview", () => {
  it("counts what is waiting, from the same functions the panels use", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/data-protection/overview",
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const overview = response.json<DataProtectionOverview>();

    /*
     * Derived rather than stored. A count kept in a column goes wrong exactly
     * when it matters - the night a deadline passes and nothing recomputes it -
     * so these are read off the rows every time.
     */
    const undecided = await prisma.personalDataBreach.count({
      where: { decidedAt: null, closedAt: null },
    });
    expect(overview.breaches.awaitingDecision).toBe(undecided);
    expect(overview.processors.notRecorded).toBeGreaterThanOrEqual(0);
    expect(typeof overview.notice.published).toBe("boolean");
  });

  it("names the nearest 72-hour bound still running", async () => {
    const view = await recorded({ discoveredAt: discoveredHoursAgo(1) });

    const response = await inject({
      method: "GET",
      url: "/api/data-protection/overview",
      headers: { cookie: boardCookie },
    });
    const overview = response.json<DataProtectionOverview>();

    expect(overview.breaches.awaitingDecision).toBeGreaterThan(0);
    expect(overview.breaches.nearestDeadline).not.toBeNull();
    // No later than this breach's own bound: it is the nearest or something
    // else is nearer.
    expect(
      new Date(overview.breaches.nearestDeadline ?? "").getTime(),
    ).toBeLessThanOrEqual(new Date(view.imyNotifyBy).getTime());
  });

  it("is refused to a resident", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/data-protection/overview",
      headers: { cookie: residentCookie },
    });

    expect(response.statusCode).toBe(403);
  });
});
