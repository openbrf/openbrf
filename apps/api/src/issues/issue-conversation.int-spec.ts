import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { ActionContext } from "@openbrf/plugin-sdk";
import { formatDayOfInstant } from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { ActionRegistryService } from "../actions/action-registry.service";
import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { registerMultipart } from "../http/multipart";
import { pngBytes } from "../media/testing/image-fixtures";
import { StorageService } from "../storage/storage.service";
import { waitFor } from "../testing/advisory-locks";
import type { Prisma } from "../generated/prisma/client";
import { lockResidencyTransitions } from "../registers/residency-lock";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import { lockErasureEligibility } from "../retention/erasure-lock";
import { lockBoardPositions, lockSystemRole } from "../roles/role-lock";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { backendPid, waitersBehind } from "../testing/lock-waiters";
import { issueTextClocks } from "./issue-free-text";
import { lockIssueType } from "./issue-lock";

/**
 * The conversation on an issue over HTTP, against a real database (decisions
 * 17 to 19): issue messages between a resident and the handlers, internal
 * notes, the handlers' own files and the saved replies.
 *
 * What is under test is who reads what. The reporter reads the messages and
 * never a note, a handler's file or a handler's name; a handler's message
 * reaches them signed with a role. The handlers read names, a protected one
 * withheld. An issue the board keeps to itself keeps its conversation with it.
 * And nothing of it is offered on `mcp` or `ai`. A handler's write is also
 * ordered against an erasure and the writers of the ties that refuse one.
 */

const env = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let registry: ActionRegistryService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

