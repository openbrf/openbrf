import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { ActionContext } from "@openbrf/plugin-sdk";
import { addLocalDays, formatLocalDay, localDayOf } from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { ActionRegistryService } from "../actions/action-registry.service";
import { AddressService } from "../addresses/address.service";
import { AppModule } from "../app.module";
import { AuditLogService } from "../audit/audit-log.service";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { registerMultipart } from "../http/multipart";
import { pngBytes } from "../media/testing/image-fixtures";
import { lockResidencyTransitions } from "../registers/residency-lock";
import { StorageService } from "../storage/storage.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { NO_ENTRY_PERMISSION } from "./issue-fit-views";
import { holdOfferedPlace, lockIssue } from "./issue-lock";
import {
  ISSUE_NOTICE_QUEUE,
  ISSUE_OVERDUE_QUEUE,
} from "./issue-mailer.service";

/**
 * What is particular to a Swedish house on an issue, over HTTP against a real
 * database (decisions 29 to 31): the resident's permission to enter, the
 * common-area place, and the mark of an inspection finding.
 *
 * What is under test is the promises. A door code is never stored. The entry
 * permission is cleared in the transaction that closes the issue, and the
 * database refuses a closed issue that holds one. A place is countable, by what
 * the reader may open. A finding has its protocol and its target date, and a
 * lift's is held to a month. And none of it is offered on `mcp` or `ai`.
 */

const env = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let registry: ActionRegistryService;
let associationCreatedHere = false;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

