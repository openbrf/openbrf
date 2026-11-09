import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  formatDayOfInstant,
  formatLocalDay,
  localDayOf,
} from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  type ActionCaller,
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { markAuthenticated } from "../actions/authenticated-request";
import { LiveResponse } from "../actions/testing/live-response";
import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { MailService } from "../mail/mail.service";
import { PendingChangeService } from "../pending-changes/pending-change.service";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import { issueTextClocks, issueTextRetentionDays } from "./issue-free-text";
import {
  ISSUE_NOTICE_QUEUE,
  IssueMailer,
  type IssueNoticeJob,
} from "./issue-mailer.service";
import { IssueReporterLinkService } from "./issue-reporter-link.service";
import { IssueTextPurgeService } from "./issue-text-purge.service";
import { IssueService } from "./issue.service";

/**
 * The ring-fence (avskärmad ärendetyp, decision 32 of the issue module's plan;
 * ADR 0054, question 5) against a real database: for every role, and for
 * every way something about an issue leaves the board's own screen.
 *
 * - **Who sets it.** The board, under issues:configure, on any type. It hands
 *   the type to the board, so the property manager is unassigned and can no
 *   longer be given it; it is refused on a type the website's form offers; and
 *   it is never lifted from a type with issues.
 * - **The property manager** reads none of it: not the queue, a count, a
 *   type, an issue's conversation, notes, files, timeline or handlers, and is
 *   never assigned one.
 * - **`mcp` and `ai`** are offered none of it: not on any page of
 *   `issue_list`, not by `issue_get`, not as a type of `issue_type_list`, and
 *   `issue_handler_list` and every write answer one as not found, a write
 *   proposed on `ai` included when it is confirmed.
 * - **Mail.** Nothing about one is mailed, to a handler or to its reporter,
 *   and a notice queued before the ring-fence sends nothing.
 * - **Posts and the website's form.** No report under it is made from a post,
 *   and the form offers none.
 * - **The clock.** Its free text is removed on the board's ring-fenced clock,
 *   apart from the other types' clock and never held to it.
 *
 * A contractor is the remaining way out: `work-orders.int-spec.ts` holds that
 * no work order is written, previewed or sent on a ring-fenced issue. A known
 * fault (känt fel) is not built on this branch yet; its change holds it to
 * the same rule.
 */

// Refuses to run without a configured environment, before anything connects.
loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let mail: MailService;
let mailer: IssueMailer;
let issues: IssueService;
let textPurge: IssueTextPurgeService;
let reporterLinks: IssueReporterLinkService;
let registry: ActionRegistryService;
let callers: ActionCallerFactory;
let encryption: FieldEncryptionService;
let changes: PendingChangeService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

