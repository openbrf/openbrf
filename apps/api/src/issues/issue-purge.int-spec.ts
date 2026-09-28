import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { ENV } from "../config/config.module";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { IssuePurgeService } from "./issue-purge.service";
import { ISSUE_RETENTION_DAYS } from "./issue-retention";
import { IssueService } from "./issue.service";

/**
 * The retention clock on a report filed through the public form.
 *
 * Three properties can only be shown against a real database, and each is a
 * promise rather than a convenience.
 *
 * The clock is wound by the board closing the issue, over HTTP, through the
 * queue screen's own route. `closedAt` is a column the purge reads and nothing
 * else writes, so a status change that forgot to set it would leave every
 * public-form report keeping its reporter's name for ever - and no unit test of
 * the arithmetic would notice, because the arithmetic would be right.
 *
 * The purge detaches the reporter and keeps the report. What the association
 * loses is the ability to write back to somebody about a fault it dealt with a
 * year ago; what it keeps is its own record of a problem with its building.
 *
 * And it reaches only what is its. A report still open, one closed last week,
 * and one filed by a resident with an account are all left exactly as they
 * were - the last of those because it belongs to the residency purge, which
 * erases it on that person's clock.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let issues: IssueService;
let purge: IssuePurgeService;
let encryption: FieldEncryptionService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

const board = {
  personId: `ip-board-${suffix}`,
  email: `ip-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `ip-resident-${suffix}`,
  email: `ip-resident-${suffix}@exempel.se`,
};
/**
 * Somebody in the register who also wrote in through the public form, without
 * signing in. The report is keyed to nobody; the address on it is theirs, which
 * is all a legal hold or a restriction can reach it by.
 */
const withheld = {
  personId: `ip-withheld-${suffix}`,
  email: `ip-withheld-${suffix}@exempel.se`,
};
const personIds = [board.personId, resident.personId, withheld.personId];

const addressId = `ip-address-${suffix}`;
const apartmentId = `ip-apartment-${suffix}`;
const publicTypeId = `ip-type-public-${suffix}`;
const memberTypeId = `ip-type-member-${suffix}`;
const typeIds = [publicTypeId, memberTypeId];

/** The reporter nobody in the register has ever heard of. */
const REPORTER = {
  name: "Nora Grannen",
  email: `ip-reporter-${suffix}@exempel.se`,
};

let boardCookie = "";
let residentCookie = "";
let associationCreatedHere = false;
let previousPublicReporting = true;

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        // 10.63.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.63.${String(subnet)}.${String(host + 1)}`,
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

/** Closes an issue the way the queue screen does: over HTTP, as the board. */
async function close(issueId: string): Promise<void> {
  const response = await inject({
    method: "POST",
    url: `/api/issue-queue/${issueId}/status`,
    headers: { cookie: boardCookie },
    payload: { status: "DONE" },
  });
  expect(response.statusCode).toBe(201);
}

/** Reopens one, the same way. */
async function reopen(issueId: string): Promise<void> {
  const response = await inject({
    method: "POST",
    url: `/api/issue-queue/${issueId}/status`,
    headers: { cookie: boardCookie },
    payload: { status: "IN_PROGRESS" },
  });
  expect(response.statusCode).toBe(201);
}

/** Backdates a closing so the clock can be read without waiting a year. */
async function closedDaysAgo(issueId: string, days: number): Promise<void> {
  await prisma.issue.update({
    where: { id: issueId },
    data: { closedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
  });
}

interface ReporterColumns {
  reporterPersonId: string | null;
  reporterNameCipher: string | null;
  reporterEmailCipher: string | null;
  reporterEmailIndex: string | null;
  description: string;
  closedAt: Date | null;
}

async function read(issueId: string): Promise<ReporterColumns> {
  return prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: {
      reporterPersonId: true,
      reporterNameCipher: true,
      reporterEmailCipher: true,
      reporterEmailIndex: true,
      description: true,
      closedAt: true,
    },
  });
}

