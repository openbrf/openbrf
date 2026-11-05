import { randomUUID } from "node:crypto";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  addLocalDays,
  formatLocalDay,
  instantAt,
  type LocalDay,
  localDayOf,
  localDayOfColumn,
} from "@openbrf/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { AppModule } from "../app.module";
import {
  capabilitiesFor,
  type Principal,
  type PrincipalRoles,
} from "../authorization/capabilities";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { JOB_SCHEMA, JobQueueService } from "../jobs/job-queue.service";
import {
  MailNotConfiguredError,
  MailService,
  type SendMailInput,
} from "../mail/mail.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { IssueConversationService } from "./issue-conversation.service";
import {
  ISSUE_NOTICE_QUEUE,
  ISSUE_OVERDUE_QUEUE,
  IssueMailer,
  type IssueNoticeJob,
  type IssueOverdueJob,
  NOTIFIED_MESSAGES_PER_REPORTER_PER_HOUR,
  NOTIFIED_PUBLIC_REPORTS_PER_HOUR,
  NOTIFIED_REPORTS_PER_REPORTER_PER_HOUR,
  REPEATED_NOTICE_SECONDS,
} from "./issue-mailer.service";
import { IssueService } from "./issue.service";

/**
 * The mail about issues against a real database (decisions 8, 10, 12 and 21 of
 * the issue module plan): who is told of a filing, an assignment, Akut, an
 * overdue issue, a reopening and an issue message; the overdue reminder once
 * for each target date; nobody whose processing is restricted; and no mail
 * that carries what anybody wrote.
 *
 * Other suites put administrators and board members into this database too,
 * so a mail to every handler is asserted by who is among its recipients, and a
 * mail to one person by exactly who.
 */

// Refuses to run without a configured environment, before anything connects.
loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
/** Whether another suite had already made the association row. */
let associationExisted = true;
let issues: IssueService;
let mailer: IssueMailer;
let mail: MailService;

const suffix = process.hrtime.bigint().toString(36);

function person(key: string, firstName: string, lastName: string) {
  return {
    personId: `im-${key}-${suffix}`,
    email: `im-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `${lastName}${suffix}`,
  };
}

const board = person("board", "Bea", "Styrelse");
const admin = person("admin", "Ada", "Administrator");
const manager = person("manager", "Frida", "Forvaltare");
/** A board member whose processing is restricted (GDPR art. 18). */
const restricted = person("restricted", "Rita", "Begransad");
/** A board member with no address on record. */
const unreachable = person("unreachable", "Ulf", "Utanadress");
const resident = person("resident", "Rune", "Boende");
/** A second resident, whose mail budget is their own. */
const neighbour = person("neighbour", "Nora", "Granne");
const people = [
  board,
  admin,
  manager,
  restricted,
  unreachable,
  resident,
  neighbour,
];
const personIds = people.map((entry) => entry.personId);

const apartmentId = `im-apartment-${suffix}`;
const addressId = `im-address-${suffix}`;

/**
 * Words only this suite writes, as a reporter and as a handler. No mail may
 * carry any of them.
 */
const REPORTER_DESCRIPTION = `Vattnet rinner ur taket hos grannen ${suffix}`;
const REPORTER_LOCATION = `Badrummet ovanför ${suffix}`;
const HANDLER_STATUS_LABEL = `Väntar på rörmokaren ${suffix}`;
const REPORTER_MESSAGE = `Droppet har blivit en stråle ${suffix}`;
const HANDLER_MESSAGE = `Rörmokaren kommer på torsdag ${suffix}`;

const typeIds = {
  unassigned: `im-type-unassigned-${suffix}`,
  assigned: `im-type-assigned-${suffix}`,
  urgent: `im-type-urgent-${suffix}`,
  boardOnly: `im-type-board-${suffix}`,
  public: `im-type-public-${suffix}`,
};
let unassignedType: IssueTypeFixture;
let assignedType: IssueTypeFixture;
let urgentType: IssueTypeFixture;
let boardOnlyType: IssueTypeFixture;
let publicType: IssueTypeFixture;

const RESIDENT_ROLES: PrincipalRoles = {
  isAdmin: false,
  isBoardMember: false,
  isPropertyManager: false,
  isResident: true,
  isMember: true,
};
const residentPrincipal: Principal = {
  ...RESIDENT_ROLES,
  personId: resident.personId,
  capabilities: capabilitiesFor(RESIDENT_ROLES),
};
const neighbourPrincipal: Principal = {
  ...residentPrincipal,
  personId: neighbour.personId,
};
/** The board member as a resident of the house, reporting as one. */
const BOARD_RESIDENT_ROLES: PrincipalRoles = {
  ...RESIDENT_ROLES,
  isBoardMember: true,
};
const boardResidentPrincipal: Principal = {
  ...BOARD_RESIDENT_ROLES,
  personId: board.personId,
  capabilities: capabilitiesFor(BOARD_RESIDENT_ROLES),
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * Moves issues out of the past hour, so they no longer spend their sender's
 * mail budget.
 */
async function outOfTheHour(issueIds: string[]): Promise<void> {
  await prisma.issue.updateMany({
    where: { id: { in: issueIds } },
    data: { createdAt: new Date(Date.now() - 2 * HOUR_MS) },
  });
}

/**
 * A report the resident files, through the service the route calls.
 *
 * The suite files more reports as this one resident than an hour's mail budget
 * allows, so each is moved out of the hour once its mail is queued, and the
 * next is mailed about as the first was. The budget has a test of its own.
 */
async function report(type: IssueTypeFixture): Promise<string> {
  const { id } = await issues.report(residentPrincipal, {
    typeId: type.id,
    apartmentId,
    location: REPORTER_LOCATION,
    description: REPORTER_DESCRIPTION,
  });
  await outOfTheHour([id]);
  return id;
}

/** The deliveries queued for one issue, in the order they were queued. */
async function notices(issueId: string): Promise<IssueNoticeJob[]> {
  const rows = await prisma.$queryRawUnsafe<{ data: IssueNoticeJob }[]>(
    "SELECT data FROM pgboss.job WHERE name = $1 AND data->>'issueId' = $2 ORDER BY created_on, id",
    ISSUE_NOTICE_QUEUE,
    issueId,
  );
  return rows.map((row) => row.data);
}

/**
 * Moves one queued notice to a state the queue puts it in: a worker takes it
 * (`active`), completes it whether or not it sent anything (`completed`), or
 * gives up on it (`failed`). Integration tests drive the deliveries
 * themselves.
 */
async function setNoticeState(
  job: IssueNoticeJob,
  state: "active" | "completed" | "failed",
): Promise<void> {
  const moved = await prisma.$executeRawUnsafe(
    "UPDATE pgboss.job SET state = $1::pgboss.job_state WHERE name = $2 AND id::text = $3",
    state,
    ISSUE_NOTICE_QUEUE,
    job.jobId,
  );
  expect(moved).toBe(1);
}

/** Whether a queued notice still holds its throttle slot. */
async function holdsSlot(job: IssueNoticeJob): Promise<boolean> {
  const [row] = await prisma.$queryRawUnsafe<{ holds: boolean }[]>(
    "SELECT singleton_on IS NOT NULL AS holds FROM pgboss.job WHERE name = $1 AND id::text = $2",
    ISSUE_NOTICE_QUEUE,
    job.jobId,
  );
  expect(row).toBeDefined();
  return row?.holds === true;
}

/**
 * How long one test may run, the integration config's `testTimeout`. A test
 * still running past it has failed.
 */
const TEST_TIMEOUT_MS = 30_000;

/**
 * Slack kept above {@link TEST_TIMEOUT_MS} when the slot is checked: the
 * test's own timer starts only after the hook returns, and the clock is read
 * before that, so a test needs more than its timeout of the slot left.
 */
const SLOT_MARGIN_MS = 1_000;

/**
 * Waits for the queue's throttle slot to turn when less than
 * {@link TEST_TIMEOUT_MS} plus {@link SLOT_MARGIN_MS} of it is left.
 *
 * The queue cuts the database's clock into slots of
 * {@link REPEATED_NOTICE_SECONDS}, each starting on the hour, and a repeated
 * assignment or reopening notice is dropped only within the slot of the first.
 * A test that queues a notice and then a repeat expects both in one slot, and
 * one started a second before the hour turns would see the repeat queued. A
 * test that starts with a timeout's worth of its slot left, and a margin, and
 * passes, cannot cross the turn.
 */
async function clearOfTheSlotTurn(): Promise<void> {
  const slotMs = REPEATED_NOTICE_SECONDS * 1000;
  for (;;) {
    // The clock the queue reads when it cuts the slot.
    const [row] = await prisma.$queryRawUnsafe<{ nowMs: number }[]>(
      `SELECT (date_part('epoch', ${JOB_SCHEMA}.job_now()) * 1000)::float8 AS "nowMs"`,
    );
    expect(row).toBeDefined();
    const leftMs = slotMs - ((row?.nowMs ?? 0) % slotMs);
    if (leftMs >= TEST_TIMEOUT_MS + SLOT_MARGIN_MS) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, leftMs + 100));
  }
}

/** The notice last queued for one issue, which a test expects there to be. */
async function lastNotice(issueId: string): Promise<IssueNoticeJob> {
  const job = (await notices(issueId)).at(-1);
  expect(job).toBeDefined();
  return job as IssueNoticeJob;
}

/** How long {@link untilWaitingForLock} looks before it gives up. */
const LOCK_WAIT_DEADLINE_MS = 10_000;

/**
 * Waits until a transaction is waiting for an advisory lock another one holds,
 * by its key's two halves. The key is this run's own, an issue's or a person's,
 * so no other suite's waiter is counted.
 */
async function untilWaitingForLock(key: string, what: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
  for (;;) {
    const [row] = await prisma.$queryRawUnsafe<{ waiting: number }[]>(
      `SELECT count(*)::int AS waiting FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
         AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
         AND objid = (hashtext($1)::bigint & 4294967295)::oid`,
      key,
    );
    if ((row?.waiting ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Nothing waited for ${what}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Waits until a transaction is waiting for the issue's lock (`lockIssue`). */
function untilWaitingForIssueLock(issueId: string): Promise<void> {
  return untilWaitingForLock(`issue:${issueId}`, "the issue's lock");
}

/**
 * Files two reports of one sender together, the first held back after its
 * mail budget was counted and before it commits, and answers both ids.
 *
 * The first is stored and mailed about in a transaction this keeps open, as
 * `IssueService` files one; `racing` then files the second, and the first
 * commits only once the second is waiting for the sender's budget lock
 * (`lockFilingBudget`, under `lockKey`). Counting without it, the second would
 * not see the first and both would be mailed about, so a missing lock fails
 * here: nothing waits for it. The two are filed under different types, as
 * `held` and as `racing` names, because a type's lock would otherwise make
 * them wait for each other and hide a missing budget lock.
 */
async function filedWhileBudgetIsCounted(options: {
  reporterPersonId: string | null;
  held: IssueTypeFixture;
  lockKey: string;
  racing: () => Promise<{ id: string }>;
}): Promise<{ held: string; racing: string }> {
  await mailer.ensureQueues();
  let racing: Promise<{ id: string }> | undefined;
  const held = await prisma.$transaction(async (tx) => {
    const { id } = await tx.issue.create({
      data: {
        typeId: options.held.id,
        statusId: options.held.statusIds.NEW,
        reporterPersonId: options.reporterPersonId,
        description: REPORTER_DESCRIPTION,
      },
      select: { id: true },
    });
    expect(await mailer.filedInTransaction(tx, id)).toBeGreaterThan(0);
    racing = options.racing();
    // A failure before it waits is reported by the wait below timing out.
    racing.catch(() => undefined);
    await untilWaitingForLock(
      options.lockKey,
      "the sender's filing budget lock",
    );
    return id;
  });
  if (racing === undefined) {
    throw new Error("The second report was never started.");
  }
  return { held, racing: (await racing).id };
}

/** Runs `run` while the association takes reports from the website's form. */
async function whilePublicReportingIsOn<T>(run: () => Promise<T>): Promise<T> {
  await mailer.ensureQueues();
  const previous = await prisma.association.findUnique({
    where: { id: 1 },
    select: { issueReportingPublic: true },
  });
  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet", issueReportingPublic: true },
    update: { issueReportingPublic: true },
  });
  try {
    return await run();
  } finally {
    if (previous === null) {
      await prisma.association.deleteMany({ where: { id: 1 } });
    } else {
      await prisma.association.update({
        where: { id: 1 },
        data: { issueReportingPublic: previous.issueReportingPublic },
      });
    }
  }
}

/** The overdue jobs queued for one issue, with when each is due. */
async function overdueJobs(
  issueId: string,
): Promise<{ data: IssueOverdueJob; start_after: Date }[]> {
  return prisma.$queryRawUnsafe(
    "SELECT data, start_after FROM pgboss.job WHERE name = $1 AND data->>'issueId' = $2 ORDER BY created_on, id",
    ISSUE_OVERDUE_QUEUE,
    issueId,
  );
}

/**
 * The overdue job queued last for an issue, as its worker would receive it.
 * A test that runs the job queued again runs this one, not a payload it builds,
 * so a replacement with the wrong target date fails the test.
 */
async function lastOverdueJob(
  issueId: string,
  targetDate: string,
): Promise<IssueOverdueJob> {
  const job = (await overdueJobs(issueId)).at(-1);
  if (!job) throw new Error("no overdue job is queued");
  expect(job.data).toEqual({ issueId, targetDate });
  return job.data;
}

function recipientsOf(jobs: IssueNoticeJob[]): Map<string, string> {
  return new Map(jobs.map((job) => [job.personId, job.event]));
}

function today(): LocalDay {
  return localDayOf(new Date());
}

/** Every message the mail layer was handed, with the send stubbed out. */
function captureSends(): SendMailInput<unknown>[] {
  const captured: SendMailInput<unknown>[] = [];
  vi.spyOn(mail, "send").mockImplementation(async (input) => {
    captured.push(input as SendMailInput<unknown>);
    return { messageId: null };
  });
  return captured;
}

const storedMessageIds: string[] = [];

/**
 * Stores a message on an issue, as the conversation does before it mails
 * about it, and answers its id for the notice to name. The resident writes a
 * reporter's message, and a handler's carries the signature given.
 *
 * A reporter's message spends the resident's hourly mail budget, so every
 * message stored here is deleted after the test, whether it passed or not.
 */
async function storeMessage(
  issueId: string,
  author:
    | { side: "REPORTER" }
    | {
        side: "HANDLER";
        personId: string;
        signature: "BOARD" | "PROPERTY_MANAGER";
      },
  body: string,
): Promise<string> {
  const { id } = await prisma.issueMessage.create({
    data:
      author.side === "REPORTER"
        ? {
            issueId,
            side: "REPORTER",
            authorPersonId: resident.personId,
            body,
          }
        : {
            issueId,
            side: "HANDLER",
            authorPersonId: author.personId,
            signature: author.signature,
            body,
          },
    select: { id: true },
  });
  storedMessageIds.push(id);
  return id;
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
  issues = app.get(IssueService);
  mailer = app.get(IssueMailer);
  mail = app.get(MailService);
  const encryption = app.get(FieldEncryptionService);

  associationExisted =
    (await prisma.association.findUnique({
      where: { id: 1 },
      select: { id: true },
    })) !== null;
  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });
  await prisma.address.create({
    data: {
      id: addressId,
      street: "Mejlgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1601", floor: 6 },
  });

  for (const entry of people) {
    const email =
      entry === unreachable
        ? null
        : await encryption.encrypt("person.email", entry.email);
    await prisma.person.create({
      data: {
        id: entry.personId,
        firstName: entry.firstName,
        lastName: entry.lastName,
        emailCipher: email?.cipher ?? null,
        emailIndex: email?.index ?? null,
        processingRestrictedAt: entry === restricted ? new Date() : null,
      },
    });
  }
  await prisma.boardPosition.createMany({
    data: [board, restricted, unreachable].map((entry) => ({
      personId: entry.personId,
      position: "BOARD_MEMBER" as const,
      electedOn: new Date("2025-05-15"),
    })),
  });
  await prisma.systemRole.createMany({
    data: [
      { personId: admin.personId, role: "ADMIN" as const },
      { personId: manager.personId, role: "PROPERTY_MANAGER" as const },
    ],
  });
  await prisma.residency.create({
    data: {
      personId: resident.personId,
      apartmentId,
      role: "MEMBER",
      movedInOn: new Date("2024-01-01"),
    },
  });

  unassignedType = await createIssueTypeFixture(prisma, {
    id: typeIds.unassigned,
    name: `Övrigt ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  assignedType = await createIssueTypeFixture(prisma, {
    id: typeIds.assigned,
    name: `Hiss ${suffix}`,
    reporters: ["RESIDENTS"],
    defaultAssigneePersonId: manager.personId,
  });
  urgentType = await createIssueTypeFixture(prisma, {
    id: typeIds.urgent,
    name: `Vattenläcka ${suffix}`,
    reporters: ["RESIDENTS"],
    defaultPriority: "URGENT",
    defaultAssigneePersonId: board.personId,
  });
  boardOnlyType = await createIssueTypeFixture(prisma, {
    id: typeIds.boardOnly,
    name: `Störning ${suffix}`,
    reporters: ["RESIDENTS"],
    handledBy: "BOARD",
  });
  publicType = await createIssueTypeFixture(prisma, {
    id: typeIds.public,
    name: `Utomhus ${suffix}`,
    reporters: ["PUBLIC"],
  });
  // A status a handler named, so the suite can look for it in the mail.
  await prisma.issueStatus.create({
    data: {
      typeId: assignedType.id,
      meaning: "WAITING",
      label: HANDLER_STATUS_LABEL,
      sortOrder: 1,
    },
  });
}, 180_000);