function person(key: string, firstName: string, lastName: string) {
  return {
    personId: `if-${key}-${suffix}`,
    email: `if-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `${lastName}${suffix}`,
  };
}

const board = person("board", "Bea", "Styrelse");
const admin = person("admin", "Ada", "Administrator");
const manager = person("manager", "Frida", "Forvaltare");
const resident = person("resident", "Rune", "Boende");
const neighbour = person("neighbour", "Nils", "Granne");
const people = [board, admin, manager, resident, neighbour];
const personIds = people.map((entry) => entry.personId);

const typeIds = {
  plain: `if-type-plain-${suffix}`,
  boardOnly: `if-type-board-${suffix}`,
};
let plain: IssueTypeFixture;
let boardOnly: IssueTypeFixture;
const apartmentId = `if-apartment-${suffix}`;

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object | Buffer;
  cookie?: string;
  headers?: Record<string, string>;
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
        // 10.201.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.201.${String(subnet)}.${String(host + 1)}`,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
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

const cookies: Record<string, string> = {};
function cookieOf(entry: { personId: string }): string {
  const cookie = cookies[entry.personId];
  if (cookie === undefined) {
    throw new Error(`${entry.personId} is not signed in`);
  }
  return cookie;
}

function call(
  who: { personId: string },
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: object,
) {
  return inject({
    method,
    url,
    cookie: cookieOf(who),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** A multipart body carrying one file, built by hand so no client is assumed. */
function multipart(bytes: Buffer, fileName: string, contentType: string) {
  const boundary = "----openbrfFitBoundary";
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      origin: new URL(env.APP_URL).origin,
    },
  };
}

let issueCounter = 0;
/** An issue, written directly, as the queue would hold it. */
async function filed(
  type: IssueTypeFixture,
  extra: {
    withApartment?: boolean;
    meaning?: "NEW" | "DONE";
    boardOnly?: boolean;
    placeId?: string;
  } = {},
): Promise<string> {
  issueCounter += 1;
  const id = `if-issue-${String(issueCounter)}-${suffix}`;
  const meaning = extra.meaning ?? "NEW";
  await prisma.issue.create({
    data: {
      id,
      typeId: type.id,
      statusId: type.statusIds[meaning],
      reporterPersonId: resident.personId,
      apartmentId: extra.withApartment === false ? null : apartmentId,
      placeId: extra.placeId ?? null,
      description: `Beskrivning ${String(issueCounter)}`,
      boardOnly: extra.boardOnly ?? false,
      ...(meaning === "DONE"
        ? { closedAt: new Date(), outcome: "FIXED" as const }
        : {}),
    },
  });
  return id;
}

async function place(name: string, active = true): Promise<string> {
  const created = await prisma.issuePlace.create({
    data: { name: `${name} ${suffix}`, active },
    select: { id: true },
  });
  return created.id;
}

/** The overdue reminders queued for one issue, in the order they were queued. */
async function overdueJobs(issueId: string): Promise<unknown[]> {
  const rows = await prisma.$queryRawUnsafe<{ data: unknown }[]>(
    "SELECT data FROM pgboss.job WHERE name = $1 AND data->>'issueId' = $2 ORDER BY created_on, id",
    ISSUE_OVERDUE_QUEUE,
    issueId,
  );
  return rows.map((row) => row.data);
}

async function stored(issueId: string) {
  return prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: {
      entryAnswer: true,
      entryNote: true,
      entryPets: true,
      entryMasterKey: true,
      entryUntil: true,
      placeId: true,
      targetDate: true,
      closedAt: true,
    },
  });
}

/**
 * Whether some backend comes to wait on a lock the given backend holds, within
 * ten seconds. A race test must see the second party queued behind the first:
 * a delay alone would also pass when the second reached the database late,
 * after the first had committed. Only that one backend is looked at, so other
 * workers' lock waiters do not count.
 */
async function blockedBehind(holderPid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting
      FROM pg_stat_activity
      WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
    if ((row?.waiting ?? 0n) > 0n) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Holds a transaction open after `work`, with the locks it took, until the
 * returned `release` is called, and then runs `after` in it, as a write that
 * read first and writes once a second party is queued behind it. `pid` is its
 * backend, for {@link blockedBehind}. A `work` that throws rejects `done` and
 * this call alike, so a failure there does not leave the caller waiting.
 */
async function heldOpen(
  work: (tx: Prisma.TransactionClient) => Promise<unknown>,
  after?: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<{ pid: number; release: () => void; done: Promise<unknown> }> {
  let holding!: (pid: number) => void;
  const holds = new Promise<number>((resolve) => {
    holding = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = prisma.$transaction(async (tx) => {
    await work(tx);
    const [backend] = await tx.$queryRaw<
      { pid: number }[]
    >`SELECT pg_backend_pid() AS pid`;
    holding(backend?.pid ?? 0);
    await released;
    await after?.(tx);
  });
  const pid = await Promise.race([holds, done.then(() => 0)]);
  return { pid, release, done };
}

/** A day offset from today, as `YYYY-MM-DD`. */
function dayFromToday(offset: number): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

/** Attaches a file for the handlers and returns the attachment's identifier. */
async function attachProtocol(
  who: { personId: string },
  issueId: string,
): Promise<string> {
  const body = multipart(pngBytes(24, 24), "protokoll.png", "image/png");
  const response = await inject({
    method: "POST",
    url: `/api/issue-queue/${issueId}/attachments`,
    payload: body.payload,
    headers: { ...body.headers, cookie: cookieOf(who) },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await registerMultipart(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  encryption = app.get(FieldEncryptionService);
  registry = app.get(ActionRegistryService);

  associationCreatedHere =
    (await prisma.association.findUnique({ where: { id: 1 } })) === null;
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
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: entry.personId,
      email: entry.email,
      name: `${entry.firstName} ${entry.lastName}`,
      password: PASSWORD,
    });
  }
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER" as const,
      electedOn: new Date("2025-05-15"),
    },
  });
  await prisma.systemRole.createMany({
    data: [
      { personId: admin.personId, role: "ADMIN" as const },
      { personId: manager.personId, role: "PROPERTY_MANAGER" as const },
    ],
  });
  const addressId = `if-address-${suffix}`;
  await prisma.address.create({
    data: {
      id: addressId,
      street: "Passagatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1701", floor: 7 },
  });
  await prisma.residency.createMany({
    data: [resident, neighbour].map((entry) => ({
      personId: entry.personId,
      apartmentId,
      role: "MEMBER" as const,
      movedInOn: new Date("2024-01-01"),
    })),
  });

  plain = await createIssueTypeFixture(prisma, {
    id: typeIds.plain,
    name: `Övrigt ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  boardOnly = await createIssueTypeFixture(prisma, {
    id: typeIds.boardOnly,
    name: `Försäkring ${suffix}`,
    reporters: ["RESIDENTS"],
    handledBy: "BOARD",
  });

  for (const entry of people) {
    cookies[entry.personId] = await signIn(entry.email);
  }
}, 180_000);

afterAll(async () => {
  // The jobs this run's issues queued: a finding's target date queues its
  // overdue reminder.
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
  await prisma.issuePlace.deleteMany({
    where: { name: { contains: suffix } },
  });
  const uploaded = await prisma.mediaFile.findMany({
    where: { uploadedByPersonId: { in: personIds } },
    select: { storageKey: true, unencryptedStorageKey: true },
  });
  const storage = app.get(StorageService);
  for (const file of uploaded) {
    for (const key of [file.storageKey, file.unencryptedStorageKey]) {
      if (key !== null) {
        await storage.remove(key);
      }
    }
  }
  await prisma.mediaFile.deleteMany({
    where: { uploadedByPersonId: { in: personIds } },
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
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.apartment.deleteMany({
    where: { addressId: `if-address-${suffix}` },
  });
  await prisma.address.deleteMany({ where: { id: `if-address-${suffix}` } });
  // Restored rather than left as this suite wanted it: the suites on this
  // worker share one database, and a later one that finds an association with
  // no organisation number reads it as not set up.
  if (associationCreatedHere) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  }
  await app.close();
});

describe("permission to enter", () => {
  it("is answered by the resident and read by them and the handlers", async () => {
    const issueId = await filed(plain);
    const until = dayFromToday(30);

    const answered = await call(
      resident,
      "PUT",
      `/api/issues/${issueId}/entry-permission`,
      {
        answer: "YES",
        note: "Ring Bea på 070 123 45 67 först.",
        pets: true,
        masterKey: true,
        until,
      },
    );
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toEqual({
      entry: {
        answer: "YES",
        note: "Ring Bea på 070 123 45 67 först.",
        pets: true,
        masterKey: true,
        until,
        expired: false,
      },
    });

    const own = await call(resident, "GET", "/api/issues/mine");
    const mine = own
      .json<{ id: string; entry: unknown }[]>()
      .find((issue) => issue.id === issueId);
    expect(mine?.entry).toMatchObject({ answer: "YES", pets: true });

    const queue = await call(board, "GET", "/api/issue-queue");
    const seen = queue
      .json<{ id: string; entry: { note: string } | null }[]>()
      .find((issue) => issue.id === issueId);
    expect(seen?.entry?.note).toBe("Ring Bea på 070 123 45 67 först.");

    // Facts in the audit entry, never the note.
    const entries = await prisma.auditLogEntry.findMany({
      where: { targetKind: "issue", targetId: issueId },
      select: { action: true, actorPersonId: true, context: true },
    });
    const set = entries.find(
      (entry) => entry.action === "ISSUE_ENTRY_PERMISSION_SET",
    );
    expect(set?.actorPersonId).toBe(resident.personId);
    // The answer and who gave it; the details of the home go with the issue's
    // closing, and the audit log would outlive that.
    expect(set?.context).toEqual({ answer: "YES", byReporter: true });
    expect(JSON.stringify(entries)).not.toContain("Ring Bea");
  });

  it("is shown on the timeline without naming the resident", async () => {
    const issueId = await filed(plain);
    await call(resident, "PUT", `/api/issues/${issueId}/entry-permission`, {
      answer: "NO",
    });

    const timeline = await call(
      board,
      "GET",
      `/api/issue-queue/${issueId}/timeline`,
    );
    const step = timeline
      .json<{ kind: string; actor: unknown; byReporter?: boolean }[]>()
      .find((each) => each.kind === "entry");
    expect(step).toMatchObject({
      kind: "entry",
      answer: "NO",
      byReporter: true,
      actor: null,
    });
    expect(timeline.body).not.toContain(resident.personId);
  });

  it("refuses a note that reads like a door code, and stores nothing", async () => {
    const issueId = await filed(plain);
    const note = "Porten har koden 4821";

    const refused = await call(
      resident,
      "PUT",
      `/api/issues/${issueId}/entry-permission`,
      { answer: "YES", note },
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      reason: "door-code",
      locations: [{ part: "entryNote", offset: note.indexOf("koden") }],
    });
    // Where it starts, and never what it says.
    expect(refused.body).not.toContain("4821");

    expect((await stored(issueId)).entryAnswer).toBeNull();
    const entries = await prisma.auditLogEntry.count({
      where: {
        targetKind: "issue",
        targetId: issueId,
        action: "ISSUE_ENTRY_PERMISSION_SET",
      },
    });
    expect(entries).toBe(0);

    // The same refusal when a handler writes it for the resident.
    const byHandler = await call(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/entry-permission`,
      { answer: "YES", note },
    );
    expect(byHandler.statusCode).toBe(422);
    expect(byHandler.json()).toMatchObject({ reason: "door-code" });
  });

  it("keeps a no to the answer alone", async () => {
    const issueId = await filed(plain);

    const answered = await call(
      resident,
      "PUT",
      `/api/issues/${issueId}/entry-permission`,
      { answer: "NO", note: "Inte utan mig", pets: true },
    );
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({
      entry: { answer: "NO", note: null, pets: null, masterKey: null },
    });
    expect(await stored(issueId)).toMatchObject({
      entryAnswer: "NO",
      entryNote: null,
      entryPets: null,
    });
  });

  it("belongs to an issue about an apartment", async () => {
    const issueId = await filed(plain, { withApartment: false });

    const refused = await call(
      resident,
      "PUT",
      `/api/issues/${issueId}/entry-permission`,
      { answer: "YES" },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "entry-needs-apartment" });
  });

  it("is not granted by a reporter who has moved to another apartment", async () => {
    // Somebody with no residency at all is refused at the door; the case here
    // is the one that still gets through it, a resident of another apartment.
    const issueId = await filed(plain);
    const otherApartmentId = `if-moved-${suffix}`;
    const home = await prisma.apartment.findUniqueOrThrow({
      where: { id: apartmentId },
      select: { addressId: true },
    });
    await prisma.apartment.create({
      data: {
        id: otherApartmentId,
        addressId: home.addressId,
        number: "1702",
        floor: 7,
      },
    });
    const newResidency = await prisma.residency.create({
      data: {
        personId: resident.personId,
        apartmentId: otherApartmentId,
        role: "MEMBER",
        movedInOn: new Date(dayFromToday(-1)),
      },
      select: { id: true },
    });
    const residency = await prisma.residency.findFirstOrThrow({
      where: { personId: resident.personId, apartmentId },
      select: { id: true },
    });
    await prisma.residency.update({
      where: { id: residency.id },
      data: { movedOutOn: new Date(dayFromToday(-1)) },
    });
    try {
      const yes = await call(
        resident,
        "PUT",
        `/api/issues/${issueId}/entry-permission`,
        { answer: "YES" },
      );
      expect(yes.statusCode).toBe(409);
      expect(yes.json()).toMatchObject({ reason: "entry-not-resident" });
      expect(await stored(issueId)).toMatchObject({ entryAnswer: null });

      const no = await call(
        resident,
        "PUT",
        `/api/issues/${issueId}/entry-permission`,
        { answer: "NO" },
      );
      expect(no.statusCode).toBe(200);
    } finally {
      await prisma.residency.update({
        where: { id: residency.id },
        data: { movedOutOn: null },
      });
      await prisma.residency.delete({ where: { id: newResidency.id } });
      await prisma.apartment.delete({ where: { id: otherApartmentId } });
    }
  });

  it("is not granted by a reporter whose residency has not begun, who is stopped at the door", async () => {
    // Before the service's own residency check: somebody who does not live
    // anywhere yet holds no resident's scope.
    const issueId = await filed(plain);
    const residency = await prisma.residency.findFirstOrThrow({
      where: { personId: resident.personId, apartmentId },
      select: { id: true, movedInOn: true },
    });
    await prisma.residency.update({
      where: { id: residency.id },
      data: { movedInOn: new Date(dayFromToday(5)) },
    });
    try {
      const yes = await call(
        resident,
        "PUT",
        `/api/issues/${issueId}/entry-permission`,
        { answer: "YES" },
      );
      expect(yes.statusCode).toBe(403);
      expect(await stored(issueId)).toMatchObject({ entryAnswer: null });
    } finally {
      await prisma.residency.update({
        where: { id: residency.id },
        data: { movedInOn: residency.movedInOn },
      });
    }
  });

  it("is not granted when the reporter's move-out is committing as the yes arrives", async () => {
    const issueId = await filed(plain);
    const residency = await prisma.residency.findFirstOrThrow({
      where: { personId: resident.personId, apartmentId },
      select: { id: true },
    });

    // A move-out under way: it holds the person's transition key and has
    // written an end date that its own snapshot shows and the yes's does not.
    const moveOut = await heldOpen(async (tx) => {
      await lockResidencyTransitions(tx, resident.personId);
      await tx.residency.update({
        where: { id: residency.id },
        data: { movedOutOn: new Date(dayFromToday(-1)) },
      });
    });
    try {
      const answer = call(
        resident,
        "PUT",
        `/api/issues/${issueId}/entry-permission`,
        { answer: "YES" },
      );
      expect(await blockedBehind(moveOut.pid)).toBe(true);
      moveOut.release();
      await moveOut.done;

      const yes = await answer;
      expect(yes.statusCode).toBe(409);
      expect(yes.json()).toMatchObject({ reason: "entry-not-resident" });
      expect(await stored(issueId)).toMatchObject({ entryAnswer: null });
    } finally {
      moveOut.release();
      await moveOut.done.catch(() => undefined);
      await prisma.residency.update({
        where: { id: residency.id },
        data: { movedOutOn: null },
      });
    }
  });

  it("is not answered by a neighbour, or with a day that has passed", async () => {
    const issueId = await filed(plain);

    const byNeighbour = await call(
      neighbour,
      "PUT",
      `/api/issues/${issueId}/entry-permission`,
      { answer: "YES" },
    );
    expect(byNeighbour.statusCode).toBe(404);
    expect(byNeighbour.json()).toMatchObject({ reason: "issue-not-found" });

    const lapsed = await call(
      resident,
      "PUT",
      `/api/issues/${issueId}/entry-permission`,
      { answer: "YES", until: dayFromToday(-1) },
    );
    expect(lapsed.statusCode).toBe(422);
    expect(lapsed.json()).toMatchObject({ reason: "entry-until-past" });

    const impossible = await call(
      resident,
      "PUT",
      `/api/issues/${issueId}/entry-permission`,
      { answer: "YES", until: "2027-02-30" },
    );
    expect(impossible.statusCode).toBe(422);
    expect(impossible.json()).toMatchObject({ reason: "date-invalid" });
  });

  it("is recorded by a handler for the resident, and withdrawn", async () => {
    const issueId = await filed(plain);

    const recorded = await call(
      manager,
      "PUT",
      `/api/issue-queue/${issueId}/entry-permission`,
      { answer: "YES", note: "Nyckel hos grannen", pets: false },
    );
    expect(recorded.statusCode).toBe(200);
    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        targetKind: "issue",
        targetId: issueId,
        action: "ISSUE_ENTRY_PERMISSION_SET",
      },
      select: { actorPersonId: true, context: true },
    });
    expect(entry?.actorPersonId).toBe(manager.personId);
    expect(entry?.context).toMatchObject({ byReporter: false });

    const withdrawn = await call(
      resident,
      "DELETE",
      `/api/issues/${issueId}/entry-permission`,
    );
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json()).toEqual({ entry: null });
    expect((await stored(issueId)).entryAnswer).toBeNull();
    expect(
      await prisma.auditLogEntry.count({
        where: {
          targetKind: "issue",
          targetId: issueId,
          action: "ISSUE_ENTRY_PERMISSION_REMOVED",
        },
      }),
    ).toBe(1);
  });

  it("refuses a personal identity number in what a handler writes", async () => {
    const issueId = await filed(plain);

    const refused = await call(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/entry-permission`,
      { answer: "YES", note: "Ring Erik, 19811218-9876." },
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      reason: "personal-identity-number",
    });
    expect(refused.body).not.toContain("9876");
  });

  it("is kept from a handler the board-only rule shuts out", async () => {
    const issueId = await filed(boardOnly);
    await call(resident, "PUT", `/api/issues/${issueId}/entry-permission`, {
      answer: "YES",
    });

    const byManager = await call(
      manager,
      "PUT",
      `/api/issue-queue/${issueId}/entry-permission`,
      { answer: "NO" },
    );
    expect(byManager.statusCode).toBe(404);
    expect((await stored(issueId)).entryAnswer).toBe("YES");
  });

  it("is cleared in the transaction that closes the issue", async () => {
    const issueId = await filed(plain);
    await call(resident, "PUT", `/api/issues/${issueId}/entry-permission`, {
      answer: "YES",
      note: "Ring på",
      pets: true,
      masterKey: true,
      until: dayFromToday(10),
    });

    const closed = await call(
      board,
      "POST",
      `/api/issue-queue/${issueId}/status`,
      { statusId: plain.statusIds.DONE, outcome: "FIXED" },
    );
    expect(closed.statusCode).toBe(201);
    expect(closed.json()).toMatchObject({ entry: null });

    expect(await stored(issueId)).toMatchObject({
      entryAnswer: null,
      entryNote: null,
      entryPets: null,
      entryMasterKey: null,
      entryUntil: null,
    });
    const change = await prisma.auditLogEntry.findFirst({
      where: {
        targetKind: "issue",
        targetId: issueId,
        action: "ISSUE_STATUS_CHANGED",
      },
      select: { context: true },
    });
    expect(change?.context).toMatchObject({ entryPermissionCleared: true });

    // And a closed issue takes no answer.
    const late = await call(
      resident,
      "PUT",
      `/api/issues/${issueId}/entry-permission`,
      { answer: "YES" },
    );
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ reason: "issue-closed" });
  });

  it("is refused by the database on a closed issue, whatever wrote it", async () => {
    const issueId = await filed(plain, { meaning: "DONE" });

    await expect(
      prisma.issue.update({
        where: { id: issueId },
        data: { entryAnswer: "YES", entryPets: false, entryMasterKey: false },
      }),
    ).rejects.toThrow();
    expect((await stored(issueId)).entryAnswer).toBeNull();
  });

  it("goes with the apartment when the board removes it", async () => {
    const goneId = `if-apartment-gone-${suffix}`;
    await prisma.apartment.create({
      data: {
        id: goneId,
        addressId: `if-address-${suffix}`,
        number: "1702",
        floor: 7,
      },
    });
    const issueId = await filed(plain);
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        apartmentId: goneId,
        entryAnswer: "YES",
        entryNote: "Ring på",
        entryPets: true,
        entryMasterKey: false,
      },
    });

    await app
      .get(AddressService)
      .removeApartment(goneId, { personId: board.personId, channel: "WEB" });

    expect(await stored(issueId)).toMatchObject({
      entryAnswer: null,
      entryNote: null,
      entryPets: null,
      entryMasterKey: null,
      entryUntil: null,
    });
    // The issue itself stays, about no apartment now.
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { apartmentId: true },
    });
    expect(after.apartmentId).toBeNull();

    // Recorded as withdrawn by the board member who removed the apartment, so
    // the timeline does not end on the answer; facts only, never the note.
    const removed = await prisma.auditLogEntry.findMany({
      where: {
        targetKind: "issue",
        targetId: issueId,
        action: "ISSUE_ENTRY_PERMISSION_REMOVED",
      },
      select: { actorPersonId: true, context: true },
    });
    expect(removed).toEqual([
      {
        actorPersonId: board.personId,
        context: { byReporter: false, apartmentRemoved: true },
      },
    ]);
  });

  it("goes with the apartment when an answer is still being written as the board removes it", async () => {
    const goneId = `if-apartment-racing-${suffix}`;
    await prisma.apartment.create({
      data: {
        id: goneId,
        addressId: `if-address-${suffix}`,
        number: "1703",
        floor: 7,
      },
    });
    const issueId = await filed(plain, { withApartment: false });
    await prisma.issue.update({
      where: { id: issueId },
      data: { apartmentId: goneId },
    });

    // An answer written but not yet committed: the removal's own snapshot
    // still shows the issue with no answer.
    const write = await heldOpen((tx) =>
      tx.issue.update({
        where: { id: issueId },
        data: { entryAnswer: "YES", entryPets: false, entryMasterKey: true },
      }),
    );
    const removal = app
      .get(AddressService)
      .removeApartment(goneId, { personId: board.personId, channel: "WEB" });
    expect(await blockedBehind(write.pid)).toBe(true);
    write.release();
    await write.done;
    await removal;

    expect(await stored(issueId)).toMatchObject({
      entryAnswer: null,
      entryPets: null,
      entryMasterKey: null,
    });
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { apartmentId: true },
    });
    expect(after.apartmentId).toBeNull();
    // The answer committed while the removal waited is the one recorded as
    // taken off.
    expect(
      await prisma.auditLogEntry.count({
        where: {
          targetKind: "issue",
          targetId: issueId,
          action: "ISSUE_ENTRY_PERMISSION_REMOVED",
        },
      }),
    ).toBe(1);
  });

  it("records one withdrawal when a handler's withdrawal and the apartment's removal come together", async () => {
    const goneId = `if-apartment-withdrawn-${suffix}`;
    await prisma.apartment.create({
      data: {
        id: goneId,
        addressId: `if-address-${suffix}`,
        number: "1705",
        floor: 7,
      },
    });
    const issueId = await filed(plain, { withApartment: false });
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        apartmentId: goneId,
        entryAnswer: "YES",
        entryPets: false,
        entryMasterKey: true,
      },
    });

    // A withdrawal as the service makes it: under the issue's lock it reads
    // the answer and records the withdrawal, and writes the clearing last.
    const withdrawal = await heldOpen(
      async (tx) => {
        await lockIssue(tx, issueId);
        const read = await tx.issue.findUniqueOrThrow({
          where: { id: issueId },
          select: { entryAnswer: true },
        });
        expect(read.entryAnswer).toBe("YES");
        await app.get(AuditLogService).record(
          {
            action: "ISSUE_ENTRY_PERMISSION_REMOVED",
            channel: "WEB",
            actorPersonId: board.personId,
            targetKind: "issue",
            targetId: issueId,
            context: { byReporter: false },
          },
          tx,
        );
      },
      (tx) =>
        tx.issue.updateMany({
          where: { id: issueId },
          data: NO_ENTRY_PERMISSION,
        }),
    );
    let removal: Promise<unknown> | undefined;
    try {
      removal = app
        .get(AddressService)
        .removeApartment(goneId, { personId: board.personId, channel: "WEB" });
      // Behind the withdrawal's issue lock, so it reads the answer once it is
      // cleared. Without the lock it would take the row, read the answer the
      // withdrawal has already recorded as taken off, and record it again.
      expect(await blockedBehind(withdrawal.pid)).toBe(true);
    } finally {
      withdrawal.release();
      await withdrawal.done.catch(() => undefined);
      await removal?.catch(() => undefined);
    }
    await withdrawal.done;
    await removal;

    expect(
      await prisma.auditLogEntry.count({
        where: {
          targetKind: "issue",
          targetId: issueId,
          action: "ISSUE_ENTRY_PERMISSION_REMOVED",
        },
      }),
    ).toBe(1);
    expect(await stored(issueId)).toMatchObject({ entryAnswer: null });
  });

  it("holds a handler's withdrawal behind the issue's lock, then records it once", async () => {
    const issueId = await filed(plain);
    await call(manager, "PUT", `/api/issue-queue/${issueId}/entry-permission`, {
      answer: "YES",
      note: "Nyckel hos grannen",
    });

    // Another writer of the issue holds its lock; the handler's withdrawal
    // goes through the route, so it must queue behind that lock.
    const holder = await heldOpen((tx) => lockIssue(tx, issueId));
    let withdrawal: ReturnType<typeof call> | undefined;
    try {
      withdrawal = call(
        manager,
        "DELETE",
        `/api/issue-queue/${issueId}/entry-permission`,
      );
      expect(await blockedBehind(holder.pid)).toBe(true);
    } finally {
      holder.release();
      await holder.done.catch(() => undefined);
      await withdrawal?.catch(() => undefined);
    }
    await holder.done;
    expect((await withdrawal)?.statusCode).toBe(200);

    expect(
      await prisma.auditLogEntry.count({
        where: {
          targetKind: "issue",
          targetId: issueId,
          action: "ISSUE_ENTRY_PERMISSION_REMOVED",
        },
      }),
    ).toBe(1);
    expect((await stored(issueId)).entryAnswer).toBeNull();
  });

  it("stays, with nothing recorded, when a key refuses the apartment's removal", async () => {
    const keptId = `if-apartment-kept-${suffix}`;
    const fileId = `if-apartment-kept-file-${suffix}`;
    await prisma.apartment.create({
      data: {
        id: keptId,
        addressId: `if-address-${suffix}`,
        number: "1704",
        floor: 7,
      },
    });
    const issueId = await filed(plain, { withApartment: false });
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        apartmentId: keptId,
        entryAnswer: "YES",
        entryNote: "Ring på",
        entryPets: true,
        entryMasterKey: false,
      },
    });
    // A file of the apartment's: its key is Restrict and the removal does not
    // count it, so the delete raises P2003 after the answers were cleared and
    // their withdrawals recorded, inside the same transaction.
    await prisma.mediaFile.create({
      data: {
        id: fileId,
        storageKey: `if-apartment-kept-${suffix}`,
        encryption: "NONE",
        contentType: "application/pdf",
        byteSize: 1024,
        checksum: `sha-if-kept-${suffix}`,
        fileName: "ritning.pdf",
        visibility: "HOUSEHOLD",
        apartmentId: keptId,
      },
    });

    try {
      await expect(
        app.get(AddressService).removeApartment(keptId, {
          personId: board.personId,
          channel: "WEB",
        }),
      ).rejects.toMatchObject({ reason: "apartment-in-use" });

      expect(await stored(issueId)).toMatchObject({
        entryAnswer: "YES",
        entryNote: "Ring på",
        entryPets: true,
        entryMasterKey: false,
      });
      const after = await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { apartmentId: true },
      });
      expect(after.apartmentId).toBe(keptId);
      expect(
        await prisma.auditLogEntry.count({
          where: {
            targetKind: "issue",
            targetId: issueId,
            action: "ISSUE_ENTRY_PERMISSION_REMOVED",
          },
        }),
      ).toBe(0);
    } finally {
      await prisma.mediaFile.delete({ where: { id: fileId } });
    }
  });

  it("is refused when it lands after the board removed the apartment", async () => {
    const issueId = await filed(plain);

    // The removal under way: it has the issue's row and takes the apartment
    // off it. The handler's write reads the issue as it stood before and then
    // waits for that row.
    const removal = await heldOpen((tx) =>
      tx.issue.update({
        where: { id: issueId },
        data: { apartmentId: null },
      }),
    );
    // Awaited inside, so the request is sent now and not when it is awaited.
    const answer = (async () =>
      call(board, "PUT", `/api/issue-queue/${issueId}/entry-permission`, {
        answer: "YES",
        pets: false,
        masterKey: false,
      }))();
    expect(await blockedBehind(removal.pid)).toBe(true);
    removal.release();
    await removal.done;

    const refused = await answer;
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ reason: "issue-not-found" });
    expect((await stored(issueId)).entryAnswer).toBeNull();
    expect(
      await prisma.auditLogEntry.count({
        where: {
          targetId: issueId,
          action: "ISSUE_ENTRY_PERMISSION_SET",
        },
      }),
    ).toBe(0);
  });

  it("keeps a half-filled yes out of the table", async () => {
    const issueId = await filed(plain);

    await expect(
      prisma.issue.update({
        where: { id: issueId },
        data: { entryAnswer: "YES" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.issue.update({
        where: { id: issueId },
        data: { entryNote: "Ring på" },
      }),
    ).rejects.toThrow();
  });
});

describe("common-area places", () => {
  it("are written by the board, never apartments, one of a name", async () => {
    const name = `Tvättstuga ${suffix}`;
    const created = await call(board, "POST", "/api/issue-places", { name });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name, active: true, issueCount: 0 });

    // The same name however it is capitalised, so a count is not split.
    const again = await call(admin, "POST", "/api/issue-places", {
      name: name.toUpperCase(),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ reason: "place-name-taken" });

    for (const apartment of ["Lgh 1101", "Lägenhet 1203", "1101", "1202A"]) {
      const refused = await call(admin, "POST", "/api/issue-places", {
        name: apartment,
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ reason: "place-name-apartment" });
    }

    const byManager = await call(manager, "POST", "/api/issue-places", {
      name: `Gård ${suffix}`,
    });
    expect(byManager.statusCode).toBe(403);
  });

  it("keep their place in the list when a sort order is null, empty or text", async () => {
    const id = await place("Ordning");
    await prisma.issuePlace.update({ where: { id }, data: { sortOrder: 7 } });

    // Number(null) and Number("") are 0: coerced, these would move the place
    // to the top of the list instead of being refused.
    for (const sortOrder of [null, "", "3", -1, 1000, 1.5]) {
      const refused = await call(admin, "PUT", `/api/issue-places/${id}`, {
        name: `Ordning ${suffix}`,
        sortOrder,
      });
      expect(refused.statusCode, JSON.stringify(sortOrder)).toBe(400);
    }
    const created = await call(admin, "POST", "/api/issue-places", {
      name: `Ordning ny ${suffix}`,
      sortOrder: null,
    });
    expect(created.statusCode).toBe(400);
    expect(
      await prisma.issuePlace.findUnique({
        where: { id },
        select: { sortOrder: true },
      }),
    ).toEqual({ sortOrder: 7 });

    const moved = await call(admin, "PUT", `/api/issue-places/${id}`, {
      name: `Ordning ${suffix}`,
      sortOrder: 0,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ sortOrder: 0 });
  });

  it("are offered to a reporter as they stand, switched-off ones left out", async () => {
    const offered = await place("Hiss");
    const off = await place("Bastu", false);

    const response = await call(resident, "GET", "/api/issues/places");
    expect(response.statusCode).toBe(200);
    const ids = response.json<{ id: string }[]>().map((each) => each.id);
    expect(ids).toContain(offered);
    expect(ids).not.toContain(off);
  });

  it("are named on a report, and a switched-off one is refused", async () => {
    const lift = await place("Hiss rapport");
    const off = await place("Bastu rapport", false);

    const reported = await call(resident, "POST", "/api/issues", {
      typeId: plain.id,
      placeId: lift,
      description: "Hissen står still.",
    });
    expect(reported.statusCode).toBe(201);
    const { id } = reported.json<{ id: string }>();
    expect((await stored(id)).placeId).toBe(lift);

    const mine = await call(resident, "GET", "/api/issues/mine");
    expect(
      mine
        .json<{ id: string; place: { id: string } | null }[]>()
        .find((issue) => issue.id === id)?.place?.id,
    ).toBe(lift);

    const refused = await call(resident, "POST", "/api/issues", {
      typeId: plain.id,
      placeId: off,
      description: "Bastun är kall.",
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ reason: "place-not-found" });
  });

  it("make a repeat fault countable, by what the reader may open", async () => {
    const lift = await place("Hiss räkning");
    await filed(plain, { placeId: lift, withApartment: false });
    await filed(plain, {
      placeId: lift,
      withApartment: false,
      meaning: "DONE",
    });
    await filed(boardOnly, { placeId: lift, withApartment: false });

    const forBoard = await call(board, "GET", "/api/issue-queue/places");
    expect(forBoard.statusCode).toBe(200);
    expect(
      forBoard
        .json<{ id: string; issues: number; open: number }[]>()
        .find((each) => each.id === lift),
    ).toMatchObject({ issues: 3, open: 2 });

    // The property manager is not told how many the board keeps to itself.
    const forManager = await call(manager, "GET", "/api/issue-queue/places");
    expect(
      forManager
        .json<{ id: string; issues: number; open: number }[]>()
        .find((each) => each.id === lift),
    ).toMatchObject({ issues: 2, open: 1 });

    const narrowed = await call(
      board,
      "GET",
      `/api/issue-queue?placeId=${lift}`,
    );
    expect(narrowed.json<unknown[]>()).toHaveLength(3);

    // The place narrows a view and its count alike, as the screen reads them.
    const snapshot = await call(
      board,
      "GET",
      `/api/issue-queue/snapshot?view=ALL&placeId=${lift}`,
    );
    expect(snapshot.statusCode).toBe(200);
    const read = snapshot.json<{
      issues: unknown[];
      counts: { all: number };
    }>();
    expect(read.issues).toHaveLength(3);
    expect(read.counts.all).toBe(3);

    // The place's name is searched as well: its words are on no other text.
    const searched = await call(
      board,
      "GET",
      `/api/issue-queue?q=${encodeURIComponent(`räkning ${suffix}`)}`,
    );
    expect(searched.statusCode).toBe(200);
    expect(searched.json<unknown[]>()).toHaveLength(3);
  });

  it("are set by a handler, and recorded on the timeline", async () => {
    const yard = await place("Gård sätt");
    const issueId = await filed(plain, { withApartment: false });

    const set = await call(board, "PUT", `/api/issue-queue/${issueId}/place`, {
      placeId: yard,
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ place: { id: yard } });

    const timeline = await call(
      board,
      "GET",
      `/api/issue-queue/${issueId}/timeline`,
    );
    expect(
      timeline.json<{ kind: string }[]>().map((each) => each.kind),
    ).toContain("place");

    const removed = await call(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/place`,
      { placeId: null },
    );
    expect(removed.json()).toMatchObject({ place: null });

    const unknown = await call(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/place`,
      { placeId: "no-such-place" },
    );
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ reason: "place-not-found" });
  });

  it("are never named on an issue about an apartment, by any path", async () => {
    const laundry = await place("Tvättstuga lägenhet");

    // A report naming both, which the form never sends.
    const reported = await call(resident, "POST", "/api/issues", {
      typeId: plain.id,
      apartmentId,
      placeId: laundry,
      description: "Det droppar.",
    });
    expect(reported.statusCode).toBe(409);
    expect(reported.json()).toMatchObject({ reason: "place-with-apartment" });

    // A handler opening one for a resident, whose apartment it is about.
    const residency = await prisma.residency.findFirstOrThrow({
      where: { personId: resident.personId, apartmentId },
      select: { id: true },
    });
    const opened = await call(board, "POST", "/api/issue-queue", {
      typeId: plain.id,
      residencyId: residency.id,
      placeId: laundry,
      description: "Det droppar.",
    });
    expect(opened.statusCode).toBe(409);
    expect(opened.json()).toMatchObject({ reason: "place-with-apartment" });

    // A handler setting one on an issue about an apartment.
    const issueId = await filed(plain);
    const set = await call(board, "PUT", `/api/issue-queue/${issueId}/place`, {
      placeId: laundry,
    });
    expect(set.statusCode).toBe(409);
    expect(set.json()).toMatchObject({ reason: "place-with-apartment" });
    expect((await stored(issueId)).placeId).toBeNull();
    // Taking none off is still answered.
    const none = await call(board, "PUT", `/api/issue-queue/${issueId}/place`, {
      placeId: null,
    });
    expect(none.statusCode).toBe(200);

    // And the database refuses a path that forgets to.
    await expect(
      prisma.issue.update({
        where: { id: issueId },
        data: { placeId: laundry },
      }),
    ).rejects.toThrow();
    expect(await prisma.issue.count({ where: { placeId: laundry } })).toBe(0);
  });

  it("are held while a write names them, so the board's removal waits and is refused", async () => {
    const held = await place("Cykelrum hålls");
    const issueId = await filed(plain, { withApartment: false });

    // The write holds the place, then waits for the removal to be under way
    // before it names it, as a report or a handler's change does.
    const write = await heldOpen(
      async (tx) => {
        expect(await holdOfferedPlace(tx, held)).toBe(true);
      },
      (tx) =>
        tx.issue.update({
          where: { id: issueId },
          data: { placeId: held },
        }),
    );

    let removal: ReturnType<typeof call> | undefined;
    try {
      removal = call(admin, "DELETE", `/api/issue-places/${held}`);
      expect(await blockedBehind(write.pid)).toBe(true);
    } finally {
      // Also when the wait failed: the held transaction would otherwise stand
      // until the timeout of an interactive transaction, with the place locked
      // for the rest of the file.
      write.release();
      await write.done.catch(() => undefined);
      await removal?.catch(() => undefined);
    }
    await write.done;
    const refused = await removal;
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "place-in-use" });
    expect((await stored(issueId)).placeId).toBe(held);
  });

  it("are switched off once an issue names them, and removed while none does", async () => {
    const used = await place("Soprum använt");
    await filed(plain, { placeId: used, withApartment: false });
    const unused = await place("Soprum oanvänt");

    const refused = await call(admin, "DELETE", `/api/issue-places/${used}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "place-in-use" });

    const removed = await call(admin, "DELETE", `/api/issue-places/${unused}`);
    expect(removed.statusCode).toBe(204);
    expect(await prisma.issuePlace.count({ where: { id: unused } })).toBe(0);

    const off = await call(admin, "PUT", `/api/issue-places/${used}`, {
      name: `Soprum använt ${suffix}`,
      active: false,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ active: false, issueCount: 1 });
  });
});