function person(key: string, firstName: string, lastName: string) {
  return {
    personId: `rf-${key}-${suffix}`,
    email: `rf-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `${lastName}${suffix}`,
  };
}

const board = person("board", "Bea", "Styrelse");
const admin = person("admin", "Ada", "Admin");
const manager = person("manager", "Frida", "Forvaltare");
const resident = person("resident", "Rune", "Rapportor");
const people = [board, admin, manager, resident];
const personIds = people.map((entry) => entry.personId);

const addressId = `rf-address-${suffix}`;
const apartmentId = `rf-apartment-${suffix}`;
const residencyId = `rf-residency-${suffix}`;

const typeIds: string[] = [];
/** Ring-fenced from the start, as a new instance's Störningar is. */
let fenced: IssueTypeFixture;
/** Open to every handler, for what the ring-fence does not touch. */
let open: IssueTypeFixture;

/** What a reporter wrote, which nothing outside the board may carry. */
const REPORT = `Grannen i 1101 spelar hög musik varje natt ${suffix}`;

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
        // 10.212.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.212.${String(subnet)}.${String(host + 1)}`,
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
const as = (entry: { personId: string }): string =>
  cookies[entry.personId] ?? "";

/** A type of this suite's, removed with it. */
async function addType(
  key: string,
  input: Omit<Parameters<typeof createIssueTypeFixture>[1], "id" | "name">,
): Promise<IssueTypeFixture> {
  const id = `rf-type-${key}-${suffix}`;
  typeIds.push(id);
  return createIssueTypeFixture(prisma, {
    id,
    name: `${key} ${suffix}`,
    ...input,
  });
}

/** Files a report as the resident, through the route a resident uses. */
async function reported(
  type: IssueTypeFixture,
  description: string = REPORT,
): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/issues",
    payload: { typeId: type.id, description },
    cookie: as(resident),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

/**
 * Opens an issue as the board member, for the resident: a handler's own
 * filing spends no reporter's hourly budget for mail, so whatever mail it
 * owes is queued however many reports this suite has filed.
 */
async function opened(type: IssueTypeFixture): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/issue-queue",
    payload: { typeId: type.id, residencyId, description: REPORT },
    cookie: as(board),
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

function setRingFence(
  typeId: string,
  ringFenced: boolean,
  cookie: string = as(board),
) {
  return inject({
    method: "PUT",
    url: `/api/issue-types/${typeId}/ring-fence`,
    payload: { ringFenced },
    cookie,
  });
}

/** The deliveries queued for one issue. */
async function notices(issueId: string): Promise<IssueNoticeJob[]> {
  const rows = await prisma.$queryRawUnsafe<{ data: IssueNoticeJob }[]>(
    "SELECT data FROM pgboss.job WHERE name = $1 AND data->>'issueId' = $2 ORDER BY created_on, id",
    ISSUE_NOTICE_QUEUE,
    issueId,
  );
  return rows.map((row) => row.data);
}

/**
 * The person on a connected app's token, as the request reaches the registry
 * once the authorization guard stands (`issue-actions.int-spec.ts`).
 */
function connectedApp(personId: string): ActionCaller {
  const token = {
    clientId: `client-${suffix}`,
    clientHost: "app.example",
    scopes: ["mcp:read", "mcp:write"],
  };
  const request = {
    id: `request-${suffix}`,
    principal: { personId, capabilities: new Set<string>() },
    token,
  } as unknown as RequestWithToken;
  markAuthenticated(request, new LiveResponse(), {
    personId,
    token,
    requestId: request.id,
  });
  return callers.forRequest(request);
}

/**
 * The AI package's own route, serving the person's session: its dispatch is
 * on `ai`, where a write is only proposed (ADR 0039).
 */
function aiPackage(personId: string): ActionCaller {
  const request = {
    id: `request-ai-package-${suffix}`,
    principal: { personId, capabilities: new Set<string>() },
  } as unknown as RequestWithToken;
  markAuthenticated(request, new LiveResponse(), {
    personId,
    token: null,
    requestId: request.id,
  });
  return callers.forPlugin(request, { id: `rf-ai-${suffix}`, ai: true });
}

/**
 * The registered handler as the AI package reaches it, with its output held
 * to the action's own schema as `invoke()` holds it.
 */
async function overAi<Output>(
  name: string,
  input: Record<string, unknown>,
): Promise<Output> {
  const held = registry.get(name);
  if (held === null) {
    throw new Error(`${name} is not registered`);
  }
  const { definition } = held;
  expect(definition.surfaces).toContain("ai");
  const parsed = await definition.input["~standard"].validate(input);
  if (parsed.issues !== undefined) {
    throw new Error(`${name} refused its input`);
  }
  const output = await definition.handler(parsed.value, {
    principal: { personId: board.personId, capabilities: ["issues:handle"] },
    channel: "ai",
    requestId: `request-ai-${suffix}`,
    now: new Date(),
  });
  const validated = await definition.output["~standard"].validate(output);
  expect(validated.issues).toBeUndefined();
  return output as Output;
}

/** Every page of `issue_list`, as raw text. */
async function wholeQueue(
  read: (input: Record<string, unknown>) => Promise<unknown>,
  filter: Record<string, unknown> = {},
): Promise<string> {
  let text = "";
  let after: string | null = null;
  let pages = 0;
  do {
    const page = (await read({
      ...filter,
      limit: 20,
      ...(after === null ? {} : { after }),
    })) as { nextCursor: string | null };
    text += JSON.stringify(page);
    after = page.nextCursor;
    pages += 1;
  } while (after !== null && pages < 500);
  return text;
}

/** Whether this suite made the association row, and so removes it. */
let createdAssociation = false;
/** The website form's switch as this suite found it, put back afterwards. */
let publicReportingBefore = false;

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
  mail = app.get(MailService);
  mailer = app.get(IssueMailer);
  issues = app.get(IssueService);
  textPurge = app.get(IssueTextPurgeService);
  reporterLinks = app.get(IssueReporterLinkService);
  registry = app.get(ActionRegistryService);
  callers = app.get(ActionCallerFactory);
  encryption = app.get(FieldEncryptionService);
  changes = app.get(PendingChangeService);

  createdAssociation =
    (await prisma.association.findUnique({
      where: { id: 1 },
      select: { id: true },
    })) === null;
  if (createdAssociation) {
    await prisma.association.create({
      data: { id: 1, name: "Brf Eksemplet" },
    });
  }
  publicReportingBefore = (
    await prisma.association.findUniqueOrThrow({
      where: { id: 1 },
      select: { issueReportingPublic: true },
    })
  ).issueReportingPublic;
  await prisma.association.update({
    where: { id: 1 },
    data: { issueReportingPublic: true },
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Avskildgatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  await prisma.apartment.create({
    data: { id: apartmentId, addressId, number: "1101", floor: 1 },
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
      position: "BOARD_MEMBER",
      electedOn: new Date("2025-05-15"),
    },
  });
  await prisma.systemRole.createMany({
    data: [
      { personId: admin.personId, role: "ADMIN" },
      { personId: manager.personId, role: "PROPERTY_MANAGER" },
    ],
  });
  await prisma.residency.create({
    data: {
      id: residencyId,
      personId: resident.personId,
      apartmentId,
      role: "MEMBER",
      movedInOn: new Date("2024-01-01"),
    },
  });

  fenced = await addType("storningar", {
    reporters: ["RESIDENTS"],
    handledBy: "BOARD",
    ringFenced: true,
  });
  open = await addType("hiss", { reporters: ["RESIDENTS"] });

  for (const entry of people) {
    cookies[entry.personId] = await signIn(entry.email);
  }
}, 180_000);

afterAll(async () => {
  vi.restoreAllMocks();
  const filed = await prisma.issue.findMany({
    where: { typeId: { in: typeIds } },
    select: { id: true },
  });
  await prisma.$executeRawUnsafe(
    "DELETE FROM pgboss.job WHERE data->>'issueId' = ANY($1::text[])",
    filed.map((issue) => issue.id),
  );
  // A change proposed on ai for a ring-fenced issue, which confirming refused
  // and so is still waiting.
  await prisma.pendingChange.deleteMany({
    where: { proposedByPersonId: { in: personIds } },
  });
  await prisma.issue.deleteMany({ where: { typeId: { in: typeIds } } });
  await prisma.issueType.deleteMany({ where: { id: { in: typeIds } } });
  await prisma.residency.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.apartment.deleteMany({ where: { id: apartmentId } });
  await prisma.address.deleteMany({ where: { id: addressId } });
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
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  if (createdAssociation) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  } else {
    await prisma.association.update({
      where: { id: 1 },
      data: { issueReportingPublic: publicReportingBefore },
    });
  }
  await app.close();
});

