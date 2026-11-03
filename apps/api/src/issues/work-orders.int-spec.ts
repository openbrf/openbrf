import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { MailService } from "../mail/mail.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { WorkOrderMailerService } from "./work-order-mailer.service";

/**
 * Work orders over HTTP, against a real database (decision 23 of the issue
 * module's plan): the contractor register, the preview, the stored record of
 * whom a work order went to, when and what it said, and the mail that follows
 * the commit.
 *
 * The rules that matter are what leaves and what does not: the mail carries
 * the handler's text and never the report or the reporter, nothing about a
 * ring-fenced issue reaches a contractor, and a handler reaches the work orders
 * of the issues they handle and of no other. The contractor's own link stays
 * switched off throughout, so this is the path a release ships with.
 */

// Refuses to run without a configured environment, before anything connects.
loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let mail: MailService;
let mailer: WorkOrderMailerService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

function person(key: string, firstName: string, lastName: string) {
  return {
    personId: `wo-${key}-${suffix}`,
    email: `wo-${key}-${suffix}@exempel.se`,
    firstName,
    lastName: `${lastName}${suffix}`,
  };
}

const board = person("board", "Bea", "Styrelse");
const manager = person("manager", "Frida", "Forvaltare");
const resident = person("resident", "Rune", "Rapportor");
const people = [board, manager, resident];
const personIds = people.map((entry) => entry.personId);

const typeIds = {
  plain: `wo-type-plain-${suffix}`,
  boardOnly: `wo-type-board-${suffix}`,
  ringFenced: `wo-type-ring-${suffix}`,
};
let plain: IssueTypeFixture;
let boardOnly: IssueTypeFixture;
let ringFenced: IssueTypeFixture;

/** What a reporter wrote, which no work order may carry. */
const REPORT = `Det läcker under diskbänken hos grannen ${suffix}`;

const contractorIds: string[] = [];

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
        // 10.181.0.0/16 is this suite's; the others each hold their own.
        "x-forwarded-for": `10.181.${String(subnet)}.${String(host + 1)}`,
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

interface ContractorRow {
  id: string;
  name: string;
  trade: string;
  phone: string | null;
  email: string | null;
  active: boolean;
  workOrderCount: number;
}

interface WorkOrderRow {
  id: string;
  contractorId: string | null;
  recipientName: string;
  recipientEmail: string;
  body: string;
  sentBy: { kind: string; personId?: string } | null;
  deliveryStatus: string;
  deliveryFailure: string | null;
}

async function addContractor(payload: {
  name: string;
  trade: string;
  phone?: string | null;
  email?: string | null;
  active?: boolean;
}): Promise<ContractorRow> {
  const response = await inject({
    method: "POST",
    url: "/api/contractors",
    payload,
    cookie: as(board),
  });
  expect(response.statusCode).toBe(201);
  const row = response.json<ContractorRow>();
  contractorIds.push(row.id);
  return row;
}

/** An issue a resident filed, written directly, as the queue would hold it. */
async function filed(type: IssueTypeFixture, key: string): Promise<string> {
  const id = `wo-issue-${key}-${suffix}`;
  await prisma.issue.create({
    data: {
      id,
      typeId: type.id,
      statusId: type.statusIds.NEW,
      reporterPersonId: resident.personId,
      location: `Lägenhet 1101 ${suffix}`,
      description: REPORT,
    },
  });
  return id;
}

function workOrder(
  cookie: string,
  issueId: string,
  payload: object,
  what: "preview" | "send" = "send",
) {
  return inject({
    method: "POST",
    url: `/api/issue-queue/${issueId}/work-orders${what === "preview" ? "/preview" : ""}`,
    payload,
    cookie,
  });
}

let plumber: ContractorRow;

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
  mailer = app.get(WorkOrderMailerService);
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
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
  });

  plain = await createIssueTypeFixture(prisma, {
    id: typeIds.plain,
    name: `Vatten ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  boardOnly = await createIssueTypeFixture(prisma, {
    id: typeIds.boardOnly,
    name: `Försäkring ${suffix}`,
    reporters: ["HANDLERS"],
    handledBy: "BOARD",
  });
  ringFenced = await createIssueTypeFixture(prisma, {
    id: typeIds.ringFenced,
    name: `Störningar ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  // Nothing sets the mark yet but the database (ADR 0054, question 5).
  await prisma.issueType.update({
    where: { id: ringFenced.id },
    data: { ringFenced: true },
  });

  for (const entry of people) {
    cookies[entry.personId] = await signIn(entry.email);
  }

  plumber = await addContractor({
    name: `Rörfirman ${suffix}`,
    trade: "Rörmokare",
    phone: "08-123 45 67",
    email: `ror-${suffix}@firma.test`,
  });
}, 180_000);

