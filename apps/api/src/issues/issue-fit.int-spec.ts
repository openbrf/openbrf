import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { ActionContext } from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { ActionRegistryService } from "../actions/action-registry.service";
import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { registerMultipart } from "../http/multipart";
import { pngBytes } from "../media/testing/image-fixtures";
import { StorageService } from "../storage/storage.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";

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
  await prisma.apartment.deleteMany({ where: { id: apartmentId } });
  await prisma.address.deleteMany({ where: { id: `if-address-${suffix}` } });
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
    expect(set?.context).toMatchObject({
      answer: "YES",
      pets: true,
      masterKey: true,
      until,
      byReporter: true,
    });
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

    for (const apartment of ["Lgh 1101", "Lägenhet 1203", "1101"]) {
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
    const lift = await place("Hiss mcp");
    const issueId = await filed(plain, { placeId: lift });
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
      const answered = JSON.stringify([one, page]);
      expect(answered).toContain(issueId);
      expect(answered).not.toContain(note);
      expect(answered).not.toContain("entry");
      expect(answered).not.toContain("finding");
      expect(answered).not.toContain("protokoll");
      expect(answered).not.toContain(`Hiss mcp ${suffix}`);
    }
  });
});
