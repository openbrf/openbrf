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
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { PagesService, PRIVACY_NOTICE_SLUG } from "../site/pages.service";
import { I18nService } from "../i18n/i18n.service";
import { MailService } from "../mail/mail.service";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
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
import { PENDING_EXTERNAL_PROCESSOR_KEY_PREFIX } from "./processor-key";
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

  it("refuses a personal identity number in the reasons a decision gives for a delay", async () => {
    const view = await recorded();

    const response = await decide(view.breachId, {
      delayReasons: `Vi vantade pa ${runIdentityNumber(suffix)}.`,
    });

    expect(response.statusCode).toBe(400);
    expect(reasonOf(response)).toBe("personal-identity-number");
  });

  it("stores what it scanned: the free text of a record and a decision, folded", async () => {
    const view = await recorded({
      title: `Felskickad\u200B  lista ${suffix}`,
      description: "Rad ett\u00AD\nRad tv\u200Ba",
    });
    expect(view.title).toBe(`Felskickad lista ${suffix}`);
    expect(view.description).toBe("Rad ett\nRad tva");

    const decided = await decide(view.breachId, {
      imyDecisionGround: "Uppgifterna\u200B nadde en obehorig.",
      imyNotifiedAt: new Date().toISOString(),
      delayReasons: "Natet\u200B var nere.",
    });
    expect(decided.statusCode).toBe(200);

    const row = await prisma.personalDataBreach.findUniqueOrThrow({
      where: { id: view.breachId },
      select: { imyDecisionGround: true, delayReasons: true },
    });
    expect(row.imyDecisionGround).toBe("Uppgifterna nadde en obehorig.");
    // Not late, so the reasons are not required, but what is given is kept folded.
    expect(row.delayReasons).toBe("Natet var nere.");
  });

  it.each([
    ["a soft hyphen", (n: string) => `${n.slice(0, 8)}\u00AD${n.slice(8)}`],
    [
      "a zero-width space",
      (n: string) => `${n.slice(0, 6)}\u200B${n.slice(6)}`,
    ],
    [
      "fullwidth digits",
      (n: string) =>
        Array.from(n, (d) => String.fromCodePoint(0xff10 + Number(d))).join(""),
    ],
    // Not hidden at all, only spaced or broken over two lines: the forms the
    // identity-number parser itself accepts.
    [
      "spaces around a hyphen",
      (n: string) => `${n.slice(0, 8)} - ${n.slice(8)}`,
    ],
    ["a line break", (n: string) => `${n.slice(0, 8)}\n${n.slice(8)}`],
  ])(
    "refuses an identity number hidden by %s in the reasons for a delay",
    async (_name, hide) => {
      const view = await recorded();

      const response = await decide(view.breachId, {
        delayReasons: `Vi vantade pa ${hide(runIdentityNumber(suffix))}.`,
      });

      expect(response.statusCode).toBe(400);
      expect(reasonOf(response)).toBe("personal-identity-number");
    },
  );

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

  it("refuses a notification before the discovery or in the future, on both routes", async () => {
    /*
     * Either is a record that cannot be true, and the future one is worse than
     * wrong: a notified-at takes the breach off the 72-hour clock, so a date
     * still to come would stop the clock on a breach IMY knows nothing about.
     */
    const discoveredAt = discoveredHoursAgo(2);
    const view = await recorded({ discoveredAt });
    const beforeDiscovery = new Date(
      new Date(discoveredAt).getTime() - 60 * 60 * 1000,
    ).toISOString();
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    for (const imyNotifiedAt of [beforeDiscovery, inAnHour]) {
      const decided = await decide(view.breachId, { imyNotifiedAt });
      expect(decided.statusCode).toBe(400);
      expect(reasonOf(decided)).toBe("notified-out-of-range");
    }

    const decided = await decide(view.breachId, {});
    expect(decided.statusCode).toBe(200);

    for (const imyNotifiedAt of [beforeDiscovery, inAnHour]) {
      const updated = await inject({
        method: "PUT",
        url: `/api/data-protection/breaches/${view.breachId}`,
        payload: { imyNotifiedAt },
        headers: { cookie: boardCookie },
      });
      expect(updated.statusCode).toBe(400);
      expect(reasonOf(updated)).toBe("notified-out-of-range");
    }

    // The clock is still running: nothing refused was written.
    const row = await prisma.personalDataBreach.findUniqueOrThrow({
      where: { id: view.breachId },
      select: { imyNotifiedAt: true },
    });
    expect(row.imyNotifiedAt).toBeNull();
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

  it("keeps the clock running after a decision to notify IMY, until the notification is recorded", async () => {
    const view = await recorded({ discoveredAt: discoveredHoursAgo(2) });

    const decided = await decide(view.breachId, {
      imyNotificationRequired: true,
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json<BreachView>().state).toBe("notificationOwed");

    const notified = await inject({
      method: "PUT",
      url: `/api/data-protection/breaches/${view.breachId}`,
      payload: { imyNotifiedAt: new Date().toISOString() },
      headers: { cookie: boardCookie },
    });
    expect(notified.statusCode).toBe(200);
    expect(notified.json<BreachView>().state).toBe("decided");
  });

  it("is overdue once the bound passes with the notification still owed", async () => {
    const view = await recorded({ discoveredAt: discoveredHoursAgo(80) });

    const decided = await decide(view.breachId, {
      imyNotificationRequired: true,
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json<BreachView>().state).toBe("overdue");

    // Late, so the notification carries the reasons for the delay.
    const notified = await inject({
      method: "PUT",
      url: `/api/data-protection/breaches/${view.breachId}`,
      payload: {
        imyNotifiedAt: new Date().toISOString(),
        delayReasons: "Styrelsen kunde inte sammantrada forran nu.",
      },
      headers: { cookie: boardCookie },
    });
    expect(notified.statusCode).toBe(200);
    expect(notified.json<BreachView>().state).toBe("decided");
  });

  it("refuses closing a breach while the notification to IMY is owed", async () => {
    // Closing would stop the clock by another route: the register, the
    // reminder and the overview all stop watching a closed breach.
    const view = await recorded();
    await decide(view.breachId, { imyNotificationRequired: true });

    const closing = await inject({
      method: "POST",
      url: `/api/data-protection/breaches/${view.breachId}/close`,
      headers: { cookie: boardCookie },
    });
    expect(closing.statusCode).toBe(409);
    expect(reasonOf(closing)).toBe("imy-notification-owed");
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

  it("names each person it reached when it is recorded, as adding one later does", async () => {
    // The entry naming them is what puts the breach on their access report.
    const view = await recorded({ subjectPersonIds: [subject.personId] });

    await expect(
      prisma.auditLogEntry.count({
        where: {
          action: "PERSONAL_DATA_BREACH_UPDATED",
          targetPersonId: subject.personId,
          targetId: view.breachId,
        },
      }),
    ).resolves.toBe(1);
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

    it("still mails the board once it has decided to notify IMY and has not", async () => {
      /*
       * Deciding that IMY is to be notified is not the notification art. 33(1)
       * asks for, and the 72 hours keep running until it is made. A board that
       * decided on day one and then forgot is the board this reminder is for.
       */
      const view = await recorded();
      const decided = await decide(view.breachId, {
        imyNotificationRequired: true,
      });
      expect(decided.statusCode).toBe(200);
      expect(decided.json<BreachView>().imyNotifiedAt).toBeNull();

      const sent = await app.get(BreachReminderService).sendBreachReminder({
        breachId: view.breachId,
        discoveredAt: view.discoveredAt,
      });

      expect(sent).toBeGreaterThanOrEqual(1);
    });

    it("sends nothing once IMY has been notified", async () => {
      const view = await recorded();
      await decide(view.breachId, {
        imyNotificationRequired: true,
        imyNotifiedAt: new Date().toISOString(),
      });

      await expect(
        app.get(BreachReminderService).sendBreachReminder({
          breachId: view.breachId,
          discoveredAt: view.discoveredAt,
        }),
      ).resolves.toBe(0);
    });

    it("sends nothing once the board has found no notification owed", async () => {
      const view = await recorded();
      await decide(view.breachId, {
        risk: "UNLIKELY",
        imyNotificationRequired: false,
      });

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

    it("fails, to be tried again, when the mail server is down", async () => {
      /*
       * The only warning before the 72-hour bound. A job that completed after
       * reaching nobody would never be tried again, so every address failing
       * is a failure the queue sees, on a job that carries retries.
       */
      const view = await recorded();
      const send = vi
        .spyOn(app.get(MailService), "send")
        .mockRejectedValue(new Error("connect ECONNREFUSED"));

      try {
        await expect(
          app.get(BreachReminderService).sendBreachReminder({
            breachId: view.breachId,
            discoveredAt: view.discoveredAt,
          }),
        ).rejects.toThrow(/did not reach/);
      } finally {
        send.mockRestore();
      }

      const [job] = await prisma.$queryRawUnsafe<{ retry_limit: number }[]>(
        "SELECT retry_limit FROM pgboss.job WHERE name = $1 AND data->>'breachId' = $2",
        BREACH_REMINDER_QUEUE,
        view.breachId,
      );
      expect(job?.retry_limit).toBe(5);
    });
  });

  describe("the reminder's record of who it reached", () => {
    const second = {
      personId: `dp-board-two-${suffix}`,
      email: `dp-board-two-${suffix}@exempel.se`,
    };

    beforeAll(async () => {
      const email = await app
        .get(FieldEncryptionService)
        .encrypt("person.email", second.email);
      await prisma.person.create({
        data: {
          id: second.personId,
          firstName: "Person",
          lastName: `Dataskydd${suffix}`,
          emailCipher: email.cipher,
          emailIndex: email.index,
        },
      });
      await prisma.boardPosition.create({
        data: {
          personId: second.personId,
          position: "BOARD_MEMBER",
          electedOn: new Date("2026-01-01"),
        },
      });
    });

    afterAll(async () => {
      await prisma.boardPosition.deleteMany({
        where: { personId: second.personId },
      });
      await prisma.person.deleteMany({ where: { id: second.personId } });
    });

    /** The addresses the mail service was asked to write to. */
    function mailed(send: { mock: { calls: unknown[][] } }): string[] {
      return send.mock.calls.map(([input]) => (input as { to: string }).to);
    }

    it("sends once for one discovery, however many jobs carry it", async () => {
      /*
       * A discovery time corrected from A to B and back to A queues a job for A
       * twice, and both match the row when they fire. The marker is what tells
       * the second that the board was reminded.
       */
      const view = await recorded();
      const job = { breachId: view.breachId, discoveredAt: view.discoveredAt };
      const send = vi
        .spyOn(app.get(MailService), "send")
        .mockResolvedValue(undefined as never);

      try {
        const first = await app
          .get(BreachReminderService)
          .sendBreachReminder(job);
        const again = await app
          .get(BreachReminderService)
          .sendBreachReminder(job);

        expect(first).toBeGreaterThanOrEqual(2);
        expect(again).toBe(0);
        expect(mailed(send)).toHaveLength(first);
        expect(new Set(mailed(send)).size).toBe(first);
      } finally {
        send.mockRestore();
      }
    });

    it("retries only the board members it did not reach", async () => {
      const view = await recorded();
      const job = { breachId: view.breachId, discoveredAt: view.discoveredAt };
      const send = vi
        .spyOn(app.get(MailService), "send")
        .mockImplementation((input) =>
          input.to === second.email
            ? Promise.reject(new Error("connect ECONNREFUSED"))
            : Promise.resolve(undefined as never),
        );

      try {
        await expect(
          app.get(BreachReminderService).sendBreachReminder(job),
        ).rejects.toThrow(/did not reach 1 of the/);
        const reached = mailed(send).filter((to) => to !== second.email);
        expect(reached).toContain(board.email);

        send.mockClear();
        send.mockResolvedValue(undefined as never);
        const retried = await app
          .get(BreachReminderService)
          .sendBreachReminder(job);

        // Whoever the first run reached is not sent a second copy.
        expect(retried).toBe(1);
        expect(mailed(send)).toEqual([second.email]);
      } finally {
        send.mockRestore();
      }
    });

    it("starts the list again for a corrected discovery time, and keeps the earlier one's", async () => {
      const view = await recorded();
      const send = vi
        .spyOn(app.get(MailService), "send")
        .mockResolvedValue(undefined as never);

      try {
        const first = await app.get(BreachReminderService).sendBreachReminder({
          breachId: view.breachId,
          discoveredAt: view.discoveredAt,
        });
        const corrected = discoveredHoursAgo(5);
        const updated = await inject({
          method: "PUT",
          url: `/api/data-protection/breaches/${view.breachId}`,
          payload: { discoveredAt: corrected },
          headers: { cookie: boardCookie },
        });
        expect(updated.statusCode).toBe(200);

        // A new discovery is a new clock, and the board is owed its reminder.
        const next = await app.get(BreachReminderService).sendBreachReminder({
          breachId: view.breachId,
          discoveredAt: updated.json<BreachView>().discoveredAt,
        });

        expect(next).toBe(first);

        // Corrected back to A: A's receipts survived B's reminder, so nobody
        // is mailed A's reminder a second time.
        const back = await inject({
          method: "PUT",
          url: `/api/data-protection/breaches/${view.breachId}`,
          payload: { discoveredAt: view.discoveredAt },
          headers: { cookie: boardCookie },
        });
        expect(back.statusCode).toBe(200);
        const mailedBefore = send.mock.calls.length;

        const again = await app.get(BreachReminderService).sendBreachReminder({
          breachId: view.breachId,
          discoveredAt: back.json<BreachView>().discoveredAt,
        });

        expect(again).toBe(0);
        expect(send.mock.calls.length).toBe(mailedBefore);
      } finally {
        send.mockRestore();
      }
    });

    it("stops mailing the rest of the board once the breach has been answered", async () => {
      const view = await recorded();
      const job = { breachId: view.breachId, discoveredAt: view.discoveredAt };
      const decideOnFirstSend = vi
        .spyOn(app.get(MailService), "send")
        .mockImplementationOnce(async () => {
          await prisma.personalDataBreach.update({
            where: { id: view.breachId },
            data: {
              decidedAt: new Date(),
              imyNotificationRequired: false,
            },
          });
          return undefined as never;
        })
        .mockResolvedValue(undefined as never);

      try {
        const sent = await app
          .get(BreachReminderService)
          .sendBreachReminder(job);

        // The send that was in flight when the board answered is the last one:
        // the lock is taken again for every member, and what is owed is read
        // again under it.
        expect(sent).toBe(1);
        expect(decideOnFirstSend).toHaveBeenCalledTimes(1);
      } finally {
        decideOnFirstSend.mockRestore();
      }
    });
  });

  it("queues no second reminder when the discovery time is saved unchanged", async () => {
    // Both jobs would carry the same clock, so the stale-job check could not
    // tell them apart and the board would be reminded twice.
    const view = await recorded();

    const updated = await inject({
      method: "PUT",
      url: `/api/data-protection/breaches/${view.breachId}`,
      payload: { discoveredAt: view.discoveredAt },
      headers: { cookie: boardCookie },
    });
    expect(updated.statusCode).toBe(200);

    await expect(reminderJobs(view.breachId)).resolves.toHaveLength(1);
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

  it("refuses a save built on a copy somebody else has replaced", async () => {
    /*
     * The art. 30 record is edited as a whole, so a board member who opened it,
     * went to a meeting and saved afterwards would put their copy over a
     * colleague's edit with nothing said to either. The advisory lock the save
     * already takes serialises two transactions that overlap on the server and
     * can say nothing about when a payload was composed.
     */
    const created = await inject({
      method: "POST",
      url: "/api/data-protection/processing-activities",
      payload: {
        name: `Cykelrum ${suffix}`,
        purpose: "Halla reda pa vem som har plats i cykelrummet.",
        legalBasis: "LEGITIMATE_INTEREST",
        dataSubjectCategories: ["member"],
        personalDataCategories: ["name", "apartment"],
        thirdCountryTransfer: false,
        retention: "Tills platsen lamnas tillbaka.",
      },
      headers: { cookie: boardCookie },
    });
    expect(created.statusCode).toBe(201);
    const activity = created.json<{ activityId: string; revision: number }>();
    const url = `/api/data-protection/processing-activities/${activity.activityId}`;

    // The other board member's save, which lands first and moves the revision.
    const first = await inject({
      method: "PUT",
      url,
      payload: {
        purpose: "Kollegans egen beskrivning.",
        expectedRevision: activity.revision,
      },
      headers: { cookie: boardCookie },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ revision: number }>().revision).toBeGreaterThan(
      activity.revision,
    );

    // And the one composed before it is refused rather than applied.
    const stale = await inject({
      method: "PUT",
      url,
      payload: {
        purpose: "Min egen beskrivning, skriven innan kollegan sparade.",
        expectedRevision: activity.revision,
      },
      headers: { cookie: boardCookie },
    });
    expect(stale.statusCode).toBe(409);
    expect(reasonOf(stale)).toBe("activity-changed");

    const row = await prisma.processingActivity.findUniqueOrThrow({
      where: { id: activity.activityId },
      select: { purpose: true },
    });
    expect(row.purpose).toBe("Kollegans egen beskrivning.");
  });

  it("writes without a precondition, as the route always has", async () => {
    const created = await inject({
      method: "POST",
      url: "/api/data-protection/processing-activities",
      payload: {
        name: `Barnvagnsrum ${suffix}`,
        purpose: "Halla reda pa vem som har plats i barnvagnsrummet.",
        legalBasis: "LEGITIMATE_INTEREST",
        dataSubjectCategories: ["member"],
        personalDataCategories: ["name", "apartment"],
        thirdCountryTransfer: false,
        retention: "Tills platsen lamnas tillbaka.",
      },
      headers: { cookie: boardCookie },
    });
    expect(created.statusCode).toBe(201);
    const activity = created.json<{ activityId: string; revision: number }>();

    const saved = await inject({
      method: "PUT",
      url: `/api/data-protection/processing-activities/${activity.activityId}`,
      payload: { purpose: "Andrad utan foregaende lasning." },
      headers: { cookie: boardCookie },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ revision: number }>().revision).toBeGreaterThan(
      activity.revision,
    );
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

  it("keeps an agreement in place when an install answers over it", async () => {
    /*
     * A plugin install writes through `record` with `onlyIfUnrecorded`: its
     * permission is to install plugins, not to change this record, so a stale
     * consent screen or a direct caller answering "being made" must leave an
     * agreement the board recorded as in place exactly as it was. Asked of the
     * write itself, against the real database, because that is where the check
     * and a concurrent classification meet.
     */
    const inPlace = await classify("hosting", {
      classification: "PROCESSOR",
      status: "IN_PLACE",
      counterparty: "Driftleverantoren AB",
      signedOn: "2026-02-01",
      termsConfirmed: true,
    });
    expect(inPlace.statusCode).toBe(200);
    const agreementId =
      inPlace.json<ProcessorView>().agreement?.agreementId ?? "";
    /*
     * Held to this recipient rather than to the kept row: an overwrite would
     * log its entry against the new row it wrote, which a count of the kept
     * row's entries cannot see.
     */
    const recordedForHosting = () =>
      prisma.auditLogEntry.count({
        where: {
          action: "PROCESSOR_AGREEMENT_RECORDED",
          targetKind: "processorAgreement",
          context: { path: ["processorKey"], equals: "hosting" },
        },
      });
    const auditBefore = await recordedForHosting();

    const kept = await app.get(ProcessorAgreementService).record(
      "hosting",
      {
        classification: "PROCESSOR",
        status: "PENDING",
        counterparty: "Nagon annan AB",
        actorPersonId: null,
        channel: "WEB",
      },
      await app.get(ProcessorFactsService).read(),
      { onlyIfUnrecorded: true },
    );

    expect(kept.state).toBe("inPlace");
    expect(kept.agreement?.agreementId).toBe(agreementId);

    const open = await prisma.processorAgreement.findMany({
      where: { processorKey: "hosting", endedAt: null },
      select: { id: true, status: true, counterparty: true },
    });
    expect(open).toEqual([
      {
        id: agreementId,
        status: "IN_PLACE",
        counterparty: "Driftleverantoren AB",
      },
    ]);
    // Nothing was recorded, so nothing is logged as recorded.
    expect(await recordedForHosting()).toBe(auditBefore);
  });

  it("takes the recipient's key before it replaces the recipient's row", async () => {
    /*
     * One open row per recipient holds only while writers of one recipient are
     * ordered: at READ COMMITTED two of them can both close the row and both
     * insert. So a classification has to wait while somebody else holds the
     * recipient's key - read out of `pg_locks`, not inferred from a delay. The
     * key is spelled out here so that a writer which changed it fails this
     * instead of passing under a new name.
     */
    const key = "processor-agreement:hosting";
    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        await holderDone;
      },
      { timeout: 60_000, maxWait: 20_000 },
    );

    try {
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, true)) > 0n,
      );

      const classifying = classify("hosting", {
        classification: "PROCESSOR",
        status: "PENDING",
        counterparty: "Driftleverantoren AB",
      });
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, false)) > 0n,
      );

      releaseHolder?.();
      await holder;
      expect((await classifying).statusCode).toBe(200);
    } finally {
      releaseHolder?.();
      await holder.catch(() => undefined);
    }
  }, 60_000);

  it("keeps a board-recorded recipient ended when the end commits while a classification waits", async () => {
    /*
     * Such a recipient exists only while its row is open. A classification
     * that found it open and then waited for the recipient's key must not
     * write it back after the board ended it in the meantime: that would put
     * a recipient the board took off the record back on it. The end takes no
     * lock, so it commits while the classification is held behind one.
     */
    const facts = await app.get(ProcessorFactsService).read();
    const recorded = await app.get(ProcessorAgreementService).recordExternal(
      {
        classification: "NOT_A_PROCESSOR",
        note: "Ingen behandling for foreningens rakning.",
        actorPersonId: board.personId,
      },
      facts,
    );
    const processorKey = recorded.processorKey;
    const agreementId = recorded.agreement?.agreementId ?? "";

    const key = `processor-agreement:${processorKey}`;
    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        await holderDone;
      },
      { timeout: 60_000, maxWait: 20_000 },
    );

    try {
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, true)) > 0n,
      );

      const classifying = classify(processorKey, {
        classification: "INDEPENDENT_CONTROLLER",
        counterparty: "Nagon annan AB",
        note: "Bestammer sina egna andamal.",
      });
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, false)) > 0n,
      );

      const ended = await inject({
        method: "POST",
        url: `/api/data-protection/processor-agreements/${agreementId}/end`,
        payload: { reason: "Inte langre anlitad." },
        headers: { cookie: boardCookie },
      });
      expect(ended.statusCode).toBe(200);

      releaseHolder?.();
      await holder;

      // The same refusal the board gets for a recipient that is not there.
      const refused = await classifying;
      expect(refused.statusCode).toBe(404);
      expect(reasonOf(refused)).toBe("processor-not-found");
    } finally {
      releaseHolder?.();
      await holder.catch(() => undefined);
    }

    const rows = await prisma.processorAgreement.findMany({
      where: { processorKey },
      select: { id: true, endedAt: true, endReason: true },
    });
    expect(rows).toEqual([
      {
        id: agreementId,
        endedAt: expect.any(Date) as Date,
        endReason: "Inte langre anlitad.",
      },
    ]);
    const listed = await listProcessors();
    expect(listed.map((processor) => processor.processorKey)).not.toContain(
      processorKey,
    );
  }, 60_000);

  it("refuses a second open row for one recipient from a writer that skips the lock", async () => {
    /*
     * The lock above is the path writers take; the partial unique index is
     * what holds when one does not. Written straight through Prisma, with no
     * lock and no read first, as a future writer that got it wrong would. P2002
     * is Prisma's name for the unique violation Postgres raises (23505), which
     * is the refusal this test is about: any other failure would satisfy a bare
     * `toThrow()`.
     */
    const processorKey = `external:dpindex${suffix}`;
    const row = {
      processorKind: "EXTERNAL" as const,
      processorKey,
      classification: "NOT_A_PROCESSOR" as const,
      note: "Ingen mottagare.",
      recordedByPersonId: board.personId,
    };

    const first = await prisma.processorAgreement.create({
      data: row,
      select: { id: true },
    });
    await expect(
      prisma.processorAgreement.create({ data: row }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Partial: a closed row is history and leaves the recipient free for the
    // next classification.
    await prisma.processorAgreement.update({
      where: { id: first.id },
      data: { endedAt: new Date(), endReason: "replaced" },
    });
    await expect(
      prisma.processorAgreement.create({ data: row }),
    ).resolves.toBeDefined();
  });

  it("records a second recipient the board knows about while the first is still being written", async () => {
    /*
     * A board-recorded recipient is written under a placeholder key and then
     * renamed after its own id, in one transaction. Under the unique index a
     * placeholder shared by both recordings would hold the second on the
     * first's insert until the first committed. So the first is held open at
     * its audit entry, after both its steps, and the second has to finish
     * while it waits.
     */
    const facts = await app.get(ProcessorFactsService).read();
    const service = app.get(ProcessorAgreementService);
    const audit = app.get(AuditLogService);
    const input = {
      classification: "NOT_A_PROCESSOR" as const,
      note: "Ingen behandling for foreningens rakning.",
      actorPersonId: board.personId,
    };

    const writeAudit = audit.record.bind(audit);
    let atAudit: (() => void) | undefined;
    const firstAtAudit = new Promise<void>((resolve) => {
      atAudit = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const held = vi
      .spyOn(audit, "record")
      .mockImplementationOnce(async (...args) => {
        atAudit?.();
        await firstReleased;
        return writeAudit(...args);
      });

    try {
      const first = service.recordExternal(input, facts);
      await firstAtAudit;

      // With a shared placeholder this waits until the first's transaction
      // times out, and the first then fails below.
      const two = await service.recordExternal(input, facts);

      releaseFirst?.();
      const one = await first;

      expect(one.processorKey).not.toBe(two.processorKey);
      expect(
        await prisma.processorAgreement.count({
          where: {
            processorKey: { startsWith: PENDING_EXTERNAL_PROCESSOR_KEY_PREFIX },
          },
        }),
      ).toBe(0);
    } finally {
      releaseFirst?.();
      held.mockRestore();
    }
  }, 30_000);

  it("answers the plugin views from the same rows", async () => {
    const states = await app.get(ProcessorAgreementService).forPlugins();

    // Nothing is installed in this suite, so the map is empty rather than
    // absent: a plugin with no classification reads as not recorded.
    expect(states.size).toBe(0);
  });

  describe("the storage seed", () => {
    /*
     * "storage" carries no run suffix and this database is shared, so what
     * stood there before the suite is put aside and put back: open rows are
     * closed for the duration and reopened after, and every row the suite
     * wrote is deleted between cases and at the end.
     */
    let before: { id: string; endedAt: Date | null }[] = [];

    const suiteRows = () => ({
      processorKey: "storage",
      id: { notIn: before.map((row) => row.id) },
    });

    const openStorageRows = () =>
      prisma.processorAgreement.findMany({
        where: { processorKey: "storage", endedAt: null },
        select: { id: true, recordedByPersonId: true },
      });

    async function seedWith(storageDriver: "local" | "s3"): Promise<void> {
      await app
        .get(ProcessorAgreementService)
        .seed(
          { ...(await app.get(ProcessorFactsService).read()), storageDriver },
          app.get(I18nService).translatorFor("sv"),
        );
    }

    beforeAll(async () => {
      before = await prisma.processorAgreement.findMany({
        where: { processorKey: "storage" },
        select: { id: true, endedAt: true },
      });
      await prisma.processorAgreement.updateMany({
        where: { processorKey: "storage", endedAt: null },
        data: { endedAt: new Date() },
      });
    });

    beforeEach(async () => {
      await prisma.processorAgreement.deleteMany({ where: suiteRows() });
    });

    afterAll(async () => {
      await prisma.processorAgreement.deleteMany({ where: suiteRows() });
      await prisma.processorAgreement.updateMany({
        where: {
          id: {
            in: before.filter((row) => row.endedAt === null).map((r) => r.id),
          },
        },
        data: { endedAt: null },
      });
    });

    it("records the association's own disk as no processor, once", async () => {
      await seedWith("local");

      const open = await openStorageRows();
      expect(open).toHaveLength(1);
      const row = await prisma.processorAgreement.findUniqueOrThrow({
        where: { id: open[0]?.id ?? "" },
        select: {
          processorKind: true,
          classification: true,
          status: true,
          recordedByPersonId: true,
        },
      });
      expect(row).toEqual({
        processorKind: "STORAGE",
        classification: "NOT_A_PROCESSOR",
        status: null,
        // The instance answered this, not a board member.
        recordedByPersonId: null,
      });

      const entries = await prisma.auditLogEntry.findMany({
        where: {
          action: "PROCESSOR_AGREEMENT_RECORDED",
          targetKind: "processorAgreement",
          targetId: open[0]?.id ?? "",
        },
        select: { channel: true, actorPersonId: true },
      });
      expect(entries).toEqual([{ channel: "SYSTEM", actorPersonId: null }]);

      const listed = await listProcessors();
      expect(
        listed.find((p) => p.processorKey === "storage")?.agreement
          ?.classification,
      ).toBe("NOT_A_PROCESSOR");
    });

    it("writes nothing when it runs again with the same driver", async () => {
      await seedWith("local");
      const rows = await prisma.processorAgreement.findMany({
        where: suiteRows(),
      });
      const entries = () =>
        prisma.auditLogEntry.count({
          where: {
            targetKind: "processorAgreement",
            targetId: { in: rows.map((row) => row.id) },
          },
        });
      const entriesBefore = await entries();

      await seedWith("local");

      expect(
        await prisma.processorAgreement.findMany({ where: suiteRows() }),
      ).toEqual(rows);
      expect(await entries()).toBe(entriesBefore);
    });

    it("closes the row it wrote once storage moves to a bucket", async () => {
      await seedWith("local");
      const [seeded] = await openStorageRows();

      await seedWith("s3");

      // The screen asks the board again rather than answering it wrongly.
      expect(await openStorageRows()).toEqual([]);
      const closed = await prisma.processorAgreement.findUniqueOrThrow({
        where: { id: seeded?.id ?? "" },
        select: { endedAt: true, endReason: true, endedByPersonId: true },
      });
      expect(closed.endedAt).not.toBeNull();
      expect(closed.endReason).toBe("driver-changed");
      expect(closed.endedByPersonId).toBeNull();

      const ended = await prisma.auditLogEntry.findMany({
        where: {
          action: "PROCESSOR_AGREEMENT_ENDED",
          targetKind: "processorAgreement",
          targetId: seeded?.id ?? "",
        },
        select: { channel: true, actorPersonId: true },
      });
      expect(ended).toEqual([{ channel: "SYSTEM", actorPersonId: null }]);
    });

    it("leaves a row the board recorded open, whatever the driver", async () => {
      const response = await classify("storage", {
        classification: "PROCESSOR",
        status: "PENDING",
        counterparty: "Lagringsleverantoren AB",
      });
      expect(response.statusCode).toBe(200);
      const agreementId =
        response.json<ProcessorView>().agreement?.agreementId ?? "";

      await seedWith("s3");
      await seedWith("local");

      // Neither closed nor joined by a seeded row beside it.
      expect(await openStorageRows()).toEqual([
        { id: agreementId, recordedByPersonId: board.personId },
      ]);
    });

    it("leaves one open row when two starts seed at once", async () => {
      /*
       * Both seeds are held behind the recipient's key until both are queued
       * on it, so they meet at the read rather than one finishing before the
       * other begins. A seed reading outside the lock never queues, and this
       * fails at the wait instead of passing by timing.
       */
      const key = "processor-agreement:storage";
      let releaseHolder: (() => void) | undefined;
      const holderDone = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
          await holderDone;
        },
        { timeout: 60_000, maxWait: 20_000 },
      );

      try {
        await waitFor(
          async () => (await advisoryLockCount(prisma, key, true)) > 0n,
        );

        const seeding = Promise.all([seedWith("local"), seedWith("local")]);
        await waitFor(
          async () => (await advisoryLockCount(prisma, key, false)) >= 2n,
        );

        releaseHolder?.();
        await holder;
        await seeding;

        expect(await openStorageRows()).toHaveLength(1);
      } finally {
        releaseHolder?.();
        await holder.catch(() => undefined);
      }
    }, 60_000);
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

  it("moves the page's revision, so a board member's open editor is refused", async () => {
    /*
     * This is the only writer to a page outside the page service, and the page
     * editor claims on the revision it read. A writer that changed the content
     * and left the number alone would let a board member's stale save match
     * afterwards - and that save carries the whole page, so it would silently
     * delete the art. 13 headings appended here.
     */
    // Seeded by the first case in this block. Thrown rather than skipped when
    // it is not there, so this case cannot pass by testing nothing.
    const page = await prisma.page.findUniqueOrThrow({
      where: { slug: PRIVACY_NOTICE_SLUG },
      select: { id: true, content: true, revision: true },
    });
    const original = page.content;

    await prisma.page.update({
      where: { id: page.id },
      data: {
        content: {
          version: 1,
          blocks: [
            { type: "paragraph", runs: [{ text: "Styrelsens egen ingress." }] },
          ],
        },
      },
    });

    try {
      const before = await prisma.page.findUniqueOrThrow({
        where: { id: page.id },
        select: { revision: true },
      });

      const appended = await inject({
        method: "POST",
        url: "/api/data-protection/privacy-notice/headings",
        headers: { cookie: boardCookie },
      });
      expect(appended.statusCode).toBe(200);

      const after = await prisma.page.findUniqueOrThrow({
        where: { id: page.id },
        select: { revision: true },
      });
      expect(after.revision).toBeGreaterThan(before.revision);

      // And the editor's own save, built on what it read before the append, is
      // refused rather than applied.
      const stale = await inject({
        method: "PUT",
        url: `/api/site/pages/${page.id}`,
        headers: { cookie: boardCookie },
        payload: {
          slug: PRIVACY_NOTICE_SLUG,
          title: "Integritetspolicy",
          content: {
            blocks: [
              {
                type: "paragraph",
                runs: [{ text: "Styrelsens egen ingress." }],
              },
            ],
          },
          expectedRevision: before.revision,
        },
      });
      expect(stale.statusCode).toBe(409);
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
    const owed = await prisma.personalDataBreach.count({
      where: {
        decidedAt: { not: null },
        closedAt: null,
        imyNotificationRequired: true,
        imyNotifiedAt: null,
      },
    });
    expect(overview.breaches.awaitingDecision).toBe(undecided);
    expect(overview.breaches.notificationOwed).toBe(owed);
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
    expect(overview.breaches.nearestDecisionDeadline).not.toBeNull();
    // No later than this breach's own bound: it is the nearest or something
    // else is nearer.
    expect(
      new Date(overview.breaches.nearestDecisionDeadline ?? "").getTime(),
    ).toBeLessThanOrEqual(new Date(view.imyNotifyBy).getTime());
  });

  it("keeps the bound of an owed notification apart from the bounds awaiting a decision", async () => {
    /*
     * The strip puts hours beside each count. Taken from one bound shared by
     * both sets, an owed notification an hour old would be shown as the
     * nearest bound on the breaches awaiting a decision.
     */
    const view = await recorded({ discoveredAt: discoveredHoursAgo(71) });
    const decided = await decide(view.breachId, {});
    expect(decided.statusCode).toBe(200);

    const response = await inject({
      method: "GET",
      url: "/api/data-protection/overview",
      headers: { cookie: boardCookie },
    });
    const overview = response.json<DataProtectionOverview>();
    const bound = new Date(view.imyNotifyBy).getTime();

    // Discovered 71 hours ago: nothing else in this file is nearer.
    expect(overview.breaches.nearestNotificationDeadline).toBe(
      new Date(bound).toISOString(),
    );
    const decision = overview.breaches.nearestDecisionDeadline;
    expect(decision === null || new Date(decision).getTime() > bound).toBe(
      true,
    );
  });

  it("counts a breach decided with IMY still owed, and as overdue past the bound", async () => {
    async function read(): Promise<DataProtectionOverview> {
      const response = await inject({
        method: "GET",
        url: "/api/data-protection/overview",
        headers: { cookie: boardCookie },
      });
      expect(response.statusCode).toBe(200);
      return response.json<DataProtectionOverview>();
    }

    const view = await recorded({ discoveredAt: discoveredHoursAgo(80) });
    await decide(view.breachId, { imyNotificationRequired: true });
    const before = await read();

    const notified = await inject({
      method: "PUT",
      url: `/api/data-protection/breaches/${view.breachId}`,
      payload: {
        imyNotifiedAt: new Date().toISOString(),
        delayReasons: "Styrelsen kunde inte sammantrada forran nu.",
      },
      headers: { cookie: boardCookie },
    });
    expect(notified.statusCode).toBe(200);
    const after = await read();

    /*
     * Differences rather than absolute counts: other cases in this file leave
     * breaches of their own behind. Recording the notification is what takes
     * this one off both counts - the decision alone did not.
     */
    expect(
      before.breaches.notificationOwed - after.breaches.notificationOwed,
    ).toBe(1);
    expect(before.breaches.overdue - after.breaches.overdue).toBe(1);
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