describe("setting the ring-fence", () => {
  it("is the board's, on any type, and hands the type to the board", async () => {
    const type = await addType("grannar", {
      reporters: ["RESIDENTS"],
      defaultAssigneePersonId: manager.personId,
    });
    const issueId = await reported(type);
    await prisma.issue.update({
      where: { id: issueId },
      data: { assigneePersonId: manager.personId },
    });

    // The property manager configures nothing, and a resident less.
    for (const entry of [manager, resident]) {
      expect((await setRingFence(type.id, true, as(entry))).statusCode).toBe(
        403,
      );
    }

    const set = await setRingFence(type.id, true);
    expect(set.statusCode).toBe(200);
    expect(
      set.json<{
        ringFenced: boolean;
        handledBy: string;
        defaultAssignee: unknown;
      }>(),
    ).toMatchObject({
      ringFenced: true,
      handledBy: "BOARD",
      defaultAssignee: null,
    });
    // The property manager no longer holds the issue, and the board member
    // who ring-fenced the type is named on the entry that says so.
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { assigneePersonId: true },
      }),
    ).toEqual({ assigneePersonId: null });
    expect(
      await prisma.auditLogEntry.findMany({
        where: { targetKind: "issue", targetId: issueId },
        select: { action: true, actorPersonId: true, context: true },
      }),
    ).toContainEqual({
      action: "ISSUE_ASSIGNED",
      actorPersonId: board.personId,
      context: { previousAssigneePersonId: manager.personId },
    });
    // The entry for the fence itself says what else it changed: the handling
    // the type moved from, and that the default assignee was cleared, without
    // saying who it was.
    const fenceEntries = await prisma.auditLogEntry.findMany({
      where: {
        action: "ISSUE_TYPE_RING_FENCE_CHANGED",
        targetKind: "issueType",
        targetId: type.id,
      },
      select: { actorPersonId: true, context: true },
    });
    expect(fenceEntries).toEqual([
      {
        actorPersonId: board.personId,
        context: {
          ringFenced: true,
          handledBy: { before: "EVERY_HANDLER", after: "BOARD" },
          defaultAssignee: true,
        },
      },
    ]);
    expect(JSON.stringify(fenceEntries)).not.toContain(manager.personId);

    // An administrator without a seat configures too (ADR 0054, question 4).
    const other = await addType("trapphus", { reporters: ["RESIDENTS"] });
    expect((await setRingFence(other.id, true, as(admin))).statusCode).toBe(
      200,
    );
  });

  it("keeps a ring-fenced type with the board and off the website's form", async () => {
    const offered = await addType("utemiljo", {
      reporters: ["PUBLIC", "RESIDENTS"],
    });
    const refused = await setRingFence(offered.id, true);
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ reason: string }>().reason).toBe(
      "ring-fenced-public",
    );

    const change = (values: object) =>
      inject({
        method: "PUT",
        url: `/api/issue-types/${fenced.id}`,
        payload: { name: `storningar ${suffix}`, ...values },
        cookie: as(board),
      });
    const opened = await change({
      reporters: ["RESIDENTS"],
      handledBy: "EVERY_HANDLER",
    });
    expect(opened.statusCode).toBe(422);
    expect(opened.json<{ reason: string }>().reason).toBe(
      "ring-fenced-board-only",
    );
    const published = await change({ reporters: ["PUBLIC", "RESIDENTS"] });
    expect(published.statusCode).toBe(422);
    expect(published.json<{ reason: string }>().reason).toBe(
      "ring-fenced-public",
    );

    // The database holds both, for a write that went round the service.
    await expect(
      prisma.issueType.update({
        where: { id: fenced.id },
        data: { handledBy: "EVERY_HANDLER" },
      }),
    ).rejects.toThrow(/issue_type_ring_fenced_board_only/);
    await expect(
      prisma.issueType.update({
        where: { id: fenced.id },
        data: { reporters: ["PUBLIC", "RESIDENTS"] },
      }),
    ).rejects.toThrow(/issue_type_ring_fenced_not_public/);
  });

  it("is lifted only from a type nobody has reported under", async () => {
    const unused = await addType("tom", {
      reporters: ["RESIDENTS"],
      handledBy: "BOARD",
      ringFenced: true,
    });
    expect((await setRingFence(unused.id, false)).statusCode).toBe(200);

    const used = await addType("anvand", {
      reporters: ["RESIDENTS"],
      handledBy: "BOARD",
      ringFenced: true,
    });
    await reported(used);
    const lifted = await setRingFence(used.id, false);
    expect(lifted.statusCode).toBe(409);
    expect(lifted.json<{ reason: string }>().reason).toBe("ring-fence-in-use");
    expect(
      await prisma.issueType.findUniqueOrThrow({
        where: { id: used.id },
        select: { ringFenced: true },
      }),
    ).toEqual({ ringFenced: true });
  });
});

