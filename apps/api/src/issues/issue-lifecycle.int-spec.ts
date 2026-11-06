import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { ISSUE_LINK_LIMITS } from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import {
  capabilitiesFor,
  type Principal,
  type PrincipalRoles,
} from "../authorization/capabilities";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { MailService, type SendMailInput } from "../mail/mail.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { IssueConversationService } from "./issue-conversation.service";
import { IssueFitService } from "./issue-fit.service";
import {
  ISSUE_NOTICE_QUEUE,
  ISSUE_OVERDUE_QUEUE,
  IssueMailer,
  type IssueNoticeJob,
} from "./issue-mailer.service";
import { lockIssue, lockIssueType, lockIssuesForHandling } from "./issue-lock";
import { IssueRedactionService } from "./issue-redaction.service";
import { IssueService } from "./issue.service";

/**
 * What happens to an issue after it closes, against a real database
 * (decisions 8 and 22, ADR 0054): a reporter's reply reopening it within the
 * window and not after, a new report following up an old one, merging
 * duplicates with every reporter still told, and the known fault the house is
 * shown.
 *
 * The window is judged on the database's clock, as `closedAt` is written, so
 * it is tested by closing the issue through the board's route and moving its
 * closing date back on that clock (`closedAgo`): 29 and 31 days ago.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let issues: IssueService;
let conversation: IssueConversationService;
let mailer: IssueMailer;
let mail: MailService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";
const DAY_MS = 24 * 60 * 60 * 1000;

function person(key: string, firstName: string, lastName: string) {
  return {
    personId: `il-${key}-${suffix}`,
    email: `il-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `${lastName}${suffix}`,
  };
}

const board = person("board", "Bea", "Styrelse");
const manager = person("manager", "Frida", "Forvaltare");
const resident = person("resident", "Rune", "Boende");
const neighbour = person("neighbour", "Nils", "Granne");
/** A resident with protected personal data, as a reporter. */
const shielded = person("shielded", "Sara", "Skyddad");
/** Signed in, and living somewhere else: not a resident of this house. */
const outsider = person("outsider", "Olle", "Utomstaende");
/** Holds a board seat and the property manager's role; the seat is set to end in the tests that need it to. */
const lapsing = person("lapsing", "Lasse", "Lapsande");
const people = [
  board,
  manager,
  resident,
  neighbour,
  shielded,
  outsider,
  lapsing,
];
/** A reporter in the register with no account, so no thread to read. */
const accountless = { personId: `il-accountless-${suffix}` };
const personIds = people.map((entry) => entry.personId);

const typeIds = {
  plain: `il-type-plain-${suffix}`,
  boardOnly: `il-type-board-${suffix}`,
  internal: `il-type-internal-${suffix}`,
};
let plain: IssueTypeFixture;
let boardOnly: IssueTypeFixture;
/** A type only handlers report: one of the board's internal categories. */
let internal: IssueTypeFixture;

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object;
  cookie?: string;
}) {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        // 10.191.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.191.${String(subnet)}.${String(host + 1)}`,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
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

const cookies: Record<string, string> = {};
function as(
  who: { personId: string },
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: object,
) {
  const cookie = cookies[who.personId];
  if (cookie === undefined) {
    throw new Error(`${who.personId} is not signed in`);
  }
  return inject({
    method,
    url,
    cookie,
    ...(payload === undefined ? {} : { payload }),
  });
}

let issueCounter = 0;
/** An open issue, written directly, as the queue would hold it. */
async function filed(
  type: IssueTypeFixture,
  reporter: { personId: string } | null = resident,
): Promise<string> {
  issueCounter += 1;
  const id = `il-issue-${String(issueCounter)}-${suffix}`;
  await prisma.issue.create({
    data: {
      id,
      typeId: type.id,
      statusId: type.statusIds.NEW,
      reporterPersonId: reporter?.personId ?? null,
      description: `Beskrivning ${String(issueCounter)} ${suffix}`,
      location: `Plats ${String(issueCounter)} ${suffix}`,
    },
  });
  return id;
}

/** Closes an issue through the board's own route, as a handler does. */
async function close(issueId: string, type: IssueTypeFixture) {
  const response = await as(
    board,
    "POST",
    `/api/issue-queue/${issueId}/status`,
    {
      statusId: type.statusIds.DONE,
      outcome: "FIXED",
    },
  );
  expect(response.statusCode).toBe(201);
  return response;
}

async function own(who: { personId: string }, issueId: string) {
  const response = await as(who, "GET", "/api/issues/mine");
  expect(response.statusCode).toBe(200);
  const found = response
    .json<
      {
        id: string;
        replyMode: string;
        mergedIntoMeaning: string | null;
        meaning: string;
      }[]
    >()
    .find((issue) => issue.id === issueId);
  if (found === undefined) {
    throw new Error(`${issueId} is not among the reporter's issues`);
  }
  return found;
}

/** The notices queued about one issue, as the queue holds them. */
async function noticeJobsOf(issueId: string): Promise<IssueNoticeJob[]> {
  const rows = await prisma.$queryRawUnsafe<{ data: IssueNoticeJob }[]>(
    "SELECT data FROM pgboss.job WHERE name = $1 AND data->>'issueId' = $2 ORDER BY created_on, id",
    ISSUE_NOTICE_QUEUE,
    issueId,
  );
  return rows.map((row) => row.data);
}

/** Who is mailed what about one issue: the queued notices, as person and event. */
async function noticesOf(
  issueId: string,
): Promise<{ personId: string; event: string }[]> {
  return (await noticeJobsOf(issueId)).map((job) => ({
    personId: job.personId,
    event: job.event,
  }));
}

/**
 * Delivers the queued notices to one person, with the send stubbed out, and
 * answers each mail as rendered: its subject, both bodies and its props.
 */
async function renderedNoticesTo(
  issueId: string,
  personId: string,
): Promise<{ event: string; parts: string[] }[]> {
  const sent: SendMailInput<unknown>[] = [];
  const send = vi.spyOn(mail, "send").mockImplementation(async (input) => {
    sent.push(input as SendMailInput<unknown>);
    return { messageId: null };
  });
  try {
    for (const job of await noticeJobsOf(issueId)) {
      if (job.personId === personId) {
        await mailer.deliver(job);
      }
    }
  } finally {
    send.mockRestore();
  }
  return Promise.all(
    sent.map(async (input) => {
      const rendered = await mail.renderMail(input);
      return {
        event: (input.props as { event?: string }).event ?? "",
        parts: [
          rendered.subject,
          rendered.html,
          rendered.text,
          JSON.stringify(input.props),
        ],
      };
    }),
  );
}

/**
 * Waits until a transaction is queued on the advisory lock `key` names. Only
 * this run's key, so another suite's waiters do not count.
 */
async function waitForLockWaiter(key: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND objid::bigint = (hashtext(${key})::bigint & 4294967295)`;
    if (row !== undefined && row.waiting > 0n) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Nothing queued on the lock ${key}`);
}

/**
 * Holds advisory locks, as a handler's write in flight would, from a second
 * transaction until `release` is called. `release` is safe to call again, and
 * a test calls it in `finally` so a failed assertion cannot leave what waits
 * on it blocked.
 */
async function holdLocks(
  take: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<{ release: () => Promise<void> }> {
  let letGo: () => void = () => undefined;
  const letGoSignal = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let held: () => void = () => undefined;
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      await take(tx);
      held();
      await letGoSignal;
    },
    { timeout: 30_000 },
  );
  await Promise.race([holding, holder]);
  return {
    release: async () => {
      letGo();
      await holder;
    },
  };
}

/** What `act` answered or threw, so a test can assert either. */
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function outcomeOf<T>(act: () => Promise<T>): Promise<Outcome<T>> {
  return act().then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );
}

/**
 * Runs `act` while the handling locks of `issueIds` are held by a second
 * transaction, `during` once `act` is queued on the first of them, and then
 * lets `act` go on. For what changes while a write waits: it must be judged on
 * what is so when the locks are got. The locks are released in `finally`.
 */
async function whileWaitingOnLocks<T>(
  issueIds: string[],
  act: () => Promise<T>,
  during: () => Promise<void>,
): Promise<Outcome<T>> {
  const lock = await holdLocks((tx) => lockIssuesForHandling(tx, issueIds));
  try {
    const outcome = outcomeOf(act);
    // The type's lock is the first it queues on.
    await waitForLockWaiter(`issue-type:${typeIds.plain}`);
    await during();
    await lock.release();
    return await outcome;
  } finally {
    await lock.release();
  }
}

