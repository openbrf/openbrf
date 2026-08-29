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
import {
  loadEnvForIntegrationTests,
  runIdentityNumber,
  runPhone,
  runSuffix,
} from "../testing/integration-env";
import { LegalHoldService } from "./legal-hold.service";
import { computePurgeDate } from "./purge-date";
import { PurgeService } from "./purge.service";

/**
 * The service-tier purge against a real database.
 *
 * The job is a promise about time - "your data is erased a year after you move
 * out" - and time is the one thing a suite cannot wait for. So the clock is
 * driven rather than awaited: every person here moved out on a fixed date in
 * 2015, and each test hands the service the instant it is to judge eligibility
 * at. Nothing sleeps, and nothing depends on when the suite is run.
 *
 * That fixed date also bounds the blast radius. `run` erases everybody who is
 * eligible, and the database is shared with the other integration suites; a
 * clock set to just after a 2015 move-out selects this suite's people and
 * nobody else's, because no other suite moves anyone out that long ago.
 *
 * What is pinned here is what the two-tier model means in practice: the service
 * tier goes, the statutory archive does not, and the archive is not merely
 * excluded from the query - it is never written to, because the database would
 * refuse and the code must not be built on believing otherwise.
 */

const env = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let purge: PurgeService;
let holds: LegalHoldService;
let encryption: FieldEncryptionService;
/** The association's own settings, read rather than set: they are shared. */
let retentionDays: number;
let defaultLocale: string;
/** A language that is not the association's, so the reset has something to do. */
let statedLocale: string;

const DAY = 24 * 60 * 60 * 1000;
const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

/**
 * The day every person in this suite left, chosen far enough back that an
 * instant just past their purge date is still in the past for everybody else
 * in the database.
 */
const MOVED_OUT = new Date("2015-03-01T00:00:00.000Z");
const MOVED_IN = new Date("2010-01-01T00:00:00.000Z");

/** The moment the retention policy has run out on that move-out, and before. */
let dueAt: Date;
let notDueAt: Date;

// Both per run, because both carry a blind index that normalizes every
// spelling to one value - so a literal here is the answer to a lookup that was
// about somebody else. This suite leaves its archived person behind on purpose,
// so a literal would accumulate one such row per run.
const PHONE = runPhone(suffix);
const IDENTITY_NUMBER = runIdentityNumber(suffix);

const addressId = `purge-address-${suffix}`;

function apartmentId(name: string): string {
  return `purge-apartment-${name}-${suffix}`;
}

const people = {
  /** Nothing keeping them: the ordinary case the job exists for. */
  due: `purge-due-${suffix}`,
  /** Same, judged before the policy has run out. */
  early: `purge-early-${suffix}`,
  /** Under a legal hold. */
  held: `purge-held-${suffix}`,
  /** Held when the scan ran, so the second check is what refuses. */
  raced: `purge-raced-${suffix}`,
  /** Elected to the board and still sitting on it. */
  board: `purge-board-${suffix}`,
  /** An administrator who moved away but still administers the instance. */
  administrator: `purge-admin-${suffix}`,
  /** Moved out of one apartment and still lives in another. */
  staying: `purge-staying-${suffix}`,
  /** Carries statutory register rows and an audit trail. */
  archived: `purge-archived-${suffix}`,
  /** Has an account, a session and an invitation that was never accepted. */
  accounted: `purge-accounted-${suffix}`,
  /** Purged twice, to prove the second run writes nothing. */
  twice: `purge-twice-${suffix}`,
  /** Reached through run() rather than through purgePerson(). */
  swept: `purge-swept-${suffix}`,
} as const;

const personIds = Object.values(people);

/** A person with contact details, an identity number and a locale to lose. */
async function seedPerson(
  personId: string,
  input: { firstName: string; locale?: string },
): Promise<void> {
  const email = await encryption.encrypt(
    "person.email",
    `${personId}@exempel.se`,
  );
  const phone = await encryption.encrypt("person.phone", PHONE);

  await prisma.person.create({
    data: {
      id: personId,
      firstName: input.firstName,
      lastName: `Gallring${suffix}`,
      postalStreet: "Storgatan 1",
      postalCode: "11122",
      postalCity: "Stockholm",
      emailCipher: email.cipher,
      emailIndex: email.index,
      phoneCipher: phone.cipher,
      phoneIndex: phone.index,
      preferredLocale: input.locale ?? "sv",
    },
  });
}