describe("an inspection finding", () => {
  it("is marked with its protocol and a real target date", async () => {
    const issueId = await filed(plain, { withApartment: false });
    const protocol = await attachProtocol(board, issueId);

    const marked = await call(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/finding`,
      {
        kind: "OVK",
        inspectedOn: "2026-03-10",
        protocolAttachmentId: protocol,
        targetDate: "2026-09-30",
      },
    );
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({
      targetDate: "2026-09-30",
      finding: {
        kind: "OVK",
        inspectedOn: "2026-03-10",
        protocol: { attachmentId: protocol, fileName: "protokoll.png" },
      },
    });
    expect((await stored(issueId)).targetDate?.toISOString()).toContain(
      "2026-09-30",
    );

    const entry = await prisma.auditLogEntry.findFirst({
      where: {
        targetKind: "issue",
        targetId: issueId,
        action: "ISSUE_FINDING_MARKED",
      },
      select: { context: true },
    });
    expect(entry?.context).toMatchObject({
      kind: "OVK",
      inspectedOn: "2026-03-10",
      targetDate: "2026-09-30",
      protocolAttachmentId: protocol,
    });
    // The file's name is free text about a case.
    expect(JSON.stringify(entry)).not.toContain("protokoll");
  });

  it("queues the overdue reminder for its target date, as any target date does", async () => {
    const issueId = await filed(plain, { withApartment: false });
    const protocol = await attachProtocol(board, issueId);
    const today = localDayOf(new Date());
    const finding = {
      kind: "OVK",
      inspectedOn: formatLocalDay(today),
      protocolAttachmentId: protocol,
      targetDate: formatLocalDay(addLocalDays(today, 60)),
    };

    const marked = await call(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/finding`,
      finding,
    );
    expect(marked.statusCode).toBe(200);
    expect(await overdueJobs(issueId)).toEqual([
      { issueId, targetDate: finding.targetDate },
    ]);

    // The same mark again changes no date and queues nothing more.
    await call(board, "PUT", `/api/issue-queue/${issueId}/finding`, finding);
    expect(await overdueJobs(issueId)).toHaveLength(1);

    // A mark that moves the date queues a reminder for the new one; the old
    // job stays and sends nothing, as for `IssueService.setTargetDate`.
    const moved = {
      ...finding,
      targetDate: formatLocalDay(addLocalDays(today, 90)),
    };
    const remarked = await call(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/finding`,
      moved,
    );
    expect(remarked.statusCode).toBe(200);
    expect(await overdueJobs(issueId)).toEqual([
      { issueId, targetDate: finding.targetDate },
      { issueId, targetDate: moved.targetDate },
    ]);
  });

  it("is read as overdue once its target date has passed", async () => {
    const issueId = await filed(plain, { withApartment: false });
    const protocol = await attachProtocol(board, issueId);

    const marked = await call(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/finding`,
      {
        kind: "FIRE",
        inspectedOn: "2020-01-10",
        protocolAttachmentId: protocol,
        targetDate: "2020-02-10",
      },
    );
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({ overdue: true });
  });

  it("holds a lift to a month from the inspection", async () => {
    const issueId = await filed(plain, { withApartment: false });
    const protocol = await attachProtocol(board, issueId);
    const finding = {
      kind: "LIFT",
      inspectedOn: "2026-01-31",
      protocolAttachmentId: protocol,
    };

    const late = await call(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/finding`,
      {
        ...finding,
        targetDate: "2026-03-01",
      },
    );
    expect(late.statusCode).toBe(422);
    expect(late.json()).toMatchObject({
      reason: "finding-target-date-too-late",
    });

    // One month from 31 January is the last day of February.
    const ok = await call(board, "PUT", `/api/issue-queue/${issueId}/finding`, {
      ...finding,
      targetDate: "2026-02-28",
    });
    expect(ok.statusCode).toBe(200);

    // The date is held afterwards too: it can be moved earlier, not past the
    // month, and not taken off.
    const moved = await call(
      board,
      "POST",
      `/api/issue-queue/${issueId}/target-date`,
      { targetDate: "2026-02-10" },
    );
    expect(moved.statusCode).toBe(201);
    const pushed = await call(
      board,
      "POST",
      `/api/issue-queue/${issueId}/target-date`,
      { targetDate: "2026-03-05" },
    );
    expect(pushed.statusCode).toBe(422);
    expect(pushed.json()).toMatchObject({
      reason: "finding-target-date-too-late",
    });
    const cleared = await call(
      board,
      "POST",
      `/api/issue-queue/${issueId}/target-date`,
      { targetDate: null },
    );
    expect(cleared.statusCode).toBe(422);
    expect(cleared.json()).toMatchObject({
      reason: "finding-needs-target-date",
    });
  });

  it("takes only one of the issue's own files as its protocol", async () => {
    const issueId = await filed(plain, { withApartment: false });
    const other = await filed(plain, { withApartment: false });
    const foreign = await attachProtocol(board, other);

    const refused = await call(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/finding`,
      {
        kind: "OVK",
        inspectedOn: "2026-03-10",
        protocolAttachmentId: foreign,
        targetDate: "2026-09-30",
      },
    );
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({
      reason: "finding-protocol-not-found",
    });
    expect(await prisma.issueFinding.count({ where: { issueId } })).toBe(0);
  });

  it("is not marked on a closed issue, and is taken off when asked", async () => {
    const closed = await filed(plain, {
      meaning: "DONE",
      withApartment: false,
    });
    const open = await filed(plain, { withApartment: false });
    const protocolOpen = await attachProtocol(board, open);
    const protocolClosed = await attachProtocol(board, closed);

    const refused = await call(
      board,
      "PUT",
      `/api/issue-queue/${closed}/finding`,
      {
        kind: "OVK",
        inspectedOn: "2026-03-10",
        protocolAttachmentId: protocolClosed,
        targetDate: "2026-09-30",
      },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "issue-closed" });

    await call(board, "PUT", `/api/issue-queue/${open}/finding`, {
      kind: "OVK",
      inspectedOn: "2026-03-10",
      protocolAttachmentId: protocolOpen,
      targetDate: "2026-09-30",
    });
    const removed = await call(
      board,
      "DELETE",
      `/api/issue-queue/${open}/finding`,
    );
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ finding: null });
    // The target date stays; a handler may clear it.
    expect(removed.json()).toMatchObject({ targetDate: "2026-09-30" });
  });

  it("places a legal hold on its first mark, which taking the mark off leaves", async () => {
    const issueId = await filed(plain, { withApartment: false });
    const protocol = await attachProtocol(board, issueId);
    const finding = {
      kind: "LIFT",
      inspectedOn: "2026-03-10",
      protocolAttachmentId: protocol,
      targetDate: "2026-04-01",
    };
    const holdOf = async (id: string): Promise<Date | null> =>
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id },
          select: { legalHoldAt: true },
        })
      ).legalHoldAt;
    const placed = async (id: string): Promise<unknown[]> =>
      prisma.auditLogEntry.findMany({
        where: {
          targetKind: "issue",
          targetId: id,
          action: "ISSUE_LEGAL_HOLD_PLACED",
        },
        select: { actorPersonId: true, context: true },
      });

    const marked = await call(
      board,
      "PUT",
      `/api/issue-queue/${issueId}/finding`,
      finding,
    );
    expect(marked.statusCode).toBe(200);
    expect(marked.json<{ legalHoldAt: string | null }>().legalHoldAt).not.toBe(
      null,
    );
    const hold = await holdOf(issueId);
    expect(hold).not.toBeNull();
    expect(await placed(issueId)).toEqual([
      { actorPersonId: board.personId, context: { byFinding: true } },
    ]);

    // A change to the mark keeps the hold's date and places no second one.
    await call(board, "PUT", `/api/issue-queue/${issueId}/finding`, {
      ...finding,
      targetDate: "2026-03-31",
    });
    expect(await holdOf(issueId)).toEqual(hold);
    expect(await placed(issueId)).toHaveLength(1);

    // Taking the mark off leaves it: it may be a hold for another reason.
    const removed = await call(
      board,
      "DELETE",
      `/api/issue-queue/${issueId}/finding`,
    );
    expect(removed.statusCode).toBe(200);
    expect(await holdOf(issueId)).toEqual(hold);

    // A hold that already stood keeps its date.
    const held = await filed(plain, { withApartment: false });
    const since = new Date("2026-01-15T10:00:00.000Z");
    await prisma.issue.update({
      where: { id: held },
      data: { legalHoldAt: since },
    });
    await call(board, "PUT", `/api/issue-queue/${held}/finding`, {
      ...finding,
      protocolAttachmentId: await attachProtocol(board, held),
    });
    expect(await holdOf(held)).toEqual(since);
    expect(await placed(held)).toEqual([]);
  });

  it("leaves a released hold released when the mark changes, and places it again on a new mark", async () => {
    const issueId = await filed(plain, { withApartment: false });
    const protocol = await attachProtocol(board, issueId);
    const finding = {
      kind: "LIFT",
      inspectedOn: "2026-03-10",
      protocolAttachmentId: protocol,
      targetDate: "2026-04-01",
    };
    const holdOf = async (): Promise<Date | null> =>
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: issueId },
          select: { legalHoldAt: true },
        })
      ).legalHoldAt;
    const url = `/api/issue-queue/${issueId}/finding`;

    await call(board, "PUT", url, finding);
    expect(await holdOf()).not.toBeNull();

    // A handler released the hold on purpose. Changing the finding is not
    // marking it, so the release stands.
    await prisma.issue.update({
      where: { id: issueId },
      data: { legalHoldAt: null },
    });
    const edited = await call(board, "PUT", url, {
      ...finding,
      targetDate: "2026-03-31",
    });
    expect(edited.statusCode).toBeLessThan(300);
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: issueId },
          select: { targetDate: true },
        })
      ).targetDate?.toISOString(),
    ).toContain("2026-03-31");
    expect(await holdOf()).toBeNull();

    // A mark put on after the mark was taken off is a new finding, which the
    // association may have to show as the first was: the hold is placed again.
    await call(board, "DELETE", url);
    expect(await holdOf()).toBeNull();
    await call(board, "PUT", url, finding);
    expect(await holdOf()).not.toBeNull();
    expect(
      await prisma.auditLogEntry.count({
        where: {
          targetKind: "issue",
          targetId: issueId,
          action: "ISSUE_LEGAL_HOLD_PLACED",
        },
      }),
    ).toBe(2);
  });

  it("is kept from the reporter, and from a handler the issue shuts out", async () => {
    const issueId = await filed(boardOnly, { withApartment: false });
    const protocol = await attachProtocol(board, issueId);
    await call(board, "PUT", `/api/issue-queue/${issueId}/finding`, {
      kind: "OVK",
      inspectedOn: "2026-03-10",
      protocolAttachmentId: protocol,
      targetDate: "2026-09-30",
    });

    const mine = await call(resident, "GET", "/api/issues/mine");
    const own = mine
      .json<Record<string, unknown>[]>()
      .find((issue) => issue.id === issueId);
    expect(own).toBeDefined();
    expect(own).not.toHaveProperty("finding");
    expect(mine.body).not.toContain("protokoll");

    const byManager = await call(
      manager,
      "PUT",
      `/api/issue-queue/${issueId}/finding`,
      {
        kind: "FIRE",
        inspectedOn: "2026-03-10",
        protocolAttachmentId: protocol,
        targetDate: "2026-09-30",
      },
    );
    expect(byManager.statusCode).toBe(404);
  });

  it("keeps its mark when the protocol is removed from the issue", async () => {
    const issueId = await filed(plain, { withApartment: false });
    const protocol = await attachProtocol(board, issueId);
    await call(board, "PUT", `/api/issue-queue/${issueId}/finding`, {
      kind: "OVK",
      inspectedOn: "2026-03-10",
      protocolAttachmentId: protocol,
      targetDate: "2026-09-30",
    });

    await prisma.issueAttachment.delete({ where: { id: protocol } });

    const finding = await prisma.issueFinding.findUniqueOrThrow({
      where: { issueId },
      select: { kind: true, protocolAttachmentId: true },
    });
    expect(finding).toEqual({ kind: "OVK", protocolAttachmentId: null });
  });
});

