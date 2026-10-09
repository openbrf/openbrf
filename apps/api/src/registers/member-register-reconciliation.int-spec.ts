import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import {
  MemberRegisterReconciliationService,
  RECONCILIATION_NOTE,
} from "./member-register-reconciliation";
import { MemberRegisterService } from "./member-register.service";

/**
 * Checking registers written before moves were recorded by date.
 *
 * Each person here is seeded with residencies and a register in a shape the old
 * code could leave behind, straight into the tables: the run under test is the
 * repair for registers no current code path writes.
 */

loadEnvForIntegrationTests();

let prisma: PrismaService;
let reconciliation: MemberRegisterReconciliationService;
let memberRegister: MemberRegisterService;
let close: () => Promise<void>;

const suffix = runSuffix();
const addressId = `mrr-address-${suffix}`;
const apartmentA = `mrr-apartment-a-${suffix}`;
const apartmentB = `mrr-apartment-b-${suffix}`;

/** Imported A [2010, 2015) before B [2012, -): an EXIT in 2015 and no ENTRY for B. */
const misordered = `mrr-misordered-${suffix}`;
/** A register that already agrees with the residencies. */
const agreeing = `mrr-agreeing-${suffix}`;
/** A register row from before any residency on record. */
const historic = `mrr-historic-${suffix}`;
const personIds = [misordered, agreeing, historic];

const day = (text: string) => new Date(`${text}T00:00:00.000Z`);

async function registerOf(personId: string) {
  return (
    await prisma.memberRegisterEntry.findMany({
      where: { personId },
      orderBy: [{ eventOn: "asc" }, { createdAt: "asc" }],
      select: {
        eventType: true,
        eventOn: true,
        apartmentId: true,
        note: true,
      },
    })
  ).map((row) => ({
    eventType: row.eventType,
    eventOn: row.eventOn.toISOString().slice(0, 10),
    apartmentId: row.apartmentId,
    note: row.note,
  }));
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  close = () => app.close();
  prisma = app.get(PrismaService);
  reconciliation = app.get(MemberRegisterReconciliationService);
  memberRegister = app.get(MemberRegisterService);

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Rattelsegatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
      sortOrder: 940,
    },
  });
  await prisma.apartment.createMany({
    data: [
      { id: apartmentA, addressId, number: "1101", floor: 1 },
      { id: apartmentB, addressId, number: "1102", floor: 1 },
    ],
  });
  for (const [personId, firstName] of [
    [misordered, "Mira"],
    [agreeing, "Alva"],
    [historic, "Hugo"],
  ] as const) {
    await prisma.person.create({
      data: { id: personId, firstName, lastName: `Rattelse${suffix}` },
    });
  }

  await prisma.residency.createMany({
    data: [
      {
        personId: misordered,
        apartmentId: apartmentA,
        role: "MEMBER",
        movedInOn: day("2010-01-01"),
        movedOutOn: day("2015-01-01"),
      },
      {
        personId: misordered,
        apartmentId: apartmentB,
        role: "MEMBER",
        movedInOn: day("2012-01-01"),
      },
      {
        personId: agreeing,
        apartmentId: apartmentA,
        role: "MEMBER",
        movedInOn: day("2016-01-01"),
      },
      {
        personId: historic,
        apartmentId: apartmentB,
        role: "MEMBER",
        movedInOn: day("2010-01-01"),
      },
    ],
  });
  const recorded = (personId: string) => ({
    personId,
    recordedFirstName: "Seed",
    recordedLastName: `Rattelse${suffix}`,
  });
  await prisma.memberRegisterEntry.createMany({
    data: [
      // B's row was read first and found A still open in 2012, so wrote
      // nothing; A's move-out then found no other residency open and wrote
      // the EXIT.
      {
        ...recorded(misordered),
        apartmentId: apartmentA,
        eventType: "ENTRY",
        eventOn: day("2010-01-01"),
        createdAt: day("2020-01-01"),
      },
      {
        ...recorded(misordered),
        apartmentId: apartmentA,
        eventType: "EXIT",
        eventOn: day("2015-01-01"),
        createdAt: day("2020-01-02"),
      },
      {
        ...recorded(agreeing),
        apartmentId: apartmentA,
        eventType: "ENTRY",
        eventOn: day("2016-01-01"),
      },
      // A membership from before any residency the register holds, then the
      // one the residencies speak for.
      {
        ...recorded(historic),
        apartmentId: apartmentB,
        eventType: "ENTRY",
        eventOn: day("2001-01-01"),
        createdAt: day("2020-01-01"),
      },
      {
        ...recorded(historic),
        apartmentId: apartmentB,
        eventType: "EXIT",
        eventOn: day("2004-01-01"),
        createdAt: day("2020-01-02"),
      },
      {
        ...recorded(historic),
        apartmentId: apartmentB,
        eventType: "ENTRY",
        eventOn: day("2010-01-01"),
        createdAt: day("2020-01-03"),
      },
    ],
  });
}, 120_000);