afterEach(async () => {
  vi.restoreAllMocks();
  const stored = storedMessageIds.splice(0);
  if (stored.length > 0) {
    await prisma.issueMessage.deleteMany({ where: { id: { in: stored } } });
  }
});

afterAll(async () => {
  const issueIds = (
    await prisma.issue.findMany({
      where: { typeId: { in: Object.values(typeIds) } },
      select: { id: true },
    })
  ).map((issue) => issue.id);
  if (issueIds.length > 0) {
    await prisma.$executeRawUnsafe(
      "DELETE FROM pgboss.job WHERE name IN ($1, $2) AND data->>'issueId' = ANY($3::text[])",
      ISSUE_NOTICE_QUEUE,
      ISSUE_OVERDUE_QUEUE,
      issueIds,
    );
  }
  await prisma.issue.deleteMany({
    where: { typeId: { in: Object.values(typeIds) } },
  });
  await prisma.issueType.deleteMany({
    where: { id: { in: Object.values(typeIds) } },
  });
  await prisma.residency.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.apartment.deleteMany({ where: { id: apartmentId } });
  await prisma.address.deleteMany({ where: { id: addressId } });
  await prisma.systemRole.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  // The row is the worker database's singleton, which later suites read. One
  // made here has no organisation number, and the register export refuses an
  // association without one, so it does not outlive this suite.
  if (!associationExisted) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  }
  await app.close();
});