async function moveOut(
  personId: string,
  apartment: string,
  movedOutOn: Date | null = MOVED_OUT,
): Promise<void> {
  await prisma.residency.create({
    data: {
      personId,
      apartmentId: apartment,
      role: "MEMBER",
      movedInOn: MOVED_IN,
      movedOutOn,
    },
  });
}

async function personRow(personId: string) {
  return prisma.person.findUniqueOrThrow({
    where: { id: personId },
    select: {
      firstName: true,
      lastName: true,
      postalStreet: true,
      postalCode: true,
      postalCity: true,
      emailCipher: true,
      emailIndex: true,
      phoneCipher: true,
      phoneIndex: true,
      personalIdentityNumberCipher: true,
      preferredLocale: true,
    },
  });
}

async function purgeEntriesFor(personId: string) {
  return prisma.auditLogEntry.findMany({
    where: { action: "SERVICE_DATA_PURGED", targetPersonId: personId },
    orderBy: [{ createdAt: "asc" }],
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
  purge = app.get(PurgeService);
  holds = app.get(LegalHoldService);
  encryption = app.get(FieldEncryptionService);

  const association = await prisma.association.findUnique({
    where: { id: 1 },
    select: { retentionDaysAfterMoveOut: true, defaultLocale: true },
  });
  retentionDays = association?.retentionDaysAfterMoveOut ?? 365;
  defaultLocale = association?.defaultLocale ?? "sv";
  statedLocale = defaultLocale === "en" ? "sv" : "en";
  dueAt = new Date(MOVED_OUT.getTime() + (retentionDays + 1) * DAY);
  notDueAt = new Date(MOVED_OUT.getTime() + (retentionDays - 1) * DAY);

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Gallringsgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: {
        create: [
          ...personIds.map((personId, index) => ({
            id: apartmentId(String(index)),
            number: String(1001 + index),
            floor: 0,
          })),
          // The apartment the staying resident did not leave.
          { id: apartmentId("second-home"), number: "2001", floor: 1 },
        ],
      },
    },
  });

  for (const [index, personId] of personIds.entries()) {
    await seedPerson(personId, {
      firstName: "Person",
      // One of them states a language preference other than the association's,
      // so the reset to the association's own default has something to do.
      locale: personId === people.due ? statedLocale : defaultLocale,
    });
    await moveOut(personId, apartmentId(String(index)));
  }

  // The identity number is apartment register content, not service data. Put
  // one on file so the purge can be shown not to reach it.
  const identityNumber = await encryption.encrypt(
    "person.personalIdentityNumber",
    IDENTITY_NUMBER,
  );
  await prisma.person.update({
    where: { id: people.archived },
    data: {
      personalIdentityNumberCipher: identityNumber.cipher,
      personalIdentityNumberIndex: identityNumber.index,
    },
  });

  await prisma.boardPosition.create({
    data: {
      personId: people.board,
      position: "BOARD_MEMBER",
      electedOn: new Date("2014-01-01T00:00:00.000Z"),
      endedOn: null,
    },
  });
  await prisma.systemRole.create({
    data: { personId: people.administrator, role: "ADMIN" },
  });
  await prisma.residency.create({
    data: {
      personId: people.staying,
      apartmentId: apartmentId("second-home"),
      role: "RESIDENT",
      movedInOn: MOVED_IN,
      movedOutOn: null,
    },
  });

  await holds.place({
    personId: people.held,
    reason: "Tvist om andrahandsuthyrning",
    actorPersonId: people.board,
  });

  // The statutory archive this suite must be able to show is untouched: an
  // entry and an exit in the member register, and the transfer that granted
  // the tenant-ownership.
  await prisma.memberRegisterEntry.createMany({
    data: [
      {
        personId: people.archived,
        apartmentId: apartmentId(String(personIds.indexOf(people.archived))),
        eventType: "ENTRY",
        eventOn: MOVED_IN,
        recordedFirstName: "Person",
        recordedLastName: `Gallring${suffix}`,
        recordedPostalStreet: "Storgatan 1",
        recordedPostalCode: "11122",
        recordedPostalCity: "Stockholm",
      },
      {
        personId: people.archived,
        apartmentId: apartmentId(String(personIds.indexOf(people.archived))),
        eventType: "EXIT",
        eventOn: MOVED_OUT,
        recordedFirstName: "Person",
        recordedLastName: `Gallring${suffix}`,
        recordedPostalStreet: "Storgatan 1",
        recordedPostalCode: "11122",
        recordedPostalCity: "Stockholm",
      },
    ],
  });
  await prisma.transfer.create({
    data: {
      apartmentId: apartmentId(String(personIds.indexOf(people.archived))),
      toPersonId: people.archived,
      transferredOn: MOVED_IN,
      agreementReference: `OVL-2010-${suffix}`,
    },
  });

  const auth = app.get(AuthService);
  await auth.createAccountForPerson({
    personId: people.accounted,
    email: `${people.accounted}@exempel.se`,
    name: "Person Gallring",
    password: PASSWORD,
  });
  await prisma.invitation.createMany({
    data: [
      {
        personId: people.accounted,
        tokenHash: `purge-open-${suffix}`,
        expiresAt: new Date(Date.now() + DAY),
      },
      {
        personId: people.accounted,
        tokenHash: `purge-accepted-${suffix}`,
        expiresAt: new Date(Date.now() + DAY),
        acceptedAt: new Date("2015-01-01T00:00:00.000Z"),
      },
    ],
  });
}, 180_000);