/** Files a report through the public form, as the website does: in process. */
async function reportPublicly(
  description: string,
  reporterEmail: string | null = REPORTER.email,
): Promise<string> {
  const { id } = await issues.reportPublicly({
    typeId: publicTypeId,
    description,
    reporterName: REPORTER.name,
    reporterEmail,
  });
  return id;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(baseEnv)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  issues = app.get(IssueService);
  purge = app.get(IssuePurgeService);
  encryption = app.get(FieldEncryptionService);

  const existing = await prisma.association.findUnique({
    where: { id: 1 },
    select: { issueReportingPublic: true },
  });
  associationCreatedHere = existing === null;
  previousPublicReporting = existing?.issueReportingPublic ?? true;
  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet", issueReportingPublic: true },
    update: { issueReportingPublic: true },
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Anmalningsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "0101", floor: 1 },
  });

  for (const person of [
    { ...board, firstName: "Bea", lastName: "Ordforande" },
    { ...resident, firstName: "Rune", lastName: "Boende" },
  ]) {
    const email = await encryption.encrypt("person.email", person.email);
    await prisma.person.create({
      data: {
        id: person.personId,
        firstName: person.firstName,
        lastName: person.lastName,
        emailCipher: email.cipher,
        emailIndex: email.index,
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: person.personId,
      email: person.email,
      name: `${person.firstName} ${person.lastName}`,
      password: PASSWORD,
    });
  }

  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "CHAIR",
      electedOn: new Date("2025-05-15"),
    },
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: board.personId,
        apartmentId,
        role: "MEMBER",
        movedInOn: new Date("2024-01-01"),
      },
      {
        personId: resident.personId,
        apartmentId,
        role: "RESIDENT",
        movedInOn: new Date("2024-01-01"),
      },
    ],
  });

  await prisma.issueType.createMany({
    data: [
      {
        id: publicTypeId,
        name: `Skadegorelse ${suffix}`,
        audience: "NON_MEMBER",
        sortOrder: 1,
      },
      {
        id: memberTypeId,
        name: `Fel i lagenheten ${suffix}`,
        audience: "MEMBER",
        sortOrder: 2,
      },
    ],
  });

  // No account: the register knows this person, and they wrote in anyway.
  const withheldEmail = await encryption.encrypt(
    "person.email",
    withheld.email,
  );
  await prisma.person.create({
    data: {
      id: withheld.personId,
      firstName: "Hedda",
      lastName: "Hallen",
      emailCipher: withheldEmail.cipher,
      emailIndex: withheldEmail.index,
    },
  });

  boardCookie = await signIn(board.email);
  residentCookie = await signIn(resident.email);
}, 180_000);

afterAll(async () => {
  await prisma.issue.deleteMany({ where: { typeId: { in: typeIds } } });
  await prisma.legalHold.deleteMany({ where: { personId: withheld.personId } });
  await prisma.issueType.deleteMany({ where: { id: { in: typeIds } } });
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.residency.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.apartment.deleteMany({ where: { id: apartmentId } });
  await prisma.address.deleteMany({ where: { id: addressId } });

  // Restored rather than left as this suite wanted it: the fixture the other
  // suites share depends on the association row it found.
  if (associationCreatedHere) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  } else {
    await prisma.association.update({
      where: { id: 1 },
      data: { issueReportingPublic: previousPublicReporting },
    });
  }

  await app.close();
});

describe("closing an issue from the queue", () => {
  it("is what starts the clock, and reopening it stops it again", async () => {
    /*
     * The whole reason closedAt is a column of its own. Nothing else writes it,
     * so a status change that forgot to would leave every public-form report
     * keeping its reporter's name for ever, with the retention arithmetic
     * entirely correct about a date that never arrived.
     */
    const issueId = await reportPublicly("Klotter pa portens insida.");
    expect((await read(issueId)).closedAt).toBeNull();

    await close(issueId);
    expect((await read(issueId)).closedAt).not.toBeNull();

    await reopen(issueId);
    expect((await read(issueId)).closedAt).toBeNull();
  });
});

describe("a public-form report a year after it was closed", () => {
  let issueId = "";

  beforeAll(async () => {
    issueId = await reportPublicly("Trasig lampa i cykelrummet.");
    await close(issueId);
    await closedDaysAgo(issueId, ISSUE_RETENTION_DAYS + 1);
  });

  it("keeps its reporter until the purge runs", async () => {
    const before = await read(issueId);

    expect(before.reporterNameCipher).not.toBeNull();
    expect(before.reporterEmailCipher).not.toBeNull();
    expect(before.reporterEmailIndex).not.toBeNull();
  });

  it("loses the reporter and keeps the report", async () => {
    const summary = await purge.run();

    expect(summary.failed).toBe(0);
    expect(summary.purged).toBeGreaterThanOrEqual(1);

    const after = await read(issueId);
    expect(after.reporterNameCipher).toBeNull();
    expect(after.reporterEmailCipher).toBeNull();
    expect(after.reporterEmailIndex).toBeNull();
    // The association's own record of a problem with its building. The person
    // who reported it having gone does not make the broken lamp less real.
    expect(after.description).toBe("Trasig lampa i cykelrummet.");
    expect(after.closedAt).not.toBeNull();
  });

  it("is recorded against the report, because there is no person to name", async () => {
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "issue",
        targetId: issueId,
      },
      select: { actorPersonId: true, targetPersonId: true, context: true },
    });

    expect(entries).toHaveLength(1);
    // Nobody clicked it: the job ran because a date arrived.
    expect(entries[0]?.actorPersonId).toBeNull();
    // And it is about somebody the register has never heard of.
    expect(entries[0]?.targetPersonId).toBeNull();
    expect(entries[0]?.context).toMatchObject({
      retentionDaysAfterClosing: ISSUE_RETENTION_DAYS,
    });
  });

  it("is not written a second time on the next run", async () => {
    /*
     * A report with nothing left to detach is not selected at all. Otherwise
     * every purged report would collect an entry a night for ever, in a table
     * that is append-only and outside every retention policy.
     */
    await purge.run();

    expect(
      await prisma.auditLogEntry.count({
        where: {
          action: "SERVICE_DATA_PURGED",
          targetKind: "issue",
          targetId: issueId,
        },
      }),
    ).toBe(1);
  });
});