describe("a report is filed", () => {
  it("mails each handler of a type with no default assignee, and not the reporter, a restricted board member or one with no address", async () => {
    const issueId = await report(unassignedType);

    const told = recipientsOf(await notices(issueId));
    expect(told.get(board.personId)).toBe("filed");
    expect(told.get(admin.personId)).toBe("filed");
    expect(told.get(manager.personId)).toBe("filed");
    expect(told.has(resident.personId)).toBe(false);
    expect(told.has(restricted.personId)).toBe(false);
    expect(told.has(unreachable.personId)).toBe(false);
  });

  it("mails the type's default assignee and nobody else", async () => {
    const issueId = await report(assignedType);

    expect(await notices(issueId)).toEqual([
      {
        issueId,
        personId: manager.personId,
        event: "assigned",
        jobId: expect.any(String),
      },
    ]);
  });

  it("mails every handler of an Akut type, the assignee among them, and tells each it is urgent", async () => {
    const issueId = await report(urgentType);

    const told = recipientsOf(await notices(issueId));
    expect(told.get(board.personId)).toBe("urgent");
    expect(told.get(admin.personId)).toBe("urgent");
    expect(told.get(manager.personId)).toBe("urgent");
    expect(told.has(restricted.personId)).toBe(false);
  });

  it("never mails the property manager about a type the board keeps to itself", async () => {
    const issueId = await report(boardOnlyType);

    const told = recipientsOf(await notices(issueId));
    expect(told.get(board.personId)).toBe("filed");
    expect(told.get(admin.personId)).toBe("filed");
    expect(told.has(manager.personId)).toBe(false);
  });

  it("does not mail the handler who opened an issue about it", async () => {
    const opened = await issues.open(
      {
        ...RESIDENT_ROLES,
        isResident: false,
        isMember: false,
        isBoardMember: true,
        personId: board.personId,
        capabilities: capabilitiesFor({
          ...RESIDENT_ROLES,
          isResident: false,
          isMember: false,
          isBoardMember: true,
        }),
      },
      { typeId: unassignedType.id, description: REPORTER_DESCRIPTION },
    );

    const told = recipientsOf(await notices(opened.id));
    expect(told.has(board.personId)).toBe(false);
    expect(told.get(admin.personId)).toBe("filed");
  });

  it("does not mail a handler about a report they filed as a resident", async () => {
    const filed: string[] = [];
    try {
      const unassigned = await issues.report(boardResidentPrincipal, {
        typeId: unassignedType.id,
        description: REPORTER_DESCRIPTION,
      });
      filed.push(unassigned.id);
      // Akut, and the type gives it to the board member who reported it.
      const urgent = await issues.report(boardResidentPrincipal, {
        typeId: urgentType.id,
        description: REPORTER_DESCRIPTION,
      });
      filed.push(urgent.id);

      const toldOfUnassigned = recipientsOf(await notices(unassigned.id));
      expect(toldOfUnassigned.has(board.personId)).toBe(false);
      expect(toldOfUnassigned.get(admin.personId)).toBe("filed");
      const toldOfUrgent = recipientsOf(await notices(urgent.id));
      expect(toldOfUrgent.has(board.personId)).toBe(false);
      expect(toldOfUrgent.get(admin.personId)).toBe("urgent");
    } finally {
      await outOfTheHour(filed);
    }
  });

  it("files a signed-in reporter's reports past their hour's budget without mail, and mails another reporter's and an Akut one", async () => {
    const filed: string[] = [];
    const file = async (
      principal: Principal,
      type: IssueTypeFixture,
    ): Promise<string> => {
      const { id } = await issues.report(principal, {
        typeId: type.id,
        description: REPORTER_DESCRIPTION,
      });
      filed.push(id);
      return id;
    };
    try {
      for (
        let index = 0;
        index < NOTIFIED_REPORTS_PER_REPORTER_PER_HOUR;
        index += 1
      ) {
        const id = await file(residentPrincipal, unassignedType);
        expect(recipientsOf(await notices(id)).get(admin.personId)).toBe(
          "filed",
        );
      }

      const past = await file(residentPrincipal, unassignedType);
      expect(await notices(past)).toEqual([]);
      // Filed and in the queue all the same.
      expect(
        await prisma.issue.findUnique({
          where: { id: past },
          select: { id: true },
        }),
      ).toEqual({ id: past });

      // Akut is counted apart, so the ordinary reports have not spent it.
      const urgent = await file(residentPrincipal, urgentType);
      const toldOfUrgent = recipientsOf(await notices(urgent));
      expect(toldOfUrgent.get(admin.personId)).toBe("urgent");
      // The assignee is among the handlers an Akut report goes to.
      expect(toldOfUrgent.get(board.personId)).toBe("urgent");

      // Another resident's budget is their own.
      const theirs = await file(neighbourPrincipal, unassignedType);
      expect(recipientsOf(await notices(theirs)).get(admin.personId)).toBe(
        "filed",
      );
    } finally {
      await outOfTheHour(filed);
    }
  });

  it("mails nobody about an ordinary report from the website's form once the hour's bound is reached, and still mails an Akut one", async () => {
    // The bound is one count for every report from the form, so the test owns
    // the hour rather than counting what is in it: the form's reports already
    // there, ordinary and Akut, are moved out for the length of the test and
    // put back after it, and its own are moved out once it is done, so no
    // later test finds the bound spent. Each worker has a database of its own
    // and runs one file at a time, so no other suite files a report meanwhile.
    const others = await prisma.issue.findMany({
      where: {
        reporterPersonId: null,
        enteredByHandler: false,
        createdAt: { gte: new Date(Date.now() - HOUR_MS) },
      },
      select: { id: true, createdAt: true, updatedAt: true },
    });
    const filed: string[] = [];
    try {
      await outOfTheHour(others.map((other) => other.id));
      for (
        let index = 0;
        index < NOTIFIED_PUBLIC_REPORTS_PER_HOUR;
        index += 1
      ) {
        const flood = await prisma.issue.create({
          data: {
            id: `im-flood-${String(index)}-${suffix}`,
            typeId: unassignedType.id,
            statusId: unassignedType.statusIds.NEW,
            description: "Skräp",
          },
          select: { id: true },
        });
        filed.push(flood.id);
      }
      // Through the service the website's form calls, which takes the report
      // whether or not it may mail.
      const { id: publicIssueId } = await whilePublicReportingIsOn(() =>
        issues.reportPublicly({
          typeId: publicType.id,
          description: REPORTER_DESCRIPTION,
        }),
      );
      filed.push(publicIssueId);

      expect(
        await prisma.issue.findUnique({
          where: { id: publicIssueId },
          select: { id: true },
        }),
      ).toEqual({ id: publicIssueId });
      expect(await notices(publicIssueId)).toEqual([]);

      // Ordinary reports do not spend Akut's budget (decision 12).
      const urgentIssue = await prisma.issue.create({
        data: {
          typeId: urgentType.id,
          statusId: urgentType.statusIds.NEW,
          priority: "URGENT",
          description: REPORTER_DESCRIPTION,
        },
        select: { id: true },
      });
      filed.push(urgentIssue.id);
      await prisma.$transaction((tx) =>
        mailer.filedInTransaction(tx, urgentIssue.id),
      );
      const told = recipientsOf(await notices(urgentIssue.id));
      expect(told.get(admin.personId)).toBe("urgent");
      expect(told.get(manager.personId)).toBe("urgent");
    } finally {
      await outOfTheHour(filed);
      for (const other of others) {
        await prisma.issue.updateMany({
          where: { id: other.id },
          // Both columns in one write: the `@updatedAt` column takes the time
          // of a write that leaves it out.
          data: { createdAt: other.createdAt, updatedAt: other.updatedAt },
        });
      }
    }
  });

  it("mails about only one of two reports a reporter files together with one slot of the hour's budget left, of two types", async () => {
    const heldBack = { reporterPersonId: resident.personId };
    const outOfTheHourAgain = () =>
      prisma.issue.updateMany({
        where: heldBack,
        data: { createdAt: new Date(Date.now() - 2 * HOUR_MS) },
      });
    try {
      // Whatever an earlier test left of this resident's hour is out of it.
      await outOfTheHourAgain();
      await prisma.issue.createMany({
        data: Array.from(
          { length: NOTIFIED_REPORTS_PER_REPORTER_PER_HOUR - 1 },
          (_, index) => ({
            id: `im-spent-${String(index)}-${suffix}`,
            typeId: unassignedType.id,
            statusId: unassignedType.statusIds.NEW,
            reporterPersonId: resident.personId,
            description: REPORTER_DESCRIPTION,
          }),
        ),
      });

      const filed = await filedWhileBudgetIsCounted({
        reporterPersonId: resident.personId,
        held: unassignedType,
        lockKey: `issue-filing-budget:person:${resident.personId}`,
        racing: () =>
          issues.report(residentPrincipal, {
            typeId: assignedType.id,
            description: REPORTER_DESCRIPTION,
          }),
      });

      // Both are filed, and the one that counted first is the only one the
      // handlers are told of.
      expect(
        await prisma.issue.count({
          where: { id: { in: [filed.held, filed.racing] } },
        }),
      ).toBe(2);
      expect(recipientsOf(await notices(filed.held)).get(admin.personId)).toBe(
        "filed",
      );
      expect(await notices(filed.racing)).toEqual([]);
    } finally {
      await outOfTheHourAgain();
    }
  });

  it("mails about only one of two reports the website's form takes together with one slot of the hour's budget left, of two types", async () => {
    // This suite's own reports from the form, however they were left.
    const ours = {
      reporterPersonId: null,
      typeId: { in: Object.values(typeIds) },
    };
    const outOfTheHourAgain = () =>
      prisma.issue.updateMany({
        where: ours,
        data: { createdAt: new Date(Date.now() - 2 * HOUR_MS) },
      });
    try {
      await outOfTheHourAgain();
      // What other suites left in the hour is part of the budget too.
      const already = await prisma.issue.count({
        where: {
          reporterPersonId: null,
          enteredByHandler: false,
          priority: { not: "URGENT" },
          createdAt: { gte: new Date(Date.now() - HOUR_MS) },
        },
      });
      const spare = NOTIFIED_PUBLIC_REPORTS_PER_HOUR - 1 - already;
      expect(spare).toBeGreaterThanOrEqual(0);
      await prisma.issue.createMany({
        data: Array.from({ length: spare }, (_, index) => ({
          id: `im-spent-public-${String(index)}-${suffix}`,
          typeId: unassignedType.id,
          statusId: unassignedType.statusIds.NEW,
          description: "Skräp",
        })),
      });

      const filed = await whilePublicReportingIsOn(() =>
        filedWhileBudgetIsCounted({
          reporterPersonId: null,
          held: unassignedType,
          lockKey: "issue-filing-budget:public-form",
          racing: () =>
            issues.reportPublicly({
              typeId: publicType.id,
              description: REPORTER_DESCRIPTION,
            }),
        }),
      );

      expect(
        await prisma.issue.count({
          where: { id: { in: [filed.held, filed.racing] } },
        }),
      ).toBe(2);
      expect(recipientsOf(await notices(filed.held)).get(admin.personId)).toBe(
        "filed",
      );
      expect(await notices(filed.racing)).toEqual([]);
    } finally {
      await outOfTheHourAgain();
    }
  });

  it("tells an assignee who became a recipient after the first look that the issue is urgent", async () => {
    const issueId = (
      await prisma.issue.create({
        data: {
          typeId: urgentType.id,
          statusId: urgentType.statusIds.NEW,
          priority: "URGENT",
          assigneePersonId: manager.personId,
          description: REPORTER_DESCRIPTION,
        },
        select: { id: true },
      })
    ).id;
    // The first look finds nobody, as if the assignee gained an address or was
    // no longer restricted between that look and the second one.
    vi.spyOn(
      mailer as unknown as { recipients: () => Promise<string[]> },
      "recipients",
    ).mockResolvedValueOnce([]);

    await prisma.$transaction((tx) => mailer.filedInTransaction(tx, issueId));

    expect(recipientsOf(await notices(issueId))).toEqual(
      new Map([[manager.personId, "urgent"]]),
    );
  });
});