afterAll(async () => {
  await prisma.issue.deleteMany({
    where: { typeId: { in: Object.values(typeIds) } },
  });
  await prisma.contractor.deleteMany({ where: { id: { in: contractorIds } } });
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
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await app.close();
});

describe("the contractor register", () => {
  it("is kept by the board, and read by every handler only as who is switched on", async () => {
    const off = await addContractor({
      name: `Gamla elfirman ${suffix}`,
      trade: "Elektriker",
      email: `el-${suffix}@firma.test`,
      active: false,
    });

    // The property manager handles issues and configures nothing.
    const refused = await inject({
      method: "POST",
      url: "/api/contractors",
      payload: { name: "Låsfirman", trade: "Låssmed" },
      cookie: as(manager),
    });
    expect(refused.statusCode).toBe(403);
    const unread = await inject({
      method: "GET",
      url: "/api/contractors",
      cookie: as(manager),
    });
    expect(unread.statusCode).toBe(403);

    const choices = await inject({
      method: "GET",
      url: "/api/issue-queue/contractors",
      cookie: as(manager),
    });
    expect(choices.statusCode).toBe(200);
    const ids = choices.json<{ id: string }[]>().map((row) => row.id);
    expect(ids).toContain(plumber.id);
    expect(ids).not.toContain(off.id);

    // A resident reaches neither.
    const resident403 = await inject({
      method: "GET",
      url: "/api/issue-queue/contractors",
      cookie: as(resident),
    });
    expect(resident403.statusCode).toBe(403);
  });

  it("stores an empty telephone number or address as none, and refuses an address that is not one", async () => {
    const row = await addContractor({
      name: `  Målarfirman ${suffix} `,
      trade: "Målare",
      phone: "  ",
      email: "",
    });
    expect(row).toMatchObject({
      name: `Målarfirman ${suffix}`,
      phone: null,
      email: null,
      active: true,
    });

    const invalid = await inject({
      method: "PUT",
      url: `/api/contractors/${row.id}`,
      payload: { name: row.name, trade: row.trade, email: "inte en adress" },
      cookie: as(board),
    });
    expect(invalid.statusCode).toBe(400);

    // Invisible characters and nothing else are no name at all.
    const blank = await inject({
      method: "PUT",
      url: `/api/contractors/${row.id}`,
      payload: { name: "​​", trade: row.trade },
      cookie: as(board),
    });
    expect(blank.statusCode).toBe(422);
    expect(blank.json<{ reason: string }>().reason).toBe(
      "contractor-incomplete",
    );
  });
});

