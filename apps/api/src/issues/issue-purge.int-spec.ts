import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { ENV } from "../config/config.module";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { createIssueTypeFixture } from "../testing/issue-fixtures";
import { lockIssueForHandling } from "./issue-lock";
import { IssuePurgeService } from "./issue-purge.service";
import { IssueRedactionService } from "./issue-redaction.service";
import {
  CONTRACTOR_RETENTION_DAYS,
  ISSUE_RETENTION_DAYS,
  WORK_ORDER_BODY_RETENTION_DAYS,
} from "./issue-retention";
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

/** The contractors this suite put on the list, removed afterwards. */
const contractorIds: string[] = [];

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

/** The default status of a meaning on the issue's own type. */
async function defaultStatusOf(
  issueId: string,
  meaning: "IN_PROGRESS" | "DONE",
): Promise<string> {
  const issue = await prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { typeId: true },
  });
  const status = await prisma.issueStatus.findFirstOrThrow({
    where: { typeId: issue.typeId, meaning, isDefault: true },
    select: { id: true },
  });
  return status.id;
}

/**
 * Closes an issue the way the queue screen does: over HTTP, as the board,
 * into its type's default DONE status unless another is named.
 */
async function close(issueId: string, statusId?: string): Promise<void> {
  const response = await inject({
    method: "POST",
    url: `/api/issue-queue/${issueId}/status`,
    headers: { cookie: boardCookie },
    payload: {
      statusId: statusId ?? (await defaultStatusOf(issueId, "DONE")),
      outcome: "FIXED",
    },
  });
  expect(response.statusCode).toBe(201);
}