describe("the slot-turn guard", () => {
  it("waits for the slot to turn when too little of it is left", async () => {
    const slotMs = REPEATED_NOTICE_SECONDS * 1000;
    const waitMs = 1_000;
    // Only the clock read is stubbed, so the wait itself still runs.
    const query = vi
      .spyOn(prisma, "$queryRawUnsafe")
      .mockResolvedValueOnce([{ nowMs: slotMs - waitMs }])
      .mockResolvedValueOnce([{ nowMs: slotMs }]);
    const startedAt = Date.now();

    await clearOfTheSlotTurn();

    expect(query).toHaveBeenCalledTimes(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(waitMs);
  });

  it("waits when a test's timeout and a millisecond of the slot is left", async () => {
    // Inside the margin: it holds a test's timeout, but not the margin above
    // it. Were the margin 0, this reading would start the test at once. The
    // wait is a fake timer's, as a real one would pass the test's timeout.
    const slotMs = REPEATED_NOTICE_SECONDS * 1000;
    const query = vi
      .spyOn(prisma, "$queryRawUnsafe")
      .mockResolvedValueOnce([{ nowMs: slotMs - TEST_TIMEOUT_MS - 1 }])
      .mockResolvedValueOnce([{ nowMs: slotMs }]);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const guard = clearOfTheSlotTurn();
      await vi.advanceTimersByTimeAsync(0);

      expect(query).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(TEST_TIMEOUT_MS + 101);
      await guard;

      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts at once when a test's worth of the slot is left", async () => {
    const slotMs = REPEATED_NOTICE_SECONDS * 1000;
    const query = vi
      .spyOn(prisma, "$queryRawUnsafe")
      .mockResolvedValueOnce([
        { nowMs: slotMs - TEST_TIMEOUT_MS - SLOT_MARGIN_MS },
      ]);

    await clearOfTheSlotTurn();

    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("a handler acts on an issue", () => {
  // Several tests here count on a notice and its repeat sharing a slot.
  beforeEach(async () => {
    await mailer.ensureQueues();
    await clearOfTheSlotTurn();
  }, TEST_TIMEOUT_MS + 15_000);

  it("mails a new assignee, and nobody who assigns an issue to themselves", async () => {
    const issueId = await report(unassignedType);
    const before = (await notices(issueId)).length;

    await issues.assign(issueId, manager.personId, board.personId);
    await issues.assign(issueId, board.personId, board.personId);
    // Assigned again to the person who has it: no change, so no mail.
    await issues.assign(issueId, board.personId, admin.personId);

    expect((await notices(issueId)).slice(before)).toEqual([
      {
        issueId,
        personId: manager.personId,
        event: "assigned",
        jobId: expect.any(String),
      },
    ]);
  });

  it("queues one assignment notice for an issue handed to somebody, away and back", async () => {
    const issueId = await report(unassignedType);
    const before = (await notices(issueId)).length;

    await issues.assign(issueId, manager.personId, board.personId);
    await issues.assign(issueId, admin.personId, board.personId);
    await issues.assign(issueId, manager.personId, board.personId);

    expect(
      (await notices(issueId))
        .slice(before)
        .map((job) => [job.personId, job.event]),
    ).toEqual([
      [manager.personId, "assigned"],
      [admin.personId, "assigned"],
    ]);
  });

  it("counts an assignment notice a repeat in the same clock hour drops as not queued", async () => {
    const issueId = await report(unassignedType);
    await mailer.ensureQueues();
    const assign = () =>
      prisma.$transaction((tx) =>
        mailer.assignedInTransaction(
          tx,
          issueId,
          manager.personId,
          board.personId,
        ),
      );

    expect(await assign()).toBe(1);
    // The same person for the same issue in the same clock hour: nothing is
    // queued.
    expect(await assign()).toBe(0);
  });

  it("queues one reopening notice for an issue reopened twice before it is delivered", async () => {
    const issueId = await report(assignedType);
    const close = () =>
      issues.setStatus(
        issueId,
        { statusId: assignedType.statusIds.DONE, outcome: "FIXED" },
        board.personId,
      );
    const reopen = () =>
      issues.setStatus(
        issueId,
        { statusId: assignedType.statusIds.IN_PROGRESS },
        board.personId,
      );
    await close();
    const before = (await notices(issueId)).length;

    await reopen();
    await close();
    await reopen();

    expect(
      (await notices(issueId))
        .slice(before)
        .map((job) => [job.personId, job.event]),
    ).toEqual([[manager.personId, "reopened"]]);
  });

  it("queues a new assignment notice once the first one was completed unsent, and sends it", async () => {
    const issueId = await report(unassignedType);
    const before = (await notices(issueId)).length;
    const sent = captureSends();

    await issues.assign(issueId, manager.personId, board.personId);
    const first = await lastNotice(issueId);
    await issues.assign(issueId, admin.personId, board.personId);
    // The worker takes the first notice while the issue is somebody else's,
    // sends nothing, and the queue completes it.
    await setNoticeState(first, "active");
    expect(await mailer.deliver(first)).toBe(false);
    await setNoticeState(first, "completed");
    expect(await holdsSlot(first)).toBe(false);

    await issues.assign(issueId, manager.personId, board.personId);

    const queued = (await notices(issueId)).slice(before);
    expect(queued.map((job) => [job.personId, job.event])).toEqual([
      [manager.personId, "assigned"],
      [admin.personId, "assigned"],
      [manager.personId, "assigned"],
    ]);
    expect(await mailer.deliver(queued[2] as IssueNoticeJob)).toBe(true);
    expect(sent.map((input) => input.to)).toEqual([manager.email]);
  });

  it("keeps the slot of an assignment notice that was sent", async () => {
    const issueId = await report(unassignedType);
    const before = (await notices(issueId)).length;
    const sent = captureSends();

    await issues.assign(issueId, manager.personId, board.personId);
    const first = await lastNotice(issueId);
    await setNoticeState(first, "active");
    expect(await mailer.deliver(first)).toBe(true);
    await setNoticeState(first, "completed");
    expect(sent).toHaveLength(1);

    await issues.assign(issueId, admin.personId, board.personId);
    await issues.assign(issueId, manager.personId, board.personId);

    // The manager was told in the same clock hour, and is not told again.
    expect(
      (await notices(issueId))
        .slice(before)
        .map((job) => [job.personId, job.event]),
    ).toEqual([
      [manager.personId, "assigned"],
      [admin.personId, "assigned"],
    ]);
  });

  it("queues a new assignment notice once the first one was given up on", async () => {
    const issueId = await report(unassignedType);
    const before = (await notices(issueId)).length;

    await issues.assign(issueId, manager.personId, board.personId);
    const first = await lastNotice(issueId);
    await setNoticeState(first, "failed");
    // What the dead letter carries: the job's own data.
    expect(await mailer.releaseNoticeSlot(first)).toBe(true);
    await issues.assign(issueId, admin.personId, board.personId);
    await issues.assign(issueId, manager.personId, board.personId);

    expect(
      (await notices(issueId))
        .slice(before)
        .map((job) => [job.personId, job.event]),
    ).toEqual([
      [manager.personId, "assigned"],
      [admin.personId, "assigned"],
      [manager.personId, "assigned"],
    ]);
  });

  it("queues a new reopening notice once the first one was completed unsent, and sends it", async () => {
    const issueId = await report(assignedType);
    const close = () =>
      issues.setStatus(
        issueId,
        { statusId: assignedType.statusIds.DONE, outcome: "FIXED" },
        board.personId,
      );
    const reopen = () =>
      issues.setStatus(
        issueId,
        { statusId: assignedType.statusIds.IN_PROGRESS },
        board.personId,
      );
    const sent = captureSends();
    await close();
    const before = (await notices(issueId)).length;

    await reopen();
    const first = await lastNotice(issueId);
    await close();
    // The issue is closed again when the worker looks, so nothing is sent.
    await setNoticeState(first, "active");
    expect(await mailer.deliver(first)).toBe(false);
    await setNoticeState(first, "completed");

    await reopen();

    const queued = (await notices(issueId)).slice(before);
    expect(queued.map((job) => [job.personId, job.event])).toEqual([
      [manager.personId, "reopened"],
      [manager.personId, "reopened"],
    ]);
    expect(await mailer.deliver(queued[1] as IssueNoticeJob)).toBe(true);
    expect(sent.map((input) => input.to)).toEqual([manager.email]);
  });

  it("sends a notice owed again by the time it settles its slot, and keeps the slot", async () => {
    const issueId = await report(unassignedType);
    const before = (await notices(issueId)).length;
    const sent = captureSends();

    await issues.assign(issueId, manager.personId, board.personId);
    const first = await lastNotice(issueId);
    await issues.assign(issueId, admin.personId, board.personId);
    await setNoticeState(first, "active");
    // The worker looks while the issue is the admin's. Before it takes the
    // issue's lock, the issue is handed back, and that queues nothing: the
    // first notice holds the slot.
    vi.spyOn(mailer, "releaseOverdueClaim").mockImplementationOnce(async () => {
      await issues.assign(issueId, manager.personId, board.personId);
    });
    expect(await mailer.deliver(first)).toBe(true);
    await setNoticeState(first, "completed");
    expect(sent.map((input) => input.to)).toEqual([manager.email]);
    expect(await holdsSlot(first)).toBe(true);

    // Away and back once more in the same clock hour: the manager has been
    // told.
    await issues.assign(issueId, admin.personId, board.personId);
    await issues.assign(issueId, manager.personId, board.personId);
    expect(
      (await notices(issueId))
        .slice(before)
        .map((job) => [job.personId, job.event]),
    ).toEqual([
      [manager.personId, "assigned"],
      [admin.personId, "assigned"],
    ]);
  });

  it("sends a reopening notice owed again by the time it settles its slot, and keeps the slot", async () => {
    const issueId = await report(assignedType);
    const close = () =>
      issues.setStatus(
        issueId,
        { statusId: assignedType.statusIds.DONE, outcome: "FIXED" },
        board.personId,
      );
    const reopen = () =>
      issues.setStatus(
        issueId,
        { statusId: assignedType.statusIds.IN_PROGRESS },
        board.personId,
      );
    const sent = captureSends();
    await close();
    const before = (await notices(issueId)).length;

    await reopen();
    const first = await lastNotice(issueId);
    await close();
    await setNoticeState(first, "active");
    vi.spyOn(mailer, "releaseOverdueClaim").mockImplementationOnce(async () => {
      await reopen();
    });
    expect(await mailer.deliver(first)).toBe(true);
    await setNoticeState(first, "completed");
    expect(sent.map((input) => input.to)).toEqual([manager.email]);

    await close();
    await reopen();
    expect(
      (await notices(issueId))
        .slice(before)
        .map((job) => [job.personId, job.event]),
    ).toEqual([[manager.personId, "reopened"]]);
  });

  it("sends nothing for a notice whose slot an assignment waits on, and lets that assignment queue its own", async () => {
    const issueId = await report(unassignedType);
    const before = (await notices(issueId)).length;
    const sent = captureSends();

    await issues.assign(issueId, manager.personId, board.personId);
    const first = await lastNotice(issueId);
    await issues.assign(issueId, admin.personId, board.personId);
    await setNoticeState(first, "active");
    // While the first notice gives its slot back under the issue's lock, the
    // issue is handed back to the manager, and that waits for the lock.
    const jobs = app.get(JobQueueService);
    const release = jobs.releaseSingleton.bind(jobs);
    let handedBack: Promise<unknown> | undefined;
    vi.spyOn(jobs, "releaseSingleton").mockImplementationOnce(
      async (...args) => {
        handedBack = issues.assign(issueId, manager.personId, board.personId);
        await untilWaitingForIssueLock(issueId);
        return release(...args);
      },
    );
    expect(await mailer.deliver(first)).toBe(false);
    await handedBack;
    await setNoticeState(first, "completed");
    expect(sent).toEqual([]);

    const queued = (await notices(issueId)).slice(before);
    expect(queued.map((job) => [job.personId, job.event])).toEqual([
      [manager.personId, "assigned"],
      [admin.personId, "assigned"],
      [manager.personId, "assigned"],
    ]);
    expect(await mailer.deliver(queued[2] as IssueNoticeJob)).toBe(true);
    expect(sent.map((input) => input.to)).toEqual([manager.email]);
  });

  it("leaves a notice that finds the issue changed after every look to its retry, holding its slot", async () => {
    const issueId = await report(unassignedType);
    await issues.assign(issueId, manager.personId, board.personId);
    const first = await lastNotice(issueId);
    await setNoticeState(first, "active");
    // Every look finds the notice not owed, as though the issue were handed
    // away each time after the lock found it owed and before the look.
    const look = vi
      .spyOn(mailer as unknown as { send: IssueMailer["deliver"] }, "send")
      .mockResolvedValue("notOwed" as never);

    await expect(mailer.deliver(first)).rejects.toThrow(/retried/);
    expect(look).toHaveBeenCalledTimes(3);
    expect(await holdsSlot(first)).toBe(true);
  });

  it("gives back the slot of the notice given up on, and not a later one's of the same person", async () => {
    const issueId = await report(unassignedType);
    const before = (await notices(issueId)).length;
    const sent = captureSends();

    await issues.assign(issueId, manager.personId, board.personId);
    const older = await lastNotice(issueId);
    // Its retries ran into the next hour's slot, where the issue is handed
    // away and back, and that queues a notice of its own.
    await prisma.$executeRawUnsafe(
      "UPDATE pgboss.job SET singleton_on = singleton_on - interval '1 hour' WHERE name = $1 AND id::text = $2",
      ISSUE_NOTICE_QUEUE,
      older.jobId,
    );
    await issues.assign(issueId, admin.personId, board.personId);
    await issues.assign(issueId, manager.personId, board.personId);
    const newer = await lastNotice(issueId);
    expect(newer.jobId).not.toBe(older.jobId);
    expect(newer.personId).toBe(manager.personId);
    await setNoticeState(newer, "active");

    // The older one is given up on, and its dead letter gives back its slot.
    await setNoticeState(older, "failed");
    expect(await mailer.releaseNoticeSlot(older)).toBe(true);
    expect(await holdsSlot(older)).toBe(false);
    expect(await holdsSlot(newer)).toBe(true);

    expect(await mailer.deliver(newer)).toBe(true);
    await setNoticeState(newer, "completed");
    expect(sent.map((input) => input.to)).toEqual([manager.email]);

    // The newer notice was sent in the same clock hour as the repeat, and still
    // keeps it out.
    await issues.assign(issueId, admin.personId, board.personId);
    await issues.assign(issueId, manager.personId, board.personId);
    expect(
      (await notices(issueId))
        .slice(before)
        .map((job) => [job.personId, job.event]),
    ).toEqual([
      [manager.personId, "assigned"],
      [admin.personId, "assigned"],
      [manager.personId, "assigned"],
    ]);
  });

  it("does not mail an assignee whose processing is restricted", async () => {
    const issueId = await report(unassignedType);
    const before = (await notices(issueId)).length;

    await issues.assign(issueId, restricted.personId, board.personId);

    expect((await notices(issueId)).slice(before)).toEqual([]);
  });

  it("mails every handler but the actor when the issue is raised to Akut, and nobody when it is lowered", async () => {
    const issueId = await report(assignedType);
    const before = (await notices(issueId)).length;

    await issues.setPriority(issueId, "URGENT", board.personId);
    const raised = recipientsOf((await notices(issueId)).slice(before));
    expect(raised.get(admin.personId)).toBe("urgent");
    expect(raised.get(manager.personId)).toBe("urgent");
    expect(raised.has(board.personId)).toBe(false);
    expect(raised.has(restricted.personId)).toBe(false);

    const afterRaise = (await notices(issueId)).length;
    await issues.setPriority(issueId, "URGENT", admin.personId);
    await issues.setPriority(issueId, "LOW", admin.personId);
    expect(await notices(issueId)).toHaveLength(afterRaise);
  });

  it("mails the assignee when a closed issue is reopened, and not the handler who reopened it", async () => {
    const issueId = await report(assignedType);
    await issues.setStatus(
      issueId,
      { statusId: assignedType.statusIds.DONE, outcome: "FIXED" },
      board.personId,
    );
    const before = (await notices(issueId)).length;

    await issues.setStatus(
      issueId,
      { statusId: assignedType.statusIds.IN_PROGRESS },
      board.personId,
    );
    expect((await notices(issueId)).slice(before)).toEqual([
      {
        issueId,
        personId: manager.personId,
        event: "reopened",
        jobId: expect.any(String),
      },
    ]);

    // The assignee reopening it themselves is told nothing.
    await issues.setStatus(
      issueId,
      { statusId: assignedType.statusIds.DONE, outcome: "FIXED" },
      manager.personId,
    );
    const reopenedOnce = (await notices(issueId)).length;
    await issues.setStatus(
      issueId,
      { statusId: assignedType.statusIds.NEW },
      manager.personId,
    );
    expect(await notices(issueId)).toHaveLength(reopenedOnce);
  });

  it("mails every handler about a reopened issue nobody is assigned", async () => {
    const issueId = await report(unassignedType);
    await issues.setStatus(
      issueId,
      { statusId: unassignedType.statusIds.DONE, outcome: "NO_FAULT" },
      board.personId,
    );
    const before = (await notices(issueId)).length;

    await issues.setStatus(
      issueId,
      { statusId: unassignedType.statusIds.NEW },
      board.personId,
    );

    const told = recipientsOf((await notices(issueId)).slice(before));
    expect(told.get(admin.personId)).toBe("reopened");
    expect(told.get(manager.personId)).toBe("reopened");
    expect(told.has(board.personId)).toBe(false);
  });
});

describe("an issue message", () => {
  it("from the reporter is mailed to the assignee, and from a handler to the reporter", async () => {
    const issueId = await report(assignedType);
    const before = (await notices(issueId)).length;
    const fromReporter = await storeMessage(
      issueId,
      { side: "REPORTER" },
      "A message from the reporter.",
    );
    const fromHandler = await storeMessage(
      issueId,
      {
        side: "HANDLER",
        personId: manager.personId,
        signature: "PROPERTY_MANAGER",
      },
      "A reply from a handler.",
    );

    await mailer.ensureQueues();
    await prisma.$transaction((tx) =>
      mailer.messageInTransaction(tx, issueId, {
        kind: "reporter",
        messageId: fromReporter,
      }),
    );
    await prisma.$transaction((tx) =>
      mailer.messageInTransaction(tx, issueId, {
        kind: "handler",
        personId: manager.personId,
        messageId: fromHandler,
      }),
    );

    expect((await notices(issueId)).slice(before)).toEqual([
      {
        issueId,
        personId: manager.personId,
        event: "message",
        messageId: fromReporter,
      },
      {
        issueId,
        personId: resident.personId,
        event: "reporterMessage",
        messageId: fromHandler,
      },
    ]);
  });

  it("is not mailed about once the free-text purge has erased it, from either side", async () => {
    const issueId = await report(assignedType);
    await mailer.ensureQueues();
    const written = await storeMessage(
      issueId,
      { side: "REPORTER" },
      "A message the purge will erase.",
    );
    const kept = await storeMessage(
      issueId,
      { side: "REPORTER" },
      "A message that stays.",
    );
    const keptByHandler = await storeMessage(
      issueId,
      {
        side: "HANDLER",
        personId: manager.personId,
        signature: "PROPERTY_MANAGER",
      },
      "A handler reply that stays.",
    );
    const before = (await notices(issueId)).length;
    await prisma.$transaction(async (tx) => {
      await mailer.messageInTransaction(tx, issueId, {
        kind: "reporter",
        messageId: written,
      });
      await mailer.messageInTransaction(tx, issueId, {
        kind: "handler",
        personId: manager.personId,
        messageId: written,
      });
      await mailer.messageInTransaction(tx, issueId, {
        kind: "reporter",
        messageId: kept,
      });
      await mailer.messageInTransaction(tx, issueId, {
        kind: "handler",
        personId: manager.personId,
        messageId: keptByHandler,
      });
    });
    const queued = (await notices(issueId)).slice(before);
    const noticeOf = (messageId: string, event: string): IssueNoticeJob => {
      const found = queued.find(
        (job) => job.messageId === messageId && job.event === event,
      );
      if (found === undefined) {
        throw new Error(`No ${event} notice for message ${messageId}.`);
      }
      return found;
    };
    expect(queued).toHaveLength(4);

    await prisma.issueMessage.delete({ where: { id: written } });
    const sent = captureSends();
    expect(await mailer.deliver(noticeOf(written, "message"))).toBe(false);
    expect(await mailer.deliver(noticeOf(written, "reporterMessage"))).toBe(
      false,
    );
    expect(sent).toHaveLength(0);
    expect(await mailer.deliver(noticeOf(kept, "message"))).toBe(true);
    expect(
      await mailer.deliver(noticeOf(keptByHandler, "reporterMessage")),
    ).toBe(true);
    expect(sent.map((input) => input.to)).toEqual([
      manager.email,
      resident.email,
    ]);
  });

  it("from one reporter is mailed about up to their hour's budget across their issues, written at once or not, and stored past it", async () => {
    const conversation = app.get(IssueConversationService);
    const first = await report(assignedType);
    const second = await report(assignedType);
    const { id: theirs } = await issues.report(neighbourPrincipal, {
      typeId: unassignedType.id,
      description: REPORTER_DESCRIPTION,
    });
    await outOfTheHour([theirs]);
    const mine = [first, second];
    let count = 0;
    const write = (issueId: string) => {
      count += 1;
      return conversation.replyAsReporter(
        resident.personId,
        issueId,
        `${REPORTER_DESCRIPTION} (${count})`,
      );
    };
    /** The message notices queued for the resident's issues. */
    const toldOfMessages = async (): Promise<IssueNoticeJob[]> =>
      (await Promise.all(mine.map((issueId) => notices(issueId))))
        .flat()
        .filter((job) => job.event === "message");

    try {
      // All but the last of the budget one after the other, on both issues.
      for (
        let index = 0;
        index < NOTIFIED_MESSAGES_PER_REPORTER_PER_HOUR - 1;
        index += 1
      ) {
        await write(mine[index % 2] as string);
      }

      // The last of the budget is stored and counted on the first issue, and
      // its transaction is kept open while a message on the second issue
      // counts. That one has to wait for the reporter's budget lock: counting
      // without it, it would not see the first and be mailed about too.
      // The write on the second issue is handled from the moment it starts: a
      // rejection is recorded here, never left unhandled while the transaction
      // is open, and thrown once the transaction is over.
      const racing: { ended?: Promise<void>; failure?: { error: unknown } } =
        {};
      await mailer.ensureQueues();
      try {
        await prisma.$transaction(
          async (tx) => {
            count += 1;
            const { id: messageId } = await tx.issueMessage.create({
              data: {
                issueId: first,
                side: "REPORTER",
                authorPersonId: resident.personId,
                body: `${REPORTER_DESCRIPTION} (${count})`,
              },
              select: { id: true },
            });
            expect(
              await mailer.messageInTransaction(tx, first, {
                kind: "reporter",
                messageId,
              }),
            ).toBe(1);
            racing.ended = write(second).then(
              () => undefined,
              (error: unknown) => {
                racing.failure = { error };
              },
            );
            await untilWaitingForLock(
              `issue-message-budget:person:${resident.personId}`,
              "the reporter's message budget lock",
            );
          },
          // Longer than the helper's own deadline, so a lock nobody waits for
          // fails with the helper's message, not the transaction's timeout.
          { timeout: LOCK_WAIT_DEADLINE_MS + 5_000 },
        );
      } catch (error) {
        // The transaction has rolled back and let go of the lock, so the write
        // that waited for it ends. Give it a moment, no longer: a write stuck
        // on something else must not hold the failure that matters back until
        // the suite's timeout.
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          racing.ended,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2_000);
          }),
        ]);
        clearTimeout(timer);
        throw error;
      }
      await racing.ended;
      if (racing.failure !== undefined) {
        throw racing.failure.error;
      }

      // Four more at once, two on each issue, all past the budget.
      await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          write(mine[index % 2] as string),
        ),
      );

      const told = await toldOfMessages();
      expect(told).toHaveLength(NOTIFIED_MESSAGES_PER_REPORTER_PER_HOUR);
      expect(new Set(told.map((job) => job.personId))).toEqual(
        new Set([manager.personId]),
      );
      // Every message is stored and in the conversation all the same.
      const threads = await Promise.all(
        mine.map((issueId) =>
          conversation.reporterThread(resident.personId, issueId),
        ),
      );
      expect(threads.flat()).toHaveLength(count);
      expect(count).toBe(NOTIFIED_MESSAGES_PER_REPORTER_PER_HOUR + 5);

      // Another reporter's budget is their own.
      const before = (await notices(theirs)).length;
      await conversation.replyAsReporter(
        neighbour.personId,
        theirs,
        REPORTER_DESCRIPTION,
      );
      const toldOfTheirs = recipientsOf((await notices(theirs)).slice(before));
      expect(toldOfTheirs.get(admin.personId)).toBe("message");
      expect(toldOfTheirs.get(manager.personId)).toBe("message");

      // Once the messages are out of the hour, the next is mailed about again.
      await prisma.issueMessage.updateMany({
        where: { issueId: { in: mine } },
        data: { createdAt: new Date(Date.now() - 2 * HOUR_MS) },
      });
      await write(first);
      expect(await toldOfMessages()).toHaveLength(
        NOTIFIED_MESSAGES_PER_REPORTER_PER_HOUR + 1,
      );
    } finally {
      // Out of the hour, so no later test finds the budget spent.
      await prisma.issueMessage.updateMany({
        where: { issueId: { in: [...mine, theirs] } },
        data: { createdAt: new Date(Date.now() - 2 * HOUR_MS) },
      });
    }
  });
});