/**
 * Runs `act` for a handler whose role is withdrawn while `act` waits on the
 * handling locks of `issueIds`. The withdrawal does not take those locks, so it
 * commits at once. What `act` threw, or `undefined`.
 */
async function actWithRoleWithdrawnWhileWaiting(
  actor: { personId: string },
  issueIds: string[],
  act: () => Promise<unknown>,
): Promise<unknown> {
  await prisma.systemRole.create({
    data: { personId: actor.personId, role: "PROPERTY_MANAGER" },
  });
  try {
    const outcome = await whileWaitingOnLocks(issueIds, act, async () => {
      await prisma.systemRole.deleteMany({
        where: { personId: actor.personId },
      });
    });
    return outcome.ok ? undefined : outcome.error;
  } finally {
    await prisma.systemRole.deleteMany({
      where: { personId: actor.personId },
    });
  }
}

/**
 * Moves an issue's closing back by `ms`, on the database's clock, as that much
 * time passing would; answers the closing date it now has.
 */
async function closedAgo(issueId: string, ms: number): Promise<Date> {
  const [row] = await prisma.$queryRaw<{ closedAt: Date }[]>`
    UPDATE "issue"
    SET "closedAt" = clock_timestamp() - make_interval(secs => ${ms / 1000})
    WHERE "id" = ${issueId}
    RETURNING "closedAt"`;
  if (row === undefined) {
    throw new Error(`${issueId} is not there to age`);
  }
  return row.closedAt;
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
  conversation = app.get(IssueConversationService);
  mailer = app.get(IssueMailer);
  mail = app.get(MailService);
  const encryption = app.get(FieldEncryptionService);

  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });

  for (const entry of people) {
    const email = await encryption.encrypt("person.email", entry.email);
    await prisma.person.create({
      data: {
        id: entry.personId,
        firstName: entry.firstName,
        lastName: entry.lastName,
        emailCipher: email.cipher,
        emailIndex: email.index,
        protectedPersonalData: entry === shielded,
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: entry.personId,
      email: entry.email,
      name: `${entry.firstName} ${entry.lastName}`,
      password: PASSWORD,
    });
  }
  await prisma.person.create({
    data: {
      id: accountless.personId,
      firstName: "Kalle",
      lastName: `Kontolos${suffix}`,
    },
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2025-05-15"),
    },
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });
  const addressId = `il-address-${suffix}`;
  await prisma.address.create({
    data: {
      id: addressId,
      street: "Livscykelgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: `il-apartment-${suffix}`, addressId, number: "1701", floor: 7 },
  });
  await prisma.residency.createMany({
    data: [resident, neighbour, shielded].map((entry) => ({
      personId: entry.personId,
      apartmentId: `il-apartment-${suffix}`,
      role: "MEMBER" as const,
      movedInOn: new Date("2024-01-01"),
    })),
  });

  plain = await createIssueTypeFixture(prisma, {
    id: typeIds.plain,
    name: `Hiss ${suffix}`,
    reporters: ["RESIDENTS", "PUBLIC"],
  });
  boardOnly = await createIssueTypeFixture(prisma, {
    id: typeIds.boardOnly,
    name: `Försäkring ${suffix}`,
    reporters: ["RESIDENTS"],
    handledBy: "BOARD",
  });
  internal = await createIssueTypeFixture(prisma, {
    id: typeIds.internal,
    name: `Intern kategori ${suffix}`,
    reporters: ["HANDLERS"],
  });

  for (const entry of people) {
    cookies[entry.personId] = await signIn(entry.email);
  }
}, 180_000);

afterAll(async () => {
  vi.useRealTimers();
  await prisma.post.deleteMany({ where: { body: { contains: suffix } } });
  // The mail this suite queued: notices, and the overdue reminder a reopening
  // may queue again. Only for this run's issues, before they go.
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
  // Duplicates first: the link to the issue merged into is set null anyway,
  // but deleting the rows that name another first keeps the order plain.
  await prisma.issue.deleteMany({
    where: {
      typeId: { in: Object.values(typeIds) },
      mergedIntoIssueId: { not: null },
    },
  });
  await prisma.issue.deleteMany({
    where: { typeId: { in: Object.values(typeIds) } },
  });
  await prisma.issueType.deleteMany({
    where: { id: { in: Object.values(typeIds) } },
  });
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.systemRole.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.residency.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.person.deleteMany({
    where: { id: { in: [...personIds, accountless.personId] } },
  });
  await prisma.apartment.deleteMany({
    where: { id: `il-apartment-${suffix}` },
  });
  await prisma.address.deleteMany({ where: { id: `il-address-${suffix}` } });
  await app.close();
});

describe("a reply on a closed issue", () => {
  it("reopens the issue on the 29th day after it closed", async () => {
    const issueId = await filed(plain);
    await close(issueId, plain);
    await closedAgo(issueId, 29 * DAY_MS);
    // Whoever handled it keeps it when it reopens.
    await prisma.issue.update({
      where: { id: issueId },
      data: { assigneePersonId: board.personId },
    });

    const mine = await issues.listOwn(resident.personId);
    expect(mine.find((issue) => issue.id === issueId)?.replyMode).toBe(
      "REOPENS",
    );
    const message = await conversation.replyAsReporter(
      resident.personId,
      issueId,
      "Det läcker igen.",
    );
    expect(message).toMatchObject({ side: "REPORTER" });

    const reopened = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: {
        statusId: true,
        assigneePersonId: true,
        outcome: true,
        closedAt: true,
        messages: { select: { body: true } },
      },
    });
    // The in-progress default, with the assignee kept, the outcome and the
    // closing date gone, and the reply on it, where the queue shows it waiting.
    expect(reopened).toEqual({
      statusId: plain.statusIds.IN_PROGRESS,
      assigneePersonId: board.personId,
      outcome: null,
      closedAt: null,
      messages: [{ body: "Det läcker igen." }],
    });

    // Whoever handles it is mailed that it is open again, and never the
    // reporter whose reply reopened it.
    const mailed = await noticesOf(issueId);
    expect(mailed).toContainEqual({
      personId: board.personId,
      event: "reopened",
    });
    expect(mailed.some((notice) => notice.personId === resident.personId)).toBe(
      false,
    );

    // What the assignee is mailed carries the number and the type, and none
    // of the free text: not the reply that reopened it, not the opening words
    // a shortened preview would still print, and not the report itself.
    const report = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { number: true, description: true, location: true },
    });
    const rendered = await renderedNoticesTo(issueId, board.personId);
    expect(rendered.map((notice) => notice.event)).toContain("reopened");
    const forbidden = [
      "Det läcker igen.",
      "läcker",
      report.description,
      report.location ?? "",
      resident.lastName,
    ];
    for (const notice of rendered) {
      for (const part of notice.parts) {
        for (const text of forbidden) {
          expect(part).not.toContain(text);
        }
        expect(part).toContain(String(report.number));
        expect(part).toContain(`Hiss ${suffix}`);
      }
    }

    // The timeline says the reporter reopened it, and names nobody.
    const timeline = await as(
      board,
      "GET",
      `/api/issue-queue/${issueId}/timeline`,
    );
    const steps = timeline.json<
      {
        kind: string;
        byReporter?: boolean;
        actor: unknown;
        toMeaning?: string;
      }[]
    >();
    expect(steps.at(-1)).toMatchObject({
      kind: "status",
      byReporter: true,
      actor: null,
      toMeaning: "IN_PROGRESS",
    });
    expect(timeline.body.includes(resident.lastName)).toBe(false);
  });

  it("reopens the issue on the 30th day after it closed", async () => {
    const issueId = await filed(plain);
    await close(issueId, plain);
    // The window includes its last day: a reply a minute short of 30 days
    // after closing still reopens. Not at the very instant, which a clock that
    // keeps running would overshoot.
    await closedAgo(issueId, 30 * DAY_MS - 60_000);
    await prisma.issue.update({
      where: { id: issueId },
      data: { assigneePersonId: board.personId },
    });

    const mine = await issues.listOwn(resident.personId);
    expect(mine.find((issue) => issue.id === issueId)?.replyMode).toBe(
      "REOPENS",
    );
    const message = await conversation.replyAsReporter(
      resident.personId,
      issueId,
      "Det läcker igen.",
    );
    expect(message).toMatchObject({ side: "REPORTER" });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: {
          statusId: true,
          assigneePersonId: true,
          outcome: true,
          closedAt: true,
        },
      }),
    ).toEqual({
      statusId: plain.statusIds.IN_PROGRESS,
      assigneePersonId: board.personId,
      outcome: null,
      closedAt: null,
    });
  });

  it("does not reopen it on the 31st day, mails nobody, and offers a new report instead", async () => {
    const issueId = await filed(plain);
    await close(issueId, plain);
    const closedAt = await closedAgo(issueId, 31 * DAY_MS);
    await prisma.issue.update({
      where: { id: issueId },
      data: { assigneePersonId: board.personId },
    });
    const queuedBefore = await noticesOf(issueId);

    const mine = await issues.listOwn(resident.personId);
    expect(mine.find((issue) => issue.id === issueId)?.replyMode).toBe(
      "NEW_REPORT",
    );
    await expect(
      conversation.replyAsReporter(resident.personId, issueId, "Igen."),
    ).rejects.toMatchObject({ reason: "issue-closed" });

    const untouched = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: {
        statusId: true,
        outcome: true,
        closedAt: true,
        _count: { select: { messages: true } },
      },
    });
    expect(untouched).toEqual({
      statusId: plain.statusIds.DONE,
      outcome: "FIXED",
      closedAt,
      _count: { messages: 0 },
    });
    // Nothing reopened, so the assignee is not mailed, and the refused reply
    // queues no message notice either.
    expect(await noticesOf(issueId)).toEqual(queuedBefore);
  });

  it("dates the closing, by a status change and by a merge, on the database's clock whatever the process's says", async () => {
    const closedIssue = await filed(plain);
    const duplicate = await filed(plain);
    const into = await filed(plain, neighbour);
    // The API's clock is ten days ahead of the database's; the window a reply
    // may reopen in is judged on the database's, so the closing is dated on it.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(new Date(Date.now() + 10 * DAY_MS));
      await close(closedIssue, plain);
      const merged = await as(
        board,
        "POST",
        `/api/issue-queue/${duplicate}/merge`,
        { intoIssueId: into },
      );
      expect(merged.statusCode).toBe(201);
    } finally {
      vi.useRealTimers();
    }
    const [row] = await prisma.$queryRaw<{ skew: number }[]>`
      SELECT GREATEST(
        ABS(EXTRACT(EPOCH FROM (clock_timestamp() - a."closedAt"))),
        ABS(EXTRACT(EPOCH FROM (clock_timestamp() - b."closedAt")))
      )::float AS skew
      FROM "issue" a, "issue" b
      WHERE a."id" = ${closedIssue} AND b."id" = ${duplicate}`;
    expect(row?.skew).toBeLessThan(300);
  });

  it("reopens through the reporter's route the moment after it closed", async () => {
    const issueId = await filed(plain);
    await close(issueId, plain);
    expect((await own(resident, issueId)).replyMode).toBe("REOPENS");

    const replied = await as(
      resident,
      "POST",
      `/api/issues/${issueId}/messages`,
      {
        body: "Det är inte lagat.",
      },
    );
    expect(replied.statusCode).toBe(201);
    expect(await own(resident, issueId)).toMatchObject({
      meaning: "IN_PROGRESS",
      replyMode: "MESSAGE",
    });
  });
});