describe("the property manager", () => {
  it("reads nothing of a ring-fenced issue, and is never given one", async () => {
    const issueId = await reported(fenced);
    const ordinary = await reported(open, `Hissen står still ${suffix}`);

    // The board reads it, an administrator without a seat too.
    for (const entry of [board, admin]) {
      const queue = await inject({
        method: "GET",
        url: "/api/issue-queue",
        cookie: as(entry),
      });
      expect(queue.statusCode).toBe(200);
      expect(queue.body).toContain(issueId);
    }

    const reads = [
      "/api/issue-queue",
      "/api/issue-queue/snapshot",
      "/api/issue-queue/counts",
      "/api/issue-queue/types",
      `/api/issue-queue/${issueId}/messages`,
      `/api/issue-queue/${issueId}/notes`,
      `/api/issue-queue/${issueId}/attachments`,
      `/api/issue-queue/${issueId}/timeline`,
      `/api/issue-queue/${issueId}/handlers`,
      `/api/issue-queue/${issueId}/work-orders`,
    ];
    for (const url of reads) {
      const response = await inject({
        method: "GET",
        url,
        cookie: as(manager),
      });
      expect(response.body, url).not.toContain(issueId);
      expect(response.body, url).not.toContain(fenced.id);
      expect(response.body, url).not.toContain(REPORT);
      if (url.includes(issueId)) {
        expect(response.statusCode, url).toBe(404);
      }
    }
    // What the ring-fence does not touch, the property manager still reads.
    const queue = await inject({
      method: "GET",
      url: "/api/issue-queue",
      cookie: as(manager),
    });
    expect(queue.body).toContain(ordinary);

    const writes: [string, object][] = [
      ["status", { statusId: fenced.statusIds.IN_PROGRESS }],
      ["priority", { priority: "LOW" }],
      ["target-date", { targetDate: null }],
      ["assignee", { assigneePersonId: manager.personId }],
      ["cost-responsibility", { costResponsibility: "ASSOCIATION" }],
      ["notes", { body: "Ringer grannen." }],
      ["legal-hold", { held: true }],
    ];
    for (const [route, payload] of writes) {
      const response = await inject({
        method: "POST",
        url: `/api/issue-queue/${issueId}/${route}`,
        payload,
        cookie: as(manager),
      });
      expect(response.statusCode, route).toBe(404);
    }

    // The board cannot give it to them either.
    const given = await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/assignee`,
      payload: { assigneePersonId: manager.personId },
      cookie: as(board),
    });
    expect(given.statusCode).toBe(422);
    expect(given.json<{ reason: string }>().reason).toBe(
      "assignee-not-a-handler",
    );
    const handlers = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/handlers`,
      cookie: as(board),
    });
    expect(handlers.body).not.toContain(manager.personId);
  });
});