describe("the overdue reminder", () => {
  it("is queued for the morning after the target date", async () => {
    const issueId = await report(assignedType);
    const target = addLocalDays(today(), 3);

    await issues.setTargetDate(issueId, formatLocalDay(target), board.personId);

    const [job] = await overdueJobs(issueId);
    expect(job?.data).toEqual({ issueId, targetDate: formatLocalDay(target) });
    // 07:00 local time the day after, not merely that day.
    expect(new Date(job?.start_after ?? 0).getTime()).toBe(
      instantAt(addLocalDays(target, 1), 7 * 60)?.getTime(),
    );
  });

  it("reminds the assignee once for each target date that has passed", async () => {
    const issueId = await report(assignedType);
    const yesterday = formatLocalDay(addLocalDays(today(), -1));
    await issues.setTargetDate(issueId, yesterday, board.personId);
    const before = (await notices(issueId)).length;

    const job = { issueId, targetDate: yesterday };
    expect(await mailer.remindOverdue(job)).toBe(true);
    // The same job again, and a second one for the same date: claimed.
    expect(await mailer.remindOverdue(job)).toBe(false);
    expect(await mailer.remindOverdue({ ...job })).toBe(false);
    expect((await notices(issueId)).slice(before)).toEqual([
      {
        issueId,
        personId: manager.personId,
        event: "overdue",
        targetDate: yesterday,
      },
    ]);

    // Moved away and back to the same date: still reminded once.
    await issues.setTargetDate(
      issueId,
      formatLocalDay(addLocalDays(today(), 5)),
      board.personId,
    );
    await issues.setTargetDate(issueId, yesterday, board.personId);
    expect(await mailer.remindOverdue(job)).toBe(false);

    // A new date that passes is a new period, reminded of its own.
    const lastWeek = formatLocalDay(addLocalDays(today(), -7));
    await issues.setTargetDate(issueId, lastWeek, board.personId);
    expect(await mailer.remindOverdue({ issueId, targetDate: lastWeek })).toBe(
      true,
    );
    expect((await notices(issueId)).slice(before)).toHaveLength(2);
  });

  it("reminds once for a date moved away and back after both dates were reminded", async () => {
    const issueId = await report(assignedType);
    const before = (await notices(issueId)).length;
    const dateA = formatLocalDay(addLocalDays(today(), -2));
    const dateB = formatLocalDay(addLocalDays(today(), -1));

    await issues.setTargetDate(issueId, dateA, board.personId);
    expect(await mailer.remindOverdue({ issueId, targetDate: dateA })).toBe(
      true,
    );
    await issues.setTargetDate(issueId, dateB, board.personId);
    expect(await mailer.remindOverdue({ issueId, targetDate: dateB })).toBe(
      true,
    );

    // Back to A: its reminder went out before B's, and B's must not erase it.
    await issues.setTargetDate(issueId, dateA, board.personId);
    expect(await mailer.remindOverdue({ issueId, targetDate: dateA })).toBe(
      false,
    );
    expect(
      (await notices(issueId))
        .slice(before)
        .map((job) => [job.event, job.targetDate]),
    ).toEqual([
      ["overdue", dateA],
      ["overdue", dateB],
    ]);
  });

  it("reminds the assignee given an issue after its job found nobody assigned", async () => {
    const issueId = await report(unassignedType);
    const yesterday = formatLocalDay(addLocalDays(today(), -1));
    await issues.setTargetDate(issueId, yesterday, board.personId);
    const job = { issueId, targetDate: yesterday };
    // The morning's job runs with nobody to remind and claims nothing.
    expect(await mailer.remindOverdue(job)).toBe(false);
    const queuedBefore = (await overdueJobs(issueId)).length;

    await issues.assign(issueId, manager.personId, board.personId);

    expect(await overdueJobs(issueId)).toHaveLength(queuedBefore + 1);
    expect(await mailer.remindOverdue(job)).toBe(true);
    // Given on to somebody else: the date is claimed, so no second reminder.
    await issues.assign(issueId, admin.personId, board.personId);
    expect(await overdueJobs(issueId)).toHaveLength(queuedBefore + 1);
    expect(await mailer.remindOverdue(job)).toBe(false);
  });

  it("does not queue the reminder again when the date has not passed or the actor takes the issue themselves", async () => {
    const future = await report(unassignedType);
    await issues.setTargetDate(
      future,
      formatLocalDay(addLocalDays(today(), 3)),
      board.personId,
    );
    const futureJobs = (await overdueJobs(future)).length;
    await issues.assign(future, manager.personId, board.personId);
    expect(await overdueJobs(future)).toHaveLength(futureJobs);

    const past = await report(unassignedType);
    await issues.setTargetDate(
      past,
      formatLocalDay(addLocalDays(today(), -1)),
      board.personId,
    );
    const pastJobs = (await overdueJobs(past)).length;
    await issues.assign(past, board.personId, board.personId);
    expect(await overdueJobs(past)).toHaveLength(pastJobs);
  });

  it("sends nothing for a stale job, a date not yet passed, a closed issue or one nobody is assigned", async () => {
    const issueId = await report(assignedType);
    const yesterday = formatLocalDay(addLocalDays(today(), -1));
    const tomorrow = formatLocalDay(addLocalDays(today(), 1));

    // Queued for yesterday, and the date moved since: stale.
    await issues.setTargetDate(issueId, tomorrow, board.personId);
    expect(await mailer.remindOverdue({ issueId, targetDate: yesterday })).toBe(
      false,
    );
    // Today is not past it yet.
    expect(await mailer.remindOverdue({ issueId, targetDate: tomorrow })).toBe(
      false,
    );

    await issues.setTargetDate(issueId, yesterday, board.personId);
    await issues.setStatus(
      issueId,
      { statusId: assignedType.statusIds.DONE, outcome: "FIXED" },
      board.personId,
    );
    expect(await mailer.remindOverdue({ issueId, targetDate: yesterday })).toBe(
      false,
    );

    const unassigned = await report(unassignedType);
    await issues.setTargetDate(unassigned, yesterday, board.personId);
    expect(
      await mailer.remindOverdue({
        issueId: unassigned,
        targetDate: yesterday,
      }),
    ).toBe(false);
  });

  it("is queued again when a closed issue past its date is reopened", async () => {
    const issueId = await report(assignedType);
    const yesterday = formatLocalDay(addLocalDays(today(), -1));
    await issues.setTargetDate(issueId, yesterday, board.personId);
    await issues.setStatus(
      issueId,
      { statusId: assignedType.statusIds.DONE, outcome: "FIXED" },
      board.personId,
    );
    expect(await mailer.remindOverdue({ issueId, targetDate: yesterday })).toBe(
      false,
    );
    const queuedBefore = (await overdueJobs(issueId)).length;

    await issues.setStatus(
      issueId,
      { statusId: assignedType.statusIds.IN_PROGRESS },
      board.personId,
    );

    expect(await overdueJobs(issueId)).toHaveLength(queuedBefore + 1);
    expect(
      await mailer.remindOverdue(await lastOverdueJob(issueId, yesterday)),
    ).toBe(true);
  });
});

