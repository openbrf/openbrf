import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { addLocalDays, dateColumnOf, localDayOf } from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { pngBytes } from "../media/testing/image-fixtures";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import { waitFor } from "../testing/advisory-locks";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { backendPid, waitersBehind } from "../testing/lock-waiters";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { lockIssueType } from "./issue-lock";
import { IssueResidentsService } from "./issue-residents.service";
import { IssueService } from "./issue.service";

/**
 * Issue handling over HTTP, against a real database (ADR 0054): the assignee,
 * the priority and the target date, routing on filing, who handles a type and
 * an issue, issues a handler opens, and the timeline.
 *
 * Every role that reaches the queue is here, because the rule that matters is
 * who is let in: a board member with a seat, an administrator without one, the
 * property manager, and a resident who reaches none of it. A protected
 * reporter, and a protected handler, show what every new read withholds.
 */

// Refuses to run without a configured environment, before anything connects.
loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

function person(key: string, firstName: string, lastName: string) {
  return {
    personId: `ih-${key}-${suffix}`,
    email: `ih-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `${lastName}${suffix}`,
  };
}

const board = person("board", "Bea", "Styrelse");
const admin = person("admin", "Ada", "Administrator");
const manager = person("manager", "Frida", "Forvaltare");
/** The property manager who also lives in the house, so reads the feed. */
const tenantManager = person("tenant-manager", "Tove", "Forvaltare");
const resident = person("resident", "Rune", "Boende");
/** A resident with protected personal data, as a reporter. */
const shielded = person("shielded", "Sara", "Skyddad");
/** A board member with protected personal data, as a handler. */
const shieldedBoard = person("shielded-board", "Sven", "Skyddad");
/** The picker's apartment: who lived, lives and will live there. */
const former = person("former", "Fanny", "Flyttad");
const leaving = person("leaving", "Lars", "Lamnar");
const arriving = person("arriving", "Anna", "Ankommer");
const outToday = person("out-today", "Olle", "Utflytt");
const inToday = person("in-today", "Ingrid", "Inflytt");
const people = [
  board,
  admin,
  manager,
  tenantManager,
  resident,
  shielded,
  shieldedBoard,
  former,
  leaving,
  arriving,
  outToday,
  inToday,
];
const personIds = people.map((entry) => entry.personId);

const addressId = `ih-address-${suffix}`;
const apartmentId = `ih-apartment-${suffix}`;
const shieldedApartmentId = `ih-apartment-shielded-${suffix}`;
const pickerApartmentId = `ih-apartment-picker-${suffix}`;
const apartmentIds = [apartmentId, shieldedApartmentId, pickerApartmentId];

/** Each residency's identifier, which is what the resident picker answers. */
const residencyIds = {
  resident: `ih-residency-resident-${suffix}`,
  shielded: `ih-residency-shielded-${suffix}`,
  tenantManager: `ih-residency-tenant-manager-${suffix}`,
  former: `ih-residency-former-${suffix}`,
  leaving: `ih-residency-leaving-${suffix}`,
  arriving: `ih-residency-arriving-${suffix}`,
  outToday: `ih-residency-out-today-${suffix}`,
  inToday: `ih-residency-in-today-${suffix}`,
};

/** The association's calendar day, as the service reads residencies on it. */
function dayFromToday(days: number): Date {
  return dateColumnOf(addLocalDays(localDayOf(new Date()), days));
}

const typeIds = {
  routed: `ih-type-routed-${suffix}`,
  plain: `ih-type-plain-${suffix}`,
  boardOnly: `ih-type-board-${suffix}`,
  turning: `ih-type-turning-${suffix}`,
  counted: `ih-type-counted-${suffix}`,
  photoTurning: `ih-type-photo-turning-${suffix}`,
  racing: `ih-type-racing-${suffix}`,
};
let routed: IssueTypeFixture;
let plain: IssueTypeFixture;
let boardOnly: IssueTypeFixture;

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST" | "PUT";
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
        // 10.177.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.177.${String(subnet)}.${String(host + 1)}`,
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

interface HandlerView {
  kind: string;
  personId?: string;
  name?: string;
}

interface QueuedRow {
  id: string;
  typeId: string;
  priority: string;
  targetDate: string | null;
  overdue: boolean;
  assignee: HandlerView | null;
  enteredBy: HandlerView | null;
  enteredByHandler: boolean;
  boardOnly: boolean;
  reporter: { kind: string; personId?: string; name?: string };
  apartment: { id: string } | null;
}

async function queue(cookie: string): Promise<QueuedRow[]> {
  const response = await inject({
    method: "GET",
    url: "/api/issue-queue",
    cookie,
  });
  expect(response.statusCode).toBe(200);
  return response.json<QueuedRow[]>();
}

async function act(
  cookie: string,
  issueId: string,
  what: "assignee" | "priority" | "target-date" | "access",
  payload: object,
) {
  return inject({
    method: "POST",
    url: `/api/issue-queue/${issueId}/${what}`,
    payload,
    cookie,
  });
}

/** An issue a resident filed, written directly, as the queue would hold it. */
async function filed(
  type: IssueTypeFixture,
  key: string,
  extra: { boardOnly?: boolean; reporterPersonId?: string } = {},
): Promise<string> {
  const id = `ih-issue-${key}-${suffix}`;
  await prisma.issue.create({
    data: {
      id,
      typeId: type.id,
      statusId: type.statusIds.NEW,
      reporterPersonId: extra.reporterPersonId ?? resident.personId,
      description: `Beskrivning ${key}`,
      boardOnly: extra.boardOnly ?? false,
    },
  });
  return id;
}

async function entries(issueId: string) {
  return prisma.auditLogEntry.findMany({
    where: { targetKind: "issue", targetId: issueId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      action: true,
      actorPersonId: true,
      targetPersonId: true,
      channel: true,
      context: true,
    },
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
  encryption = app.get(FieldEncryptionService);

  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });
  await prisma.address.create({
    data: {
      id: addressId,
      street: "Ansvarsgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.createMany({
    data: [
      { id: apartmentId, addressId, number: "1501", floor: 5 },
      { id: shieldedApartmentId, addressId, number: "1502", floor: 5 },
      { id: pickerApartmentId, addressId, number: "1503", floor: 5 },
    ],
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
      { personId: tenantManager.personId, role: "PROPERTY_MANAGER" as const },
    ],
  });
  await prisma.residency.createMany({
    data: [
      {
        id: residencyIds.resident,
        personId: resident.personId,
        apartmentId,
        role: "MEMBER" as const,
        movedInOn: new Date("2024-01-01"),
      },
      {
        id: residencyIds.shielded,
        personId: shielded.personId,
        apartmentId: shieldedApartmentId,
        role: "MEMBER" as const,
        movedInOn: new Date("2024-01-01"),
      },
      {
        id: residencyIds.tenantManager,
        personId: tenantManager.personId,
        apartmentId,
        role: "MEMBER" as const,
        movedInOn: new Date("2024-01-01"),
      },
      // Moved out last year: a former resident.
      {
        id: residencyIds.former,
        personId: former.personId,
        apartmentId: pickerApartmentId,
        role: "MEMBER" as const,
        movedInOn: new Date("2020-01-01"),
        movedOutOn: dayFromToday(-365),
      },
      // A move-out scheduled for next month: still lives here today.
      {
        id: residencyIds.leaving,
        personId: leaving.personId,
        apartmentId: pickerApartmentId,
        role: "MEMBER" as const,
        movedInOn: new Date("2020-01-01"),
        movedOutOn: dayFromToday(30),
      },
      // A move-in next month: does not live here yet.
      {
        id: residencyIds.arriving,
        personId: arriving.personId,
        apartmentId: pickerApartmentId,
        role: "MEMBER" as const,
        movedInOn: dayFromToday(30),
      },
      // Moves out today, the first day the residency is not held.
      {
        id: residencyIds.outToday,
        personId: outToday.personId,
        apartmentId: pickerApartmentId,
        role: "RESIDENT" as const,
        movedInOn: new Date("2020-01-01"),
        movedOutOn: dayFromToday(0),
      },
      // Moves in today, the first day the residency is held.
      {
        id: residencyIds.inToday,
        personId: inToday.personId,
        apartmentId: pickerApartmentId,
        role: "RESIDENT" as const,
        movedInOn: dayFromToday(0),
      },
    ],
  });

  routed = await createIssueTypeFixture(prisma, {
    id: typeIds.routed,
    name: `Vattenläcka ${suffix}`,
    reporters: ["RESIDENTS"],
    defaultPriority: "URGENT",
    defaultAssigneePersonId: manager.personId,
  });
  plain = await createIssueTypeFixture(prisma, {
    id: typeIds.plain,
    name: `Övrigt ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  boardOnly = await createIssueTypeFixture(prisma, {
    id: typeIds.boardOnly,
    name: `Försäkring ${suffix}`,
    reporters: ["HANDLERS"],
    handledBy: "BOARD",
  });

  for (const entry of [
    board,
    admin,
    manager,
    tenantManager,
    resident,
    shielded,
  ]) {
    cookies[entry.personId] = await signIn(entry.email);
  }
}, 180_000);

afterAll(async () => {
  await prisma.post.deleteMany({
    where: { authorPersonId: { in: personIds } },
  });
  await prisma.issue.deleteMany({
    where: { typeId: { in: Object.values(typeIds) } },
  });
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
    where: { id: { in: apartmentIds } },
  });
  await prisma.address.deleteMany({ where: { id: addressId } });
  await app.close();
});

describe("routing on filing", () => {
  it("files a report with its type's default priority and assignee, and records who set it", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/issues",
      payload: { typeId: routed.id, description: "Det droppar" },
      cookie: cookies[resident.personId],
    });
    expect(response.statusCode).toBe(201);
    const { id } = response.json<{ id: string }>();

    const row = (await queue(cookies[board.personId] ?? "")).find(
      (issue) => issue.id === id,
    );
    expect(row).toMatchObject({
      priority: "URGENT",
      assignee: {
        kind: "person",
        personId: manager.personId,
        name: `${manager.firstName} ${manager.lastName}`,
      },
      enteredBy: null,
      enteredByHandler: false,
    });
    // Nobody chose it: the type's setting did, and the entry says so.
    expect(await entries(id)).toEqual([
      {
        action: "ISSUE_ASSIGNED",
        actorPersonId: null,
        targetPersonId: manager.personId,
        channel: "SYSTEM",
        context: { byTypeDefault: true },
      },
    ]);
  });

  it("lands a report unassigned at normal priority on a type with no default", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/issues",
      payload: { typeId: plain.id, description: "Något annat" },
      cookie: cookies[resident.personId],
    });
    const { id } = response.json<{ id: string }>();

    const row = (await queue(cookies[board.personId] ?? "")).find(
      (issue) => issue.id === id,
    );
    expect(row).toMatchObject({ priority: "NORMAL", assignee: null });
    expect(await entries(id)).toEqual([]);
  });
});

describe("assigning, priority and target date", () => {
  it("lets a handler assign, reassign and unassign, each recorded with the previous assignee", async () => {
    const id = await filed(plain, "assign");
    const assigned = await act(cookies[board.personId] ?? "", id, "assignee", {
      assigneePersonId: manager.personId,
    });
    expect(assigned.statusCode).toBe(201);
    expect(assigned.json<QueuedRow>().assignee).toMatchObject({
      personId: manager.personId,
    });

    // The property manager hands it on to the board member.
    const reassigned = await act(
      cookies[manager.personId] ?? "",
      id,
      "assignee",
      { assigneePersonId: board.personId },
    );
    expect(reassigned.json<QueuedRow>().assignee).toMatchObject({
      personId: board.personId,
    });
    // Asking for what it already is records nothing.
    await act(cookies[manager.personId] ?? "", id, "assignee", {
      assigneePersonId: board.personId,
    });
    const unassigned = await act(
      cookies[admin.personId] ?? "",
      id,
      "assignee",
      { assigneePersonId: null },
    );
    expect(unassigned.json<QueuedRow>().assignee).toBeNull();

    expect(await entries(id)).toEqual([
      {
        action: "ISSUE_ASSIGNED",
        actorPersonId: board.personId,
        targetPersonId: manager.personId,
        channel: "WEB",
        context: { previousAssigneePersonId: null },
      },
      {
        action: "ISSUE_ASSIGNED",
        actorPersonId: manager.personId,
        targetPersonId: board.personId,
        channel: "WEB",
        context: { previousAssigneePersonId: manager.personId },
      },
      {
        action: "ISSUE_ASSIGNED",
        actorPersonId: admin.personId,
        targetPersonId: null,
        channel: "WEB",
        context: { previousAssigneePersonId: board.personId },
      },
    ]);
  });

  it("refuses an assignee who does not handle the issue, a resident or a stranger alike", async () => {
    const id = await filed(plain, "not-a-handler");
    for (const assigneePersonId of [resident.personId, `nobody-${suffix}`]) {
      const refused = await act(cookies[board.personId] ?? "", id, "assignee", {
        assigneePersonId,
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json<{ reason: string }>().reason).toBe(
        "assignee-not-a-handler",
      );
    }
    // Nor the property manager on an issue the board keeps to itself.
    const kept = await filed(boardOnly, "not-a-board-handler");
    const refused = await act(cookies[board.personId] ?? "", kept, "assignee", {
      assigneePersonId: manager.personId,
    });
    expect(refused.statusCode).toBe(422);
    expect(await entries(id)).toEqual([]);
  });

  it("sets the priority and the target date, marks a past date overdue, and records both sides", async () => {
    const id = await filed(plain, "priority");
    const cookie = cookies[manager.personId] ?? "";

    const urgent = await act(cookie, id, "priority", { priority: "URGENT" });
    expect(urgent.json<QueuedRow>().priority).toBe("URGENT");

    const dated = await act(cookie, id, "target-date", {
      targetDate: "2020-02-29",
    });
    expect(dated.json<QueuedRow>()).toMatchObject({
      targetDate: "2020-02-29",
      overdue: true,
    });
    const later = await act(cookie, id, "target-date", {
      targetDate: "2999-01-31",
    });
    expect(later.json<QueuedRow>().overdue).toBe(false);

    const invalid = await act(cookie, id, "target-date", {
      targetDate: "2026-02-30",
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<{ reason: string }>().reason).toBe(
      "target-date-invalid",
    );

    const cleared = await act(cookie, id, "target-date", { targetDate: null });
    expect(cleared.json<QueuedRow>().targetDate).toBeNull();

    expect(
      (await entries(id)).map((entry) => [entry.action, entry.context]),
    ).toEqual([
      ["ISSUE_PRIORITY_CHANGED", { from: "NORMAL", to: "URGENT" }],
      ["ISSUE_TARGET_DATE_CHANGED", { from: null, to: "2020-02-29" }],
      ["ISSUE_TARGET_DATE_CHANGED", { from: "2020-02-29", to: "2999-01-31" }],
      ["ISSUE_TARGET_DATE_CHANGED", { from: "2999-01-31", to: null }],
    ]);
  });

  it("is closed to a resident, who handles nothing", async () => {
    const id = await filed(plain, "resident");
    const cookie = cookies[resident.personId] ?? "";
    for (const [what, payload] of [
      ["assignee", { assigneePersonId: resident.personId }],
      ["priority", { priority: "URGENT" }],
      ["target-date", { targetDate: "2030-01-01" }],
      ["access", { boardOnly: true }],
    ] as const) {
      expect((await act(cookie, id, what, payload)).statusCode).toBe(403);
    }
    for (const url of [
      "/api/issue-queue",
      `/api/issue-queue/${id}/handlers`,
      `/api/issue-queue/${id}/timeline`,
    ]) {
      expect((await inject({ method: "GET", url, cookie })).statusCode).toBe(
        403,
      );
    }
  });
});

describe("who handles a type and an issue", () => {
  it("keeps a board-only type's issues from the property manager on every read, and not from an administrator without a seat", async () => {
    const id = await filed(boardOnly, "kept");

    expect(
      (await queue(cookies[manager.personId] ?? "")).map((row) => row.id),
    ).not.toContain(id);
    for (const url of [
      `/api/issue-queue/${id}/handlers`,
      `/api/issue-queue/${id}/timeline`,
    ]) {
      const refused = await inject({
        method: "GET",
        url,
        cookie: cookies[manager.personId],
      });
      expect(refused.statusCode).toBe(404);
      expect(refused.json<{ reason: string }>().reason).toBe("issue-not-found");
    }
    const moved = await act(cookies[manager.personId] ?? "", id, "priority", {
      priority: "LOW",
    });
    expect(moved.statusCode).toBe(404);
    const status = await inject({
      method: "POST",
      url: `/api/issue-queue/${id}/status`,
      payload: { statusId: boardOnly.statusIds.IN_PROGRESS },
      cookie: cookies[manager.personId],
    });
    expect(status.statusCode).toBe(404);

    // Nor is the type itself offered to them.
    const types = await inject({
      method: "GET",
      url: "/api/issue-queue/types",
      cookie: cookies[manager.personId],
    });
    expect(types.json<{ id: string }[]>().map((type) => type.id)).not.toContain(
      boardOnly.id,
    );

    // The same omission inside the service, for the reads the actions bind.
    const issues = app.get(IssueService);
    const page = await issues.pageOfQueue(
      manager.personId,
      { typeId: boardOnly.id },
      "omit",
    );
    expect(page.issues).toEqual([]);
    await expect(
      issues.queuedIssue(manager.personId, id, "omit"),
    ).rejects.toMatchObject({ reason: "issue-not-found" });

    for (const reader of [board, admin]) {
      expect(
        (await queue(cookies[reader.personId] ?? "")).map((row) => row.id),
      ).toContain(id);
    }
  });

  it("lets any handler close an issue to the board, unassigning a handler it shuts out, and lets only the board open it again", async () => {
    const id = await filed(plain, "tighten");
    await act(cookies[board.personId] ?? "", id, "assignee", {
      assigneePersonId: manager.personId,
    });

    const tightened = await act(cookies[manager.personId] ?? "", id, "access", {
      boardOnly: true,
    });
    expect(tightened.statusCode).toBe(201);
    expect(tightened.json<QueuedRow>()).toMatchObject({
      boardOnly: true,
      assignee: null,
    });

    // Gone from the property manager, who cannot open it again either.
    expect(
      (await queue(cookies[manager.personId] ?? "")).map((row) => row.id),
    ).not.toContain(id);
    const loosened = await act(cookies[manager.personId] ?? "", id, "access", {
      boardOnly: false,
    });
    expect(loosened.statusCode).toBe(404);

    const reopened = await act(cookies[board.personId] ?? "", id, "access", {
      boardOnly: false,
    });
    expect(reopened.json<QueuedRow>().boardOnly).toBe(false);

    expect(
      (await entries(id)).map((entry) => [
        entry.action,
        entry.actorPersonId,
        entry.context,
      ]),
    ).toEqual([
      ["ISSUE_ASSIGNED", board.personId, { previousAssigneePersonId: null }],
      ["ISSUE_ACCESS_CHANGED", manager.personId, { boardOnly: true }],
      [
        "ISSUE_ASSIGNED",
        manager.personId,
        { previousAssigneePersonId: manager.personId },
      ],
      ["ISSUE_ACCESS_CHANGED", board.personId, { boardOnly: false }],
    ]);
  });

  it("hands a type to the board, unassigning and clearing the property manager", async () => {
    const turning = await createIssueTypeFixture(prisma, {
      id: typeIds.turning,
      name: `Störningar ${suffix}`,
      reporters: ["RESIDENTS"],
      defaultAssigneePersonId: manager.personId,
    });
    const id = await filed(turning, "turning");
    await prisma.issue.update({
      where: { id },
      data: { assigneePersonId: manager.personId },
    });

    const changed = await inject({
      method: "PUT",
      url: `/api/issue-types/${turning.id}`,
      payload: {
        name: `Störningar ${suffix}`,
        reporters: ["RESIDENTS"],
        handledBy: "BOARD",
      },
      cookie: cookies[board.personId],
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      handledBy: "BOARD",
      defaultAssignee: null,
    });
    expect(
      await prisma.issue.findUnique({
        where: { id },
        select: { assigneePersonId: true },
      }),
    ).toEqual({ assigneePersonId: null });
    expect(await entries(id)).toEqual([
      {
        action: "ISSUE_ASSIGNED",
        actorPersonId: board.personId,
        targetPersonId: null,
        channel: "WEB",
        context: { previousAssigneePersonId: manager.personId },
      },
    ]);

    // Naming the property manager as the default of a board-only type is
    // refused rather than kept.
    const refused = await inject({
      method: "PUT",
      url: `/api/issue-types/${turning.id}`,
      payload: {
        name: `Störningar ${suffix}`,
        reporters: ["RESIDENTS"],
        defaultAssigneePersonId: manager.personId,
      },
      cookie: cookies[board.personId],
    });
    expect(refused.statusCode).toBe(422);
  });

  it("names the people an issue may be assigned to, and nothing else about them", async () => {
    const id = await filed(plain, "handlers");
    const response = await inject({
      method: "GET",
      url: `/api/issue-queue/${id}/handlers`,
      cookie: cookies[manager.personId],
    });
    expect(response.statusCode).toBe(200);
    const handlers = response
      .json<HandlerView[]>()
      .filter(
        (handler) =>
          handler.personId !== undefined &&
          personIds.includes(handler.personId),
      );
    expect(handlers).toEqual(
      expect.arrayContaining([
        {
          kind: "person",
          personId: board.personId,
          name: `${board.firstName} ${board.lastName}`,
        },
        {
          kind: "person",
          personId: admin.personId,
          name: `${admin.firstName} ${admin.lastName}`,
        },
        {
          kind: "person",
          personId: manager.personId,
          name: `${manager.firstName} ${manager.lastName}`,
        },
        {
          kind: "person",
          personId: tenantManager.personId,
          name: `${tenantManager.firstName} ${tenantManager.lastName}`,
        },
        // A protected handler can be chosen, by identifier, and is named to
        // nobody.
        { kind: "protected", personId: shieldedBoard.personId },
      ]),
    );
    expect(handlers).toHaveLength(5);
    // Names only: never an address, a telephone or an apartment.
    expect(response.body).not.toContain("@exempel.se");
    expect(response.body).not.toContain(shieldedBoard.lastName);

    const kept = await filed(boardOnly, "handlers-board");
    const board_ = await inject({
      method: "GET",
      url: `/api/issue-queue/${kept}/handlers`,
      cookie: cookies[admin.personId],
    });
    expect(
      board_.json<HandlerView[]>().map((handler) => handler.personId),
    ).not.toContain(manager.personId);
  });
});

describe("what the board-only rule keeps beyond the queue", () => {
  /** A photograph the resident attached to their own report. */
  async function photographed(issueId: string): Promise<string> {
    const photo = await app.get(IssueService).attachPhoto({
      issueId,
      reporterPersonId: resident.personId,
      bytes: pngBytes(24, 24),
      fileName: "skada.png",
    });
    return photo.url;
  }

  function download(url: string, reader: { personId: string }) {
    return inject({ method: "GET", url, cookie: cookies[reader.personId] });
  }

  async function accessesBy(url: string, reader: { personId: string }) {
    return prisma.auditLogEntry.count({
      where: {
        action: "MEDIA_ACCESSED",
        targetId: url.slice("/api/media/".length),
        actorPersonId: reader.personId,
      },
    });
  }

  it("stops serving a photograph to the property manager once the issue is kept to the board, and keeps serving the board and the reporter", async () => {
    const id = await filed(plain, "photo-tightened");
    const url = await photographed(id);

    // An address the property manager was handed while the issue was theirs.
    expect((await download(url, manager)).statusCode).toBe(200);
    expect(await accessesBy(url, manager)).toBe(1);

    const tightened = await act(cookies[board.personId] ?? "", id, "access", {
      boardOnly: true,
    });
    expect(tightened.statusCode).toBe(201);

    const refused = await download(url, manager);
    expect(refused.statusCode).toBe(404);
    // Refused before anything was served, so nothing more is recorded.
    expect(await accessesBy(url, manager)).toBe(1);

    expect((await download(url, board)).statusCode).toBe(200);
    expect(await accessesBy(url, board)).toBe(1);
    expect((await download(url, admin)).statusCode).toBe(200);
    // The reporter reads their own photograph, and is not recorded doing so.
    expect((await download(url, resident)).statusCode).toBe(200);
    expect(await accessesBy(url, resident)).toBe(0);
  });

  it("stops serving a photograph to the property manager once its type is handed to the board", async () => {
    const turning = await createIssueTypeFixture(prisma, {
      id: typeIds.photoTurning,
      name: `Skador ${suffix}`,
      reporters: ["RESIDENTS"],
    });
    const id = await filed(turning, "photo-turning");
    const url = await photographed(id);
    expect((await download(url, manager)).statusCode).toBe(200);

    const changed = await inject({
      method: "PUT",
      url: `/api/issue-types/${turning.id}`,
      payload: {
        name: `Skador ${suffix}`,
        reporters: ["RESIDENTS"],
        handledBy: "BOARD",
      },
      cookie: cookies[board.personId],
    });
    expect(changed.statusCode).toBe(200);

    expect((await download(url, manager)).statusCode).toBe(404);
    expect((await download(url, board)).statusCode).toBe(200);
    expect((await download(url, resident)).statusCode).toBe(200);
  });

  it("shows a post's issue to a property manager who lives here only while they handle it, and always to its reporter", async () => {
    const audiences = await inject({
      method: "GET",
      url: "/api/feed/audiences",
      cookie: cookies[resident.personId],
    });
    const allAudienceId =
      audiences
        .json<{ audiences: { id: string; kind: string }[] }>()
        .audiences.find((audience) => audience.kind === "ALL")?.id ?? "";
    const written = await inject({
      method: "POST",
      url: "/api/feed/posts",
      payload: {
        audienceId: allAudienceId,
        body: `Läcka i källaren ${suffix}`,
      },
      cookie: cookies[resident.personId],
    });
    expect(written.statusCode, written.body).toBe(201);
    const postId = written.json<{ id: string }>().id;

    const id = await filed(plain, "post-linked");
    await prisma.post.update({ where: { id: postId }, data: { issueId: id } });

    const issueOnPost = async (reader: { personId: string }) => {
      const read = await inject({
        method: "GET",
        url: `/api/feed/posts/${postId}`,
        cookie: cookies[reader.personId],
      });
      expect(read.statusCode, read.body).toBe(200);
      return read.json<{ issue: unknown }>().issue;
    };

    expect(await issueOnPost(tenantManager)).toEqual({
      id,
      meaning: "NEW",
      reportedByReader: false,
    });

    // Kept to the board one issue at a time.
    await prisma.issue.update({ where: { id }, data: { boardOnly: true } });
    expect(await issueOnPost(tenantManager)).toBeNull();
    expect(await issueOnPost(resident)).toEqual({
      id,
      meaning: "NEW",
      reportedByReader: true,
    });

    // And by its type.
    await prisma.issue.update({
      where: { id },
      data: {
        boardOnly: false,
        typeId: boardOnly.id,
        statusId: boardOnly.statusIds.NEW,
      },
    });
    expect(await issueOnPost(tenantManager)).toBeNull();
    expect(await issueOnPost(resident)).toMatchObject({
      reportedByReader: true,
    });
  });

  it("counts a type's issues for the property manager without those kept to the board", async () => {
    const counted = await createIssueTypeFixture(prisma, {
      id: typeIds.counted,
      name: `Räknade ${suffix}`,
      reporters: ["RESIDENTS"],
    });
    await filed(counted, "counted-open");
    await filed(counted, "counted-kept", { boardOnly: true });

    const countsFor = async (reader: { personId: string }) => {
      const response = await inject({
        method: "GET",
        url: "/api/issue-queue/types",
        cookie: cookies[reader.personId],
      });
      expect(response.statusCode).toBe(200);
      const type = response
        .json<
          {
            id: string;
            reportCount: number;
            statuses: { meaning: string; issueCount: number }[];
          }[]
        >()
        .find((candidate) => candidate.id === counted.id);
      return {
        reportCount: type?.reportCount,
        newCount: type?.statuses.find((status) => status.meaning === "NEW")
          ?.issueCount,
      };
    };

    expect(await countsFor(manager)).toEqual({ reportCount: 1, newCount: 1 });
    expect(await countsFor(board)).toEqual({ reportCount: 2, newCount: 2 });

    // The board's configuration screen counts every issue, for the reason it
    // counts them at all: why a type cannot be deleted.
    const configured = await inject({
      method: "GET",
      url: "/api/issue-types",
      cookie: cookies[board.personId],
    });
    expect(
      configured
        .json<{ id: string; reportCount: number }[]>()
        .find((type) => type.id === counted.id)?.reportCount,
    ).toBe(2);
  });

  it("does not offer a property manager who lives here a type the board keeps to itself, as a type to report under", async () => {
    const offered = async (reader: { personId: string }) => {
      const response = await inject({
        method: "GET",
        url: "/api/issues/types",
        cookie: cookies[reader.personId],
      });
      expect(response.statusCode).toBe(200);
      return response.json<{ id: string }[]>().map((type) => type.id);
    };

    const toManager = await offered(tenantManager);
    expect(toManager).not.toContain(boardOnly.id);
    // A resident's type is still theirs, as a resident.
    expect(toManager).toContain(plain.id);
    expect(await offered(board)).toContain(boardOnly.id);

    const refused = await inject({
      method: "POST",
      url: "/api/issues",
      payload: { typeId: boardOnly.id, description: "Försäkringsärende" },
      cookie: cookies[tenantManager.personId],
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json<{ reason: string }>().reason).toBe("type-not-found");
    expect(
      await prisma.issue.count({
        where: {
          typeId: boardOnly.id,
          reporterPersonId: tenantManager.personId,
        },
      }),
    ).toBe(0);
  });
});

describe("issues a handler opens", () => {
  it("opens one for a named resident, who is then its reporter, with the handler shown and recorded", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: {
        typeId: plain.id,
        residencyId: residencyIds.resident,
        description: "Ringde om dörren",
      },
      cookie: cookies[board.personId],
    });
    expect(response.statusCode).toBe(201);
    const row = response.json<QueuedRow>();
    expect(row).toMatchObject({
      reporter: { kind: "resident", personId: resident.personId },
      apartment: { id: apartmentId },
      enteredBy: { kind: "person", personId: board.personId },
      enteredByHandler: true,
    });
    expect(await entries(row.id)).toEqual([
      {
        action: "ISSUE_OPENED",
        actorPersonId: board.personId,
        targetPersonId: resident.personId,
        channel: "WEB",
        context: { typeId: plain.id, internal: false },
      },
    ]);

    // The resident reads it as theirs, told a handler entered it and not who.
    const own = await inject({
      method: "GET",
      url: "/api/issues/mine",
      cookie: cookies[resident.personId],
    });
    const mine = own
      .json<{ id: string; enteredByHandler: boolean }[]>()
      .find((issue) => issue.id === row.id);
    expect(mine).toMatchObject({ enteredByHandler: true });
    expect(JSON.stringify(mine)).not.toContain(board.personId);
  });

  it("masks a protected resident it is opened for, as every reporter is", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: {
        typeId: plain.id,
        residencyId: residencyIds.shielded,
        description: "Skyddad anmälan",
      },
      cookie: cookies[admin.personId],
    });
    expect(response.statusCode).toBe(201);
    const row = response.json<QueuedRow>();
    expect(row.reporter).toEqual({ kind: "protected" });
    expect(row.apartment).toBeNull();
    expect(response.body).not.toContain(shielded.personId);
    expect(response.body).not.toContain(shielded.lastName);

    const timeline = await inject({
      method: "GET",
      url: `/api/issue-queue/${row.id}/timeline`,
      cookie: cookies[admin.personId],
    });
    expect(timeline.body).not.toContain(shielded.personId);
  });

  it("lets the property manager open an internal issue, and one for a resident named from the picker", async () => {
    const internal = await inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: { typeId: plain.id, description: "Trasig lampa i trapphuset" },
      cookie: cookies[manager.personId],
    });
    expect(internal.statusCode).toBe(201);
    expect(internal.json<QueuedRow>()).toMatchObject({
      reporter: { kind: "unknown" },
      enteredBy: { kind: "person", personId: manager.personId },
    });

    // The way the form does it: the apartment, then who lives there.
    const listed = await inject({
      method: "GET",
      url: `/api/issue-queue/apartments/${apartmentId}/residents`,
      cookie: cookies[manager.personId],
    });
    expect(listed.statusCode).toBe(200);
    const rune = listed
      .json<ResidentChoice[]>()
      .find(
        (choice) =>
          choice.name === `${resident.firstName} ${resident.lastName}`,
      );
    expect(rune).toEqual({
      kind: "person",
      residencyId: residencyIds.resident,
      name: `${resident.firstName} ${resident.lastName}`,
    });

    const named = await inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: {
        typeId: plain.id,
        residencyId: rune?.residencyId,
        description: "Ringde om tvättstugan",
      },
      cookie: cookies[manager.personId],
    });
    expect(named.statusCode).toBe(201);
    const row = named.json<QueuedRow>();
    expect(row).toMatchObject({
      reporter: { kind: "resident", personId: resident.personId },
      apartment: { id: apartmentId },
      enteredBy: { kind: "person", personId: manager.personId },
      enteredByHandler: true,
    });
    expect(await entries(row.id)).toEqual([
      {
        action: "ISSUE_OPENED",
        actorPersonId: manager.personId,
        targetPersonId: resident.personId,
        channel: "WEB",
        context: { typeId: plain.id, internal: false },
      },
    ]);

    // Nor under a type the board keeps to itself.
    const kept = await inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: {
        typeId: boardOnly.id,
        residencyId: residencyIds.resident,
        description: "Försäkring",
      },
      cookie: cookies[manager.personId],
    });
    expect(kept.statusCode).toBe(404);
    expect(kept.json<{ reason: string }>().reason).toBe("type-not-found");
  });

  it("refuses an issue the property manager opens under a type handed to the board while they wait for it, and files nothing", async () => {
    const racing = await createIssueTypeFixture(prisma, {
      id: typeIds.racing,
      name: `Kapplöpning ${suffix}`,
      reporters: ["RESIDENTS"],
    });

    let reached: (pid: number) => void = () => undefined;
    const holding = new Promise<number>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The board's change, holding the type's lock as `IssueTypeService.update`
    // does, and committing only once the opening waits behind it.
    const change = prisma.$transaction(
      async (tx) => {
        await lockIssueType(tx, racing.id);
        await tx.issueType.update({
          where: { id: racing.id },
          data: { handledBy: "BOARD" },
        });
        reached(await backendPid(tx));
        await gate;
      },
      { timeout: 30_000 },
    );
    const holder = await holding;
    const opening = inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: { typeId: racing.id, description: "Medan styrelsen ändrar" },
      cookie: cookies[manager.personId],
    });
    try {
      await waitFor(async () => (await waitersBehind(prisma, holder)) > 0);
    } finally {
      release();
      await change;
    }

    const answer = await opening;
    expect(answer.statusCode).toBe(404);
    expect(answer.json<{ reason: string }>().reason).toBe("type-not-found");
    expect(await prisma.issue.count({ where: { typeId: racing.id } })).toBe(0);
  });

  it("names nobody who does not live here today, and takes no person identifier", async () => {
    for (const residencyId of [
      residencyIds.former,
      residencyIds.arriving,
      residencyIds.outToday,
      `ih-residency-nobody-${suffix}`,
    ]) {
      const refused = await inject({
        method: "POST",
        url: "/api/issue-queue",
        payload: { typeId: plain.id, residencyId, description: "Bor inte här" },
        cookie: cookies[board.personId],
      });
      expect(refused.statusCode).toBe(404);
      expect(refused.json<{ reason: string }>().reason).toBe(
        "resident-not-found",
      );
    }

    // A person or an apartment named the way the address book once did is
    // refused, rather than dropped into an internal issue.
    const before = await prisma.issue.count({ where: { typeId: plain.id } });
    const unread = await inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: {
        typeId: plain.id,
        reporterPersonId: resident.personId,
        apartmentId,
        description: "Gammal väg",
      },
      cookie: cookies[manager.personId],
    });
    expect(unread.statusCode).toBe(400);
    expect(await prisma.issue.count({ where: { typeId: plain.id } })).toBe(
      before,
    );
  });
});

interface ResidentChoice {
  kind: "person" | "protected";
  residencyId: string;
  name?: string;
}

describe("the resident picker", () => {
  async function residentsOf(reader: { personId: string }, apartment: string) {
    return inject({
      method: "GET",
      url: `/api/issue-queue/apartments/${apartment}/residents`,
      cookie: cookies[reader.personId],
    });
  }

  async function listings(reader: { personId: string }, apartment: string) {
    return prisma.auditLogEntry.findMany({
      where: {
        action: "ISSUE_RESIDENTS_LISTED",
        actorPersonId: reader.personId,
        targetId: apartment,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { targetKind: true, targetPersonId: true, context: true },
    });
  }

  it("offers every apartment by designation to every handler, the property manager included", async () => {
    for (const reader of [board, admin, manager]) {
      const response = await inject({
        method: "GET",
        url: "/api/issue-queue/apartments",
        cookie: cookies[reader.personId],
      });
      expect(response.statusCode).toBe(200);
      const ours = response
        .json<{ id: string; number: string; address: string }[]>()
        .filter((apartment) => apartmentIds.includes(apartment.id));
      expect(ours).toEqual([
        { id: apartmentId, number: "1501", address: `Ansvarsgatan ${suffix}` },
        {
          id: shieldedApartmentId,
          number: "1502",
          address: `Ansvarsgatan ${suffix}`,
        },
        {
          id: pickerApartmentId,
          number: "1503",
          address: `Ansvarsgatan ${suffix}`,
        },
      ]);
    }
  });

  it("lists who lives there today: a scheduled move-out and a move-in today, not a former resident, a move-in ahead or a move-out today", async () => {
    const response = await residentsOf(manager, pickerApartmentId);
    expect(response.statusCode).toBe(200);
    expect(response.json<ResidentChoice[]>()).toEqual([
      {
        kind: "person",
        residencyId: residencyIds.inToday,
        name: `${inToday.firstName} ${inToday.lastName}`,
      },
      {
        kind: "person",
        residencyId: residencyIds.leaving,
        name: `${leaving.firstName} ${leaving.lastName}`,
      },
    ]);
    // Names and residencies, and no person identifier of anybody's.
    for (const entry of [former, leaving, arriving, outToday, inToday]) {
      expect(response.body).not.toContain(entry.personId);
    }
    expect(response.body).not.toContain(former.lastName);
    expect(response.body).not.toContain(arriving.lastName);
    expect(response.body).not.toContain(outToday.lastName);

    // Audited with the apartment and how many, never who.
    expect(await listings(manager, pickerApartmentId)).toEqual([
      {
        targetKind: "apartment",
        targetPersonId: null,
        context: { residents: 2 },
      },
    ]);
  });

  it("masks a protected resident, with neither name nor person identifier", async () => {
    const response = await residentsOf(manager, shieldedApartmentId);
    expect(response.statusCode).toBe(200);
    expect(response.json<ResidentChoice[]>()).toEqual([
      { kind: "protected", residencyId: residencyIds.shielded },
    ]);
    expect(response.body).not.toContain(shielded.personId);
    expect(response.body).not.toContain(shielded.firstName);
    expect(response.body).not.toContain(shielded.lastName);
  });

  it("is no search of the register: the property manager still cannot read the address book", async () => {
    for (const url of [
      `/api/address-book?search=${encodeURIComponent(resident.lastName)}`,
      `/api/address-book/apartments/${apartmentId}`,
    ]) {
      const refused = await inject({
        method: "GET",
        url,
        cookie: cookies[manager.personId],
      });
      expect(refused.statusCode).toBe(403);
    }
  });

  it("gives nothing to a person who does not handle issues, and answers an unknown apartment with nothing it records", async () => {
    for (const url of [
      "/api/issue-queue/apartments",
      `/api/issue-queue/apartments/${apartmentId}/residents`,
    ]) {
      const refused = await inject({
        method: "GET",
        url,
        cookie: cookies[resident.personId],
      });
      expect(refused.statusCode).toBe(403);
    }

    /*
     * The service asks the database on its own, whatever the route let
     * through: a person who handles nothing today is shown no apartment and no
     * resident, and leaves no entry, as a seat that ended or a grant taken
     * back between the guard and the read would.
     */
    const service = app.get(IssueResidentsService);
    expect(await service.apartments(resident.personId)).toEqual([]);
    await expect(
      service.residents(resident.personId, apartmentId),
    ).rejects.toMatchObject({ reason: "apartment-not-found" });
    expect(await listings(resident, apartmentId)).toEqual([]);

    const unknown = await residentsOf(board, `ih-apartment-nowhere-${suffix}`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ reason: string }>().reason).toBe(
      "apartment-not-found",
    );
    expect(await listings(board, `ih-apartment-nowhere-${suffix}`)).toEqual([]);
  });
});

describe("the timeline", () => {
  it("says who did what, when, oldest first, with a protected handler unnamed", async () => {
    const id = await filed(plain, "timeline");
    const cookie = cookies[board.personId] ?? "";
    await act(cookie, id, "assignee", {
      assigneePersonId: shieldedBoard.personId,
    });
    await act(cookie, id, "priority", { priority: "LOW" });
    await inject({
      method: "POST",
      url: `/api/issue-queue/${id}/status`,
      payload: {
        statusId: plain.statusIds.WAITING,
        waitingReason: "PARTS",
      },
      cookie,
    });

    const response = await inject({
      method: "GET",
      url: `/api/issue-queue/${id}/timeline`,
      cookie: cookies[manager.personId],
    });
    expect(response.statusCode).toBe(200);
    const actor = {
      kind: "person",
      personId: board.personId,
      name: `${board.firstName} ${board.lastName}`,
    };
    expect(
      response.json<object[]>().map((step) => ({ ...step, at: undefined })),
    ).toEqual([
      { kind: "reported", at: undefined, actor: null },
      {
        kind: "assigned",
        at: undefined,
        actor,
        assignee: { kind: "protected", personId: shieldedBoard.personId },
        byTypeDefault: false,
      },
      { kind: "priority", at: undefined, actor, from: "NORMAL", to: "LOW" },
      {
        kind: "status",
        at: undefined,
        actor,
        fromMeaning: "NEW",
        toMeaning: "WAITING",
        fromStatusId: plain.statusIds.NEW,
        toStatusId: plain.statusIds.WAITING,
        waitingReason: "PARTS",
        outcome: null,
      },
    ]);
    expect(response.body).not.toContain(shieldedBoard.lastName);
  });
});

describe("the access report of an assignee", () => {
  it("lists the issues and types naming them, and nothing a reporter wrote", async () => {
    const id = await filed(plain, "report");
    await prisma.issue.update({
      where: { id },
      data: { assigneePersonId: admin.personId },
    });
    await prisma.issueType.update({
      where: { id: plain.id },
      data: { defaultAssigneePersonId: admin.personId },
    });
    try {
      const report = await app
        .get(DataSubjectReportService)
        .portable(admin.personId);
      expect(report.issueAssignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "issue",
            issueId: id,
            typeName: `Övrigt ${suffix}`,
            meaning: "NEW",
            closedAt: null,
          }),
          {
            kind: "typeDefault",
            typeId: plain.id,
            typeName: `Övrigt ${suffix}`,
          },
        ]),
      );
      expect(JSON.stringify(report.issueAssignments)).not.toContain(
        "Beskrivning report",
      );
    } finally {
      await prisma.issueType.update({
        where: { id: plain.id },
        data: { defaultAssigneePersonId: null },
      });
    }
  });
});