describe("mcp and ai", () => {
  it("are offered no ring-fenced issue and no ring-fenced type", async () => {
    const issueId = await reported(fenced);
    const ordinary = await reported(open, `Lampan i entrén ${suffix}`);

    const overMcp = (input: Record<string, unknown>) =>
      registry.invoke(connectedApp(board.personId), "issue_list", input);
    const overAiList = (input: Record<string, unknown>) =>
      overAi("issue_list", input);

    for (const read of [overMcp, overAiList]) {
      const whole = await wholeQueue(read);
      expect(whole).not.toContain(issueId);
      expect(whole).not.toContain(REPORT);
      expect(whole).toContain(ordinary);
      // Naming the type answers as a type with no issues.
      expect(await wholeQueue(read, { typeId: fenced.id })).not.toContain(
        issueId,
      );
    }

    // By its identifier, it is an issue that does not exist.
    await expect(
      registry.invoke(connectedApp(board.personId), "issue_get", {
        id: issueId,
      }),
    ).rejects.toMatchObject({ reason: "issue-not-found" });
    await expect(overAi("issue_get", { id: issueId })).rejects.toMatchObject({
      reason: "issue-not-found",
    });
    expect(
      (
        await registry.invoke<{ id: string }>(
          connectedApp(board.personId),
          "issue_get",
          { id: ordinary },
        )
      ).id,
    ).toBe(ordinary);

    // The type itself is left out (ADR 0056).
    for (const types of [
      await registry.invoke<{ types: { id: string }[] }>(
        connectedApp(board.personId),
        "issue_type_list",
        {},
      ),
      await overAi<{ types: { id: string }[] }>("issue_type_list", {}),
    ]) {
      const ids = types.types.map((type) => type.id);
      expect(ids).not.toContain(fenced.id);
      expect(ids).toContain(open.id);
    }
  });

  /** What the issue's handling holds, which no refused write may move. */
  async function handling(issueId: string) {
    return prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: {
        assigneePersonId: true,
        priority: true,
        targetDate: true,
        statusId: true,
      },
    });
  }

  /** Each write of ADR 0056 on one issue, by its own type's statuses. */
  function everyWrite(issueId: string, type: IssueTypeFixture) {
    return [
      ["issue_assign", { id: issueId, assigneePersonId: board.personId }],
      ["issue_set_priority", { id: issueId, priority: "URGENT" }],
      ["issue_set_target_date", { id: issueId, targetDate: "2031-05-30" }],
      [
        "issue_set_status",
        { id: issueId, statusId: type.statusIds.IN_PROGRESS },
      ],
    ] as const;
  }

  it("answer a ring-fenced issue as not found to every write and to the list of who may take it", async () => {
    const issueId = await reported(fenced);
    const ordinary = await reported(open, `Fläkten låter ${suffix}`);
    const before = await handling(issueId);

    for (const [name, input] of [
      ["issue_handler_list", { id: issueId }],
      ...everyWrite(issueId, fenced),
    ] as const) {
      // Answered as an identifier that never existed, with the same words.
      const fencedRefusal = await registry
        .invoke(connectedApp(board.personId), name, input)
        .catch((cause: unknown) => cause);
      const missing = await registry
        .invoke(connectedApp(board.personId), name, {
          ...input,
          id: `rf-never-${suffix}`,
        })
        .catch((cause: unknown) => cause);
      expect(fencedRefusal, name).toMatchObject({ reason: "issue-not-found" });
      expect((fencedRefusal as Error).message, name).toBe(
        (missing as Error).message,
      );
    }
    expect(await handling(issueId)).toEqual(before);
    // Nothing was recorded against it.
    expect(
      await prisma.auditLogEntry.count({
        where: { targetKind: "issue", targetId: issueId, channel: "MCP" },
      }),
    ).toBe(0);

    // The control: the same writes land on an ordinary issue, as the person
    // who connected the app and under the channel they came by.
    expect(
      (
        await registry.invoke<{ handlers: { personId?: string }[] }>(
          connectedApp(board.personId),
          "issue_handler_list",
          { id: ordinary },
        )
      ).handlers.map((handler) => handler.personId),
    ).toContain(board.personId);
    for (const [name, input] of everyWrite(ordinary, open)) {
      await registry.invoke(connectedApp(board.personId), name, input);
    }
    expect(await handling(ordinary)).toEqual({
      assigneePersonId: board.personId,
      priority: "URGENT",
      targetDate: new Date("2031-05-30T00:00:00.000Z"),
      statusId: open.statusIds.IN_PROGRESS,
    });
    const entries = await prisma.auditLogEntry.findMany({
      where: { targetKind: "issue", targetId: ordinary, channel: "MCP" },
      select: { action: true, actorPersonId: true },
    });
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      "ISSUE_ASSIGNED",
      "ISSUE_PRIORITY_CHANGED",
      "ISSUE_STATUS_CHANGED",
      "ISSUE_TARGET_DATE_CHANGED",
    ]);
    for (const entry of entries) {
      expect(entry.actorPersonId, entry.action).toBe(board.personId);
    }
  });

  it("show a write proposed on ai for a ring-fenced issue as gone, and refuse to confirm it", async () => {
    const issueId = await reported(fenced);
    const before = await handling(issueId);

    // On ai a write is never carried out directly.
    await expect(
      registry.invoke(aiPackage(board.personId), "issue_set_priority", {
        id: issueId,
        priority: "LOW",
      }),
    ).rejects.toMatchObject({ reason: "confirmation-required" });

    // Proposed, it waits: nothing about the issue is read to hold it.
    const proposed = await changes.propose(
      aiPackage(board.personId),
      "issue_set_priority",
      { id: issueId, priority: "LOW" },
    );
    expect(
      await registry.targetOf(
        "issue_set_priority",
        { id: issueId, priority: "LOW" },
        board.personId,
      ),
    ).toEqual({ kind: "issue", id: issueId, state: "missing", facts: [] });

    const confirmed = await inject({
      method: "POST",
      url: `/api/pending-changes/mine/${proposed.id}/confirm`,
      cookie: as(board),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(404);
    expect(confirmed.json<{ reason: string }>().reason).toBe("issue-not-found");
    expect(await handling(issueId)).toEqual(before);
  });
});