/** Reopens one, the same way. */
async function reopen(issueId: string): Promise<void> {
  const response = await inject({
    method: "POST",
    url: `/api/issue-queue/${issueId}/status`,
    headers: { cookie: boardCookie },
    payload: { statusId: await defaultStatusOf(issueId, "IN_PROGRESS") },
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

  await createIssueTypeFixture(prisma, {
    id: publicTypeId,
    name: `Skadegorelse ${suffix}`,
    reporters: ["PUBLIC"],
    sortOrder: 1,
  });
  await createIssueTypeFixture(prisma, {
    id: memberTypeId,
    name: `Fel i lagenheten ${suffix}`,
    reporters: ["RESIDENTS"],
    sortOrder: 2,
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
  await prisma.contractor.deleteMany({ where: { id: { in: contractorIds } } });
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

describe("a status the board added under done", () => {
  it("closes a report for the purge as the default one does", async () => {
    // The purge reads the meaning, never a status by its label or a literal
    // DONE (ADR 0057): a report closed into the board's own done status would
    // otherwise keep its reporter's contact details for ever.
    const archived = await prisma.issueStatus.create({
      data: {
        typeId: publicTypeId,
        meaning: "DONE",
        label: `Arkiverat ${suffix}`,
        sortOrder: 1,
      },
    });
    const issueId = await reportPublicly("Trasigt staket mot gatan.");
    try {
      await close(issueId, archived.id);
      await closedDaysAgo(issueId, ISSUE_RETENTION_DAYS + 1);

      expect(await purge.eligible(new Date(), ISSUE_RETENTION_DAYS)).toContain(
        issueId,
      );

      // The control: an open report of the same age is not.
      await reopen(issueId);
      expect(
        await purge.eligible(new Date(), ISSUE_RETENTION_DAYS),
      ).not.toContain(issueId);
    } finally {
      await prisma.issue.update({
        where: { id: issueId },
        // Off the status about to be removed, whichever step failed.
        data: {
          statusId: await defaultStatusOf(issueId, "IN_PROGRESS"),
          closedAt: null,
          outcome: null,
        },
      });
      await prisma.issueStatus.delete({ where: { id: archived.id } });
    }
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

describe("the text of a work order", () => {
  /** A work order on the issue, as the sending writes one. */
  /**
   * A work order on the issue, to a contractor still on the list, as a
   * handler's sending writes one.
   */
  async function workOrderOn(issueId: string, body: string): Promise<string> {
    const contractor = await prisma.contractor.create({
      data: { name: `Rormokare ${suffix}`, trade: "Rormokare" },
      select: { id: true },
    });
    contractorIds.push(contractor.id);
    const order = await prisma.workOrder.create({
      data: {
        issueId,
        contractorId: contractor.id,
        recipientName: `Rormokare ${suffix}`,
        recipientEmailCipher: "kept-as-it-was",
        body,
        sentByPersonId: board.personId,
        deliveryStatus: "SENT",
      },
      select: { id: true },
    });
    return order.id;
  }

  async function readOrder(id: string) {
    return prisma.workOrder.findUniqueOrThrow({
      where: { id },
      select: { body: true, recipientName: true, recipientEmailCipher: true },
    });
  }

  /** A resident's own report, closed the given number of days ago. */
  async function residentIssueClosed(
    description: string,
    days: number,
  ): Promise<string> {
    const response = await inject({
      method: "POST",
      url: "/api/issues",
      headers: { cookie: residentCookie },
      payload: { typeId: memberTypeId, description },
    });
    expect(response.statusCode).toBe(201);
    const { id: issueId } = JSON.parse(response.body) as { id: string };
    await close(issueId);
    await closedDaysAgo(issueId, days);
    return issueId;
  }

  it("is erased past its window after the issue closed, and the record of whom it went to stays", async () => {
    // A resident's report as well as the public form's: the text is erased
    // on every issue, because no person-keyed purge ever reads it.
    const issueId = await residentIssueClosed(
      "Stopp i avloppet i tvattstugan.",
      WORK_ORDER_BODY_RETENTION_DAYS + 1,
    );
    const orderId = await workOrderOn(issueId, "Spola avloppet, fragan Eva.");

    const summary = await purge.run();
    expect(summary.workOrderTexts.failed).toBe(0);
    expect(summary.workOrderTexts.purged).toBeGreaterThanOrEqual(1);

    const after = await readOrder(orderId);
    expect(after.body).toBeNull();
    expect(after.recipientName).toBe(`Rormokare ${suffix}`);
    expect(after.recipientEmailCipher).toBe("kept-as-it-was");

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "issue",
        targetId: issueId,
      },
      select: { actorPersonId: true, context: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorPersonId).toBeNull();
    expect(entries[0]?.context).toEqual({
      workOrderTexts: 1,
      retentionDaysAfterClosing: WORK_ORDER_BODY_RETENTION_DAYS,
    });
    expect(JSON.stringify(entries[0]?.context)).not.toContain("Spola");

    // Nothing left to erase, so nothing is selected or written again.
    expect(
      await purge.eligibleWorkOrderTexts(
        new Date(),
        WORK_ORDER_BODY_RETENTION_DAYS,
      ),
    ).not.toContain(issueId);
  });

  it("is kept while the issue is open, however old", async () => {
    const issueId = await reportPublicly("Fukt i kallaren.");
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        createdAt: new Date(
          Date.now() - 2 * WORK_ORDER_BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ),
      },
    });
    const orderId = await workOrderOn(issueId, "Mat fukten i kallaren.");

    await purge.run();

    expect((await readOrder(orderId)).body).toBe("Mat fukten i kallaren.");
  });

  it("is kept on an issue closed inside its window", async () => {
    const issueId = await residentIssueClosed(
      "Glodlampan i trappan ar trasig.",
      WORK_ORDER_BODY_RETENTION_DAYS - 7,
    );
    const orderId = await workOrderOn(issueId, "Byt lampan i trappan.");

    await purge.run();

    expect((await readOrder(orderId)).body).toBe("Byt lampan i trappan.");
  });

  it("is kept on an issue reopened since the scan", async () => {
    const issueId = await residentIssueClosed(
      "Dorren till soprummet gar inte i las.",
      WORK_ORDER_BODY_RETENTION_DAYS + 1,
    );
    const orderId = await workOrderOn(issueId, "Justera stangaren.");
    expect(
      await purge.eligibleWorkOrderTexts(
        new Date(),
        WORK_ORDER_BODY_RETENTION_DAYS,
      ),
    ).toContain(issueId);

    await reopen(issueId);

    // Asked directly, so the closing read inside the transaction is shown.
    await expect(purge.purgeWorkOrderTexts(issueId)).resolves.toBe(false);
    expect((await readOrder(orderId)).body).toBe("Justera stangaren.");
  });

  it("is kept while a legal hold stands on the issue, and erased once it is released", async () => {
    const issueId = await residentIssueClosed(
      "Vattenskada i taket efter stammen.",
      WORK_ORDER_BODY_RETENTION_DAYS + 1,
    );
    const orderId = await workOrderOn(issueId, "Riv ut den vata skivan.");
    expect(
      await purge.eligibleWorkOrderTexts(
        new Date(),
        WORK_ORDER_BODY_RETENTION_DAYS,
      ),
    ).toContain(issueId);

    async function setHold(held: boolean): Promise<void> {
      const response = await inject({
        method: "POST",
        url: `/api/issue-queue/${issueId}/legal-hold`,
        headers: { cookie: boardCookie },
        payload: { held },
      });
      expect(response.statusCode).toBe(201);
    }

    // Placed after the scan above, as a handler's hold may land while a run
    // is in flight: the transaction that erases reads it again.
    await setHold(true);
    await expect(purge.purgeWorkOrderTexts(issueId)).resolves.toBe(false);
    expect(
      await purge.eligibleWorkOrderTexts(
        new Date(),
        WORK_ORDER_BODY_RETENTION_DAYS,
      ),
    ).not.toContain(issueId);
    await purge.run();
    expect((await readOrder(orderId)).body).toBe("Riv ut den vata skivan.");

    await setHold(false);
    const summary = await purge.run();
    expect(summary.workOrderTexts.failed).toBe(0);
    expect((await readOrder(orderId)).body).toBeNull();
  });

  it("is kept by a hold on the issue placed while the purge waits for the issue", async () => {
    /*
     * A handler's hold takes the issue's lock (`lockIssueForHandling`) before
     * it writes `legalHoldAt`, and the purge reads the hold again under that
     * lock. Held open here with the hold written, the purge queues behind it;
     * the hold commits as the lock goes, so the purge finds it. A resident's
     * report, with no address index, so the purge writes nothing to the issue
     * before the lock and the wait is on the advisory key, which `pg_locks`
     * shows, rather than a row.
     */
    const issueId = await residentIssueClosed(
      "Sprucken ruta i portdorren.",
      WORK_ORDER_BODY_RETENTION_DAYS + 1,
    );
    const orderId = await workOrderOn(issueId, "Byt rutan i portdorren.");
    const key = `issue:${issueId}`;

    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holder: Promise<void> | undefined;
    let running: Promise<boolean> | undefined;

    try {
      // Longer than the waits below, so the transaction held open on purpose
      // is not aborted by the five-second default and its lock released early.
      holder = prisma.$transaction(
        async (tx) => {
          await lockIssueForHandling(tx, issueId);
          await tx.issue.update({
            where: { id: issueId },
            data: { legalHoldAt: new Date() },
          });
          await holderDone;
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, true)) > 0n,
      );

      running = purge.purgeWorkOrderTexts(issueId);
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, false)) > 0n,
      );

      releaseHolder?.();
      await holder;

      await expect(running).resolves.toBe(false);
      expect((await readOrder(orderId)).body).toBe("Byt rutan i portdorren.");
    } finally {
      releaseHolder?.();
      await holder?.catch(() => undefined);
      await running?.catch(() => undefined);
      await prisma.issue.update({
        where: { id: issueId },
        data: { legalHoldAt: null },
      });
    }
  }, 60_000);

  it("is kept while a legal hold stands against the reporter", async () => {
    const issueId = await reportPublicly(
      "Skadat racke pa balkongen.",
      withheld.email,
    );
    await close(issueId);
    await closedDaysAgo(issueId, WORK_ORDER_BODY_RETENTION_DAYS + 1);
    const orderId = await workOrderOn(issueId, "Laga racket pa balkongen.");
    const hold = await prisma.legalHold.create({
      data: {
        personId: withheld.personId,
        reason: `Tvist om racket ${suffix}`,
        placedByPersonId: board.personId,
      },
    });

    try {
      expect(
        await purge.eligibleWorkOrderTexts(
          new Date(),
          WORK_ORDER_BODY_RETENTION_DAYS,
        ),
      ).not.toContain(issueId);
      await expect(purge.purgeWorkOrderTexts(issueId)).resolves.toBe(false);

      expect((await readOrder(orderId)).body).toBe("Laga racket pa balkongen.");
    } finally {
      await prisma.legalHold.delete({ where: { id: hold.id } });
    }
  });

  describe("on a public-form report", () => {
    async function purgeEntries(issueId: string) {
      return prisma.auditLogEntry.findMany({
        where: {
          action: "SERVICE_DATA_PURGED",
          targetKind: "issue",
          targetId: issueId,
        },
        orderBy: { createdAt: "asc" },
        select: { context: true },
      });
    }

    async function restrict(restricted: boolean): Promise<void> {
      await prisma.person.update({
        where: { id: withheld.personId },
        data: { processingRestrictedAt: restricted ? new Date() : null },
      });
    }

    it("keeps the address index past the year, so a restriction placed later still keeps the text", async () => {
      /*
       * The index is all a hold or a restriction can reach a public-form
       * reporter by (ADR 0057). Cleared with the name a year after closing, a
       * restriction placed in year three would match nothing and the text
       * would go at year ten regardless.
       */
      const issueId = await reportPublicly(
        "Mogel bakom kylskapet.",
        withheld.email,
      );
      await close(issueId);
      await closedDaysAgo(issueId, ISSUE_RETENTION_DAYS + 1);
      const orderId = await workOrderOn(issueId, "Sanera bakom kylskapet.");

      try {
        // The year passes with nobody withheld: name and address go, the
        // index stays.
        await purge.run();
        const afterYear = await read(issueId);
        expect(afterYear.reporterNameCipher).toBeNull();
        expect(afterYear.reporterEmailCipher).toBeNull();
        expect(afterYear.reporterEmailIndex).not.toBeNull();
        expect((await purgeEntries(issueId)).map((e) => e.context)).toEqual([
          {
            retentionDaysAfterClosing: ISSUE_RETENTION_DAYS,
            addressIndexKept: true,
          },
        ]);

        // A report left with only its kept index is not selected again, and
        // asked directly it detaches nothing and writes nothing.
        expect(
          await purge.eligible(new Date(), ISSUE_RETENTION_DAYS),
        ).not.toContain(issueId);
        await expect(purge.purgeIssue(issueId)).resolves.toBe(false);
        await purge.run();
        expect(await purgeEntries(issueId)).toHaveLength(1);

        // Years later the person who wrote in is restricted, and then the
        // work order's ten years run out.
        await restrict(true);
        await closedDaysAgo(issueId, WORK_ORDER_BODY_RETENTION_DAYS + 1);

        expect(
          await purge.eligibleWorkOrderTexts(
            new Date(),
            WORK_ORDER_BODY_RETENTION_DAYS,
          ),
        ).not.toContain(issueId);
        await expect(purge.purgeWorkOrderTexts(issueId)).resolves.toBe(false);
        await purge.run();
        expect((await readOrder(orderId)).body).toBe("Sanera bakom kylskapet.");
        expect((await read(issueId)).reporterEmailIndex).not.toBeNull();
        expect(await purgeEntries(issueId)).toHaveLength(1);
      } finally {
        await restrict(false);
      }

      // Lifted, the text goes and the index with it, in one entry.
      await purge.run();
      expect((await readOrder(orderId)).body).toBeNull();
      expect((await read(issueId)).reporterEmailIndex).toBeNull();
      expect((await purgeEntries(issueId)).map((e) => e.context)).toEqual([
        {
          retentionDaysAfterClosing: ISSUE_RETENTION_DAYS,
          addressIndexKept: true,
        },
        {
          workOrderTexts: 1,
          retentionDaysAfterClosing: WORK_ORDER_BODY_RETENTION_DAYS,
          addressIndexCleared: true,
        },
      ]);

      // And nothing is left for either purge to select.
      expect(
        await purge.eligible(new Date(), ISSUE_RETENTION_DAYS),
      ).not.toContain(issueId);
      expect(
        await purge.eligibleWorkOrderTexts(
          new Date(),
          WORK_ORDER_BODY_RETENTION_DAYS,
        ),
      ).not.toContain(issueId);
    });

    it("clears a kept index once no text stands, however the text went", async () => {
      // Erased by something other than the clock, the text no longer needs
      // the index, and the year's purge takes it on its next run.
      const issueId = await reportPublicly("Trasig ruta i entren.");
      await close(issueId);
      await closedDaysAgo(issueId, ISSUE_RETENTION_DAYS + 1);
      const orderId = await workOrderOn(issueId, "Byt rutan i entren.");

      await purge.run();
      expect((await read(issueId)).reporterEmailIndex).not.toBeNull();

      await prisma.workOrder.update({
        where: { id: orderId },
        data: { body: null },
      });
      expect(await purge.eligible(new Date(), ISSUE_RETENTION_DAYS)).toContain(
        issueId,
      );
      await purge.run();

      expect((await read(issueId)).reporterEmailIndex).toBeNull();
      expect((await purgeEntries(issueId)).map((e) => e.context)).toEqual([
        {
          retentionDaysAfterClosing: ISSUE_RETENTION_DAYS,
          addressIndexKept: true,
        },
        { retentionDaysAfterClosing: ISSUE_RETENTION_DAYS },
      ]);
    });
  });
});

describe("a contractor on the list", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY);
  let counter = 0;

  /** A contractor the board added the given number of days ago. */
  async function contractorAdded(days: number): Promise<string> {
    counter += 1;
    const id = `ip-contractor-${String(counter)}-${suffix}`;
    contractorIds.push(id);
    await prisma.contractor.create({
      data: {
        id,
        name: `Rorfirman ${String(counter)} ${suffix}`,
        trade: "Rormokare",
        createdAt: daysAgo(days),
      },
    });
    return id;
  }

  /**
   * A work order sent the contractor the given number of days ago, on an
   * issue of its own, with its text or, as the clock leaves it, without.
   */
  async function workOrderTo(
    contractorId: string,
    days: number,
    body: string | null,
    delivery: {
      deliveryStatus: "PENDING" | "SENT" | "FAILED";
      deliveryFailure?: string;
    } = { deliveryStatus: "SENT" },
  ): Promise<{ issueId: string; orderId: string }> {
    const issueId = await reportPublicly("Droppande kran i tvattstugan.");
    const order = await prisma.workOrder.create({
      data: {
        issueId,
        contractorId,
        recipientName: `Rormokare ${suffix}`,
        recipientEmailCipher: "kept-as-it-was",
        body,
        sentByPersonId: board.personId,
        ...delivery,
        createdAt: daysAgo(days),
      },
      select: { id: true },
    });
    return { issueId, orderId: order.id };
  }

  async function onTheList(id: string): Promise<boolean> {
    return (
      (await prisma.contractor.findUnique({
        where: { id },
        select: { id: true },
      })) !== null
    );
  }

  async function eligible(): Promise<string[]> {
    return purge.eligibleContractors(new Date(), CONTRACTOR_RETENTION_DAYS);
  }

  it("is removed ten years after the last work order sent them, and erased from it", async () => {
    const id = await contractorAdded(CONTRACTOR_RETENTION_DAYS + 400);
    const { orderId } = await workOrderTo(
      id,
      CONTRACTOR_RETENTION_DAYS + 1,
      null,
    );
    expect(await eligible()).toContain(id);

    // Another suite's run may take it first, so the outcome is what is read.
    await purge.purgeContractor(id);

    expect(await onTheList(id)).toBe(false);
    // The work order stays, without the copy of whom it went to.
    expect(
      await prisma.workOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: {
          contractorId: true,
          recipientName: true,
          recipientEmailCipher: true,
          deliveryStatus: true,
        },
      }),
    ).toEqual({
      contractorId: null,
      recipientName: null,
      recipientEmailCipher: null,
      deliveryStatus: "SENT",
    });

    // Recorded against the contractor by id, never by name.
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "contractor",
        targetId: id,
      },
      select: { actorPersonId: true, channel: true, context: true },
    });
    expect(entries).toEqual([
      {
        actorPersonId: null,
        channel: "SYSTEM",
        context: {
          workOrdersErased: 1,
          workOrdersKept: 0,
          retentionDaysAfterLastWorkOrder: CONTRACTOR_RETENTION_DAYS,
        },
      },
    ]);
    expect(JSON.stringify(entries[0]?.context)).not.toContain(suffix);
  });

  it("is kept while the last work order sent them is inside the window, however long ago they were added", async () => {
    const id = await contractorAdded(CONTRACTOR_RETENTION_DAYS + 400);
    await workOrderTo(id, CONTRACTOR_RETENTION_DAYS + 1, null);
    await workOrderTo(id, CONTRACTOR_RETENTION_DAYS - 7, null);

    expect(await eligible()).not.toContain(id);
    await expect(purge.purgeContractor(id)).resolves.toBe(false);
    await purge.run();
    expect(await onTheList(id)).toBe(true);
  });

  it("is kept by a work order whose mail may have gone out, and not by one whose mail never left", async () => {
    const unsent = await contractorAdded(CONTRACTOR_RETENTION_DAYS + 400);
    await workOrderTo(unsent, CONTRACTOR_RETENTION_DAYS + 1, null);
    await workOrderTo(unsent, 7, null, {
      deliveryStatus: "FAILED",
      deliveryFailure: "send-failed",
    });
    const unconfirmed = await contractorAdded(CONTRACTOR_RETENTION_DAYS + 400);
    await workOrderTo(unconfirmed, CONTRACTOR_RETENTION_DAYS + 1, null);
    await workOrderTo(unconfirmed, 7, null, {
      deliveryStatus: "FAILED",
      deliveryFailure: "delivery-unconfirmed",
    });
    const pending = await contractorAdded(CONTRACTOR_RETENTION_DAYS + 400);
    await workOrderTo(pending, CONTRACTOR_RETENTION_DAYS + 1, null);
    await workOrderTo(pending, 7, null, { deliveryStatus: "PENDING" });

    const found = await eligible();
    expect(found).toContain(unsent);
    expect(found).not.toContain(unconfirmed);
    expect(found).not.toContain(pending);

    await purge.purgeContractor(unsent);
    await expect(purge.purgeContractor(unconfirmed)).resolves.toBe(false);
    await expect(purge.purgeContractor(pending)).resolves.toBe(false);
    expect(await onTheList(unsent)).toBe(false);
    expect(await onTheList(unconfirmed)).toBe(true);
    expect(await onTheList(pending)).toBe(true);
  });

  async function recipientOf(orderId: string) {
    return prisma.workOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        contractorId: true,
        recipientName: true,
        recipientEmailCipher: true,
        body: true,
      },
    });
  }

  it("is removed on the list's clock while a work order sent them still holds its text, which keeps whom it went to until the text goes", async () => {
    // The issue is still open ten years after the work order went, so the
    // text's own clock has not started; the list's has run out regardless.
    const id = await contractorAdded(CONTRACTOR_RETENTION_DAYS + 400);
    const { issueId, orderId } = await workOrderTo(
      id,
      CONTRACTOR_RETENTION_DAYS + 1,
      "Byt packningen i kranen.",
    );

    expect(await eligible()).toContain(id);
    await purge.purgeContractor(id);
    expect(await onTheList(id)).toBe(false);
    // The list's details are gone; the work order keeps what it said and
    // whom it was written to.
    expect(await recipientOf(orderId)).toEqual({
      contractorId: null,
      recipientName: `Rormokare ${suffix}`,
      recipientEmailCipher: "kept-as-it-was",
      body: "Byt packningen i kranen.",
    });
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "contractor",
        targetId: id,
      },
      select: { context: true },
    });
    expect(entries).toEqual([
      {
        context: {
          workOrdersErased: 0,
          workOrdersKept: 1,
          retentionDaysAfterLastWorkOrder: CONTRACTOR_RETENTION_DAYS,
        },
      },
    ]);

    // The issue closes, and ten years on the text goes, and whom it went to
    // with it.
    await close(issueId);
    await closedDaysAgo(issueId, WORK_ORDER_BODY_RETENTION_DAYS + 1);
    expect(
      await purge.eligibleWorkOrderTexts(
        new Date(),
        WORK_ORDER_BODY_RETENTION_DAYS,
      ),
    ).toContain(issueId);
    await purge.purgeWorkOrderTexts(issueId);
    expect(await recipientOf(orderId)).toEqual({
      contractorId: null,
      recipientName: null,
      recipientEmailCipher: null,
      body: null,
    });
  });

  it("is removed on the list's clock while a work order sent them is on an issue under a legal hold, which keeps whom it went to until the hold is released", async () => {
    // A redacted text: nothing but the hold keeps the work order's copy.
    const id = await contractorAdded(CONTRACTOR_RETENTION_DAYS + 400);
    const { issueId, orderId } = await workOrderTo(
      id,
      CONTRACTOR_RETENTION_DAYS + 1,
      null,
    );
    await close(issueId);
    await closedDaysAgo(issueId, WORK_ORDER_BODY_RETENTION_DAYS + 1);
    await prisma.issue.update({
      where: { id: issueId },
      data: { legalHoldAt: new Date() },
    });

    expect(await eligible()).toContain(id);
    await purge.purgeContractor(id);
    expect(await onTheList(id)).toBe(false);
    expect(await recipientOf(orderId)).toMatchObject({
      contractorId: null,
      recipientName: `Rormokare ${suffix}`,
      recipientEmailCipher: "kept-as-it-was",
    });
    // Held: the text purge leaves it.
    await expect(purge.purgeWorkOrderTexts(issueId)).resolves.toBe(false);
    expect((await recipientOf(orderId)).recipientName).not.toBeNull();

    await prisma.issue.update({
      where: { id: issueId },
      data: { legalHoldAt: null },
    });
    // No text stands on it, and the copy alone brings it back to the purge.
    expect(
      await purge.eligibleWorkOrderTexts(
        new Date(),
        WORK_ORDER_BODY_RETENTION_DAYS,
      ),
    ).toContain(issueId);
    await purge.purgeWorkOrderTexts(issueId);
    expect(await recipientOf(orderId)).toMatchObject({
      recipientName: null,
      recipientEmailCipher: null,
    });
  });

  it("loses the copy of whom a work order went to, kept for its text, when a handler redacts the text", async () => {
    const id = await contractorAdded(CONTRACTOR_RETENTION_DAYS + 400);
    const { issueId, orderId } = await workOrderTo(
      id,
      CONTRACTOR_RETENTION_DAYS + 1,
      "Byt packningen i kranen.",
    );
    await purge.purgeContractor(id);
    expect((await recipientOf(orderId)).recipientName).not.toBeNull();

    await app
      .get(IssueRedactionService)
      .redact(board.personId, issueId, { target: "workOrder", id: orderId });

    expect(await recipientOf(orderId)).toEqual({
      contractorId: null,
      recipientName: null,
      recipientEmailCipher: null,
      body: null,
    });
  });

  it("loses the copy of whom a work order went to, kept for a legal hold, when a handler releases the hold", async () => {
    // A redacted text on an open issue: only the hold keeps the copy, and the
    // work order's own clock has not started.
    const id = await contractorAdded(CONTRACTOR_RETENTION_DAYS + 400);
    const { issueId, orderId } = await workOrderTo(
      id,
      CONTRACTOR_RETENTION_DAYS + 1,
      null,
    );
    const holds = app.get(IssueRedactionService);
    await holds.setLegalHold(board.personId, issueId, true);
    await purge.purgeContractor(id);
    expect((await recipientOf(orderId)).recipientName).not.toBeNull();

    await holds.setLegalHold(board.personId, issueId, false);

    expect(await recipientOf(orderId)).toMatchObject({
      recipientName: null,
      recipientEmailCipher: null,
    });
    const released = await prisma.auditLogEntry.findMany({
      where: {
        action: "ISSUE_LEGAL_HOLD_RELEASED",
        targetKind: "issue",
        targetId: issueId,
      },
      select: { context: true },
    });
    expect(released).toEqual([
      {
        context: {
          placedAt: expect.any(String),
          workOrderRecipients: 1,
        },
      },
    ]);
  });

  it("leaves whom a work order went to while its contractor stays on the list, when the text goes", async () => {
    const id = await contractorAdded(CONTRACTOR_RETENTION_DAYS - 400);
    const { issueId, orderId } = await workOrderTo(
      id,
      CONTRACTOR_RETENTION_DAYS - 400,
      "Rensa golvbrunnen.",
    );
    await close(issueId);
    await closedDaysAgo(issueId, WORK_ORDER_BODY_RETENTION_DAYS + 1);

    await purge.purgeWorkOrderTexts(issueId);
    expect(await recipientOf(orderId)).toEqual({
      contractorId: id,
      recipientName: `Rormokare ${suffix}`,
      recipientEmailCipher: "kept-as-it-was",
      body: null,
    });
    expect(await onTheList(id)).toBe(true);
  });

  it("is kept by a work order written while the purge waits for the contractor's row", async () => {
    const id = await contractorAdded(CONTRACTOR_RETENTION_DAYS + 400);
    await workOrderTo(id, CONTRACTOR_RETENTION_DAYS + 1, null);
    expect(await eligible()).toContain(id);

    // A sending holds the row while it writes the work order, as
    // `ContractorService.lockForSending` does; the purge waits for it and
    // then reads the new work order.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const issueId = await reportPublicly("Ny lacka under diskbanken.");
    const sending = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "contractor" WHERE "id" = ${id} FOR SHARE`;
      locked();
      await released;
      await tx.workOrder.create({
        data: {
          issueId,
          contractorId: id,
          recipientName: `Rormokare ${suffix}`,
          recipientEmailCipher: "kept-as-it-was",
          body: null,
          sentByPersonId: board.personId,
        },
      });
    });
    await holding;
    const purged = purge.purgeContractor(id);
    // Give the purge time to reach the row lock before the sending commits.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await sending;

    await expect(purged).resolves.toBe(false);
    expect(await onTheList(id)).toBe(true);
  });

  it("with no work order sent them, is removed ten years after being added, and kept before", async () => {
    const kept = await contractorAdded(CONTRACTOR_RETENTION_DAYS - 7);
    const removed = await contractorAdded(CONTRACTOR_RETENTION_DAYS + 1);

    const found = await eligible();
    expect(found).toContain(removed);
    expect(found).not.toContain(kept);

    await purge.purgeContractor(removed);
    await expect(purge.purgeContractor(kept)).resolves.toBe(false);
    expect(await onTheList(removed)).toBe(false);
    expect(await onTheList(kept)).toBe(true);
  });
});