describe("a new report following up a closed one", () => {
  it("links to the reporter's own closed issue, both ways for a handler", async () => {
    const earlier = await filed(plain);
    await close(earlier, plain);

    const filedAgain = await as(resident, "POST", "/api/issues", {
      typeId: plain.id,
      description: `Hissen igen ${suffix}`,
      followsIssueId: earlier,
    });
    expect(filedAgain.statusCode).toBe(201);
    const later = filedAgain.json<{ id: string }>().id;

    const laterLinks = await as(
      board,
      "GET",
      `/api/issue-queue/${later}/links`,
    );
    expect(laterLinks.json()).toMatchObject({
      follows: { kind: "issue", id: earlier, meaning: "DONE" },
      mergedInto: null,
    });
    const earlierLinks = await as(
      board,
      "GET",
      `/api/issue-queue/${earlier}/links`,
    );
    expect(earlierLinks.json()).toMatchObject({
      followUps: [{ kind: "issue", id: later }],
    });
  });

  it("refuses somebody else's issue as one that does not exist, and an open one of one's own", async () => {
    const neighbours = await filed(plain, neighbour);
    await close(neighbours, plain);
    const others = await as(resident, "POST", "/api/issues", {
      typeId: plain.id,
      description: `Följer upp ${suffix}`,
      followsIssueId: neighbours,
    });
    expect(others.statusCode).toBe(404);
    expect(others.json()).toMatchObject({ reason: "issue-not-found" });

    const open = await filed(plain);
    const stillOpen = await as(resident, "POST", "/api/issues", {
      typeId: plain.id,
      description: `Följer upp ${suffix}`,
      followsIssueId: open,
    });
    expect(stillOpen.statusCode).toBe(422);
    expect(stillOpen.json()).toMatchObject({
      reason: "follow-up-of-open-issue",
    });
    expect(
      await prisma.issue.count({
        where: { followsIssueId: { in: [neighbours, open] } },
      }),
    ).toBe(0);
  });
});

describe("a follow-up racing a handler's reopening", () => {
  it("is refused as the follow-up of an open issue when the handler's move commits first", async () => {
    const earlier = await filed(plain);
    await close(earlier, plain);

    // What a handler's status move holds: the type's lock and the issue's own.
    const handler = await holdLocks((tx) =>
      lockIssuesForHandling(tx, [earlier]),
    );
    try {
      const outcome = outcomeOf(() =>
        as(resident, "POST", "/api/issues", {
          typeId: plain.id,
          description: `Hissen igen ${suffix}`,
          followsIssueId: earlier,
        }),
      );
      // The follow-up queues on the locks of the earlier issue's type first.
      await waitForLockWaiter(`issue-type:${typeIds.plain}`);
      await prisma.issue.update({
        where: { id: earlier },
        data: {
          statusId: plain.statusIds.IN_PROGRESS,
          outcome: null,
          closedAt: null,
        },
      });
      await handler.release();

      const answered = await outcome;
      if (!answered.ok) {
        throw answered.error;
      }
      // Read once the locks are got, the earlier issue is open: nothing is
      // filed against a status that has gone.
      expect(answered.value.statusCode).toBe(422);
      expect(answered.value.json()).toMatchObject({
        reason: "follow-up-of-open-issue",
      });
    } finally {
      await handler.release();
    }
    expect(
      await prisma.issue.count({ where: { followsIssueId: earlier } }),
    ).toBe(0);
  });
});