describe("mail", () => {
  /** Everything that queues a mail on an issue, as the board and the resident do it. */
  async function everyMailedAct(issueId: string): Promise<void> {
    const acts: [string, object][] = [
      ["assignee", { assigneePersonId: admin.personId }],
      ["priority", { priority: "NORMAL" }],
      ["priority", { priority: "URGENT" }],
      [
        "target-date",
        {
          targetDate: formatLocalDay(
            localDayOf(new Date(Date.now() - 3 * 86_400_000)),
          ),
        },
      ],
      ["messages", { body: "Vi har pratat med grannen." }],
    ];
    for (const [route, payload] of acts) {
      const response = await inject({
        method: "POST",
        url: `/api/issue-queue/${issueId}/${route}`,
        payload,
        cookie: as(board),
      });
      expect(response.statusCode, `${route}: ${response.body}`).toBeLessThan(
        300,
      );
    }
    const reply = await inject({
      method: "POST",
      url: `/api/issues/${issueId}/messages`,
      payload: { body: "Det fortsätter." },
      cookie: as(resident),
    });
    expect(reply.statusCode, reply.body).toBeLessThan(300);
  }

  it("tells nobody of a ring-fenced issue, whatever happens on it", async () => {
    const send = vi.spyOn(mail, "send");
    try {
      // The same type twice, one of them ring-fenced: what the open one is
      // mailed about is what the fenced one would be without its fence.
      const twin = {
        reporters: ["RESIDENTS"] as const,
        handledBy: "BOARD" as const,
        defaultPriority: "URGENT" as const,
      };
      const control = await opened(await addType("akut-oppen", twin));
      const issueId = await opened(
        await addType("akut", { ...twin, ringFenced: true }),
      );

      await everyMailedAct(control);
      await everyMailedAct(issueId);

      // Akut to every handler, the assignment, the raise to Akut, the reply
      // each way: the control was told of them.
      const told = new Set((await notices(control)).map((job) => job.event));
      expect(told).toEqual(
        new Set(["urgent", "assigned", "message", "reporterMessage"]),
      );
      expect(await notices(issueId)).toEqual([]);

      // The overdue reminder for the date that has passed is owed to nobody.
      const { targetDate } = await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { targetDate: true },
      });
      expect(targetDate).not.toBeNull();
      expect(
        await mailer.remindOverdue({
          issueId,
          targetDate: formatLocalDay(localDayOf(targetDate ?? new Date())),
        }),
      ).toBe(false);
      expect(await notices(issueId)).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  it("sends nothing queued before the board ring-fenced the type", async () => {
    const send = vi.spyOn(mail, "send");
    try {
      const type = await addType("forst-oppen", { reporters: ["RESIDENTS"] });
      const issueId = await opened(type);
      const queued = await notices(issueId);
      // Unassigned, so its other handlers were to be told.
      expect(queued.length).toBeGreaterThan(0);

      expect((await setRingFence(type.id, true)).statusCode).toBe(200);
      for (const job of queued) {
        expect(await mailer.deliver(job)).toBe(false);
      }
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  it("makes the board's ring-fence wait for a mail that is being handed over", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let handedOver: () => void = () => undefined;
    const atHandoff = new Promise<void>((resolve) => {
      handedOver = resolve;
    });
    const send = vi.spyOn(mail, "send").mockImplementation(async () => {
      handedOver();
      await held;
      return {} as never;
    });
    try {
      const type = await addType("under-sandning", {
        reporters: ["RESIDENTS"],
      });
      const issueId = await opened(type);
      const [job] = await notices(issueId);
      if (job === undefined) {
        throw new Error("The issue queued no notice.");
      }

      const delivery = mailer.deliver(job);
      await atHandoff;
      let fenced = false;
      const fencing = setRingFence(type.id, true).then((response) => {
        fenced = true;
        return response;
      });
      // The mail server has the message and has not answered: the change
      // waits, and the mail was decided before it. Seen queued on the
      // ring-fence's key, which a delay could not tell from a slow change.
      await waitFor(
        async () =>
          (await advisoryLockCount(
            prisma,
            `issue-type-ring-fence:${type.id}`,
            false,
          )) > 0n,
        10_000,
      );
      expect(fenced).toBe(false);
      // It waits without the type's lock, so a report filed under the type
      // meanwhile does not queue behind the mail server. Bounded, so a filing
      // that does fails here rather than at the suite's time limit with the
      // send still held.
      const filing = opened(type);
      filing.catch(() => undefined);
      const filed = await Promise.race([
        filing.then(() => "filed" as const),
        new Promise<"waiting">((resolve) =>
          setTimeout(() => resolve("waiting"), 10_000),
        ),
      ]);
      expect(filed).toBe("filed");
      expect(fenced).toBe(false);

      // Under a deadline the send is ended at before the transaction's limit
      // can end the transaction and let the ring-fence go (MAIL_HANDOFF_MS).
      const signal = send.mock.calls[0]?.[0].signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      release();
      expect(await delivery).toBe(true);
      expect((await fencing).statusCode).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      release();
      send.mockRestore();
    }
  });

  it("mails a private link under a deadline that ends before the locks can go", async () => {
    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });
    try {
      const type = await addType("webb-frist", { reporters: ["PUBLIC"] });
      const { id: issueId } = await issues.reportPublicly({
        typeId: type.id,
        description: REPORT,
        reporterName: "Vera Frist",
        reporterEmail: `rf-frist-${suffix}@exempel.se`,
      });

      expect(await reporterLinks.deliver(issueId)).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      const signal = send.mock.calls[0]?.[0].signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    } finally {
      send.mockRestore();
    }
  });

  it("does not mail a private link to a website reporter once the type is ring-fenced", async () => {
    const send = vi.spyOn(mail, "send");
    try {
      const type = await addType("webb", { reporters: ["PUBLIC"] });
      const { id: issueId } = await issues.reportPublicly({
        typeId: type.id,
        description: REPORT,
        reporterName: "Vera Webb",
        reporterEmail: `rf-web-${suffix}@exempel.se`,
      });
      // The board takes the type off the form and ring-fences it before the
      // link goes out.
      await prisma.issueType.update({
        where: { id: type.id },
        data: { reporters: ["RESIDENTS"] },
      });
      expect((await setRingFence(type.id, true)).statusCode).toBe(200);

      expect(await reporterLinks.deliver(issueId)).toBe(false);
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
  });

  it("gives back the slot of a link a failed attempt left when the retry finds the type ring-fenced", async () => {
    const send = vi
      .spyOn(mail, "send")
      .mockRejectedValue(new Error("mail server unavailable"));
    try {
      const type = await addType("webb-retry", { reporters: ["PUBLIC"] });
      const { id: issueId } = await issues.reportPublicly({
        typeId: type.id,
        description: REPORT,
        reporterName: "Vera Retry",
        reporterEmail: `rf-retry-${suffix}@exempel.se`,
      });
      // The first attempt issues a link and fails to mail it: the link is
      // kept for the retry and counts toward the address's three a day.
      await expect(reporterLinks.deliver(issueId)).rejects.toThrow();
      expect(
        await prisma.issueReporterLink.count({
          where: { issueId, mailedAt: null },
        }),
      ).toBe(1);

      await prisma.issueType.update({
        where: { id: type.id },
        data: { reporters: ["RESIDENTS"] },
      });
      expect((await setRingFence(type.id, true)).statusCode).toBe(200);
      send.mockClear();

      expect(await reporterLinks.deliver(issueId)).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(await prisma.issueReporterLink.count({ where: { issueId } })).toBe(
        0,
      );
    } finally {
      send.mockRestore();
    }
  });
});

describe("posts and the website's form", () => {
  it("files no ring-fenced report from a post, and the form offers none", async () => {
    const before = await prisma.issue.count({ where: { typeId: fenced.id } });
    const fromPost = await inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        typeId: fenced.id,
        description: REPORT,
        postId: `rf-post-${suffix}`,
      },
      cookie: as(resident),
    });
    expect(fromPost.statusCode).toBe(422);
    expect(fromPost.json<{ reason: string }>().reason).toBe("ring-fenced-post");
    // Taken back with the refusal: no report was filed.
    expect(await prisma.issue.count({ where: { typeId: fenced.id } })).toBe(
      before,
    );

    // The resident's own form offers it, marked, so it can carry its warning.
    const offered = await inject({
      method: "GET",
      url: "/api/issues/types",
      cookie: as(resident),
    });
    expect(
      offered
        .json<{ id: string; ringFenced: boolean }[]>()
        .find((type) => type.id === fenced.id),
    ).toMatchObject({ ringFenced: true });
    const ordinary = offered
      .json<{ id: string; ringFenced: boolean }[]>()
      .find((type) => type.id === open.id);
    expect(ordinary).toMatchObject({ ringFenced: false });

    // The website's form offers none, and is refused one by its identifier.
    await expect(
      issues.reportPublicly({ typeId: fenced.id, description: REPORT }),
    ).rejects.toMatchObject({ reason: "type-not-found" });
  });
});