/**
 * Runs every cleanup step, then reports whichever of them failed.
 *
 * One step must not be able to stop the next: this database is shared with the
 * other integration suites, so a row this one leaves behind turns up later as a
 * stranger in a suite that scans the person table.
 */
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
      "The purge suite could not clean up after itself.",
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
          prisma.invitation.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.legalHold.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.boardPosition.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.systemRole.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.residency.deleteMany({
            where: { personId: { in: personIds } },
          }),
        /*
         * Everyone but the archived person, whose member register entries and
         * transfer keep both them and their apartment: the archive is
         * append-only by design, and the rows that reference them cannot be
         * removed to make room. Audit entries stay for the same reason.
         */
        () =>
          prisma.person.deleteMany({
            where: {
              id: { in: personIds.filter((id) => id !== people.archived) },
            },
          }),
        /*
         * The apartments too, once no residency points at them. Only the
         * archived person's is held by anything - their member register
         * entries and their transfer - so the rest would otherwise be left as
         * strangers in the shared apartment table, one set per run. The
         * address stays with the apartment that stays, which is what its
         * foreign key requires.
         */
        () =>
          prisma.apartment.deleteMany({
            where: {
              addressId,
              NOT: {
                id: apartmentId(String(personIds.indexOf(people.archived))),
              },
            },
          }),
      ]);
    }
  } finally {
    await app?.close();
  }
});