describe("an overdue reminder that is never sent", () => {
  /** An issue past its date, its reminder claimed and its notice queued. */
  async function remindedIssue(): Promise<{
    issueId: string;
    targetDate: string;
    notice: IssueNoticeJob;
  }> {
    const issueId = await report(assignedType);
    const targetDate = formatLocalDay(addLocalDays(today(), -1));
    await issues.setTargetDate(issueId, targetDate, board.personId);
    expect(await mailer.remindOverdue({ issueId, targetDate })).toBe(true);
    const notice = (await notices(issueId)).at(-1);
    expect(notice?.event).toBe("overdue");
    return { issueId, targetDate, notice: notice as IssueNoticeJob };
  }

  const claimed = async (issueId: string): Promise<string[]> =>
    (
      await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { overdueRemindedFor: true },
      })
    ).overdueRemindedFor.map((day) => formatLocalDay(localDayOfColumn(day)));

  it("keeps its claim once the mail is sent", async () => {
    const { issueId, targetDate, notice } = await remindedIssue();
    captureSends();

    expect(await mailer.deliver(notice)).toBe(true);

    expect(await claimed(issueId)).toEqual([targetDate]);
  });

  it("gives the date back, and reminds the new assignee, when the issue was handed on", async () => {
    const { issueId, targetDate, notice } = await remindedIssue();
    const sent = captureSends();
    await issues.assign(issueId, admin.personId, board.personId);
    const queuedBefore = (await overdueJobs(issueId)).length;

    expect(await mailer.deliver(notice)).toBe(false);

    expect(sent).toEqual([]);
    expect(await claimed(issueId)).toEqual([]);
    expect(await overdueJobs(issueId)).toHaveLength(queuedBefore + 1);
    expect(
      await mailer.remindOverdue(await lastOverdueJob(issueId, targetDate)),
    ).toBe(true);
    expect((await notices(issueId)).at(-1)).toEqual({
      issueId,
      personId: admin.personId,
      event: "overdue",
      targetDate,
    });
  });

  it("gives the date back, without queueing it again, when the instance has no mail settings", async () => {
    const { issueId, notice } = await remindedIssue();
    vi.spyOn(mail, "send").mockRejectedValue(new MailNotConfiguredError());
    const queuedBefore = (await overdueJobs(issueId)).length;

    expect(await mailer.deliver(notice)).toBe(false);

    expect(await claimed(issueId)).toEqual([]);
    expect(await overdueJobs(issueId)).toHaveLength(queuedBefore);
  });

  it("gives the date back, and reminds the same assignee at their new address, when it changed while it was decrypted", async () => {
    const { issueId, targetDate, notice } = await remindedIssue();
    const sent = captureSends();
    const encryption = app.get(FieldEncryptionService);
    const decrypt = encryption.decrypt.bind(encryption);
    const before = await prisma.person.findUniqueOrThrow({
      where: { id: manager.personId },
      select: { emailCipher: true },
    });
    const moved = `moved-${randomUUID()}@example.test`;
    const spy = vi
      .spyOn(encryption, "decrypt")
      .mockImplementationOnce(async (...args) => {
        const plain = await decrypt(...args);
        // The address is changed after the first read found it.
        await prisma.person.update({
          where: { id: manager.personId },
          data: {
            emailCipher: (await encryption.encrypt("person.email", moved))
              .cipher,
          },
        });
        return plain;
      });
    try {
      const queuedBefore = (await overdueJobs(issueId)).length;

      expect(await mailer.deliver(notice)).toBe(false);

      expect(sent).toEqual([]);
      expect(await claimed(issueId)).toEqual([]);
      expect(await overdueJobs(issueId)).toHaveLength(queuedBefore + 1);
      expect(
        await mailer.remindOverdue(await lastOverdueJob(issueId, targetDate)),
      ).toBe(true);
      const again = await lastNotice(issueId);
      expect(again).toEqual({
        issueId,
        personId: manager.personId,
        event: "overdue",
        targetDate,
      });
      expect(await mailer.deliver(again)).toBe(true);
      expect(sent.map((input) => input.to)).toEqual([moved]);
      expect(await claimed(issueId)).toEqual([targetDate]);
    } finally {
      spy.mockRestore();
      await prisma.person.update({
        where: { id: manager.personId },
        data: { emailCipher: before.emailCipher },
      });
    }
  });

  it("gives the date back, and claims nothing again while the same assignee is still restricted, when they were restricted while it was decrypted", async () => {
    const { issueId, targetDate, notice } = await remindedIssue();
    const sent = captureSends();
    const encryption = app.get(FieldEncryptionService);
    const decrypt = encryption.decrypt.bind(encryption);
    const spy = vi
      .spyOn(encryption, "decrypt")
      .mockImplementationOnce(async (...args) => {
        const plain = await decrypt(...args);
        // The restriction is granted after the first read found them in reach.
        await prisma.person.update({
          where: { id: manager.personId },
          data: { processingRestrictedAt: new Date() },
        });
        return plain;
      });
    try {
      const queuedBefore = (await overdueJobs(issueId)).length;

      expect(await mailer.deliver(notice)).toBe(false);

      expect(sent).toEqual([]);
      expect(await claimed(issueId)).toEqual([]);
      expect(await overdueJobs(issueId)).toHaveLength(queuedBefore + 1);
      // Still restricted when the job queued again runs: nothing is claimed,
      // and nothing more is queued.
      const noticesBefore = (await notices(issueId)).length;
      expect(
        await mailer.remindOverdue(await lastOverdueJob(issueId, targetDate)),
      ).toBe(false);
      expect(await claimed(issueId)).toEqual([]);
      expect(await notices(issueId)).toHaveLength(noticesBefore);
      expect(await overdueJobs(issueId)).toHaveLength(queuedBefore + 1);
    } finally {
      spy.mockRestore();
      await prisma.person.update({
        where: { id: manager.personId },
        data: { processingRestrictedAt: null },
      });
    }
  });

  it("reminds the same assignee when the job queued again runs after their restriction is lifted", async () => {
    const { issueId, targetDate, notice } = await remindedIssue();
    const sent = captureSends();
    const encryption = app.get(FieldEncryptionService);
    const decrypt = encryption.decrypt.bind(encryption);
    const spy = vi
      .spyOn(encryption, "decrypt")
      .mockImplementationOnce(async (...args) => {
        const plain = await decrypt(...args);
        await prisma.person.update({
          where: { id: manager.personId },
          data: { processingRestrictedAt: new Date() },
        });
        return plain;
      });
    try {
      const queuedBefore = (await overdueJobs(issueId)).length;

      expect(await mailer.deliver(notice)).toBe(false);

      expect(sent).toEqual([]);
      expect(await claimed(issueId)).toEqual([]);
      expect(await overdueJobs(issueId)).toHaveLength(queuedBefore + 1);
      // The restriction is lifted before the job queued again runs.
      await prisma.person.update({
        where: { id: manager.personId },
        data: { processingRestrictedAt: null },
      });
      expect(
        await mailer.remindOverdue(await lastOverdueJob(issueId, targetDate)),
      ).toBe(true);
      const again = await lastNotice(issueId);
      expect(again).toEqual({
        issueId,
        personId: manager.personId,
        event: "overdue",
        targetDate,
      });
      expect(await mailer.deliver(again)).toBe(true);
      expect(sent.map((input) => input.to)).toEqual([manager.email]);
      expect(await claimed(issueId)).toEqual([targetDate]);
    } finally {
      spy.mockRestore();
      await prisma.person.update({
        where: { id: manager.personId },
        data: { processingRestrictedAt: null },
      });
    }
  });

  it("gives the date back, without queueing it again for the same assignee, when the delivery is given up on after its retries", async () => {
    const { issueId, notice } = await remindedIssue();
    const queuedBefore = (await overdueJobs(issueId)).length;

    await mailer.releaseOverdueClaim(notice);

    expect(await claimed(issueId)).toEqual([]);
    expect(await overdueJobs(issueId)).toHaveLength(queuedBefore);
  });

  it("gives back no date that a reminder of another notice or another date claimed", async () => {
    const { issueId, targetDate, notice } = await remindedIssue();

    await mailer.releaseOverdueClaim({ ...notice, event: "assigned" });
    await mailer.releaseOverdueClaim({ ...notice, targetDate: "2000-01-01" });

    expect(await claimed(issueId)).toEqual([targetDate]);
  });
});