describe("merging duplicates", () => {
  it("merges no issue across the ring-fence, and two inside it", async () => {
    const fencedIssue = await opened(fenced);
    const ordinaryIssue = await opened(open);
    const merge = (issueId: string, intoIssueId: string) =>
      inject({
        method: "POST",
        url: `/api/issue-queue/${issueId}/merge`,
        payload: { intoIssueId },
        cookie: as(board),
      });

    // A duplicate's reporter follows the issue it was merged into, and is
    // told how it stands: neither way across the ring-fence.
    for (const [from, into] of [
      [fencedIssue, ordinaryIssue],
      [ordinaryIssue, fencedIssue],
    ] as const) {
      const refused = await merge(from, into);
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ reason: string }>().reason).toBe(
        "merge-ring-fenced",
      );
      expect(
        await prisma.issue.findUniqueOrThrow({
          where: { id: from },
          select: { mergedIntoIssueId: true, outcome: true },
        }),
      ).toEqual({ mergedIntoIssueId: null, outcome: null });
    }

    // Inside the ring-fence the board merges as it does elsewhere.
    const alsoFenced = await opened(fenced);
    const merged = await merge(alsoFenced, fencedIssue);
    expect(merged.statusCode, merged.body).toBe(201);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: alsoFenced },
        select: { mergedIntoIssueId: true },
      }),
    ).toEqual({ mergedIntoIssueId: fencedIssue });
  });
});

