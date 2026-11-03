import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
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
const resident = person("resident", "Rune", "Boende");
/** A resident with protected personal data, as a reporter. */
const shielded = person("shielded", "Sara", "Skyddad");
/** A board member with protected personal data, as a handler. */
const shieldedBoard = person("shielded-board", "Sven", "Skyddad");
const people = [board, admin, manager, resident, shielded, shieldedBoard];
const personIds = people.map((entry) => entry.personId);

const addressId = `ih-address-${suffix}`;
const apartmentId = `ih-apartment-${suffix}`;
const shieldedApartmentId = `ih-apartment-shielded-${suffix}`;

const typeIds = {
  routed: `ih-type-routed-${suffix}`,
  plain: `ih-type-plain-${suffix}`,
  boardOnly: `ih-type-board-${suffix}`,
  turning: `ih-type-turning-${suffix}`,
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
    ],
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: resident.personId,
        apartmentId,
        role: "MEMBER" as const,
        movedInOn: new Date("2024-01-01"),
      },
      {
        personId: shielded.personId,
        apartmentId: shieldedApartmentId,
        role: "MEMBER" as const,
        movedInOn: new Date("2024-01-01"),
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

  for (const entry of [board, admin, manager, resident, shielded]) {
    cookies[entry.personId] = await signIn(entry.email);
  }
}, 180_000);

afterAll(async () => {
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
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.apartment.deleteMany({
    where: { id: { in: [apartmentId, shieldedApartmentId] } },
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
        // A protected handler can be chosen, by identifier, and is named to
        // nobody.
        { kind: "protected", personId: shieldedBoard.personId },
      ]),
    );
    expect(handlers).toHaveLength(4);
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

describe("issues a handler opens", () => {
  it("opens one for a named resident, who is then its reporter, with the handler shown and recorded", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: {
        typeId: plain.id,
        reporterPersonId: resident.personId,
        apartmentId,
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
        reporterPersonId: shielded.personId,
        apartmentId: shieldedApartmentId,
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

  it("lets the property manager open an internal issue and never name a resident", async () => {
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

    for (const payload of [
      { reporterPersonId: resident.personId },
      { reporterPersonId: resident.personId, apartmentId },
    ]) {
      const refused = await inject({
        method: "POST",
        url: "/api/issue-queue",
        payload: { typeId: plain.id, description: "Namngiven", ...payload },
        cookie: cookies[manager.personId],
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json<{ reason: string }>().reason).toBe(
        "reporter-not-nameable",
      );
    }
    // Nor under a type the board keeps to itself.
    const kept = await inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: { typeId: boardOnly.id, description: "Försäkring" },
      cookie: cookies[manager.personId],
    });
    expect(kept.statusCode).toBe(404);
  });

  it("refuses an apartment that is not the named resident's, and a person who does not live here", async () => {
    const apartment = await inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: {
        typeId: plain.id,
        reporterPersonId: resident.personId,
        apartmentId: shieldedApartmentId,
        description: "Fel lägenhet",
      },
      cookie: cookies[board.personId],
    });
    expect(apartment.json<{ reason: string }>().reason).toBe(
      "apartment-not-found",
    );
    const stranger = await inject({
      method: "POST",
      url: "/api/issue-queue",
      payload: {
        typeId: plain.id,
        reporterPersonId: manager.personId,
        description: "Bor inte här",
      },
      cookie: cookies[board.personId],
    });
    expect(stranger.json<{ reason: string }>().reason).toBe(
      "resident-not-found",
    );
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