describe("delivering a mail", () => {
  it("sends nothing to a person whose processing became restricted after it was queued", async () => {
    const issueId = await report(unassignedType);
    const sent = captureSends();
    await prisma.person.update({
      where: { id: admin.personId },
      data: { processingRestrictedAt: new Date() },
    });
    try {
      expect(
        await mailer.deliver({
          issueId,
          personId: admin.personId,
          event: "filed",
        }),
      ).toBe(false);
    } finally {
      await prisma.person.update({
        where: { id: admin.personId },
        data: { processingRestrictedAt: null },
      });
    }
    expect(sent).toEqual([]);
  });

  it("sends nothing to a person whose processing became restricted while the address was decrypted", async () => {
    const issueId = await report(unassignedType);
    const sent = captureSends();
    const encryption = app.get(FieldEncryptionService);
    const decrypt = encryption.decrypt.bind(encryption);
    const spy = vi
      .spyOn(encryption, "decrypt")
      .mockImplementation(async (...args) => {
        const plain = await decrypt(...args);
        // The restriction is granted after the first read found them eligible.
        await prisma.person.update({
          where: { id: admin.personId },
          data: { processingRestrictedAt: new Date() },
        });
        return plain;
      });
    try {
      expect(
        await mailer.deliver({
          issueId,
          personId: admin.personId,
          event: "filed",
        }),
      ).toBe(false);
    } finally {
      spy.mockRestore();
      await prisma.person.update({
        where: { id: admin.personId },
        data: { processingRestrictedAt: null },
      });
    }
    expect(sent).toEqual([]);
  });

  it("sends nothing to an address that was changed while it was decrypted", async () => {
    const issueId = await report(unassignedType);
    const sent = captureSends();
    const encryption = app.get(FieldEncryptionService);
    const decrypt = encryption.decrypt.bind(encryption);
    const before = await prisma.person.findUniqueOrThrow({
      where: { id: admin.personId },
      select: { emailCipher: true },
    });
    const spy = vi
      .spyOn(encryption, "decrypt")
      .mockImplementation(async (...args) => {
        const plain = await decrypt(...args);
        // The address is changed after the first read found it.
        await prisma.person.update({
          where: { id: admin.personId },
          data: {
            emailCipher: (
              await encryption.encrypt(
                "person.email",
                `moved-${randomUUID()}@example.test`,
              )
            ).cipher,
          },
        });
        return plain;
      });
    try {
      expect(
        await mailer.deliver({
          issueId,
          personId: admin.personId,
          event: "filed",
        }),
      ).toBe(false);
    } finally {
      spy.mockRestore();
      await prisma.person.update({
        where: { id: admin.personId },
        data: { emailCipher: before.emailCipher },
      });
    }
    expect(sent).toEqual([]);
  });

  it("asks again by the time it is when the address was decrypted, so a seat that ended meanwhile is not mailed", async () => {
    const issueId = await report(unassignedType);
    const sent = captureSends();
    const encryption = app.get(FieldEncryptionService);
    const decrypt = encryption.decrypt.bind(encryption);
    const spy = vi
      .spyOn(encryption, "decrypt")
      .mockImplementation(async (...args) => {
        const plain = await decrypt(...args);
        // The seat ends after the first read found it held. An end date is a
        // whole day, so the job's own earlier instant would still call it held.
        await prisma.boardPosition.updateMany({
          where: { personId: board.personId },
          data: { endedOn: new Date("2025-06-01") },
        });
        return plain;
      });
    try {
      expect(
        await mailer.deliver(
          { issueId, personId: board.personId, event: "filed" },
          new Date("2025-05-20T10:00:00Z"),
        ),
      ).toBe(false);
    } finally {
      spy.mockRestore();
      await prisma.boardPosition.updateMany({
        where: { personId: board.personId },
        data: { endedOn: null },
      });
    }
    expect(sent).toEqual([]);
  });

  it("sends nothing to the property manager once the issue became board-only while the address was decrypted", async () => {
    const issueId = await report(unassignedType);
    const sent = captureSends();
    const encryption = app.get(FieldEncryptionService);
    const decrypt = encryption.decrypt.bind(encryption);
    const spy = vi
      .spyOn(encryption, "decrypt")
      .mockImplementation(async (...args) => {
        const plain = await decrypt(...args);
        // Committed after the first read found the manager eligible.
        await prisma.issue.update({
          where: { id: issueId },
          data: { boardOnly: true },
        });
        return plain;
      });
    try {
      expect(
        await mailer.deliver({
          issueId,
          personId: manager.personId,
          event: "filed",
        }),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(sent).toEqual([]);
  });

  it("sends nothing once what it tells of stopped being so", async () => {
    const issueId = await report(urgentType);
    const sent = captureSends();

    await issues.assign(issueId, manager.personId, admin.personId);
    await issues.setPriority(issueId, "NORMAL", admin.personId);

    // Queued when it was the board member's and Akut; neither holds now.
    expect(
      await mailer.deliver({
        issueId,
        personId: board.personId,
        event: "assigned",
      }),
    ).toBe(false);
    expect(
      await mailer.deliver({
        issueId,
        personId: admin.personId,
        event: "urgent",
      }),
    ).toBe(false);
    expect(sent).toEqual([]);
  });

  it("drops a notice to the handlers of an unassigned issue once somebody is assigned", async () => {
    const issueId = await report(unassignedType);
    const sent = captureSends();
    const filed = {
      issueId,
      personId: admin.personId,
      event: "filed",
    } as const;

    expect(await mailer.deliver(filed)).toBe(true);
    expect(sent).toHaveLength(1);

    await issues.assign(issueId, manager.personId, board.personId);

    // "Nobody is assigned" is untrue now, for the handler and the assignee.
    expect(await mailer.deliver(filed)).toBe(false);
    expect(await mailer.deliver({ ...filed, personId: manager.personId })).toBe(
      false,
    );
    expect(sent).toHaveLength(1);
  });

  it("drops a reopening or message notice for somebody the issue is no longer assigned to", async () => {
    const issueId = await report(assignedType);
    const sent = captureSends();

    for (const event of ["reopened", "message"] as const) {
      expect(
        await mailer.deliver({ issueId, personId: manager.personId, event }),
      ).toBe(true);
    }
    expect(sent).toHaveLength(2);

    await issues.assign(issueId, admin.personId, board.personId);

    for (const event of ["reopened", "message"] as const) {
      // Queued for the manager, who is no longer the assignee.
      expect(
        await mailer.deliver({ issueId, personId: manager.personId, event }),
      ).toBe(false);
      expect(
        await mailer.deliver({ issueId, personId: admin.personId, event }),
      ).toBe(true);
    }
    expect(sent).toHaveLength(4);
  });

  it("carries the number, the type and the priority, and nothing a reporter or a handler wrote", async () => {
    const issueId = await report(assignedType);
    await issues.setStatus(
      issueId,
      {
        statusId: (
          await prisma.issueStatus.findFirstOrThrow({
            where: { typeId: assignedType.id, label: HANDLER_STATUS_LABEL },
          })
        ).id,
        waitingReason: "CONTRACTOR",
      },
      board.personId,
    );
    await issues.setPriority(issueId, "URGENT", board.personId);
    await issues.setStatus(
      issueId,
      { statusId: assignedType.statusIds.DONE, outcome: "FIXED" },
      board.personId,
    );
    await issues.setStatus(
      issueId,
      { statusId: assignedType.statusIds.IN_PROGRESS },
      board.personId,
    );
    const yesterday = formatLocalDay(addLocalDays(today(), -1));
    await issues.setTargetDate(issueId, yesterday, board.personId);
    await mailer.remindOverdue({ issueId, targetDate: yesterday });
    const fromReporter = await storeMessage(
      issueId,
      { side: "REPORTER" },
      REPORTER_MESSAGE,
    );
    const fromHandler = await storeMessage(
      issueId,
      { side: "HANDLER", personId: board.personId, signature: "BOARD" },
      HANDLER_MESSAGE,
    );

    await mailer.ensureQueues();
    await prisma.$transaction(async (tx) => {
      await mailer.messageInTransaction(tx, issueId, {
        kind: "reporter",
        messageId: fromReporter,
      });
      await mailer.messageInTransaction(tx, issueId, {
        kind: "handler",
        personId: board.personId,
        messageId: fromHandler,
      });
    });

    const jobs = await notices(issueId);
    expect(new Set(jobs.map((job) => job.event))).toEqual(
      new Set([
        "assigned",
        "urgent",
        "reopened",
        "overdue",
        "message",
        "reporterMessage",
      ]),
    );

    const sent = captureSends();
    for (const job of jobs) {
      await mailer.deliver(job);
    }
    // Every event was delivered to somebody: none of them was found stale.
    expect(
      new Set(
        sent.map((input) =>
          input.template.id === "issue-reporter-notice"
            ? "reporterMessage"
            : (input.props as { event: string }).event,
        ),
      ),
    ).toEqual(new Set(jobs.map((job) => job.event)));

    const issue = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { number: true },
    });
    const forbidden = [
      REPORTER_DESCRIPTION,
      REPORTER_LOCATION,
      HANDLER_STATUS_LABEL,
      REPORTER_MESSAGE,
      HANDLER_MESSAGE,
      // The opening words of each message, which a shortened preview would
      // still print although it is not the whole text.
      REPORTER_MESSAGE.split(" ")[0],
      HANDLER_MESSAGE.split(" ")[0],
      // The reporter's name, which only the reporter's own mail greets.
      resident.lastName,
    ];
    for (const input of sent) {
      const rendered = await mail.renderMail(input);
      const everything = [
        rendered.subject,
        rendered.html,
        rendered.text,
        JSON.stringify(input.props),
      ];
      for (const part of everything) {
        for (const text of forbidden) {
          if (text === resident.lastName && input.to === resident.email) {
            continue;
          }
          expect(part).not.toContain(text);
        }
      }
      expect(rendered.subject).toContain(String(issue.number));
      expect(rendered.subject).toContain(`Hiss ${suffix}`);
    }
  });
});