describe("what the purge erases", () => {
  it("clears the contact details and the stated language of somebody past their purge date", async () => {
    const before = await personRow(people.due);
    expect(before.emailCipher).not.toBeNull();

    const outcome = await purge.purgePerson(people.due, dueAt);

    expect(outcome).not.toBeNull();
    expect(outcome?.cleared).toEqual(
      expect.arrayContaining(["email", "phone", "preferredLocale"]),
    );

    const after = await personRow(people.due);
    expect(after.emailCipher).toBeNull();
    // The blind index goes with the cipher. An index left behind would still
    // answer "is this address in the register" for anyone who could guess it.
    expect(after.emailIndex).toBeNull();
    expect(after.phoneCipher).toBeNull();
    expect(after.phoneIndex).toBeNull();
    // Back to the association's own default rather than to nothing: the column
    // is not nullable, and it is the stated preference that is personal data.
    expect(after.preferredLocale).toBe(defaultLocale);
  });

  it("keeps the name and the postal address, which are member register content", async () => {
    const after = await personRow(people.due);

    // The register is public on request. One that lost its members' names
    // would not be a register, which is why the purge is a service-tier act
    // and not a deletion of the person.
    expect(after.firstName).toBe("Person");
    expect(after.lastName).toBe(`Gallring${suffix}`);
    expect(after.postalStreet).toBe("Storgatan 1");
    expect(after.postalCity).toBe("Stockholm");
  });

  it("leaves the person row, so somebody who moves back in is the same person", async () => {
    // The UI reads the absent contact data as "not recorded" rather than as a
    // missing person, which is only true because the row survives.
    await expect(
      prisma.person.findUnique({ where: { id: people.due } }),
    ).resolves.not.toBeNull();
  });

  it("deletes the account and every invitation still open", async () => {
    const outcome = await purge.purgePerson(people.accounted, dueAt);

    expect(outcome?.accountDeleted).toBe(true);
    expect(outcome?.invitationsDeleted).toBe(1);

    await expect(
      prisma.user.count({ where: { personId: people.accounted } }),
    ).resolves.toBe(0);
    // The sessions and credentials go with the account, by the cascades on it.
    await expect(
      prisma.session.count({ where: { user: { personId: people.accounted } } }),
    ).resolves.toBe(0);
    await expect(
      prisma.invitation.count({
        where: { personId: people.accounted, acceptedAt: null },
      }),
    ).resolves.toBe(0);
    // An accepted invitation is a spent record of an activation rather than a
    // live way in, so it is left where it is.
    await expect(
      prisma.invitation.count({
        where: { personId: people.accounted, NOT: { acceptedAt: null } },
      }),
    ).resolves.toBe(1);
  });

  it("records the purge naming what was cleared and none of the values", async () => {
    const [entry, ...rest] = await purgeEntriesFor(people.due);

    expect(entry).toBeDefined();
    expect(rest).toHaveLength(0);
    // Nobody clicked this: the job ran because a date arrived.
    expect(entry?.actorPersonId).toBeNull();
    expect(entry?.context).toMatchObject({
      cleared: expect.arrayContaining(["email", "phone"]),
      retentionDaysAfterMoveOut: retentionDays,
      lastMovedOutOn: "2015-03-01",
    });

    // The entry outlives the data it describes, so a value copied into it
    // would be the one copy the purge did not reach.
    const written = JSON.stringify(entry?.context);
    expect(written).not.toContain("@exempel.se");
    expect(written).not.toContain(PHONE);
  });

  it("states the purge date the register had been promising", async () => {
    const [entry] = await purgeEntriesFor(people.due);
    const promised = computePurgeDate(MOVED_OUT, retentionDays);

    expect(entry?.context).toMatchObject({
      purgeOn: promised?.toISOString().slice(0, 10),
    });
  });
});