describe("what the purge leaves alone", () => {
  it("does not touch a report that is still open, however old", async () => {
    const issueId = await reportPublicly("Aterkommande fukt i garaget.");
    // Reported two years ago and never closed: the association is still working
    // on the problem, and still needs to be able to answer whoever wrote in.
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        createdAt: new Date(
          Date.now() - 2 * ISSUE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ),
      },
    });

    await purge.run();

    expect((await read(issueId)).reporterEmailCipher).not.toBeNull();
  });

  it("does not touch a report closed inside its window", async () => {
    const issueId = await reportPublicly("Porten gar inte igen.");
    await close(issueId);
    await closedDaysAgo(issueId, ISSUE_RETENTION_DAYS - 7);

    await purge.run();

    expect((await read(issueId)).reporterEmailCipher).not.toBeNull();
  });

  it("leaves a resident's own report to the residency purge", async () => {
    /*
     * An issue keyed to a person is erased on that person's clock, by the purge
     * that also releases their address and their bookings. Reaching this row
     * from both ends would be two jobs racing over it.
     */
    const response = await inject({
      method: "POST",
      url: "/api/issues",
      headers: { cookie: residentCookie },
      payload: { typeId: memberTypeId, description: "Droppande kran i koket." },
    });
    expect(response.statusCode).toBe(201);
    const { id: issueId } = JSON.parse(response.body) as { id: string };
    await close(issueId);
    await closedDaysAgo(issueId, ISSUE_RETENTION_DAYS + 1);

    await purge.run();

    const after = await read(issueId);
    expect(after.reporterPersonId).toBe(resident.personId);
  });
});