describe("merging duplicates", () => {
  it("closes the duplicate as one, and its reporter follows the issue it was merged into", async () => {
    const kept = await filed(plain, neighbour);
    const duplicate = await filed(plain, resident);
    const before = await prisma.issue.findUniqueOrThrow({
      where: { id: kept },
      select: { updatedAt: true },
    });

    const merged = await as(
      board,
      "POST",
      `/api/issue-queue/${duplicate}/merge`,
      {
        intoIssueId: kept,
      },
    );
    expect(merged.statusCode).toBe(201);
    // The issue merged into moves too, so a panel open on it reads its links.
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: kept },
      select: { updatedAt: true },
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime(),
    );
    expect(merged.json()).toMatchObject({
      meaning: "DONE",
      outcome: "DUPLICATE",
      status: { id: plain.statusIds.DONE },
    });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: duplicate },
        select: { mergedIntoIssueId: true, closedAt: true },
      }),
    ).toMatchObject({ mergedIntoIssueId: kept, closedAt: expect.any(Date) });

    // The reporter sees where the kept issue stands, and nothing else of it.
    expect(await own(resident, duplicate)).toMatchObject({
      meaning: "DONE",
      replyMode: "NEW_REPORT",
      mergedIntoMeaning: "NEW",
    });
    const moved = await as(board, "POST", `/api/issue-queue/${kept}/status`, {
      statusId: plain.statusIds.IN_PROGRESS,
    });
    expect(moved.statusCode).toBe(201);
    const followed = await as(resident, "GET", "/api/issues/mine");
    expect(
      followed
        .json<{ id: string; mergedIntoMeaning: string | null }[]>()
        .find((issue) => issue.id === duplicate)?.mergedIntoMeaning,
    ).toBe("IN_PROGRESS");
    // Nothing of the kept issue's report or reporter reaches them.
    expect(followed.body.includes(neighbour.lastName)).toBe(false);

    // A reply on a duplicate does not reopen it, whenever it closed.
    const replied = await as(
      resident,
      "POST",
      `/api/issues/${duplicate}/messages`,
      {
        body: "Hissen står still igen.",
      },
    );
    expect(replied.statusCode).toBe(409);
    expect(replied.json()).toMatchObject({ reason: "issue-closed" });

    const links = await as(board, "GET", `/api/issue-queue/${kept}/links`);
    expect(links.json()).toMatchObject({
      duplicates: [{ kind: "issue", id: duplicate, meaning: "DONE" }],
    });
    const back = await as(board, "GET", `/api/issue-queue/${duplicate}/links`);
    expect(back.json()).toMatchObject({
      mergedInto: { kind: "issue", id: kept, meaning: "IN_PROGRESS" },
    });
  });

  it("clears the duplicate's entry permission as it closes it, and says so on the status change", async () => {
    const kept = await filed(plain, neighbour);
    const duplicate = await filed(plain, resident);
    // Written directly: the merge is under test, not the resident's answer.
    await prisma.issue.update({
      where: { id: duplicate },
      data: {
        entryAnswer: "YES",
        entryNote: "Ring på",
        entryPets: true,
        entryMasterKey: false,
      },
    });

    const merged = await as(
      board,
      "POST",
      `/api/issue-queue/${duplicate}/merge`,
      { intoIssueId: kept },
    );
    expect(merged.statusCode).toBe(201);
    expect(merged.json()).toMatchObject({ outcome: "DUPLICATE", entry: null });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: duplicate },
        select: {
          entryAnswer: true,
          entryNote: true,
          entryPets: true,
          entryMasterKey: true,
          entryUntil: true,
        },
      }),
    ).toEqual({
      entryAnswer: null,
      entryNote: null,
      entryPets: null,
      entryMasterKey: null,
      entryUntil: null,
    });
    const change = await prisma.auditLogEntry.findFirst({
      where: {
        targetKind: "issue",
        targetId: duplicate,
        action: "ISSUE_STATUS_CHANGED",
      },
      select: { context: true },
    });
    expect(change?.context).toMatchObject({
      outcome: "DUPLICATE",
      entryPermissionCleared: true,
    });
  });

  it("tells every reporter of the duplicates, each on their own report, a protected one masked as before", async () => {
    const kept = await filed(plain, neighbour);
    const first = await filed(plain, resident);
    const second = await filed(plain, shielded);
    for (const id of [first, second]) {
      const merged = await as(board, "POST", `/api/issue-queue/${id}/merge`, {
        intoIssueId: kept,
      });
      expect(merged.statusCode).toBe(201);
    }

    const sent = await as(
      board,
      "POST",
      `/api/issue-queue/${kept}/duplicate-messages`,
      { body: "En tekniker kommer på torsdag." },
    );
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toEqual({ sent: 2, skipped: 0 });

    // Each reporter is mailed that there is a new message, never what it says.
    expect(await noticesOf(first)).toContainEqual({
      personId: resident.personId,
      event: "reporterMessage",
    });

    for (const [who, id] of [
      [resident, first],
      [shielded, second],
    ] as const) {
      const thread = await as(who, "GET", `/api/issues/${id}/messages`);
      expect(thread.statusCode).toBe(200);
      expect(thread.json()).toEqual([
        expect.objectContaining({
          side: "HANDLER",
          signature: "BOARD",
          body: "En tekniker kommer på torsdag.",
        }),
      ]);
    }
    // The kept issue's own reporter is not written to by it, and no reporter
    // reads another's report.
    expect(await prisma.issueMessage.count({ where: { issueId: kept } })).toBe(
      0,
    );
    const foreign = await as(resident, "GET", `/api/issues/${second}/messages`);
    expect(foreign.statusCode).toBe(404);

    // The protected reporter stays masked on their duplicate's row, and is
    // named nowhere in the queue.
    const page = await as(board, "GET", "/api/issue-queue");
    const listed =
      page.json<
        { id: string; reporter: { kind: string }; apartment: unknown }[]
      >();
    expect(listed.find((issue) => issue.id === second)).toMatchObject({
      reporter: { kind: "protected" },
      apartment: null,
    });
    expect(page.body.includes(shielded.lastName)).toBe(false);
  });

  it("counts a reporter without an account, and an issue without a reporter, as not reached, and reaches a duplicate of another type", async () => {
    const kept = await filed(plain, neighbour);
    const reached = await filed(boardOnly, resident);
    const unreached = await filed(plain, accountless);
    const nobody = await filed(plain, null);
    for (const id of [reached, unreached, nobody]) {
      const merged = await as(board, "POST", `/api/issue-queue/${id}/merge`, {
        intoIssueId: kept,
      });
      expect(merged.statusCode).toBe(201);
    }

    const sent = await as(
      board,
      "POST",
      `/api/issue-queue/${kept}/duplicate-messages`,
      { body: "Hissen är lagad." },
    );
    expect(sent.statusCode).toBe(201);
    // The issue with no reporter at all is skipped too, so the two counts add
    // up to the merged reports the handler handles.
    expect(sent.json()).toEqual({ sent: 1, skipped: 2 });
    expect(
      await prisma.issueMessage.count({ where: { issueId: reached } }),
    ).toBe(1);
    expect(
      await prisma.issueMessage.count({ where: { issueId: unreached } }),
    ).toBe(0);
  });

  it("refuses a message to the duplicates' reporters when nobody can read it", async () => {
    const kept = await filed(plain, neighbour);
    const internal = await filed(plain, null);
    const unreached = await filed(plain, accountless);
    for (const id of [internal, unreached]) {
      await as(board, "POST", `/api/issue-queue/${id}/merge`, {
        intoIssueId: kept,
      });
    }
    const refused = await as(
      board,
      "POST",
      `/api/issue-queue/${kept}/duplicate-messages`,
      { body: "Hej" },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "no-reporter" });
  });

  it("refuses itself, a chain and an issue others were merged into", async () => {
    const kept = await filed(plain, neighbour);
    const duplicate = await filed(plain);
    const other = await filed(plain);

    const itself = await as(board, "POST", `/api/issue-queue/${kept}/merge`, {
      intoIssueId: kept,
    });
    expect(itself.statusCode).toBe(422);
    expect(itself.json()).toMatchObject({ reason: "merge-into-itself" });

    await as(board, "POST", `/api/issue-queue/${duplicate}/merge`, {
      intoIssueId: kept,
    });
    const chain = await as(board, "POST", `/api/issue-queue/${other}/merge`, {
      intoIssueId: duplicate,
    });
    expect(chain.statusCode).toBe(409);
    expect(chain.json()).toMatchObject({ reason: "merge-into-duplicate" });

    const keptAway = await as(board, "POST", `/api/issue-queue/${kept}/merge`, {
      intoIssueId: other,
    });
    expect(keptAway.statusCode).toBe(409);
    expect(keptAway.json()).toMatchObject({ reason: "merge-has-duplicates" });

    // Nobody chooses the outcome itself.
    const chosen = await as(board, "POST", `/api/issue-queue/${other}/status`, {
      statusId: plain.statusIds.DONE,
      outcome: "DUPLICATE",
    });
    expect(chosen.statusCode).toBe(400);
  });

  it("refuses to merge a duplicate into a different issue, and repeats the same merge", async () => {
    const kept = await filed(plain, neighbour);
    const elsewhere = await filed(plain);
    const duplicate = await filed(plain, resident);
    const merge = (into: string) =>
      as(board, "POST", `/api/issue-queue/${duplicate}/merge`, {
        intoIssueId: into,
      });

    expect((await merge(kept)).statusCode).toBe(201);
    expect((await merge(kept)).statusCode).toBe(201);
    const moved = await merge(elsewhere);
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ reason: "merge-already-duplicate" });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: duplicate },
        select: { mergedIntoIssueId: true },
      }),
    ).toEqual({ mergedIntoIssueId: kept });
  });

  it("refuses to merge into an issue that is done, and leaves both as they were", async () => {
    const closed = await filed(plain, neighbour);
    const duplicate = await filed(plain, resident);
    const done = await as(board, "POST", `/api/issue-queue/${closed}/status`, {
      statusId: plain.statusIds.DONE,
      outcome: "FIXED",
    });
    expect(done.statusCode).toBe(201);

    const refused = await as(
      board,
      "POST",
      `/api/issue-queue/${duplicate}/merge`,
      { intoIssueId: closed },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "merge-into-closed" });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: duplicate },
        select: { mergedIntoIssueId: true, outcome: true, closedAt: true },
      }),
    ).toEqual({ mergedIntoIssueId: null, outcome: null, closedAt: null });

    // Reopened, it is a target again.
    const reopened = await as(
      board,
      "POST",
      `/api/issue-queue/${closed}/status`,
      { statusId: plain.statusIds.IN_PROGRESS },
    );
    expect(reopened.statusCode).toBe(201);
    const merged = await as(
      board,
      "POST",
      `/api/issue-queue/${duplicate}/merge`,
      { intoIssueId: closed },
    );
    expect(merged.statusCode).toBe(201);
  });

  it("merges an issue that is done already, which keeps its day of closing and takes the outcome Dublett", async () => {
    const kept = await filed(plain, neighbour);
    const duplicate = await filed(plain, resident);
    const done = await as(
      board,
      "POST",
      `/api/issue-queue/${duplicate}/status`,
      { statusId: plain.statusIds.DONE, outcome: "FIXED" },
    );
    expect(done.statusCode).toBe(201);
    const closedAt = (
      await prisma.issue.findUniqueOrThrow({
        where: { id: duplicate },
        select: { closedAt: true },
      })
    ).closedAt;

    const merged = await as(
      board,
      "POST",
      `/api/issue-queue/${duplicate}/merge`,
      { intoIssueId: kept },
    );
    expect(merged.statusCode).toBe(201);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: duplicate },
        select: { mergedIntoIssueId: true, outcome: true, closedAt: true },
      }),
    ).toEqual({ mergedIntoIssueId: kept, outcome: "DUPLICATE", closedAt });
  });

  it("is answered as no such issue to a handler the board keeps out of either", async () => {
    const kept = await filed(boardOnly, neighbour);
    const duplicate = await filed(plain);

    const byManager = await as(
      manager,
      "POST",
      `/api/issue-queue/${duplicate}/merge`,
      { intoIssueId: kept },
    );
    expect(byManager.statusCode).toBe(404);
    expect(byManager.json()).toMatchObject({ reason: "issue-not-found" });

    // The board merges it; the property manager learns there is a link and
    // nothing about the other end of it.
    const byBoard = await as(
      board,
      "POST",
      `/api/issue-queue/${duplicate}/merge`,
      { intoIssueId: kept },
    );
    expect(byBoard.statusCode).toBe(201);
    const links = await as(
      manager,
      "GET",
      `/api/issue-queue/${duplicate}/links`,
    );
    expect(links.json()).toEqual({
      mergedInto: { kind: "hidden" },
      duplicates: [],
      duplicateCount: 0,
      follows: null,
      followUps: [],
      followUpCount: 0,
    });
  });

  it("counts a duplicate hidden from a handler, so the merge is not offered where it would be refused", async () => {
    const kept = await filed(plain, neighbour);
    const hidden = await filed(boardOnly, resident);
    const merged = await as(board, "POST", `/api/issue-queue/${hidden}/merge`, {
      intoIssueId: kept,
    });
    expect(merged.statusCode).toBe(201);

    const links = await as(manager, "GET", `/api/issue-queue/${kept}/links`);
    expect(links.statusCode).toBe(200);
    expect(links.json()).toMatchObject({ duplicates: [], duplicateCount: 1 });
  });

  it("accepts a merge into an issue with one duplicate below the limit", async () => {
    const kept = await filed(plain, neighbour);
    const extra = await filed(plain, resident);
    await prisma.issue.createMany({
      data: Array.from(
        { length: ISSUE_LINK_LIMITS.duplicates - 1 },
        (_, index) => ({
          id: `il-near-${String(index)}-${suffix}`,
          typeId: plain.id,
          statusId: plain.statusIds.DONE,
          outcome: "DUPLICATE" as const,
          closedAt: new Date(),
          mergedIntoIssueId: kept,
          reporterPersonId: null,
          description: `Dublett ${String(index)} ${suffix}`,
          location: `Plats ${String(index)} ${suffix}`,
        }),
      ),
    });

    const merged = await as(board, "POST", `/api/issue-queue/${extra}/merge`, {
      intoIssueId: kept,
    });
    expect(merged.statusCode).toBe(201);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: extra },
        select: { mergedIntoIssueId: true },
      }),
    ).toEqual({ mergedIntoIssueId: kept });
  });

  it("refuses a merge into an issue that already has as many duplicates as one may", async () => {
    const kept = await filed(plain, neighbour);
    const extra = await filed(plain, resident);
    await prisma.issue.createMany({
      data: Array.from(
        { length: ISSUE_LINK_LIMITS.duplicates },
        (_, index) => ({
          id: `il-dup-${String(index)}-${suffix}`,
          typeId: plain.id,
          statusId: plain.statusIds.DONE,
          outcome: "DUPLICATE" as const,
          closedAt: new Date(),
          mergedIntoIssueId: kept,
          reporterPersonId: null,
          description: `Dublett ${String(index)} ${suffix}`,
          location: `Plats ${String(index)} ${suffix}`,
        }),
      ),
    });

    const refused = await as(board, "POST", `/api/issue-queue/${extra}/merge`, {
      intoIssueId: kept,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "merge-limit" });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: extra },
        select: { mergedIntoIssueId: true },
      }),
    ).toEqual({ mergedIntoIssueId: null });
  });

  it("lists a page of the follow-ups of an issue and counts them all", async () => {
    const earlier = await filed(plain);
    await close(earlier, plain);
    const total = ISSUE_LINK_LIMITS.followUpsListed + 2;
    await prisma.issue.createMany({
      data: Array.from({ length: total }, (_, index) => ({
        id: `il-fu-${String(index)}-${suffix}`,
        typeId: plain.id,
        statusId: plain.statusIds.NEW,
        followsIssueId: earlier,
        reporterPersonId: null,
        description: `Uppföljning ${String(index)} ${suffix}`,
        location: `Plats ${String(index)} ${suffix}`,
      })),
    });

    const links = await as(board, "GET", `/api/issue-queue/${earlier}/links`);
    expect(links.statusCode).toBe(200);
    const body = links.json<{ followUps: unknown[]; followUpCount: number }>();
    expect(body.followUps).toHaveLength(ISSUE_LINK_LIMITS.followUpsListed);
    expect(body.followUpCount).toBe(total);
  });

  it("leaves the issue merged into when the duplicate is reopened", async () => {
    const kept = await filed(plain, neighbour);
    const duplicate = await filed(plain);
    await as(board, "POST", `/api/issue-queue/${duplicate}/merge`, {
      intoIssueId: kept,
    });

    const reopened = await as(
      board,
      "POST",
      `/api/issue-queue/${duplicate}/status`,
      { statusId: plain.statusIds.IN_PROGRESS },
    );
    expect(reopened.statusCode).toBe(201);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: duplicate },
        select: { mergedIntoIssueId: true, outcome: true },
      }),
    ).toEqual({ mergedIntoIssueId: null, outcome: null });
    expect((await own(resident, duplicate)).mergedIntoMeaning).toBeNull();
  });
});