describe("mcp and ai", () => {
  it("leave the entry permission, the place and the finding out of the issue actions", async () => {
    // An issue about an apartment carries the entry permission and the
    // finding; one about the lift, beside it, its place. Never both on one.
    const lift = await place("Hiss mcp");
    const issueId = await filed(plain);
    const placedId = await filed(plain, {
      placeId: lift,
      withApartment: false,
    });
    const note = `Anteckning som stannar ${suffix}`;
    await call(resident, "PUT", `/api/issues/${issueId}/entry-permission`, {
      answer: "YES",
      note,
    });
    const protocol = await attachProtocol(board, issueId);
    await call(board, "PUT", `/api/issue-queue/${issueId}/finding`, {
      kind: "OVK",
      inspectedOn: "2026-03-10",
      protocolAttachmentId: protocol,
      targetDate: "2026-09-30",
    });

    const names = registry.all().map((held) => held.definition.name);
    expect(names).toContain("issue_get");
    expect(
      names.filter((name) => /entry|place|finding|protocol/i.test(name)),
    ).toEqual([]);

    for (const channel of ["mcp", "ai"] as const) {
      const context: ActionContext = {
        principal: {
          personId: board.personId,
          capabilities: ["issues:handle"],
        },
        channel,
        requestId: `request-${channel}-${suffix}`,
        now: new Date(),
      };
      const one = await registry
        .get("issue_get")
        ?.definition.handler({ id: issueId }, context);
      const page = await registry
        .get("issue_list")
        ?.definition.handler({ typeId: plain.id, limit: 50 }, context);
      const placed = await registry
        .get("issue_get")
        ?.definition.handler({ id: placedId }, context);
      const answered = JSON.stringify([one, placed, page]);
      expect(answered).toContain(issueId);
      expect(answered).toContain(placedId);
      expect(answered).not.toContain(note);
      expect(answered).not.toContain("entry");
      expect(answered).not.toContain("finding");
      expect(answered).not.toContain("protokoll");
      expect(answered).not.toContain(`Hiss mcp ${suffix}`);
    }
  });
});