function person(key: string, firstName: string, lastName: string) {
  return {
    personId: `ic-${key}-${suffix}`,
    email: `ic-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `${lastName}${suffix}`,
  };
}

const board = person("board", "Bea", "Styrelse");
const admin = person("admin", "Ada", "Administrator");
const manager = person("manager", "Frida", "Forvaltare");
const resident = person("resident", "Rune", "Boende");
const neighbour = person("neighbour", "Nils", "Granne");
/** A resident with protected personal data, as a reporter. */
const shielded = person("shielded", "Sara", "Skyddad");
/** A board member with protected personal data, as a handler. */
const shieldedBoard = person("shielded-board", "Sven", "Skyddad");
const people = [
  board,
  admin,
  manager,
  resident,
  neighbour,
  shielded,
  shieldedBoard,
];
const personIds = people.map((entry) => entry.personId);
const names = people.map((entry) => `${entry.firstName} ${entry.lastName}`);

const typeIds = {
  plain: `ic-type-plain-${suffix}`,
  boardOnly: `ic-type-board-${suffix}`,
  turning: `ic-type-turning-${suffix}`,
  turningFile: `ic-type-turning-file-${suffix}`,
  erasure: `ic-type-erasure-${suffix}`,
};
let plain: IssueTypeFixture;
let boardOnly: IssueTypeFixture;
let turning: IssueTypeFixture;
let turningFile: IssueTypeFixture;
let erasure: IssueTypeFixture;

/** A personal identity number with a valid check digit, as one is pasted. */
const WITH_A_NUMBER = "Ring Erik, 19811218-9876, om nyckeln.";

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
        // 10.183.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.183.${String(subnet)}.${String(host + 1)}`,
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

/** A multipart body carrying one file, built by hand so no client is assumed. */
function multipart(bytes: Buffer, fileName: string, contentType: string) {
  const boundary = "----openbrfConversationBoundary";
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
async function externalReporter(email: string) {
  const sealed = await encryption.encrypt("issue.reporterEmail", email);
  return {
    reporterEmailCipher: sealed.cipher,
    reporterEmailIndex: sealed.index,
  };
}

async function filed(
  type: IssueTypeFixture,
  extra: {
    reporterPersonId?: string | null;
    meaning?: "NEW" | "DONE";
    boardOnly?: boolean;
    /** An address and no account, as a report from the website's form leaves. */
    externalEmail?: string;
  } = {},
): Promise<string> {
  issueCounter += 1;
  const id = `ic-issue-${String(issueCounter)}-${suffix}`;
  const meaning = extra.meaning ?? "NEW";
  await prisma.issue.create({
    data: {
      id,
      typeId: type.id,
      statusId: type.statusIds[meaning],
      reporterPersonId:
        extra.reporterPersonId === undefined
          ? resident.personId
          : extra.reporterPersonId,
      ...(extra.externalEmail === undefined
        ? {}
        : await externalReporter(extra.externalEmail)),
      description: `Beskrivning ${String(issueCounter)}`,
      boardOnly: extra.boardOnly ?? false,
      ...(meaning === "DONE"
        ? { closedAt: new Date(), outcome: "FIXED" as const }
        : {}),
    },
  });
  return id;
}

function write(
  who: { personId: string },
  path: string,
  body: string,
): ReturnType<typeof inject> {
  return inject({
    method: "POST",
    url: path,
    payload: { body },
    cookie: cookieOf(who),
  });
}

function read(who: { personId: string }, path: string) {
  return inject({ method: "GET", url: path, cookie: cookieOf(who) });
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
        protectedPersonalData: entry === shielded || entry === shieldedBoard,
      },
    });
    await app.get(AuthService).createAccountForPerson({
      personId: entry.personId,
      email: entry.email,
      name: `${entry.firstName} ${entry.lastName}`,
      password: PASSWORD,
    });
  }
  await prisma.boardPosition.createMany({
    data: [board, shieldedBoard].map((entry) => ({
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
  // The reporters live here, which is what gives them issues:report.
  const addressId = `ic-address-${suffix}`;
  await prisma.address.create({
    data: {
      id: addressId,
      street: "Samtalsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: `ic-apartment-${suffix}`, addressId, number: "1601", floor: 6 },
  });
  await prisma.residency.createMany({
    data: [resident, neighbour, shielded].map((entry) => ({
      personId: entry.personId,
      apartmentId: `ic-apartment-${suffix}`,
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
  turning = await createIssueTypeFixture(prisma, {
    id: typeIds.turning,
    name: `Vänder ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  turningFile = await createIssueTypeFixture(prisma, {
    id: typeIds.turningFile,
    name: `Vänder fil ${suffix}`,
    reporters: ["RESIDENTS"],
  });

  erasure = await createIssueTypeFixture(prisma, {
    id: typeIds.erasure,
    name: `Raderas ${suffix}`,
    reporters: ["RESIDENTS"],
  });

  for (const entry of people) {
    cookies[entry.personId] = await signIn(entry.email);
  }
}, 180_000);

afterAll(async () => {
  await prisma.issueSavedReply.deleteMany({
    where: { title: { contains: suffix } },
  });
  await prisma.issue.deleteMany({
    where: { typeId: { in: Object.values(typeIds) } },
  });
  // The objects first: the local driver writes them under the data directory,
  // and a row deleted before its keys are read leaves them there for good.
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
    where: { id: `ic-apartment-${suffix}` },
  });
  await prisma.address.deleteMany({ where: { id: `ic-address-${suffix}` } });
  await app.close();
});

describe("a resident and the handlers converse", () => {
  it("carries messages both ways, signed to the reporter with a role and never a name", async () => {
    const issueId = await filed(plain);

    const asked = await write(
      resident,
      `/api/issues/${issueId}/messages`,
      "Kommer någon i dag?",
    );
    expect(asked.statusCode).toBe(201);
    expect(asked.json()).toMatchObject({ side: "REPORTER" });

    const byBoard = await write(
      board,
      `/api/issue-queue/${issueId}/messages`,
      "Vi kommer i eftermiddag.",
    );
    expect(byBoard.statusCode).toBe(201);
    expect(byBoard.json()).toMatchObject({
      side: "HANDLER",
      signature: "BOARD",
      author: {
        kind: "person",
        personId: board.personId,
        name: `${board.firstName} ${board.lastName}`,
      },
    });
    const byManager = await write(
      manager,
      `/api/issue-queue/${issueId}/messages`,
      "Fastighetsskötaren är på väg.",
    );
    expect(byManager.json()).toMatchObject({ signature: "PROPERTY_MANAGER" });
    // An administrator without a seat writes for the association.
    const byAdmin = await write(
      admin,
      `/api/issue-queue/${issueId}/messages`,
      "Vi har bokat en tid.",
    );
    expect(byAdmin.json()).toMatchObject({ signature: "BOARD" });

    const own = await read(resident, `/api/issues/${issueId}/messages`);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual([
      expect.objectContaining({
        side: "REPORTER",
        body: "Kommer någon i dag?",
      }),
      expect.objectContaining({ side: "HANDLER", signature: "BOARD" }),
      expect.objectContaining({
        side: "HANDLER",
        signature: "PROPERTY_MANAGER",
      }),
      expect.objectContaining({ side: "HANDLER", signature: "BOARD" }),
    ]);
    // Nobody's name or identifier, in any field: the whole body.
    for (const id of personIds) {
      expect(own.body).not.toContain(id);
    }
    for (const name of names) {
      expect(own.body).not.toContain(name);
    }
    expect(own.body).not.toContain("author");

    // The handlers read the same conversation with the writers named, and the
    // reporter's messages with no author: the queue row names the reporter.
    const handled = await read(manager, `/api/issue-queue/${issueId}/messages`);
    expect(handled.statusCode).toBe(200);
    const thread = handled.json<{ side: string; author?: unknown }[]>();
    expect(thread.map((message) => message.side)).toEqual([
      "REPORTER",
      "HANDLER",
      "HANDLER",
      "HANDLER",
    ]);
    expect(thread[0]).not.toHaveProperty("author");
    expect(handled.body).not.toContain(resident.personId);

    // Each message is on its writer's own record, as an act and never as text.
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        targetKind: "issue",
        targetId: issueId,
        action: "ISSUE_MESSAGE_SENT",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { actorPersonId: true, targetPersonId: true, context: true },
    });
    expect(entries.map((entry) => entry.actorPersonId)).toEqual([
      resident.personId,
      board.personId,
      manager.personId,
      admin.personId,
    ]);
    for (const entry of entries) {
      expect(entry.targetPersonId).toBeNull();
      expect(Object.keys(entry.context as object)).toEqual(["messageId"]);
    }
  });

  it("answers somebody else's issue to a resident as one that does not exist", async () => {
    const issueId = await filed(plain);

    const readByNeighbour = await read(
      neighbour,
      `/api/issues/${issueId}/messages`,
    );
    const writtenByNeighbour = await write(
      neighbour,
      `/api/issues/${issueId}/messages`,
      "Jag också",
    );
    const absent = await read(neighbour, `/api/issues/ic-nothing/messages`);

    expect(readByNeighbour.statusCode).toBe(404);
    expect(writtenByNeighbour.statusCode).toBe(404);
    expect(readByNeighbour.json()).toEqual(absent.json());
    // And a resident reaches none of the handlers' routes.
    expect(
      (await read(resident, `/api/issue-queue/${issueId}/messages`)).statusCode,
    ).toBe(403);
    expect(
      (await read(resident, `/api/issue-queue/${issueId}/notes`)).statusCode,
    ).toBe(403);
  });

  it("takes no message from the reporter on an issue closed past the reopening window, and still takes the handlers'", async () => {
    const issueId = await filed(plain, { meaning: "DONE" });
    // Closed 31 days ago: a reply no longer reopens it (ADR 0054), which
    // `issue-lifecycle.int-spec.ts` tests at its edge.
    await prisma.issue.update({
      where: { id: issueId },
      data: { closedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });

    const refused = await write(
      resident,
      `/api/issues/${issueId}/messages`,
      "Det läcker igen",
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "issue-closed" });

    const answered = await write(
      board,
      `/api/issue-queue/${issueId}/messages`,
      "Vi stängde det efter besiktningen.",
    );
    expect(answered.statusCode).toBe(201);
  });

  it("refuses a message to nobody, and takes a note on the same issue", async () => {
    // An internal issue: no reporter to read an answer.
    const issueId = await filed(plain, { reporterPersonId: null });

    const refused = await write(
      board,
      `/api/issue-queue/${issueId}/messages`,
      "Hej",
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "no-reporter" });
    expect(await prisma.issueMessage.count({ where: { issueId } })).toBe(0);

    const noted = await write(
      board,
      `/api/issue-queue/${issueId}/notes`,
      "Försäkringsbolaget ringer tillbaka.",
    );
    expect(noted.statusCode).toBe(201);
  });

  it("refuses a message to a reporter who left an address and has no account", async () => {
    const issueId = await filed(plain, {
      reporterPersonId: null,
      externalEmail: `ic-extern-${suffix}@exempel.se`,
    });

    const refused = await write(
      board,
      `/api/issue-queue/${issueId}/messages`,
      "Hej",
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "no-reporter" });
    expect(await prisma.issueMessage.count({ where: { issueId } })).toBe(0);
  });

  it("refuses a message to a reporter whose person has no sign-in account", async () => {
    const accountless = `ic-accountless-${suffix}`;
    await prisma.person.create({
      data: {
        id: accountless,
        firstName: "Kim",
        lastName: `Utankonto${suffix}`,
      },
    });
    try {
      const issueId = await filed(plain, { reporterPersonId: accountless });

      const refused = await write(
        board,
        `/api/issue-queue/${issueId}/messages`,
        "Hej",
      );
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ reason: "no-reporter" });
      expect(await prisma.issueMessage.count({ where: { issueId } })).toBe(0);
    } finally {
      await prisma.person.delete({ where: { id: accountless } });
    }
  });

  it("refuses a personal identity number in what the board writes back, and stores the reporter's words as written", async () => {
    const issueId = await filed(plain);

    for (const path of ["messages", "notes"]) {
      const refused = await write(
        board,
        `/api/issue-queue/${issueId}/${path}`,
        WITH_A_NUMBER,
      );
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({
        reason: "personal-identity-number",
        locations: [{ part: "body", offset: WITH_A_NUMBER.indexOf("1981") }],
      });
      // A position is safe to publish; the value never is.
      expect(refused.body).not.toContain("19811218");
    }
    // The reporter's own text is not scanned, as the description is not.
    const own = await write(
      resident,
      `/api/issues/${issueId}/messages`,
      WITH_A_NUMBER,
    );
    expect(own.statusCode).toBe(201);
  });

  it("refuses a message of nothing but whitespace", async () => {
    const issueId = await filed(plain);
    const blank = await write(
      resident,
      `/api/issues/${issueId}/messages`,
      "   \n ",
    );
    expect(blank.statusCode).toBe(400);
  });
});

describe("a message is mailed as a notice", () => {
  it("queues a notice about the message and never its words, and mails nothing for a note", async () => {
    const issueId = await filed(plain);
    const queued = async (): Promise<string[]> =>
      (
        await prisma.$queryRawUnsafe<{ data: unknown }[]>(
          "SELECT data FROM pgboss.job WHERE name = 'issue-notice' AND data->>'issueId' = $1 ORDER BY created_on, id",
          issueId,
        )
      ).map((row) => JSON.stringify(row.data));
    try {
      const before = (await queued()).length;
      const asked = await write(
        resident,
        `/api/issues/${issueId}/messages`,
        "Hemligt ord från boende.",
      );
      expect(asked.statusCode).toBe(201);
      const answered = await write(
        manager,
        `/api/issue-queue/${issueId}/messages`,
        "Hemligt ord från förvaltaren.",
      );
      expect(answered.statusCode).toBe(201);
      const afterMessages = (await queued()).slice(before);
      expect(afterMessages.some((job) => job.includes('"message"'))).toBe(true);
      expect(
        afterMessages.some(
          (job) =>
            job.includes('"reporterMessage"') &&
            job.includes(resident.personId),
        ),
      ).toBe(true);
      for (const job of afterMessages) {
        expect(job).not.toContain("Hemligt");
      }

      const afterNote = await write(
        manager,
        `/api/issue-queue/${issueId}/notes`,
        "Hemlig anteckning.",
      );
      expect(afterNote.statusCode).toBe(201);
      expect((await queued()).length).toBe(before + afterMessages.length);
    } finally {
      await prisma.$executeRawUnsafe(
        "DELETE FROM pgboss.job WHERE name = 'issue-notice' AND data->>'issueId' = $1",
        issueId,
      );
    }
  });
});

describe("internal notes and the handlers' files", () => {
  it("keeps notes and files from the reporter, and gives them to every handler the issue lets in", async () => {
    const issueId = await filed(plain);
    const secret = `Grannen klagar igen ${suffix}`;

    const noted = await write(
      board,
      `/api/issue-queue/${issueId}/notes`,
      secret,
    );
    expect(noted.statusCode).toBe(201);
    expect(noted.json()).toMatchObject({
      author: { kind: "person", personId: board.personId },
      body: secret,
    });
    // Every handler of the issue reads it, the property manager included.
    const managerNotes = await read(
      manager,
      `/api/issue-queue/${issueId}/notes`,
    );
    expect(managerNotes.json()).toEqual([
      expect.objectContaining({ body: secret }),
    ]);

    const upload = multipart(pngBytes(24, 24), "offert.png", "image/png");
    const attached = await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/attachments`,
      payload: upload.payload,
      headers: { ...upload.headers, cookie: cookieOf(board) },
    });
    expect(attached.statusCode).toBe(201);
    const { url } = attached.json<{ url: string }>();

    // The reporter's whole view of their issue says nothing of either.
    const own = await read(resident, `/api/issues/${issueId}/messages`);
    const mine = await read(resident, "/api/issues/mine");
    for (const body of [own.body, mine.body]) {
      expect(body).not.toContain(secret);
      expect(body).not.toContain("offert.png");
      expect(body).not.toContain(url);
    }
    // And the file's address is refused to them, as to a stranger.
    expect((await read(resident, url)).statusCode).toBe(404);
    expect((await read(board, url)).statusCode).toBe(200);
    expect((await read(manager, url)).statusCode).toBe(200);

    expect(
      (await read(manager, `/api/issue-queue/${issueId}/attachments`)).json(),
    ).toEqual([expect.objectContaining({ fileName: "offert.png", url })]);
  });

  it("keeps a board-only issue's conversation, notes and files from the property manager", async () => {
    const issueId = await filed(boardOnly);
    await write(board, `/api/issue-queue/${issueId}/notes`, "Bara styrelsen");
    const upload = multipart(pngBytes(24, 24), "skada.png", "image/png");
    const attached = await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/attachments`,
      payload: upload.payload,
      headers: { ...upload.headers, cookie: cookieOf(board) },
    });
    const { url } = attached.json<{ url: string }>();

    for (const path of ["messages", "notes", "attachments"]) {
      expect(
        (await read(manager, `/api/issue-queue/${issueId}/${path}`)).statusCode,
      ).toBe(404);
    }
    for (const path of ["messages", "notes"]) {
      expect(
        (await write(manager, `/api/issue-queue/${issueId}/${path}`, "Hej"))
          .statusCode,
      ).toBe(404);
    }
    expect((await read(manager, url)).statusCode).toBe(404);
    // The administrator, seat or not, is let in (ADR 0054, question 4).
    expect(
      (await read(admin, `/api/issue-queue/${issueId}/notes`)).statusCode,
    ).toBe(200);
  });

  it("keeps a file on an issue the board marked board-only from the property manager, on a type that lets every handler in", async () => {
    // The type admits the property manager; only the issue's own flag keeps
    // them out, so removing that check from the file rule fails this.
    const issueId = await filed(plain, { boardOnly: true });
    const upload = multipart(pngBytes(24, 24), "forsakring.png", "image/png");
    const attached = await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/attachments`,
      payload: upload.payload,
      headers: { ...upload.headers, cookie: cookieOf(board) },
    });
    expect(attached.statusCode).toBe(201);
    const { url } = attached.json<{ url: string }>();

    expect((await read(manager, url)).statusCode).toBe(404);
    expect(
      (await read(manager, `/api/issue-queue/${issueId}/attachments`))
        .statusCode,
    ).toBe(404);
    expect((await read(board, url)).statusCode).toBe(200);
    expect((await read(admin, url)).statusCode).toBe(200);
  });

  it("keeps the name of a handler's file out of the audit log, as stored and as removed", async () => {
    const revealing = `Rune Boende medical assessment ${suffix}.pdf`;
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
    );

    // Kept: the upload's entry says what was accepted, and not what it was
    // called. The name is still stored and served to the handlers.
    const issueId = await filed(plain);
    const kept = multipart(pdf, revealing, "application/pdf");
    const attached = await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/attachments`,
      payload: kept.payload,
      headers: { ...kept.headers, cookie: cookieOf(board) },
    });
    expect(attached.statusCode).toBe(201);
    const stored = await prisma.issueAttachment.findMany({
      where: { issueId },
      select: { fileId: true, file: { select: { fileName: true } } },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.file.fileName).toContain("medical assessment");
    const keptEntries = await prisma.auditLogEntry.findMany({
      where: {
        action: "MEDIA_UPLOADED",
        targetKind: "media",
        targetId: stored[0]?.fileId ?? "",
      },
      select: { context: true },
    });
    expect(keptEntries).toHaveLength(1);
    expect(JSON.stringify(keptEntries)).not.toContain("medical assessment");
    expect(keptEntries[0]?.context).not.toHaveProperty("fileName");

    // Refused after the upload: the file is taken away again, and the removal
    // is in the log without the name too. The type is handed to the board
    // while the upload waits, which is what refuses the attachment.
    const refusedIssueId = await filed(turningFile);
    const refusedUpload = multipart(pdf, revealing, "application/pdf");
    const refused = await behindHandingToBoard(turningFile.id, () =>
      inject({
        method: "POST",
        url: `/api/issue-queue/${refusedIssueId}/attachments`,
        payload: refusedUpload.payload,
        headers: { ...refusedUpload.headers, cookie: cookieOf(manager) },
      }),
    );
    expect(refused.statusCode).toBe(404);
    expect(
      await prisma.issueAttachment.count({
        where: { issueId: refusedIssueId },
      }),
    ).toBe(0);
    const refusedEntries = await prisma.auditLogEntry.findMany({
      where: {
        actorPersonId: manager.personId,
        action: { in: ["MEDIA_UPLOADED", "MEDIA_DELETED"] },
      },
      select: { action: true, context: true },
    });
    // Both the upload and its removal happened, and neither names the file.
    expect(refusedEntries.map((entry) => entry.action).sort()).toEqual([
      "MEDIA_DELETED",
      "MEDIA_UPLOADED",
    ]);
    expect(JSON.stringify(refusedEntries)).not.toContain("medical assessment");
    for (const entry of refusedEntries) {
      expect(entry.context).not.toHaveProperty("fileName");
    }
  });

  it("decides a message after the board hands the type to itself, not before", async () => {
    const issueId = await filed(turning);

    const answer = await behindHandingToBoard(turning.id, () =>
      write(manager, `/api/issue-queue/${issueId}/messages`, "Jag tar det"),
    );

    expect(answer.statusCode).toBe(404);
    expect(await prisma.issueMessage.count({ where: { issueId } })).toBe(0);
  });
});

describe("protected personal data", () => {
  it("keeps a protected reporter masked, and names a protected handler to nobody", async () => {
    const issueId = await filed(plain, { reporterPersonId: shielded.personId });

    await write(
      shielded,
      `/api/issues/${issueId}/messages`,
      "Fönstret är trasigt",
    );
    const answered = await write(
      shieldedBoard,
      `/api/issue-queue/${issueId}/messages`,
      "Vi byter glaset.",
    );
    expect(answered.json()).toMatchObject({
      signature: "BOARD",
      author: { kind: "protected", personId: shieldedBoard.personId },
    });
    await write(
      shieldedBoard,
      `/api/issue-queue/${issueId}/notes`,
      "Glasmästaren",
    );

    for (const handler of [board, manager]) {
      const thread = await read(
        handler,
        `/api/issue-queue/${issueId}/messages`,
      );
      const notes = await read(handler, `/api/issue-queue/${issueId}/notes`);
      for (const body of [thread.body, notes.body]) {
        // Neither the reporter nor the handler is named, and the reporter
        // carries no identifier either.
        expect(body).not.toContain(shielded.lastName);
        expect(body).not.toContain(shielded.personId);
        expect(body).not.toContain(shieldedBoard.lastName);
      }
      expect(thread.json()).toEqual([
        expect.objectContaining({ side: "REPORTER" }),
        expect.objectContaining({
          side: "HANDLER",
          author: { kind: "protected", personId: shieldedBoard.personId },
        }),
      ]);
    }

    // The reporter reads the board's answer signed by the board.
    const own = await read(shielded, `/api/issues/${issueId}/messages`);
    expect(own.json()).toEqual([
      expect.objectContaining({ side: "REPORTER" }),
      expect.objectContaining({ side: "HANDLER", signature: "BOARD" }),
    ]);
    expect(own.body).not.toContain(shieldedBoard.personId);
  });
});

describe("mcp and ai", () => {
  it("offers no action that reads or writes the conversation", () => {
    const issueActions = registry
      .all()
      .map((held) => held.definition.name)
      .filter((name) => name.startsWith("issue"));
    // Without this, a renamed group would pass the assertion below by finding
    // nothing to check.
    expect(issueActions).toContain("issue_get");
    expect(
      issueActions.filter((name) =>
        /message|note|attachment|saved_?repl|conversation/i.test(name),
      ),
    ).toEqual([]);
  });

  it("leaves the conversation out of what the issue actions answer", async () => {
    const issueId = await filed(plain);
    const message = `Svar som stannar ${suffix}`;
    const note = `Anteckning som stannar ${suffix}`;
    await write(resident, `/api/issues/${issueId}/messages`, message);
    await write(board, `/api/issue-queue/${issueId}/messages`, message);
    await write(board, `/api/issue-queue/${issueId}/notes`, note);

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
      const answered = JSON.stringify([one, page]);
      expect(answered).toContain(issueId);
      expect(answered).not.toContain(message);
      expect(answered).not.toContain(note);
    }
  });
});

describe("the data subject access report", () => {
  it("gives a reporter their issues and conversations, and no internal note's words before the board weighs it", async () => {
    const own = await filed(plain);
    const neighbours = await filed(plain, {
      reporterPersonId: neighbour.personId,
    });
    const tag = `report-${suffix}`;

    for (const [who, path, body] of [
      [resident, `/api/issues/${own}/messages`, `Fråga ${tag}`],
      [board, `/api/issue-queue/${own}/messages`, `Svar ${tag}`],
      // About the reporter, on their own issue and on somebody else's.
      [board, `/api/issue-queue/${own}/notes`, `Anteckning om Rune ${tag}`],
      [manager, `/api/issue-queue/${neighbours}/notes`, `Rune igen ${tag}`],
      // The neighbour's own conversation, which the resident never reads.
      [neighbour, `/api/issues/${neighbours}/messages`, `Grannens ${tag}`],
    ] as const) {
      expect((await write(who, path, body)).statusCode).toBe(201);
    }
    // The handler the board assigned answers for it through its own section.
    await prisma.issue.update({
      where: { id: neighbours },
      data: { assigneePersonId: board.personId },
    });

    const report = await app
      .get(DataSubjectReportService)
      .portable(resident.personId);
    const issue = report.issues.find((entry) => entry.issueId === own);
    expect(issue?.messages).toEqual([
      expect.objectContaining({ side: "REPORTER", body: `Fråga ${tag}` }),
      expect.objectContaining({
        side: "HANDLER",
        signature: "BOARD",
        body: `Svar ${tag}`,
      }),
    ]);
    expect(issue?.number).toEqual(expect.any(Number));
    // Open, so no clock runs yet.
    expect(issue?.freeTextErasableFrom).toBeNull();
    expect(report.issues.map((entry) => entry.issueId)).not.toContain(
      neighbours,
    );
    // The note on their own issue is listed, and none of its words are given
    // until the board weighs it (ADR 0057); the one on the neighbour's issue
    // is not theirs at all.
    expect(issue?.notes).toEqual([
      expect.objectContaining({ content: { state: "unweighed" } }),
    ]);
    const text = JSON.stringify(report);
    expect(text).not.toContain(`Anteckning om Rune ${tag}`);
    expect(text).not.toContain(`Rune igen ${tag}`);
    expect(text).not.toContain(`Grannens ${tag}`);
    // No handler named in the conversation: a role, as on the screen.
    expect(JSON.stringify(issue?.messages)).not.toContain(board.personId);
    expect(JSON.stringify(issue?.messages)).not.toContain(board.firstName);

    // The assignee's report lists the issue by its number and type, and none
    // of what anybody wrote on it.
    const assigned = await app
      .get(DataSubjectReportService)
      .portable(board.personId);
    expect(assigned.issueAssignments).toContainEqual(
      expect.objectContaining({ kind: "issue", issueId: neighbours }),
    );
    expect(assigned.issues.map((entry) => entry.issueId)).not.toContain(
      neighbours,
    );
    expect(JSON.stringify(assigned.issueAssignments)).not.toContain(tag);
  });

  it("dates the removal of a closed issue's text on its type's clock, and not under a hold on the issue", async () => {
    const closed = await filed(plain, { meaning: "DONE" });
    const closedAt = new Date("2026-03-10T10:00:00.000Z");
    await prisma.issue.update({ where: { id: closed }, data: { closedAt } });
    const held = await filed(plain, { meaning: "DONE" });
    await prisma.issue.update({
      where: { id: held },
      data: { closedAt, legalHoldAt: new Date() },
    });
    // The board's setting is the association's singleton, which the retention
    // suite changes while it runs: read on either side of the report, so the
    // date the report states is the one for the setting it read.
    const before = (await issueTextClocks(prisma)).years;
    const report = await app
      .get(DataSubjectReportService)
      .portable(resident.personId);
    const after = (await issueTextClocks(prisma)).years;
    const on = (years: number) =>
      formatDayOfInstant(
        new Date(closedAt.getTime() + years * 365 * 24 * 60 * 60 * 1000),
      );

    const dated = report.issues.find((entry) => entry.issueId === closed);
    expect(dated).toMatchObject({
      closedAt: closedAt.toISOString(),
      onLegalHold: false,
    });
    expect([on(before), on(after)]).toContain(dated?.freeTextErasableFrom);
    expect(report.issues.find((entry) => entry.issueId === held)).toMatchObject(
      { onLegalHold: true, freeTextErasableFrom: null },
    );
  });
});

describe("saved replies", () => {
  it("are written by the board and read by every handler", async () => {
    const title = `Ditt ansvar ${suffix}`;
    const created = await inject({
      method: "POST",
      url: "/api/issue-saved-replies",
      payload: { title, body: "Enligt stadgarna är det ditt ansvar." },
      cookie: cookieOf(board),
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();

    // The property manager picks from them and does not write them.
    const offered = await read(manager, "/api/issue-queue/saved-replies");
    expect(offered.statusCode).toBe(200);
    expect(offered.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, title })]),
    );
    const byManager = await inject({
      method: "POST",
      url: "/api/issue-saved-replies",
      payload: { title: `Förvaltaren ${suffix}`, body: "Nej" },
      cookie: cookieOf(manager),
    });
    expect(byManager.statusCode).toBe(403);
    expect(
      (await read(resident, "/api/issue-queue/saved-replies")).statusCode,
    ).toBe(403);

    const changed = await inject({
      method: "PUT",
      url: `/api/issue-saved-replies/${id}`,
      payload: { title, body: "Enligt era stadgar är det ert ansvar." },
      cookie: cookieOf(admin),
    });
    expect(changed.json()).toMatchObject({
      body: "Enligt era stadgar är det ert ansvar.",
    });

    const removed = await inject({
      method: "DELETE",
      url: `/api/issue-saved-replies/${id}`,
      cookie: cookieOf(board),
    });
    expect(removed.statusCode).toBe(204);
    const again = await inject({
      method: "DELETE",
      url: `/api/issue-saved-replies/${id}`,
      cookie: cookieOf(board),
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ reason: "saved-reply-not-found" });
  });

  it("refuses a personal identity number in a saved reply", async () => {
    const refused = await inject({
      method: "POST",
      url: "/api/issue-saved-replies",
      payload: { title: `Med nummer ${suffix}`, body: WITH_A_NUMBER },
      cookie: cookieOf(board),
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      reason: "personal-identity-number",
      locations: [{ part: "body", offset: WITH_A_NUMBER.indexOf("1981") }],
    });
  });
});

describe("a handler's write against erasure and standing ties", () => {
  /**
   * `replyAsHandler` and `addNote` name the handler as the author of the row
   * they write. What makes a person's authored rows erasable is that nothing
   * ties them to the association any more - no residency, no board seat, no
   * system role - and the purge that erases them detaches the rows they wrote
   * (`lockErasureEligibility`). A write that is decided before that purge reads
   * and commits after it has detached would leave a row authored by somebody
   * the purge has judged free to erase. So a write takes the same three keys
   * the purge and the writers of those ties take, before it reads anything, and
   * holds them until it commits.
   *
   * A handler's file and the withdrawal of the reporter's link are not among
   * them: neither transaction writes a row the purge detaches (the attachment
   * and the link name nobody, and the file's uploader is written by the upload
   * before it), and the audit entry that names the writer is never detached.
   *
   * The write is held where it is in flight: it has taken its keys and waits on
   * the issue type's lock, which the test holds. A contender is then started
   * that takes one key, as the writer of that tie or the purge itself does. It
   * must queue behind the write and, once the write has committed, see its row.
   * A write that does not take the key lets the contender through while it is
   * still waiting, and the contender is answered first.
   */
  const writes = [
    {
      kind: "a message to the reporter",
      path: "messages",
      authored: (issueId: string, personId: string) =>
        prisma.issueMessage.count({
          where: { issueId, authorPersonId: personId },
        }),
    },
    {
      kind: "an internal note",
      path: "notes",
      authored: (issueId: string, personId: string) =>
        prisma.issueNote.count({
          where: { issueId, authorPersonId: personId },
        }),
    },
  ];

  /** A tie's writer, or the erasure, by the key it takes first. */
  const contenders: {
    who: string;
    handler: { personId: string };
    take: (tx: Prisma.TransactionClient, personId: string) => Promise<void>;
  }[] = [
    {
      who: "the writer's residency changing",
      handler: manager,
      take: lockResidencyTransitions,
    },
    {
      who: "the writer's board seat changing",
      handler: board,
      take: lockBoardPositions,
    },
    {
      who: "the writer's system role changing",
      handler: manager,
      take: (tx) => lockSystemRole(tx, "PROPERTY_MANAGER"),
    },
    {
      who: "the writer's erasure",
      handler: manager,
      take: lockErasureEligibility,
    },
  ];

  describe.each(writes)("$kind", ({ path, authored }) => {
    it.each(contenders)(
      "is decided before $who, and seen by it",
      async ({ handler, take }) => {
        const issueId = await filed(erasure);
        const seen = await queuedBehindWrite({
          typeId: erasure.id,
          send: () =>
            write(handler, `/api/issue-queue/${issueId}/${path}`, "Hej"),
          contend: async (tx) => {
            await take(tx, handler.personId);
            const messages = await tx.issueMessage.count({
              where: { issueId },
            });
            const notes = await tx.issueNote.count({ where: { issueId } });
            return messages + notes;
          },
        });

        expect(seen.answer.statusCode).toBe(201);
        // The contender took its key after the write committed, so it read
        // the row the write left.
        expect(seen.read).toBe(1);
        expect(await authored(issueId, handler.personId)).toBe(1);
      },
    );

    it("leaves no row authored by a person the purge has detached", async () => {
      const issueId = await filed(erasure);
      const seen = await queuedBehindWrite({
        typeId: erasure.id,
        send: () =>
          write(manager, `/api/issue-queue/${issueId}/${path}`, "Hej"),
        // What `PurgeService.purgePerson` does with the rows a person wrote:
        // takes the keys, then detaches what it finds.
        contend: async (tx) => {
          await lockErasureEligibility(tx, manager.personId);
          const messages = await tx.issueMessage.updateMany({
            where: { issueId, authorPersonId: manager.personId },
            data: { authorPersonId: null },
          });
          const notes = await tx.issueNote.updateMany({
            where: { issueId, authorPersonId: manager.personId },
            data: { authorPersonId: null },
          });
          return messages.count + notes.count;
        },
      });

      expect(seen.answer.statusCode).toBe(201);
      // The purge found the row the write committed, and detached it.
      expect(seen.read).toBe(1);
      expect(await authored(issueId, manager.personId)).toBe(0);
    });
  });
});

/**
 * What a test of the lock order may spend waiting on the database, in all its
 * polls together. It is shorter than the 30 s the held transactions and the
 * test itself are given, so a slow run fails on the condition it was waiting
 * for and not on a timeout that hides it.
 */
const QUEUE_WAIT_MS = 12_000;

/** Waits for the condition within what is left of one shared deadline. */
function waitWithin(
  deadline: number,
  condition: () => Promise<boolean>,
): Promise<void> {
  return waitFor(condition, Math.max(0, deadline - Date.now()));
}

/**
 * Plays a handler's write out against a contender that takes a key the write
 * holds.
 *
 * The test holds the issue type's lock, which the write takes after the keys of
 * the erasure, so the write is in flight with them taken. The contender is
 * started once the database says the write is queued, and released only when it
 * too is queued, behind the write. A write that holds no such key lets the
 * contender through at once: it answers before the type's lock is let go, and
 * the order has not been played out.
 */
async function queuedBehindWrite<T>(options: {
  typeId: string;
  send: () => ReturnType<typeof inject>;
  contend: (tx: Prisma.TransactionClient) => Promise<T>;
}): Promise<{ answer: Awaited<ReturnType<typeof inject>>; read: T }> {
  let reached: (pid: number) => void = () => undefined;
  const holding = new Promise<number>((resolve) => {
    reached = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holdingType = prisma.$transaction(
    async (tx) => {
      await lockIssueType(tx, options.typeId);
      reached(await backendPid(tx));
      await gate;
    },
    { timeout: 30_000 },
  );
  const holder = await holding;
  const deadline = Date.now() + QUEUE_WAIT_MS;

  let answered = false;
  let contended = false;
  const request = options.send().finally(() => {
    answered = true;
  });
  let contender: Promise<T> | undefined;
  let waited = false;
  try {
    // The write is queued behind the type's lock, holding its keys.
    await waitWithin(
      deadline,
      async () => answered || (await waitersBehind(prisma, holder)) > 0,
    );
    expect(answered, "the write waits for the type's lock").toBe(false);

    contender = prisma
      .$transaction((tx) => options.contend(tx), { timeout: 30_000 })
      .finally(() => {
        contended = true;
      });
    // Queued behind the write, which is itself queued behind the holder.
    await waitWithin(
      deadline,
      async () => contended || (await waitersBehind(prisma, holder)) > 1,
    );
    waited = !contended;
  } finally {
    release();
    await holdingType;
  }
  const answer = await request;
  const read = await (contender ?? Promise.reject(new Error("not started")));
  expect(waited, "the contender waits for the write's keys").toBe(true);
  return { answer, read };
}

/**
 * Plays a request out against the board handing a type to itself, in the order
 * the type's lock exists for: the change holds the lock, as
 * `IssueTypeService.update` does, the request is sent, and the change commits
 * only once the database says the request waits behind it. A write that does
 * not take the lock decides on the handlers the type had before, and answers
 * first.
 */
async function behindHandingToBoard(
  typeId: string,
  send: () => ReturnType<typeof inject>,
): ReturnType<typeof inject> {
  let reached: (pid: number) => void = () => undefined;
  const holding = new Promise<number>((resolve) => {
    reached = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const change = prisma.$transaction(
    async (tx) => {
      await lockIssueType(tx, typeId);
      await tx.issueType.update({
        where: { id: typeId },
        data: { handledBy: "BOARD" },
      });
      reached(await backendPid(tx));
      await gate;
    },
    { timeout: 30_000 },
  );
  const holder = await holding;
  const deadline = Date.now() + QUEUE_WAIT_MS;

  let answered = false;
  const request = send().finally(() => {
    answered = true;
  });
  let waited = false;
  try {
    await waitWithin(
      deadline,
      async () => answered || (await waitersBehind(prisma, holder)) > 0,
    );
    waited = !answered;
  } finally {
    release();
    await change;
  }
  expect(waited, "the request waits for the type's lock").toBe(true);
  return request;
}