describe("a known fault", () => {
  let notices = 0;
  /** A notice of its own for each test, so one test's is never another's. */
  function notice(): string {
    notices += 1;
    return `Hissen i port 14 står still; en tekniker kommer på torsdag. ${suffix}-${String(notices)}`;
  }

  async function shown(who: { personId: string }) {
    const response = await as(who, "GET", "/api/issues/known-faults");
    expect(response.statusCode).toBe(200);
    return response.json<
      { body: string; typeName: string; signature: string }[]
    >();
  }

  it("is shown to signed-in residents, signed with a role and carrying nothing of the report", async () => {
    const NOTICE = notice();
    const issueId = await filed(plain);
    const published = await as(
      manager,
      "PUT",
      `/api/issue-queue/${issueId}/known-fault`,
      { body: NOTICE },
    );
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      knownFault: { body: NOTICE, signature: "PROPERTY_MANAGER" },
    });

    for (const who of [resident, neighbour, board]) {
      const faults = await shown(who);
      expect(faults).toContainEqual({
        body: NOTICE,
        typeName: `Hiss ${suffix}`,
        signature: "PROPERTY_MANAGER",
        publishedAt: expect.any(String),
      });
    }
    const response = await as(neighbour, "GET", "/api/issues/known-faults");
    expect(response.body.includes(`Beskrivning`)).toBe(false);
    expect(response.body.includes(`Plats`)).toBe(false);
    expect(response.body.includes(manager.lastName)).toBe(false);
    expect(response.body.includes(issueId)).toBe(false);

    // A signed-in person who does not live here reports nothing here, and
    // is told of none.
    const outside = await as(outsider, "GET", "/api/issues/known-faults");
    expect(outside.statusCode).toBe(403);
  });

  it("is not published by a person who no longer holds issues:handle", async () => {
    const issueId = await filed(plain);
    // Past the route's guard, as a role withdrawn in between: the service
    // answers from the database and signs for nobody.
    await expect(
      issues.publishKnownFault(issueId, notice(), resident.personId),
    ).rejects.toMatchObject({ reason: "issue-not-found" });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { knownFault: true, knownFaultSignature: true },
      }),
    ).toEqual({ knownFault: null, knownFaultSignature: null });
  });

  it("is not merged, withdrawn or written to duplicates by a person who no longer holds issues:handle", async () => {
    const kept = await filed(plain, neighbour);
    const duplicate = await filed(plain);
    const noted = await filed(plain);
    // Past the route's guard, as a role withdrawn in between: each service
    // answers from the database and acts for nobody. The person reads as the
    // narrower scope, which admits every issue of an every-handler type.
    await expect(
      issues.merge(duplicate, kept, resident.personId),
    ).rejects.toMatchObject({ reason: "issue-not-found" });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: duplicate },
        select: { mergedIntoIssueId: true, closedAt: true },
      }),
    ).toEqual({ mergedIntoIssueId: null, closedAt: null });

    const published = await as(
      board,
      "PUT",
      `/api/issue-queue/${noted}/known-fault`,
      { body: notice() },
    );
    expect(published.statusCode).toBe(200);
    await expect(
      issues.withdrawKnownFault(noted, resident.personId),
    ).rejects.toMatchObject({ reason: "issue-not-found" });
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: noted },
          select: { knownFaultPublishedAt: true },
        })
      ).knownFaultPublishedAt,
    ).not.toBeNull();

    // A duplicate with a reporter who has an account, merged by the board.
    const merged = await filed(plain, neighbour);
    expect(
      (
        await as(board, "POST", `/api/issue-queue/${merged}/merge`, {
          intoIssueId: kept,
        })
      ).statusCode,
    ).toBe(201);
    await expect(
      conversation.replyToDuplicates(resident.personId, kept, "Hej"),
    ).rejects.toMatchObject({ reason: "issue-not-found" });
    expect(
      await prisma.issueMessage.count({ where: { issueId: merged } }),
    ).toBe(0);
  });

  it("does not merge or withdraw for a handler whose role is withdrawn while it waits on the locks", async () => {
    const kept = await filed(plain, neighbour);
    const duplicate = await filed(plain);
    const noted = await filed(plain);
    const published = await as(
      board,
      "PUT",
      `/api/issue-queue/${noted}/known-fault`,
      { body: notice() },
    );
    expect(published.statusCode).toBe(200);

    // The role is read after the waits: a check made before them would let
    // both through.
    expect(
      await actWithRoleWithdrawnWhileWaiting(outsider, [duplicate, kept], () =>
        issues.merge(duplicate, kept, outsider.personId),
      ),
    ).toMatchObject({ reason: "issue-not-found" });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: duplicate },
        select: { mergedIntoIssueId: true, closedAt: true },
      }),
    ).toEqual({ mergedIntoIssueId: null, closedAt: null });

    expect(
      await actWithRoleWithdrawnWhileWaiting(outsider, [noted], () =>
        issues.withdrawKnownFault(noted, outsider.personId),
      ),
    ).toMatchObject({ reason: "issue-not-found" });
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: noted },
          select: { knownFaultPublishedAt: true },
        })
      ).knownFaultPublishedAt,
    ).not.toBeNull();
  });

  it("does not add a note or move the status for a person who no longer holds issues:handle", async () => {
    const issueId = await filed(plain);
    // Past the route's guard, as a role withdrawn in between: the narrower
    // scope admits the issue, so only the role check refuses.
    await expect(
      conversation.addNote(resident.personId, issueId, "Anteckning"),
    ).rejects.toMatchObject({ reason: "issue-not-found" });
    expect(await prisma.issueNote.count({ where: { issueId } })).toBe(0);

    await expect(
      issues.setStatus(
        issueId,
        { statusId: plain.statusIds.IN_PROGRESS },
        { personId: resident.personId, channel: "WEB" },
        "show",
      ),
    ).rejects.toMatchObject({ reason: "issue-not-found" });
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: issueId },
          select: { statusId: true },
        })
      ).statusId,
    ).toBe(plain.statusIds.NEW);
  });

  it("does not assign, prioritise, date or mark an issue for a person who no longer holds issues:handle", async () => {
    const issueId = await filed(plain);
    const handling = {
      assigneePersonId: true,
      priority: true,
      targetDate: true,
      costResponsibility: true,
      boardOnly: true,
    } as const;
    const before = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: handling,
    });
    const actor = { personId: resident.personId, channel: "WEB" } as const;
    // Past the route's guard, as a role withdrawn in between: the narrower
    // scope admits the issue, so only the role check refuses each write.
    for (const [name, write] of [
      ["assign", () => issues.assign(issueId, null, actor, "show")],
      [
        "setPriority",
        () => issues.setPriority(issueId, "URGENT", actor, "show"),
      ],
      [
        "setTargetDate",
        () => issues.setTargetDate(issueId, "2031-05-30", actor, "show"),
      ],
      [
        "setCostResponsibility",
        () =>
          issues.setCostResponsibility(
            issueId,
            "ASSOCIATION",
            resident.personId,
          ),
      ],
      [
        "setBoardOnly",
        () => issues.setBoardOnly(issueId, true, resident.personId),
      ],
    ] as const) {
      await expect(write(), name).rejects.toMatchObject({
        reason: "issue-not-found",
      });
    }
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: handling,
      }),
    ).toEqual(before);
  });

  it("does not write to the reporter as a person who no longer holds issues:handle", async () => {
    const issueId = await filed(plain, neighbour);
    // Past the route's guard, as a role withdrawn in between: the narrower
    // scope admits the issue, and the signature would be the board's.
    await expect(
      conversation.replyAsHandler(resident.personId, issueId, "Hej"),
    ).rejects.toMatchObject({ reason: "issue-not-found" });
    expect(await prisma.issueMessage.count({ where: { issueId } })).toBe(0);
  });

  it("does not write to the reporter as a handler whose role is withdrawn while it waits on the locks", async () => {
    const issueId = await filed(plain, neighbour);

    expect(
      await actWithRoleWithdrawnWhileWaiting(outsider, [issueId], () =>
        conversation.replyAsHandler(outsider.personId, issueId, "Hej"),
      ),
    ).toMatchObject({ reason: "issue-not-found" });
    expect(await prisma.issueMessage.count({ where: { issueId } })).toBe(0);

    // The same for the message to the duplicates' reporters.
    const duplicate = await filed(plain, resident);
    expect(
      (
        await as(board, "POST", `/api/issue-queue/${duplicate}/merge`, {
          intoIssueId: issueId,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      await actWithRoleWithdrawnWhileWaiting(
        outsider,
        [issueId, duplicate],
        () => conversation.replyToDuplicates(outsider.personId, issueId, "Hej"),
      ),
    ).toMatchObject({ reason: "issue-not-found" });
    expect(
      await prisma.issueMessage.count({ where: { issueId: duplicate } }),
    ).toBe(0);
  });

  it("does not file an issue for a handler whose role is withdrawn while the open waits on the type's lock", async () => {
    const roles: PrincipalRoles = {
      isAdmin: false,
      isBoardMember: false,
      isPropertyManager: true,
      isResident: false,
      isMember: false,
    };
    const principal: Principal = {
      ...roles,
      personId: outsider.personId,
      capabilities: capabilitiesFor(roles),
    };
    const description = `Utan roll ${suffix}`;
    await prisma.systemRole.create({
      data: { personId: outsider.personId, role: "PROPERTY_MANAGER" },
    });
    const lock = await holdLocks((tx) => lockIssueType(tx, typeIds.plain));
    try {
      const outcome = outcomeOf(() =>
        issues.open(principal, { typeId: typeIds.plain, description }),
      );
      await waitForLockWaiter(`issue-type:${typeIds.plain}`);
      // The role is read after the wait: a check made before it would let the
      // open through, and the narrower scope admits an every-handler type.
      await prisma.systemRole.deleteMany({
        where: { personId: outsider.personId },
      });
      await lock.release();
      expect(await outcome).toMatchObject({
        ok: false,
        error: { reason: "type-not-found" },
      });
    } finally {
      await lock.release();
      await prisma.systemRole.deleteMany({
        where: { personId: outsider.personId },
      });
    }
    expect(
      await prisma.issue.count({
        where: { enteredByPersonId: outsider.personId },
      }),
    ).toBe(0);
  });

  describe("a handler's write by a person who no longer holds issues:handle", () => {
    const WRITES: [
      name: string,
      write: (who: string, issueId: string) => Promise<unknown>,
    ][] = [
      [
        "assign",
        (who, id) =>
          issues.assign(id, board.personId, handlerActor(who), "show"),
      ],
      [
        "setPriority",
        (who, id) =>
          issues.setPriority(id, "URGENT", handlerActor(who), "show"),
      ],
      [
        "setTargetDate",
        (who, id) =>
          issues.setTargetDate(id, "2026-12-24", handlerActor(who), "show"),
      ],
      [
        "setCostResponsibility",
        (who, id) => issues.setCostResponsibility(id, "ASSOCIATION", who),
      ],
      ["setBoardOnly", (who, id) => issues.setBoardOnly(id, true, who)],
      [
        "markDamageCase",
        (who, id) =>
          issues.markDamageCase(
            id,
            {
              insurer: "Trygg",
              claimNumber: "K-1",
              occurredOn: "2025-01-10",
              cause: "WATER",
            },
            null,
            who,
          ),
      ],
      [
        "removeDamageCase",
        (who, id) =>
          issues.removeDamageCase(
            id,
            {
              insurer: "Trygg",
              claimNumber: "K-1",
              occurredOn: "2025-01-10",
              cause: "WATER",
            },
            who,
          ),
      ],
      [
        "answerEntryAsHandler",
        (who, id) =>
          app
            .get(IssueFitService)
            .answerEntryAsHandler(who, id, { answer: "YES" }),
      ],
      [
        "withdrawEntryAsHandler",
        (who, id) => app.get(IssueFitService).withdrawEntryAsHandler(who, id),
      ],
      [
        "setPlace",
        (who, id) => app.get(IssueFitService).setPlace(who, id, null),
      ],
      [
        "markFinding",
        (who, id) =>
          app.get(IssueFitService).markFinding(who, id, {
            kind: "OVK",
            inspectedOn: "2026-01-10",
            protocolAttachmentId: "no-such-file",
            targetDate: "2026-02-10",
          }),
      ],
      [
        "removeFinding",
        (who, id) => app.get(IssueFitService).removeFinding(who, id),
      ],
      [
        "setLegalHold",
        (who, id) => app.get(IssueRedactionService).setLegalHold(who, id, true),
      ],
      [
        "redact",
        (who, id) =>
          app
            .get(IssueRedactionService)
            .redact(who, id, { target: "description" }),
      ],
    ];

    const handlerActor = (personId: string) =>
      ({ personId, channel: "WEB" }) as const;

    /** The issue and its entries in the audit log, as a write would change them. */
    async function standing(issueId: string) {
      return {
        issue: await prisma.issue.findUniqueOrThrow({
          where: { id: issueId },
          include: { damageCase: true, finding: true },
        }),
        entries: await prisma.auditLogEntry.count({
          where: { targetId: issueId },
        }),
      };
    }

    it.each(WRITES)(
      "%s is refused as an issue that does not exist, past the route's guard",
      async (_name, write) => {
        const issueId = await filed(plain);
        const before = await standing(issueId);
        // The person reads as the narrower scope, which admits every issue of
        // an every-handler type: only the role check refuses.
        await expect(write(resident.personId, issueId)).rejects.toMatchObject({
          reason: "issue-not-found",
        });
        expect(await standing(issueId)).toEqual(before);
      },
    );

    it.each(WRITES)(
      "%s is refused for a handler whose role is withdrawn while it waits on the locks",
      async (_name, write) => {
        const issueId = await filed(plain);
        const before = await standing(issueId);
        // The role is read after the waits: a check made before them would
        // let the write through.
        expect(
          await actWithRoleWithdrawnWhileWaiting(outsider, [issueId], () =>
            write(outsider.personId, issueId),
          ),
        ).toMatchObject({ reason: "issue-not-found" });
        expect(await standing(issueId)).toEqual(before);
      },
    );
  });

  describe("when a board seat ends while a write waits on the locks", () => {
    /**
     * The handler holds a seat that ends two days on, and the property
     * manager's role. The waiting write is started with the clock where it is
     * and the clock is moved four days on during the wait, so a write that
     * read it before the locks sees a seat, and one that read it after them
     * sees none.
     */
    async function withLapsingSeat<T>(run: () => Promise<T>): Promise<T> {
      const today = new Date();
      const endedOn = new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate() + 2,
        ),
      );
      await prisma.boardPosition.create({
        data: {
          personId: lapsing.personId,
          position: "BOARD_MEMBER",
          electedOn: new Date("2025-05-15"),
          endedOn,
        },
      });
      await prisma.systemRole.create({
        data: { personId: lapsing.personId, role: "PROPERTY_MANAGER" },
      });
      vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
      try {
        return await run();
      } finally {
        vi.useRealTimers();
        await prisma.boardPosition.deleteMany({
          where: { personId: lapsing.personId },
        });
        await prisma.systemRole.deleteMany({
          where: { personId: lapsing.personId },
        });
      }
    }

    const fourDaysOn = async (): Promise<void> => {
      vi.setSystemTime(new Date(Date.now() + 4 * DAY_MS));
      await Promise.resolve();
    };

    it("signs a message to the reporter with the role held when the locks are got", async () => {
      const issueId = await filed(plain, neighbour);

      const outcome = await withLapsingSeat(() =>
        whileWaitingOnLocks(
          [issueId],
          () => conversation.replyAsHandler(lapsing.personId, issueId, "Hej"),
          fourDaysOn,
        ),
      );

      expect(outcome.ok).toBe(true);
      expect(
        await prisma.issueMessage.findMany({
          where: { issueId },
          select: { signature: true },
        }),
      ).toEqual([{ signature: "PROPERTY_MANAGER" }]);
    });

    it("signs a message to the duplicates' reporters, and reaches the duplicates, as of when the locks are got", async () => {
      const kept = await filed(plain, neighbour);
      const open = await filed(plain, resident);
      const boardsOwn = await filed(plain, shielded);
      for (const id of [open, boardsOwn]) {
        expect(
          (
            await as(board, "POST", `/api/issue-queue/${id}/merge`, {
              intoIssueId: kept,
            })
          ).statusCode,
        ).toBe(201);
      }
      // Kept to the board after it was merged, so only a board seat reaches it.
      await prisma.issue.update({
        where: { id: boardsOwn },
        data: { boardOnly: true },
      });

      const outcome = await withLapsingSeat(() =>
        whileWaitingOnLocks(
          [kept, open, boardsOwn],
          () => conversation.replyToDuplicates(lapsing.personId, kept, "Hej"),
          fourDaysOn,
        ),
      );

      expect(outcome).toEqual({ ok: true, value: { sent: 1, skipped: 0 } });
      expect(
        await prisma.issueMessage.findMany({
          where: { issueId: { in: [open, boardsOwn] } },
          select: { issueId: true, signature: true },
        }),
      ).toEqual([{ issueId: open, signature: "PROPERTY_MANAGER" }]);
    });
  });

  it("does not write to a duplicate the board keeps to itself while the message waits on the locks", async () => {
    const kept = await filed(plain, neighbour);
    const open = await filed(plain, resident);
    const boardsOwn = await filed(plain, shielded);
    for (const id of [open, boardsOwn]) {
      expect(
        (
          await as(board, "POST", `/api/issue-queue/${id}/merge`, {
            intoIssueId: kept,
          })
        ).statusCode,
      ).toBe(201);
    }

    // The property manager handles both until the board takes one, which
    // commits at once: it does not wait for the locks the message waits on.
    const outcome = await whileWaitingOnLocks(
      [kept, open, boardsOwn],
      () => conversation.replyToDuplicates(manager.personId, kept, "Hej"),
      async () => {
        await prisma.issue.update({
          where: { id: boardsOwn },
          data: { boardOnly: true },
        });
      },
    );

    expect(outcome).toEqual({ ok: true, value: { sent: 1, skipped: 0 } });
    expect(
      await prisma.issueMessage.count({ where: { issueId: boardsOwn } }),
    ).toBe(0);
    expect(await prisma.issueMessage.count({ where: { issueId: open } })).toBe(
      1,
    );
  });

  it("starts over when an issue is merged in while the message waits, and takes the new duplicate's lock before it writes", async () => {
    const kept = await filed(plain, neighbour);
    const first = await filed(plain, resident);
    const late = await filed(plain, shielded);
    expect(
      (
        await as(board, "POST", `/api/issue-queue/${first}/merge`, {
          intoIssueId: kept,
        })
      ).statusCode,
    ).toBe(201);

    const first_ = await holdLocks((tx) =>
      lockIssuesForHandling(tx, [kept, first]),
    );
    let lateLock: { release: () => Promise<void> } | null = null;
    try {
      const outcome = outcomeOf(() =>
        conversation.replyToDuplicates(manager.personId, kept, "Hej"),
      );
      await waitForLockWaiter(`issue-type:${typeIds.plain}`);
      // Merged in between the message's unlocked read and its locks. Its own
      // lock is held by a handler writing to it.
      await prisma.issue.update({
        where: { id: late },
        data: { mergedIntoIssueId: kept },
      });
      lateLock = await holdLocks((tx) => lockIssue(tx, late));
      await first_.release();

      // The first attempt finds a duplicate it holds no lock of and starts
      // over; the second waits for that lock instead of writing past it.
      await waitForLockWaiter(`issue:${late}`);
      expect(
        await prisma.issueMessage.count({ where: { issueId: late } }),
      ).toBe(0);
      await lateLock.release();

      expect(await outcome).toEqual({
        ok: true,
        value: { sent: 2, skipped: 0 },
      });
      expect(
        await prisma.issueMessage.count({
          where: { issueId: { in: [first, late] } },
        }),
      ).toBe(2);
    } finally {
      await first_.release();
      await lateLock?.release();
    }
  });

  it("withholds the name of a type only handlers report from the house", async () => {
    const NOTICE = notice();
    const issueId = await filed(internal, null);
    const published = await as(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/known-fault`,
      { body: NOTICE },
    );
    expect(published.statusCode).toBe(200);

    const faults = await as(resident, "GET", "/api/issues/known-faults");
    expect(
      faults
        .json<{ body: string; typeName: string | null }[]>()
        .find((fault) => fault.body === NOTICE),
    ).toMatchObject({ typeName: null });
    expect(faults.body.includes(`Intern kategori ${suffix}`)).toBe(false);
  });

  it("is shown on the post its issue was reported from, to every reader of the post", async () => {
    const NOTICE = notice();
    const issueId = await filed(plain);
    const audiences = await as(resident, "GET", "/api/feed/audiences");
    const allId = audiences
      .json<{ audiences: { id: string; kind: string }[] }>()
      .audiences.find((audience) => audience.kind === "ALL")?.id;
    if (allId === undefined) {
      throw new Error("no Alla audience");
    }
    const post = await prisma.post.create({
      data: {
        audienceId: allId,
        authorPersonId: resident.personId,
        body: `Hissen står still igen ${suffix}`,
        issueId,
      },
      select: { id: true },
    });

    const before = await as(neighbour, "GET", `/api/feed/posts/${post.id}`);
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ knownFault: null, issue: null });

    await as(board, "PUT", `/api/issue-queue/${issueId}/known-fault`, {
      body: NOTICE,
    });
    const after = await as(neighbour, "GET", `/api/feed/posts/${post.id}`);
    expect(after.json()).toMatchObject({
      knownFault: { body: NOTICE, signature: "BOARD" },
      // The report itself stays the reporter's and the handlers'.
      issue: null,
    });

    // The post is read the way the known faults are: not while the board
    // keeps the issue to itself.
    await as(board, "POST", `/api/issue-queue/${issueId}/access`, {
      boardOnly: true,
    });
    const kept = await as(neighbour, "GET", `/api/feed/posts/${post.id}`);
    expect(kept.json()).toMatchObject({ knownFault: null });
    await as(board, "POST", `/api/issue-queue/${issueId}/access`, {
      boardOnly: false,
    });

    await as(board, "DELETE", `/api/issue-queue/${issueId}/known-fault`);
    const withdrawn = await as(neighbour, "GET", `/api/feed/posts/${post.id}`);
    expect(withdrawn.json()).toMatchObject({ knownFault: null });
  });

  it("stops showing when the board keeps the issue to itself, and is cleared when it closes", async () => {
    const NOTICE = notice();
    const issueId = await filed(plain);
    await as(board, "PUT", `/api/issue-queue/${issueId}/known-fault`, {
      body: NOTICE,
    });
    expect((await shown(resident)).some((f) => f.body === NOTICE)).toBe(true);

    await as(board, "POST", `/api/issue-queue/${issueId}/access`, {
      boardOnly: true,
    });
    expect((await shown(resident)).some((f) => f.body === NOTICE)).toBe(false);

    await as(board, "POST", `/api/issue-queue/${issueId}/access`, {
      boardOnly: false,
    });
    expect((await shown(resident)).some((f) => f.body === NOTICE)).toBe(true);

    await close(issueId, plain);
    expect((await shown(resident)).some((f) => f.body === NOTICE)).toBe(false);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { knownFault: true, knownFaultSignature: true },
      }),
    ).toEqual({ knownFault: null, knownFaultSignature: null });
  });

  it("is refused on a closed issue, on one the board keeps to itself and with a personal identity number", async () => {
    const NOTICE = notice();
    const closed = await filed(plain);
    await close(closed, plain);
    const onClosed = await as(
      board,
      "PUT",
      `/api/issue-queue/${closed}/known-fault`,
      { body: NOTICE },
    );
    expect(onClosed.statusCode).toBe(409);
    expect(onClosed.json()).toMatchObject({ reason: "issue-closed" });

    const kept = await filed(boardOnly);
    const onKept = await as(
      board,
      "PUT",
      `/api/issue-queue/${kept}/known-fault`,
      {
        body: NOTICE,
      },
    );
    expect(onKept.statusCode).toBe(409);
    expect(onKept.json()).toMatchObject({ reason: "known-fault-board-only" });

    const open = await filed(plain);
    const numbered = await as(
      board,
      "PUT",
      `/api/issue-queue/${open}/known-fault`,
      {
        body: "Ring Erik, 19811218-9876.",
      },
    );
    expect(numbered.statusCode).toBe(422);
    expect(numbered.json()).toMatchObject({
      reason: "personal-identity-number",
    });
    expect(
      await prisma.issue.count({
        where: { id: { in: [closed, kept, open] }, knownFault: { not: null } },
      }),
    ).toBe(0);
  });

  it("is on the timeline, published and withdrawn, and never its text", async () => {
    const NOTICE = notice();
    const issueId = await filed(plain);
    await as(board, "PUT", `/api/issue-queue/${issueId}/known-fault`, {
      body: NOTICE,
    });
    await as(board, "DELETE", `/api/issue-queue/${issueId}/known-fault`);
    const timeline = await as(
      board,
      "GET",
      `/api/issue-queue/${issueId}/timeline`,
    );
    expect(
      timeline
        .json<{ kind: string; published?: boolean }[]>()
        .filter((step) => step.kind === "knownFault")
        .map((step) => step.published),
    ).toEqual([true, false]);
    const entries = await prisma.auditLogEntry.findMany({
      where: { targetId: issueId, action: "ISSUE_KNOWN_FAULT_CHANGED" },
      select: { context: true, actorPersonId: true },
    });
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries).includes("Hissen")).toBe(false);
  });
});