afterAll(async () => {
  // Register rows, persons and apartments stay: the archive is append-only.
  await prisma.residency.deleteMany({ where: { personId: { in: personIds } } });
  await close();
});

describe("checking the member register against the residencies", () => {
  it("reports the disagreement on a dry run and writes nothing", async () => {
    const before = await registerOf(misordered);

    const report = await reconciliation.reconcile({ apply: false, personIds });

    expect(report.applied).toBe(false);
    expect(report.checked).toBe(3);
    expect(report.disagreements).toEqual([
      {
        personId: misordered,
        owed: [
          {
            eventType: "ENTRY",
            eventOn: day("2015-01-01"),
            apartmentId: apartmentB,
          },
        ],
        unverifiableRows: 0,
      },
    ]);
    // History the residencies cannot speak for is named, never changed.
    expect(report.unverifiable).toEqual([{ personId: historic, rows: 2 }]);
    expect(await registerOf(misordered)).toEqual(before);
  });

  it("appends the missing row on apply, and only that row", async () => {
    const report = await reconciliation.reconcile({ apply: true, personIds });

    expect(report.disagreements.map((person) => person.personId)).toEqual([
      misordered,
    ]);
    expect(await registerOf(misordered)).toEqual([
      {
        eventType: "ENTRY",
        eventOn: "2010-01-01",
        apartmentId: apartmentA,
        note: null,
      },
      {
        eventType: "EXIT",
        eventOn: "2015-01-01",
        apartmentId: apartmentA,
        note: null,
      },
      {
        eventType: "ENTRY",
        eventOn: "2015-01-01",
        apartmentId: apartmentB,
        note: RECONCILIATION_NOTE,
      },
    ]);
    expect(await registerOf(agreeing)).toHaveLength(1);
    expect(await registerOf(historic)).toHaveLength(3);

    // The register now reads as a member today, which is what B says.
    const extract = await memberRegister.extract({
      actorPersonId: agreeing,
      scope: "current",
    });
    expect(extract.rows.map((row) => row.personId)).toContain(misordered);
  });

  it("writes nothing on a second apply", async () => {
    const before = await prisma.memberRegisterEntry.count({
      where: { personId: { in: personIds } },
    });

    const report = await reconciliation.reconcile({ apply: true, personIds });

    expect(report.disagreements).toEqual([]);
    expect(
      await prisma.memberRegisterEntry.count({
        where: { personId: { in: personIds } },
      }),
    ).toBe(before);
  });

  it("waits for a move holding the person's residency lock", async () => {
    // A move for this person, in flight: it holds the lock every move and
    // import takes before it reads the residencies it writes rows from.
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`residency:${agreeing}`}))`;
        await released;
      },
      { timeout: 30_000 },
    );
    await waitFor(
      async () =>
        (await advisoryLockCount(prisma, `residency:${agreeing}`, true)) > 0n,
    );

    const running = reconciliation.reconcile({
      apply: true,
      personIds: [agreeing],
    });
    await waitFor(
      async () =>
        (await advisoryLockCount(prisma, `residency:${agreeing}`, false)) > 0n,
    );

    release();
    await holding;
    expect((await running).checked).toBe(1);
  });
});