describe("what the purge never touches", () => {
  it("leaves the member register, the transfer and the audit log alone", async () => {
    const before = {
      entries: await prisma.memberRegisterEntry.count({
        where: { personId: people.archived },
      }),
      transfers: await prisma.transfer.count({
        where: { toPersonId: people.archived },
      }),
    };
    expect(before.entries).toBe(2);
    expect(before.transfers).toBe(1);

    const outcome = await purge.purgePerson(people.archived, dueAt);
    expect(outcome).not.toBeNull();

    // Not "the query excluded them": these tables are append-only at the
    // database level, so an attempt would have raised rather than erased.
    await expect(
      prisma.memberRegisterEntry.count({
        where: { personId: people.archived },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.transfer.count({ where: { toPersonId: people.archived } }),
    ).resolves.toBe(1);

    const entry = await prisma.memberRegisterEntry.findFirstOrThrow({
      where: { personId: people.archived, eventType: "EXIT" },
    });
    expect(entry.recordedLastName).toBe(`Gallring${suffix}`);
    expect(entry.recordedPostalStreet).toBe("Storgatan 1");
  });

  it("leaves the personal identity number, which is apartment register content", async () => {
    const after = await personRow(people.archived);

    // Confidential register content under BRL 9 kap., not service data: it is
    // masked from every screen and reachable only through the audited reveal,
    // and the retention policy does not govern it.
    expect(after.personalIdentityNumberCipher).not.toBeNull();
    expect(after.emailCipher).toBeNull();
  });
});

describe("who the purge leaves alone", () => {
  it("leaves somebody whose retention has not run out", async () => {
    await expect(
      purge.eligible(notDueAt, retentionDays),
    ).resolves.not.toContain(people.early);

    await expect(purge.purgePerson(people.early, notDueAt)).resolves.toBeNull();

    const after = await personRow(people.early);
    expect(after.emailCipher).not.toBeNull();

    // And nothing at all at an instant before the move-out itself, which is
    // the same rule read from its other end.
    const beforeTheMoveOut = new Date(MOVED_OUT.getTime() - DAY);
    await expect(
      purge.eligible(beforeTheMoveOut, retentionDays),
    ).resolves.not.toContain(people.early);
  });

  it("leaves somebody under a legal hold, and reaches them once it is released", async () => {
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.held,
    );
    await expect(purge.purgePerson(people.held, dueAt)).resolves.toBeNull();
    expect((await personRow(people.held)).emailCipher).not.toBeNull();

    await holds.release({
      personId: people.held,
      reason: "Tvisten avgjord",
      actorPersonId: people.board,
    });

    // Releasing does not erase: it makes the person eligible again, and the
    // job acts on that in its own time.
    await expect(purge.eligible(dueAt, retentionDays)).resolves.toContain(
      people.held,
    );
    await expect(purge.purgePerson(people.held, dueAt)).resolves.not.toBeNull();
    expect((await personRow(people.held)).emailCipher).toBeNull();
  });

  it("refuses a person held after the scan selected them", async () => {
    const scanned = await purge.eligible(dueAt, retentionDays);
    expect(scanned).toContain(people.raced);

    // Between the scan and the erasure, which is the window a board member
    // clicking the button falls into.
    await holds.place({
      personId: people.raced,
      reason: "Forsakringsarende",
      actorPersonId: people.board,
    });

    await expect(purge.purgePerson(people.raced, dueAt)).resolves.toBeNull();
    expect((await personRow(people.raced)).emailCipher).not.toBeNull();
  });

  it("leaves somebody who still sits on the board", async () => {
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.board,
    );
    await expect(purge.purgePerson(people.board, dueAt)).resolves.toBeNull();
    expect((await personRow(people.board)).emailCipher).not.toBeNull();
  });

  it("leaves an administrator, whose account is not a residency", async () => {
    // Erasing the account of the only administrator because they moved away
    // is a lockout rather than a purge.
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.administrator,
    );
    await expect(
      purge.purgePerson(people.administrator, dueAt),
    ).resolves.toBeNull();
  });

  it("leaves somebody who moved out of one apartment and lives in another", async () => {
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.staying,
    );
    await expect(purge.purgePerson(people.staying, dueAt)).resolves.toBeNull();
    expect((await personRow(people.staying)).emailCipher).not.toBeNull();
  });
});

describe("running the job", () => {
  it("is idempotent: a second run writes no second entry", async () => {
    const first = await purge.purgePerson(people.twice, dueAt);
    expect(first).not.toBeNull();

    // Nothing left to erase, so the eligibility query does not select them
    // again - which is what stops a purged person collecting an entry a night
    // for ever in a table nobody can tidy.
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.twice,
    );
    await expect(purge.purgePerson(people.twice, dueAt)).resolves.toBeNull();

    await expect(purgeEntriesFor(people.twice)).resolves.toHaveLength(1);
  });

  it("erases everybody eligible and reports what it did", async () => {
    const summary = await purge.run(dueAt);

    expect(summary.considered).toBeGreaterThanOrEqual(1);
    expect(summary.purged).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBe(0);

    expect((await personRow(people.swept)).emailCipher).toBeNull();
    // The people the rules protect are still untouched after a full run.
    expect((await personRow(people.board)).emailCipher).not.toBeNull();
    expect((await personRow(people.staying)).emailCipher).not.toBeNull();
    expect((await personRow(people.raced)).emailCipher).not.toBeNull();
  });
});

describe("the environment the worker runs in", () => {
  it("registers no worker under test, so nothing races a suite", () => {
    // onModuleInit returns early when NODE_ENV is "test": the suites drive the
    // job with a clock of their own, and a real worker waking mid-suite would
    // erase rows a test was about to assert on.
    expect(env.NODE_ENV).toBe("test");
  });
});