describe("a work order", () => {
  it("is previewed as the mail the contractor will receive, with the handler's text and nothing of the report", async () => {
    const issueId = await filed(plain, "preview");
    const text = `Byt packningen under diskbänken i 1101.\nRing Bea först. ${suffix}`;

    const response = await workOrder(
      as(board),
      issueId,
      { contractorId: plumber.id, body: text },
      "preview",
    );
    expect(response.statusCode).toBe(200);
    const preview = response.json<{
      recipient: { name: string; email: string };
      subject: string;
      text: string;
    }>();
    expect(preview.recipient).toEqual({
      name: plumber.name,
      email: plumber.email,
    });
    expect(preview.subject).toContain("Brf Eksemplet");
    expect(preview.text).toContain(`Ring Bea först. ${suffix}`);
    expect(preview.text).toContain(plumber.name);
    // Never the report, the place the reporter wrote, or the reporter.
    expect(preview.text).not.toContain(REPORT);
    expect(preview.text).not.toContain(`Lägenhet 1101 ${suffix}`);
    expect(preview.text).not.toContain(resident.lastName);
    expect(preview.text).not.toContain(resident.email);
    // No link into the application: a contractor has no account.
    expect(preview.text).not.toMatch(/https?:\/\//);

    // A preview stores nothing and sends nothing.
    expect(await prisma.workOrder.count({ where: { issueId } })).toBe(0);
  });

  it("is stored before it is sent, mails what was previewed, and is recorded with whom, when and what", async () => {
    const issueId = await filed(plain, "sent");
    const text = `Kom på torsdag förmiddag. ${suffix}`;

    const previewed = (
      await workOrder(
        as(board),
        issueId,
        { contractorId: plumber.id, body: text },
        "preview",
      )
    ).json<{ subject: string; text: string }>();

    const response = await workOrder(as(board), issueId, {
      contractorId: plumber.id,
      body: text,
    });
    expect(response.statusCode).toBe(201);
    const sent = response.json<WorkOrderRow>();
    expect(sent).toMatchObject({
      contractorId: plumber.id,
      recipientName: plumber.name,
      recipientEmail: plumber.email,
      body: text,
      sentBy: { kind: "person", personId: board.personId },
      deliveryStatus: "PENDING",
      deliveryFailure: null,
    });

    // The entry says who sent what to whom, and not a word of it.
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        targetKind: "issue",
        targetId: issueId,
        action: "ISSUE_WORK_ORDER_SENT",
      },
      select: { actorPersonId: true, channel: true, context: true },
    });
    expect(entries).toEqual([
      {
        actorPersonId: board.personId,
        channel: "WEB",
        context: {
          workOrderId: sent.id,
          contractorId: plumber.id,
          characters: text.length,
        },
      },
    ]);
    expect(JSON.stringify(entries.map((entry) => entry.context))).not.toContain(
      suffix,
    );

    // The job hands the mail service the contractor's address and the
    // handler's text, rendered by the template the preview used.
    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });
    let handed: Parameters<MailService["send"]>[0] | undefined;
    try {
      expect(await mailer.send(sent.id)).toBe("sent");
      handed = send.mock.calls[0]?.[0];
      // At most once: a retried job finds the work order settled.
      expect(await mailer.send(sent.id)).toBe("skipped");
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
    if (handed === undefined) {
      throw new Error("The mailer handed nothing over.");
    }
    expect(handed.to).toBe(plumber.email);
    const rendered = await mail.renderMail(handed);
    expect(rendered.subject).toBe(previewed.subject);
    expect(rendered.text).toBe(previewed.text);

    const listed = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/work-orders`,
      cookie: as(manager),
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json<{ ringFenced: boolean; workOrders: WorkOrderRow[] }>(),
    ).toMatchObject({
      ringFenced: false,
      workOrders: [{ id: sent.id, deliveryStatus: "SENT", body: text }],
    });

    const timeline = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/timeline`,
      cookie: as(board),
    });
    expect(
      timeline.json<{ kind: string }[]>().map((step) => step.kind),
    ).toContain("workOrder");
  });

  it("records a mail server's refusal as a code on the work order", async () => {
    const issueId = await filed(plain, "refused");
    const sent = (
      await workOrder(as(board), issueId, {
        contractorId: plumber.id,
        body: "Byt lampan i trapphuset.",
      })
    ).json<WorkOrderRow>();

    const send = vi
      .spyOn(mail, "send")
      .mockRejectedValue(new Error(`550 no such user ${plumber.email ?? ""}`));
    try {
      expect(await mailer.send(sent.id)).toBe("failed");
    } finally {
      send.mockRestore();
    }
    expect(
      await prisma.workOrder.findUniqueOrThrow({
        where: { id: sent.id },
        select: { deliveryStatus: true, deliveryFailure: true },
      }),
    ).toEqual({ deliveryStatus: "FAILED", deliveryFailure: "send-failed" });
  });

  it("is never offered, previewed or sent on a ring-fenced issue", async () => {
    const issueId = await filed(ringFenced, "ring");
    const payload = { contractorId: plumber.id, body: "Kom och titta." };

    for (const what of ["preview", "send"] as const) {
      const refused = await workOrder(as(board), issueId, payload, what);
      expect(refused.statusCode, what).toBe(422);
      expect(refused.json<{ reason: string }>().reason, what).toBe(
        "work-order-ring-fenced",
      );
    }
    expect(await prisma.workOrder.count({ where: { issueId } })).toBe(0);
    expect(
      await prisma.auditLogEntry.count({
        where: {
          targetId: issueId,
          action: "ISSUE_WORK_ORDER_SENT",
        },
      }),
    ).toBe(0);

    const listed = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/work-orders`,
      cookie: as(board),
    });
    expect(listed.json<{ ringFenced: boolean }>().ringFenced).toBe(true);
  });

  it("refuses a personal identity number, an empty text, and a contractor with no address or off the list", async () => {
    const issueId = await filed(plain, "refusals");
    const noAddress = await addContractor({
      name: `Telefonfirman ${suffix}`,
      trade: "Snickare",
      phone: "070-123 45 67",
    });
    const off = await addContractor({
      name: `Avslutad firma ${suffix}`,
      trade: "Snickare",
      email: `av-${suffix}@firma.test`,
      active: false,
    });

    const cases: [object, number, string][] = [
      [
        { contractorId: plumber.id, body: "Boende 19811228-9874 släpper in." },
        422,
        "work-order-identity-number",
      ],
      [{ contractorId: plumber.id, body: "​​​" }, 422, "work-order-empty"],
      [
        { contractorId: noAddress.id, body: "Kom på måndag." },
        422,
        "contractor-without-email",
      ],
      [
        { contractorId: off.id, body: "Kom på måndag." },
        404,
        "contractor-not-found",
      ],
    ];
    for (const [payload, status, reason] of cases) {
      for (const what of ["preview", "send"] as const) {
        const refused = await workOrder(as(board), issueId, payload, what);
        expect(refused.statusCode, `${reason} ${what}`).toBe(status);
        expect(refused.json<{ reason: string }>().reason).toBe(reason);
      }
    }
    expect(await prisma.workOrder.count({ where: { issueId } })).toBe(0);

    // A field the route does not read is refused rather than dropped.
    const extra = await workOrder(as(board), issueId, {
      contractorId: plumber.id,
      body: "Kom på måndag.",
      photoIds: ["a"],
    });
    expect(extra.statusCode).toBe(400);
  });

  it("is reached by a property manager on an issue they handle, and on a board-only one is no issue at all", async () => {
    const handled = await filed(plain, "manager");
    const kept = await filed(boardOnly, "kept");
    const payload = { contractorId: plumber.id, body: "Kom på fredag." };

    const preview = await workOrder(as(manager), handled, payload, "preview");
    expect(preview.statusCode).toBe(200);

    for (const what of ["preview", "send"] as const) {
      const refused = await workOrder(as(manager), kept, payload, what);
      expect(refused.statusCode, what).toBe(404);
      expect(refused.json<{ reason: string }>().reason).toBe("issue-not-found");
    }
    const listed = await inject({
      method: "GET",
      url: `/api/issue-queue/${kept}/work-orders`,
      cookie: as(manager),
    });
    expect(listed.statusCode).toBe(404);

    // The board handles it.
    const board200 = await workOrder(as(board), kept, payload, "preview");
    expect(board200.statusCode).toBe(200);

    // A resident reaches no work order at all.
    const resident403 = await workOrder(as(resident), handled, payload);
    expect(resident403.statusCode).toBe(403);
  });

  it("keeps whom it went to when the contractor is taken off the list", async () => {
    const issueId = await filed(plain, "removed");
    const firm = await addContractor({
      name: `Tillfällig firma ${suffix}`,
      trade: "Glasmästare",
      email: `glas-${suffix}@firma.test`,
    });
    const sent = (
      await workOrder(as(board), issueId, {
        contractorId: firm.id,
        body: "Byt rutan i porten.",
      })
    ).json<WorkOrderRow>();

    const removed = await inject({
      method: "DELETE",
      url: `/api/contractors/${firm.id}`,
      cookie: as(board),
    });
    expect(removed.statusCode).toBe(204);

    const listed = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/work-orders`,
      cookie: as(board),
    });
    expect(listed.json<{ workOrders: WorkOrderRow[] }>().workOrders).toEqual([
      expect.objectContaining({
        id: sent.id,
        contractorId: null,
        recipientName: firm.name,
        recipientEmail: firm.email,
      }),
    ]);
  });
});