describe("a report whose address is a withheld person's", () => {
  /** Files a report as the withheld person, closed a year and a day ago. */
  async function agedWithheldReport(description: string): Promise<string> {
    const issueId = await reportPublicly(description, withheld.email);
    await close(issueId);
    await closedDaysAgo(issueId, ISSUE_RETENTION_DAYS + 1);
    return issueId;
  }

  async function purgeEntries(issueId: string): Promise<number> {
    return prisma.auditLogEntry.count({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "issue",
        targetId: issueId,
      },
    });
  }

  async function restrict(restricted: boolean): Promise<void> {
    await prisma.person.update({
      where: { id: withheld.personId },
      data: { processingRestrictedAt: restricted ? new Date() : null },
    });
  }

  /**
   * How many transactions hold, or are queued behind, the legal hold registry
   * key, in this worker's database only: the key is the same string in every
   * worker's, and `pg_locks` shows the whole cluster. `hashtext` gives a signed
   * int4 and the advisory lock space addresses it as two halves of a bigint,
   * which is what the shifting reassembles.
   */
  async function registryLockCount(granted: boolean): Promise<bigint> {
    const key = "legal-hold:registry";
    const [row] = await prisma.$queryRaw<{ locks: bigint }[]>`
      SELECT count(*) AS locks
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND granted = ${granted}
        AND objsubid = 1
        AND classid = ((hashtext(${key})::bigint >> 32) & 4294967295)::oid
        AND objid = (hashtext(${key})::bigint & 4294967295)::oid`;
    return row?.locks ?? 0n;
  }

  /** Polls until the condition holds, or gives up so a failure is a failure. */
  async function waitFor(
    condition: () => Promise<boolean>,
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for the purge to block or finish.");
  }

  it("keeps its reporter while a legal hold stands against that person", async () => {
    const issueId = await agedWithheldReport("Vattenskada i trapphuset.");
    const hold = await prisma.legalHold.create({
      data: {
        personId: withheld.personId,
        reason: `Tvist om vattenskadan ${suffix}`,
        placedByPersonId: board.personId,
      },
    });

    try {
      expect(
        await purge.eligible(new Date(), ISSUE_RETENTION_DAYS),
      ).not.toContain(issueId);
      // Asked directly too, so the check inside the transaction is shown on its
      // own and not only through the scan that skips the report.
      await expect(purge.purgeIssue(issueId)).resolves.toBe(false);
      await purge.run();

      const after = await read(issueId);
      expect(after.reporterNameCipher).not.toBeNull();
      expect(after.reporterEmailCipher).not.toBeNull();
      expect(after.reporterEmailIndex).not.toBeNull();
      expect(await purgeEntries(issueId)).toBe(0);
    } finally {
      await prisma.legalHold.update({
        where: { id: hold.id },
        data: { releasedAt: new Date(), releaseReason: "Avgjord" },
      });
    }

    // Released, the report is back on its window's clock.
    await purge.run();
    expect((await read(issueId)).reporterEmailCipher).toBeNull();
    expect(await purgeEntries(issueId)).toBe(1);
  });

  it("keeps its reporter while a restriction of processing stands, until it is lifted", async () => {
    /*
     * Art. 18(2): under a restriction the association may store the data and
     * little else, so erasing it is the one act the person asked it not to
     * perform.
     */
    const issueId = await agedWithheldReport("Hissen stannar mellan vaningar.");
    // And one from an address no hold or restriction matches, aged the same.
    // The restriction keeps its own person's report and nobody else's: a scan
    // or a check that dropped every address once anybody was withheld would
    // look, from the withheld report alone, exactly like one that works.
    const unrelatedId = await reportPublicly("Taklampa trasig i tvattstugan.");
    await close(unrelatedId);
    await closedDaysAgo(unrelatedId, ISSUE_RETENTION_DAYS + 1);
    await restrict(true);

    try {
      const eligible = await purge.eligible(new Date(), ISSUE_RETENTION_DAYS);
      expect(eligible).not.toContain(issueId);
      expect(eligible).toContain(unrelatedId);
      await expect(purge.purgeIssue(issueId)).resolves.toBe(false);
      await purge.run();

      const after = await read(issueId);
      expect(after.reporterNameCipher).not.toBeNull();
      expect(after.reporterEmailCipher).not.toBeNull();
      expect(after.reporterEmailIndex).not.toBeNull();
      expect(await purgeEntries(issueId)).toBe(0);

      const unrelated = await read(unrelatedId);
      expect(unrelated.reporterNameCipher).toBeNull();
      expect(unrelated.reporterEmailCipher).toBeNull();
      expect(unrelated.reporterEmailIndex).toBeNull();
      expect(await purgeEntries(unrelatedId)).toBe(1);
    } finally {
      await restrict(false);
    }

    await purge.run();
    expect((await read(issueId)).reporterEmailCipher).toBeNull();
    expect(await purgeEntries(issueId)).toBe(1);
  });

  it("is kept by a restriction granted while the run is already in flight", async () => {
    /*
     * The purge cannot name the person a report is from, so it takes the
     * registry key and the grant takes it as well as the person's own. A
     * restriction that committed between the scan and the update would
     * otherwise lose the address it was granted to keep. The wait is read out
     * of `pg_locks` rather than inferred from a delay.
     */
    const issueId = await agedWithheldReport("Sopnedkastet luktar.");

    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holder: Promise<void> | undefined;

    try {
      // Longer than the waits below, so the transaction held open on purpose
      // is not aborted by the five-second default and its lock released early.
      holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legal-hold:${withheld.personId}`}))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"legal-hold:registry"}))`;
          await tx.person.update({
            where: { id: withheld.personId },
            data: { processingRestrictedAt: new Date() },
          });
          await holderDone;
        },
        { timeout: 60_000, maxWait: 20_000 },
      );

      await waitFor(async () => (await registryLockCount(true)) > 0n);

      const running = purge.purgeIssue(issueId);
      await waitFor(async () => (await registryLockCount(false)) > 0n);

      releaseHolder?.();
      await holder;

      // It detached nothing, because by the time it got the key the
      // restriction stood.
      await expect(running).resolves.toBe(false);
      expect((await read(issueId)).reporterEmailCipher).not.toBeNull();
      expect(await purgeEntries(issueId)).toBe(0);
    } finally {
      releaseHolder?.();
      await holder?.catch(() => undefined);
      await restrict(false);
    }
  }, 60_000);

  it("does not keep a report that left no address while a restriction stands", async () => {
    /*
     * A name alone matches nobody, and a report without an address must not be
     * dropped from the scan by the `NOT IN` a withheld address adds to it.
     */
    const issueId = await reportPublicly("Cykel lamnad i entren.", null);
    await close(issueId);
    await closedDaysAgo(issueId, ISSUE_RETENTION_DAYS + 1);
    await restrict(true);

    try {
      expect(await purge.eligible(new Date(), ISSUE_RETENTION_DAYS)).toContain(
        issueId,
      );
      await purge.run();
      expect((await read(issueId)).reporterNameCipher).toBeNull();
    } finally {
      await restrict(false);
    }
  });
});