describe("the clock", () => {
  it("removes the free text on the board's ring-fenced clock, apart from the other types' clock", async () => {
    const now = new Date();
    const closedAgo = (days: number) =>
      new Date(now.getTime() - days * 86_400_000);
    const due = issueTextRetentionDays(1);
    const close = async (issueId: string, type: IssueTypeFixture, at: Date) =>
      prisma.issue.update({
        where: { id: issueId },
        data: {
          statusId: type.statusIds.DONE,
          outcome: "FIXED",
          closedAt: at,
        },
      });

    const pastYear = await reported(fenced);
    await close(pastYear, fenced, closedAgo(due + 2));
    const withinYear = await reported(fenced);
    await close(withinYear, fenced, closedAgo(due - 30));
    const held = await reported(fenced);
    await close(held, fenced, closedAgo(due + 2));
    await prisma.issue.update({
      where: { id: held },
      data: { legalHoldAt: closedAgo(due) },
    });
    const ordinary = await reported(open, `Dörren går trögt ${suffix}`);
    await close(ordinary, open, closedAgo(due + 2));

    // The longest clock for the other types, ten years, and one year for a
    // ring-fenced type: a ring-fenced issue keeps to its own clock, and an
    // ordinary one to the other.
    const oneYear = { years: 10, ringFencedYears: 1 };
    expect(await textPurge.purgeIssue(pastYear, now, oneYear)).toBe("removed");
    expect(await textPurge.purgeIssue(withinYear, now, oneYear)).toBe("kept");
    expect(await textPurge.purgeIssue(held, now, oneYear)).toBe("kept");
    expect(await textPurge.purgeIssue(ordinary, now, oneYear)).toBe("kept");

    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: pastYear },
        select: { description: true, freeTextRemovedAt: true },
      }),
    ).toEqual({ description: "", freeTextRemovedAt: now });
    for (const kept of [withinYear, held, ordinary]) {
      expect(
        (
          await prisma.issue.findUniqueOrThrow({
            where: { id: kept },
            select: { description: true },
          })
        ).description,
      ).not.toBe("");
    }
    // The entry names the clock the removal was judged by.
    expect(
      await prisma.auditLogEntry.findFirstOrThrow({
        where: {
          action: "SERVICE_DATA_PURGED",
          targetKind: "issue",
          targetId: pastYear,
        },
        select: { context: true },
      }),
    ).toMatchObject({
      context: {
        layer: "freeText",
        retentionYearsAfterClosing: 1,
        ringFenced: true,
      },
    });

    // The nightly scan finds it by the same rule.
    const eligible = new Set(
      (await textPurge.eligiblePage(now, oneYear, undefined, 10_000)).map(
        (issue) => issue.id,
      ),
    );
    expect(eligible.has(withinYear)).toBe(false);
    expect(eligible.has(held)).toBe(false);
    expect(eligible.has(ordinary)).toBe(false);
  });

  it("dates the free text in its reporter's access report on the board's ring-fenced clock", async () => {
    const closedAt = new Date("2026-03-10T10:00:00.000Z");
    const issueId = await reported(fenced);
    await prisma.issue.update({
      where: { id: issueId },
      data: { statusId: fenced.statusIds.DONE, outcome: "FIXED", closedAt },
    });
    // The settings are the association's singleton, which the retention suite
    // changes while it runs: read on either side of the report, so the date
    // the report states is the one for the setting it read.
    const before = await issueTextClocks(prisma);
    const report = await app
      .get(DataSubjectReportService)
      .portable(resident.personId);
    const after = await issueTextClocks(prisma);
    const on = (years: number) =>
      formatDayOfInstant(
        new Date(
          closedAt.getTime() + issueTextRetentionDays(years) * 86_400_000,
        ),
      );

    const dated = report.issues.find((entry) => entry.issueId === issueId);
    expect(dated?.onLegalHold).toBe(false);
    expect([on(before.ringFencedYears), on(after.ringFencedYears)]).toContain(
      dated?.freeTextErasableFrom,
    );
  });

  it("keeps a ring-fenced issue's text past the other types' clock when the board's ring-fenced clock is longer", async () => {
    const now = new Date();
    const closedAgo = (days: number) =>
      new Date(now.getTime() - days * 86_400_000);
    const pastTwoYears = issueTextRetentionDays(2) + 2;
    const close = async (issueId: string, type: IssueTypeFixture) =>
      prisma.issue.update({
        where: { id: issueId },
        data: {
          statusId: type.statusIds.DONE,
          outcome: "FIXED",
          closedAt: closedAgo(pastTwoYears),
        },
      });
    const fencedIssue = await opened(fenced);
    await close(fencedIssue, fenced);
    const ordinary = await opened(open);
    await close(ordinary, open);

    // Two years for the other types, five for a ring-fenced one: the two
    // clocks are set apart, and neither is held to the shorter of them.
    const longer = { years: 2, ringFencedYears: 5 };
    const eligible = new Set(
      (await textPurge.eligiblePage(now, longer, undefined, 10_000)).map(
        (issue) => issue.id,
      ),
    );
    expect(eligible.has(fencedIssue)).toBe(false);
    expect(eligible.has(ordinary)).toBe(true);
    expect(await textPurge.purgeIssue(fencedIssue, now, longer)).toBe("kept");
    expect(await textPurge.purgeIssue(ordinary, now, longer)).toBe("removed");
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: fencedIssue },
          select: { description: true },
        })
      ).description,
    ).not.toBe("");
  });
});
