import { Logger } from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuditLogService } from "../audit/audit-log.service";
import { AuthService } from "../auth/auth.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { siteUrl } from "../http/app-base-path";
import { I18nService } from "../i18n/i18n.service";
import { MailService } from "../mail/mail.service";
import { PagesService, PRIVACY_NOTICE_SLUG } from "../site/pages.service";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { backendPid, waitersBehind } from "../testing/lock-waiters";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { IssuePurgeService } from "./issue-purge.service";
import { WORK_ORDER_BODY_RETENTION_DAYS } from "./issue-retention";
import { WorkOrderMailerService } from "./work-order-mailer.service";
import { WorkOrderService } from "./work-order.service";

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
let purge: IssuePurgeService;
let encryption: FieldEncryptionService;
/**
 * Whether the association's privacy notice is published, as the mailer asks
 * it. Answered by a stub rather than by the shared database's page, which
 * other suites write: published, as a new instance's is, unless a test says
 * otherwise, because the first work order to a contractor is not sent without
 * its link.
 */
let noticePath: MockInstance<PagesService["privacyNoticePath"]>;
let noticeUrl = "";

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

const typeIds: Record<string, string> = {
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
  recipientName: string | null;
  recipientEmail: string | null;
  body: string | null;
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

/** Previews a work order and sends it with the preview's token. */
async function previewAndSend(
  cookie: string,
  issueId: string,
  payload: { contractorId: string; body: string },
) {
  const preview = await workOrder(cookie, issueId, payload, "preview");
  expect(preview.statusCode).toBe(200);
  const { previewToken } = preview.json<{ previewToken: string }>();
  return workOrder(cookie, issueId, { ...payload, previewToken });
}

/** A promise the test opens by hand, and one that says it has been reached. */
function gate(): {
  reached: Promise<void>;
  reach: () => void;
  opened: Promise<void>;
  open: () => void;
} {
  let reach: () => void = () => undefined;
  let open: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { reached, reach, opened, open };
}

/**
 * Holds the worker's claim at its door: the first transaction opened after
 * this is called - the worker's claim, when `mailer.send` is called next -
 * waits until `release` is called, while `reached` settles once the worker is
 * standing there. Whatever the test commits in between is therefore committed
 * before the claim, which is the schedule an erasure can fall into between the
 * worker's start and its claim.
 */
function holdTheClaim(): {
  reached: Promise<void>;
  release: () => void;
  restore: () => void;
} {
  const door = gate();
  const original = prisma.$transaction.bind(prisma) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  let held = false;
  const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((
    ...args: unknown[]
  ) => {
    if (!held) {
      held = true;
      door.reach();
      return door.opened.then(() => original(...args));
    }
    return original(...args);
  }) as unknown as typeof prisma.$transaction);
  return {
    reached: door.reached,
    release: door.open,
    restore: () => spy.mockRestore(),
  };
}

/** Ring-fences a type, or lifts its ring-fence, as the board does. */
function setRingFence(typeId: string, ringFenced: boolean) {
  return inject({
    method: "PUT",
    url: `/api/issue-types/${typeId}/ring-fence`,
    payload: { ringFenced },
    cookie: as(board),
  });
}

/** A token no preview signed, for a sending refused before it is read. */
const UNSIGNED = "1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let plumber: ContractorRow;

/** Whether this suite made the association row, and so removes it. */
let createdAssociation = false;

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
  purge = app.get(IssuePurgeService);
  encryption = app.get(FieldEncryptionService);
  noticePath = vi
    .spyOn(app.get(PagesService), "privacyNoticePath")
    .mockResolvedValue(`/${PRIVACY_NOTICE_SLUG}`);
  noticeUrl = siteUrl(app.get<Env>(ENV).APP_URL, `/${PRIVACY_NOTICE_SLUG}`);

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
    id: `wo-type-plain-${suffix}`,
    name: `Vatten ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  boardOnly = await createIssueTypeFixture(prisma, {
    id: `wo-type-board-${suffix}`,
    name: `Försäkring ${suffix}`,
    reporters: ["HANDLERS"],
    handledBy: "BOARD",
  });
  ringFenced = await createIssueTypeFixture(prisma, {
    id: `wo-type-ring-${suffix}`,
    name: `Störningar ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  for (const entry of people) {
    cookies[entry.personId] = await signIn(entry.email);
  }

  // The board ring-fences the type through its own route.
  const fenced = await inject({
    method: "PUT",
    url: `/api/issue-types/${ringFenced.id}/ring-fence`,
    payload: { ringFenced: true },
    cookie: as(board),
  });
  expect(fenced.statusCode).toBe(200);

  plumber = await addContractor({
    name: `Rörfirman ${suffix}`,
    trade: "Rörmokare",
    phone: "08-123 45 67",
    email: `ror-${suffix}@firma.test`,
  });
}, 180_000);

afterAll(async () => {
  noticePath.mockRestore();
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
  if (createdAssociation) {
    await prisma.association.deleteMany({ where: { id: 1 } });
  }
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
    // No link into the application: a contractor has no account. The one
    // link is the privacy notice on the website, in the first work order.
    expect(preview.text).toContain(noticeUrl);
    expect(preview.text.replaceAll(noticeUrl, "")).not.toMatch(/https?:\/\//);

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
    ).json<{ subject: string; text: string; previewToken: string }>();

    const response = await workOrder(as(board), issueId, {
      contractorId: plumber.id,
      body: text,
      previewToken: previewed.previewToken,
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
      timeline.json<{ kind: string; delivery?: string }[]>(),
    ).toContainEqual(
      expect.objectContaining({ kind: "workOrder", delivery: "sent" }),
    );
  });

  it("is mailed in the association's default language", async () => {
    const before = await prisma.association.findUniqueOrThrow({
      where: { id: 1 },
      select: { defaultLocale: true },
    });
    await prisma.association.update({
      where: { id: 1 },
      data: { defaultLocale: "en" },
    });
    try {
      const rendered = await mailer.render({
        recipientName: "Rör AB",
        body: "Fix the tap.",
        privacyNoticePath: null,
      });
      expect(rendered.subject).toMatch(/^Work order from /);

      // And the sending, which reads the language again when the worker runs.
      const issueId = await filed(plain, "english");
      const sent = (
        await previewAndSend(as(board), issueId, {
          contractorId: plumber.id,
          body: "Fix the tap in the laundry room.",
        })
      ).json<WorkOrderRow>();
      const send = vi
        .spyOn(mail, "send")
        .mockResolvedValue({ messageId: null });
      try {
        expect(await mailer.send(sent.id)).toBe("sent");
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ locale: "en" }),
        );
      } finally {
        send.mockRestore();
      }
    } finally {
      await prisma.association.update({
        where: { id: 1 },
        data: { defaultLocale: before.defaultLocale },
      });
    }
  });

  it.each([
    {
      // The server refused the envelope: the driver says nothing was handed
      // over, so the work order did not go out and the timeline says so.
      handover: "not-handed-over",
      failure: "send-failed",
      delivery: "failed",
    },
    {
      // The connection broke once the message was on its way: the server may
      // hold it, so nobody can vouch for it either way.
      handover: "may-have-been-handed-over",
      failure: "delivery-unconfirmed",
      delivery: "unconfirmed",
    },
  ] as const)(
    "records a failed mail send the driver says was $handover as $failure, $delivery on the timeline",
    async ({ handover, failure, delivery }) => {
      const issueId = await filed(plain, `refused-${handover}`);
      const sent = (
        await previewAndSend(as(board), issueId, {
          contractorId: plumber.id,
          body: "Byt lampan i trapphuset.",
        })
      ).json<WorkOrderRow>();

      // The driver's error as it reaches the sender: its words quote the
      // address, and its handover is what decides the record.
      const send = vi.spyOn(mail, "send").mockRejectedValue(
        Object.assign(new Error(`550 no such user ${plumber.email ?? ""}`), {
          handover,
        }),
      );
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
      ).toEqual({ deliveryStatus: "FAILED", deliveryFailure: failure });

      const timeline = await inject({
        method: "GET",
        url: `/api/issue-queue/${issueId}/timeline`,
        cookie: as(board),
      });
      expect(
        timeline.json<{ kind: string; delivery?: string }[]>(),
      ).toContainEqual(
        expect.objectContaining({ kind: "workOrder", delivery }),
      );
    },
  );

  it("is never offered, previewed or sent on a ring-fenced issue", async () => {
    const issueId = await filed(ringFenced, "ring");
    const payload = { contractorId: plumber.id, body: "Kom och titta." };

    for (const what of ["preview", "send"] as const) {
      const refused = await workOrder(
        as(board),
        issueId,
        { ...payload, ...(what === "send" ? { previewToken: UNSIGNED } : {}) },
        what,
      );
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
        const refused = await workOrder(
          as(board),
          issueId,
          {
            ...payload,
            ...(what === "send" ? { previewToken: UNSIGNED } : {}),
          },
          what,
        );
        expect(refused.statusCode, `${reason} ${what}`).toBe(status);
        expect(refused.json<{ reason: string }>().reason).toBe(reason);
      }
    }
    expect(await prisma.workOrder.count({ where: { issueId } })).toBe(0);

    // A field the route does not read is refused rather than dropped.
    const extra = await workOrder(as(board), issueId, {
      contractorId: plumber.id,
      body: "Kom på måndag.",
      previewToken: UNSIGNED,
      photoIds: ["a"],
    });
    expect(extra.statusCode).toBe(400);

    // A sending with no preview behind it is refused, and stores nothing.
    for (const previewToken of [undefined, UNSIGNED]) {
      const unpreviewed = await workOrder(as(board), issueId, {
        contractorId: plumber.id,
        body: "Kom på måndag.",
        ...(previewToken === undefined ? {} : { previewToken }),
      });
      expect(unpreviewed.statusCode).toBe(
        previewToken === undefined ? 400 : 409,
      );
    }
    expect(await prisma.workOrder.count({ where: { issueId } })).toBe(0);
  });

  it("is reached by a property manager on an issue they handle, and on a board-only one is no issue at all", async () => {
    const handled = await filed(plain, "manager");
    const kept = await filed(boardOnly, "kept");
    const payload = { contractorId: plumber.id, body: "Kom på fredag." };

    const preview = await workOrder(as(manager), handled, payload, "preview");
    expect(preview.statusCode).toBe(200);

    for (const what of ["preview", "send"] as const) {
      const refused = await workOrder(
        as(manager),
        kept,
        { ...payload, ...(what === "send" ? { previewToken: UNSIGNED } : {}) },
        what,
      );
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

  it("erases a removed contractor from the work orders sent them, and keeps the work orders", async () => {
    const issueId = await filed(plain, "removed");
    const firm = await addContractor({
      name: `Tillfällig firma ${suffix}`,
      trade: "Glasmästare",
      email: `glas-${suffix}@firma.test`,
    });
    const sent = (
      await previewAndSend(as(board), issueId, {
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
        recipientName: null,
        recipientEmail: null,
        body: "Byt rutan i porten.",
        sentBy: expect.objectContaining({ personId: board.personId }),
      }),
    ]);

    // Its mail had not gone out: there is nobody left to send it to.
    const send = vi.spyOn(mail, "send");
    try {
      expect(await mailer.send(sent.id)).toBe("failed");
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
    expect(
      await prisma.workOrder.findUniqueOrThrow({
        where: { id: sent.id },
        select: { deliveryStatus: true, deliveryFailure: true },
      }),
    ).toEqual({
      deliveryStatus: "FAILED",
      deliveryFailure: "recipient-removed",
    });

    // The removal is audited by id and count, never by name or address.
    const entries = await prisma.auditLogEntry.findMany({
      where: { targetKind: "contractor", targetId: firm.id },
      orderBy: { createdAt: "asc" },
      select: { action: true, actorPersonId: true, context: true },
    });
    expect(entries).toEqual([
      {
        action: "CONTRACTOR_LIST_CHANGED",
        actorPersonId: board.personId,
        context: { change: "added", fields: ["name", "trade", "email"] },
      },
      {
        action: "CONTRACTOR_LIST_CHANGED",
        actorPersonId: board.personId,
        context: { change: "removed", fields: [], workOrdersErased: 1 },
      },
    ]);
    expect(JSON.stringify(entries.map((entry) => entry.context))).not.toContain(
      suffix,
    );
  });
});

describe("the privacy notice", () => {
  // Sent by the property manager, whose hourly budget no earlier test spends,
  // so the board's stays for the tests that follow.
  /** Sends a work order through the worker, and returns the mail's text. */
  async function mailed(id: string): Promise<string> {
    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });
    try {
      expect(await mailer.send(id)).toBe("sent");
      const handed = send.mock.calls[0]?.[0];
      if (handed === undefined) {
        throw new Error("The mailer handed nothing over.");
      }
      return (await mail.renderMail(handed)).text;
    } finally {
      send.mockRestore();
    }
  }

  async function givenAt(id: string): Promise<Date | null> {
    return (
      await prisma.contractor.findUniqueOrThrow({
        where: { id },
        select: { privacyNoticeGivenAt: true },
      })
    ).privacyNoticeGivenAt;
  }

  async function previewText(
    issueId: string,
    contractorId: string,
    body: string,
  ): Promise<string> {
    const response = await workOrder(
      as(manager),
      issueId,
      { contractorId, body },
      "preview",
    );
    expect(response.statusCode).toBe(200);
    return response.json<{ text: string }>().text;
  }

  it("is linked in the first work order mailed to a contractor and not in a later one, until the board changes their address", async () => {
    const firm = await addContractor({
      name: `Elfirman ${suffix}`,
      trade: "Elektriker",
      email: `el-${suffix}@firma.test`,
    });
    const issueId = await filed(plain, "notice-first");

    // The preview shows the link the mail will carry.
    expect(
      await previewText(issueId, firm.id, "Byt säkringen i elcentralen."),
    ).toContain(noticeUrl);
    const first = (
      await previewAndSend(as(manager), issueId, {
        contractorId: firm.id,
        body: "Byt säkringen i elcentralen.",
      })
    ).json<WorkOrderRow>();
    // Not marked until the mail server has the mail.
    expect(await givenAt(firm.id)).toBeNull();
    const firstText = await mailed(first.id);
    expect(firstText).toContain(noticeUrl);
    // Nothing of the issue rides along with it.
    expect(firstText).not.toContain(REPORT);
    expect(await givenAt(firm.id)).not.toBeNull();

    // A later work order, on another issue, does not repeat it.
    const later = await filed(plain, "notice-later");
    expect(
      await previewText(later, firm.id, "Kontrollera jordfelsbrytaren."),
    ).not.toContain(noticeUrl);
    const second = (
      await previewAndSend(as(manager), later, {
        contractorId: firm.id,
        body: "Kontrollera jordfelsbrytaren.",
      })
    ).json<WorkOrderRow>();
    expect(await mailed(second.id)).not.toMatch(/https?:\/\//);

    // The trade changed: the same person reads the same address.
    const traded = await inject({
      method: "PUT",
      url: `/api/contractors/${firm.id}`,
      payload: {
        name: firm.name,
        trade: "Elinstallatör",
        email: firm.email,
      },
      cookie: as(board),
    });
    expect(traded.statusCode).toBe(200);
    expect(await givenAt(firm.id)).not.toBeNull();

    // A new address may be somebody else, who has not been told.
    const moved = await inject({
      method: "PUT",
      url: `/api/contractors/${firm.id}`,
      payload: {
        name: firm.name,
        trade: "Elinstallatör",
        email: `el-ny-${suffix}@firma.test`,
      },
      cookie: as(board),
    });
    expect(moved.statusCode).toBe(200);
    expect(await givenAt(firm.id)).toBeNull();
    const third = (
      await previewAndSend(as(manager), later, {
        contractorId: firm.id,
        body: "Byt uttaget i tvättstugan.",
      })
    ).json<WorkOrderRow>();
    expect(await mailed(third.id)).toContain(noticeUrl);
    expect(await givenAt(firm.id)).not.toBeNull();
  });

  it("refuses a work order that must link the notice while it is unpublished, records one already queued as not sent, and sends it once it is published", async () => {
    const firm = await addContractor({
      name: `Måleriet ${suffix}`,
      trade: "Målare",
      email: `mal-${suffix}@firma.test`,
    });
    const issueId = await filed(plain, "notice-unpublished");
    const payload = { contractorId: firm.id, body: "Måla om trapphuset." };
    // Queued while the notice was published.
    const queued = (
      await previewAndSend(as(manager), issueId, payload)
    ).json<WorkOrderRow>();

    // The board takes the notice down, or makes it members' only.
    noticePath.mockResolvedValue(null);
    try {
      // The preview and the sending are refused, with what to do about it.
      for (const response of [
        await workOrder(
          as(manager),
          issueId,
          { contractorId: firm.id, body: "Måla om tvättstugan." },
          "preview",
        ),
        await workOrder(as(manager), issueId, {
          contractorId: firm.id,
          body: "Måla om tvättstugan.",
          previewToken: "ignored",
        }),
      ]) {
        expect(response.statusCode).toBe(409);
        expect(response.json<{ reason: string }>().reason).toBe(
          "work-order-privacy-notice-unpublished",
        );
      }

      // The one queued before is not sent without the link.
      const send = vi.spyOn(mail, "send");
      try {
        expect(await mailer.send(queued.id)).toBe("failed");
        expect(send).not.toHaveBeenCalled();
      } finally {
        send.mockRestore();
      }
      expect(
        await prisma.workOrder.findUniqueOrThrow({
          where: { id: queued.id },
          select: { deliveryStatus: true, deliveryFailure: true },
        }),
      ).toEqual({
        deliveryStatus: "FAILED",
        deliveryFailure: "privacy-notice-unpublished",
      });
      expect(await givenAt(firm.id)).toBeNull();
    } finally {
      noticePath.mockResolvedValue(`/${PRIVACY_NOTICE_SLUG}`);
    }

    // Published again: the same work order is written again, is not held
    // back as a repeat of one that never left, and carries the link.
    const again = (
      await previewAndSend(as(manager), issueId, payload)
    ).json<WorkOrderRow>();
    expect(await mailed(again.id)).toContain(noticeUrl);
    expect(await givenAt(firm.id)).not.toBeNull();

    // A contractor told already is sent work orders while it is down.
    noticePath.mockResolvedValue(null);
    try {
      const later = await filed(plain, "notice-unpublished-later");
      const sent = (
        await previewAndSend(as(manager), later, {
          contractorId: firm.id,
          body: "Laga fönsterkarmen.",
        })
      ).json<WorkOrderRow>();
      expect(await mailed(sent.id)).not.toMatch(/https?:\/\//);
    } finally {
      noticePath.mockResolvedValue(`/${PRIVACY_NOTICE_SLUG}`);
    }
  });

  it("is not marked as given when the mail did not go out", async () => {
    const firm = await addContractor({
      name: `Golvfirman ${suffix}`,
      trade: "Golvläggare",
      email: `golv-${suffix}@firma.test`,
    });
    // The mail server refused it: the link reached nobody.
    const refusedIssue = await filed(plain, "notice-refused");
    const refused = (
      await previewAndSend(as(manager), refusedIssue, {
        contractorId: firm.id,
        body: "Slipa golvet i föreningslokalen.",
      })
    ).json<WorkOrderRow>();
    const send = vi
      .spyOn(mail, "send")
      .mockRejectedValue(
        Object.assign(new Error("550"), { handover: "not-handed-over" }),
      );
    try {
      expect(await mailer.send(refused.id)).toBe("failed");
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          props: expect.objectContaining({
            privacyNoticePath: `/${PRIVACY_NOTICE_SLUG}`,
          }),
        }),
      );
    } finally {
      send.mockRestore();
    }
    expect(await givenAt(firm.id)).toBeNull();
  });

  it("is linked in a work order queued for the name and address the board then changed, though one to the new ones went out first", async () => {
    const firm = await addContractor({
      name: `Låssmeden ${suffix}`,
      trade: "Låssmed",
      email: `las-${suffix}@firma.test`,
    });
    // The first contact's work order is queued, and its job is delayed.
    const first = await filed(plain, "notice-reordered");
    const toFirst = (
      await previewAndSend(as(manager), first, {
        contractorId: firm.id,
        body: "Byt låscylindern i porten.",
      })
    ).json<WorkOrderRow>();

    // The board gives the entry another firm's name and address.
    const handed = await inject({
      method: "PUT",
      url: `/api/contractors/${firm.id}`,
      payload: {
        name: `Nya låssmeden ${suffix}`,
        trade: "Låssmed",
        email: `nya-las-${suffix}@firma.test`,
      },
      cookie: as(board),
    });
    expect(handed.statusCode).toBe(200);

    // The new firm's work order goes out first, with the link, and marks the
    // row as told.
    const second = await filed(plain, "notice-reordered-new");
    const toSecond = (
      await previewAndSend(as(manager), second, {
        contractorId: firm.id,
        body: "Smörj låset till förrådet.",
      })
    ).json<WorkOrderRow>();
    expect(await mailed(toSecond.id)).toContain(noticeUrl);
    const told = await givenAt(firm.id);
    expect(told).not.toBeNull();

    // The first firm's, delivered last, still carries it: the mark is the new
    // firm's, and says nothing about whoever reads the old address.
    expect(await mailed(toFirst.id)).toContain(noticeUrl);
    expect(await givenAt(firm.id)).toEqual(told);
  });

  it("is read from the page in the claim's own transaction, which waits for the board taking it down and then sends nothing", async () => {
    /*
     * The one case that asks the database rather than the stub. The page is
     * this worker database's own, so it is made published for the case and put
     * back as it was in `finally`.
     */
    const pages = app.get(PagesService);
    const seeded = await pages.seedPrivacyNotice(
      app.get(I18nService).translatorFor("sv"),
    );
    const page = await prisma.page.findUniqueOrThrow({
      where: { slug: PRIVACY_NOTICE_SLUG },
      select: { id: true, status: true },
    });
    const unpublishing = gate();
    const committed = gate();
    let holding: Promise<void> | undefined;
    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });
    try {
      await prisma.page.update({
        where: { id: page.id },
        data: { status: "PUBLIC" },
      });
      // The spy is on the instance, so the prototype still has the lookup.
      noticePath.mockImplementation((db, options) =>
        PagesService.prototype.privacyNoticePath.call(pages, db, options),
      );

      const firm = await addContractor({
        name: `Glasmästeriet ${suffix}`,
        trade: "Glasmästare",
        email: `glas-${suffix}@firma.test`,
      });
      const issueId = await filed(plain, "notice-taken-down");
      const payload = { contractorId: firm.id, body: "Byt rutan i porten." };
      const queued = (
        await previewAndSend(as(manager), issueId, payload)
      ).json<WorkOrderRow>();

      // The board takes the notice down, and has not committed yet.
      let holder = 0;
      holding = prisma.$transaction(
        async (tx) => {
          holder = await backendPid(tx);
          await tx.page.update({
            where: { id: page.id },
            data: { status: "DRAFT" },
          });
          unpublishing.reach();
          await committed.opened;
        },
        { timeout: 30_000 },
      );
      await unpublishing.reached;

      // A lookup without the share lock would read the notice as published
      // and send now, without waiting.
      const running = mailer.send(queued.id);
      await waitFor(async () => (await waitersBehind(prisma, holder)) > 0);
      // And the one waiting is the claim's own transaction, which has taken
      // the work order: a lookup on a connection of its own would wait
      // holding nothing of it, and with a pool of one would never be served.
      const [claim] = await prisma.$queryRaw<{ holding: number }[]>`
        SELECT count(*)::int AS holding
        FROM pg_locks
        WHERE pid IN (
            SELECT pid FROM pg_stat_activity
            WHERE ${holder}::int = ANY (pg_blocking_pids(pid))
          )
          AND locktype = 'relation'
          AND relation = 'work_order'::regclass
          AND mode = 'RowExclusiveLock'
          AND granted`;
      expect(claim?.holding).toBe(1);
      expect(send).not.toHaveBeenCalled();

      committed.open();
      await holding;
      expect(await running).toBe("failed");
      expect(send).not.toHaveBeenCalled();
      expect(
        await prisma.workOrder.findUniqueOrThrow({
          where: { id: queued.id },
          select: { deliveryStatus: true, deliveryFailure: true },
        }),
      ).toEqual({
        deliveryStatus: "FAILED",
        deliveryFailure: "privacy-notice-unpublished",
      });
      expect(await givenAt(firm.id)).toBeNull();

      // Published again, the work order written again carries the link.
      await prisma.page.update({
        where: { id: page.id },
        data: { status: "PUBLIC" },
      });
      const again = (
        await previewAndSend(as(manager), issueId, payload)
      ).json<WorkOrderRow>();
      send.mockClear();
      expect(await mailer.send(again.id)).toBe("sent");
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          props: expect.objectContaining({
            privacyNoticePath: `/${PRIVACY_NOTICE_SLUG}`,
          }),
        }),
      );
      expect(await givenAt(firm.id)).not.toBeNull();
    } finally {
      committed.open();
      await holding?.catch(() => undefined);
      send.mockRestore();
      noticePath.mockResolvedValue(`/${PRIVACY_NOTICE_SLUG}`);
      if (seeded.created) {
        await prisma.page.delete({ where: { id: page.id } });
      } else {
        await prisma.page.update({
          where: { id: page.id },
          data: { status: page.status },
        });
      }
    }
  });
});

describe("what is sent is what was previewed", () => {
  it("refuses a sending after the board changed the contractor's address, and sends to the new one only after a fresh preview", async () => {
    const issueId = await filed(plain, "rebound");
    const firm = await addContractor({
      name: `Flyttfirman ${suffix}`,
      trade: "Snickare",
      email: `gammal-${suffix}@firma.test`,
    });
    const payload = {
      contractorId: firm.id,
      body: "Laga dörren till förrådet.",
    };

    const first = await workOrder(as(board), issueId, payload, "preview");
    const { previewToken } = first.json<{ previewToken: string }>();
    expect(first.json<{ recipient: { email: string } }>().recipient.email).toBe(
      `gammal-${suffix}@firma.test`,
    );

    // Another board member corrects the address while the preview is open.
    const changed = await inject({
      method: "PUT",
      url: `/api/contractors/${firm.id}`,
      payload: {
        name: firm.name,
        trade: firm.trade,
        email: `ny-${suffix}@firma.test`,
      },
      cookie: as(board),
    });
    expect(changed.statusCode).toBe(200);

    const stale = await workOrder(as(board), issueId, {
      ...payload,
      previewToken,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ reason: string }>().reason).toBe(
      "work-order-preview-stale",
    );
    expect(await prisma.workOrder.count({ where: { issueId } })).toBe(0);

    // A changed text is not what was previewed either.
    const edited = await workOrder(as(board), issueId, {
      ...payload,
      body: "Laga dörren till cykelrummet.",
      previewToken,
    });
    expect(edited.statusCode).toBe(409);

    // Nor is another handler's preview of the same work order.
    const others = await workOrder(as(manager), issueId, payload, "preview");
    const borrowed = await workOrder(as(board), issueId, {
      ...payload,
      previewToken: others.json<{ previewToken: string }>().previewToken,
    });
    expect(borrowed.statusCode).toBe(409);

    const sent = await previewAndSend(as(board), issueId, payload);
    expect(sent.statusCode).toBe(201);
    expect(sent.json<WorkOrderRow>().recipientEmail).toBe(
      `ny-${suffix}@firma.test`,
    );

    // The change is audited by the fields it touched, never their values.
    const audited = await prisma.auditLogEntry.findMany({
      where: {
        targetKind: "contractor",
        targetId: firm.id,
        context: { path: ["change"], equals: "changed" },
      },
      select: { context: true },
    });
    expect(audited).toEqual([
      { context: { change: "changed", fields: ["email"] } },
    ]);
  });

  it("counts an earlier work order as a sending unless it is known not to have left", async () => {
    const attempt = async (
      label: string,
      failure: string,
      status: "FAILED" | "PENDING" = "FAILED",
    ) => {
      const issueId = await filed(plain, label);
      const payload = {
        contractorId: plumber.id,
        body: `Sota imkanalen. ${label} ${suffix}`,
      };
      const preview = await workOrder(as(manager), issueId, payload, "preview");
      const { previewToken } = preview.json<{ previewToken: string }>();
      expect(
        (await workOrder(as(manager), issueId, { ...payload, previewToken }))
          .statusCode,
      ).toBe(201);
      await prisma.workOrder.updateMany({
        where: { issueId },
        data: {
          deliveryStatus: status,
          deliveryFailure: status === "FAILED" ? failure : null,
        },
      });
      const again = await workOrder(as(manager), issueId, {
        ...payload,
        previewToken,
      });
      return {
        again,
        count: await prisma.workOrder.count({ where: { issueId } }),
      };
    };

    // Told "write it again to send it", the handler is not refused for a
    // sending that never happened. Three of the codes stand for the rest, which
    // `work-order-delivery.spec.ts` keeps in step with the check. The property
    // manager sends these: each costs two of a handler's twenty sendings an
    // hour, which the board's own tests need.
    for (const failure of [
      "sending-interrupted",
      "mail-not-configured",
      "send-failed",
    ]) {
      const { again, count } = await attempt(`never-left-${failure}`, failure);
      expect(again.statusCode, failure).toBe(201);
      expect(count, failure).toBe(2);
    }

    // A mail that may have gone out, or is still on its way, is a sending.
    for (const [failure, status] of [
      ["delivery-unconfirmed", "FAILED"],
      ["", "PENDING"],
    ] as const) {
      const { again, count } = await attempt(
        `may-have-left-${failure || status}`,
        failure,
        status,
      );
      expect(again.statusCode, failure || status).toBe(409);
      expect(again.json<{ reason: string }>().reason).toBe(
        "work-order-duplicate",
      );
      expect(count, failure || status).toBe(1);
    }
  });

  it("refuses the same work order sent twice in a moment, and a handler past the hourly budget", async () => {
    const issueId = await filed(plain, "twice");
    const payload = {
      contractorId: plumber.id,
      body: `Sota imkanalen. ${suffix}`,
    };
    const preview = await workOrder(as(board), issueId, payload, "preview");
    const { previewToken } = preview.json<{ previewToken: string }>();

    const [first, second] = await Promise.all([
      workOrder(as(board), issueId, { ...payload, previewToken }),
      workOrder(as(board), issueId, { ...payload, previewToken }),
    ]);
    expect([first.statusCode, second.statusCode].sort((a, b) => a - b)).toEqual(
      [201, 409],
    );
    expect(
      [first, second]
        .filter((response) => response.statusCode === 409)
        .map((response) => response.json<{ reason: string }>().reason),
    ).toEqual(["work-order-duplicate"]);
    expect(await prisma.workOrder.count({ where: { issueId } })).toBe(1);

    // A send whose answer was lost and is pressed again a quarter of an hour
    // later, still on the same preview, finds the first order and is refused.
    await prisma.workOrder.updateMany({
      where: { issueId },
      data: { createdAt: new Date(Date.now() - 15 * 60 * 1000) },
    });
    const retried = await workOrder(as(board), issueId, {
      ...payload,
      previewToken,
    });
    expect(retried.statusCode).toBe(409);
    expect(retried.json<{ reason: string }>().reason).toBe(
      "work-order-duplicate",
    );
    expect(await prisma.workOrder.count({ where: { issueId } })).toBe(1);

    // A handler redacts the text meanwhile (ADR 0057). The same press, on the
    // same preview, still finds the first order: it must not mail the words
    // that were removed.
    await prisma.workOrder.updateMany({
      where: { issueId },
      data: { body: null, redactedAt: new Date() },
    });
    const afterRedaction = await workOrder(as(board), issueId, {
      ...payload,
      previewToken,
    });
    expect(afterRedaction.statusCode).toBe(409);
    expect(afterRedaction.json<{ reason: string }>().reason).toBe(
      "work-order-duplicate",
    );
    expect(await prisma.workOrder.count({ where: { issueId } })).toBe(1);

    // The manager has sent their budget's worth in the last hour.
    const budgetIssue = await filed(plain, "budget");
    await prisma.workOrder.createMany({
      data: Array.from({ length: 20 }, (_, index) => ({
        issueId: budgetIssue,
        contractorId: plumber.id,
        recipientName: plumber.name,
        body: `Arbetsorder ${String(index)} ${suffix}`,
        sentByPersonId: manager.personId,
        deliveryStatus: "SENT" as const,
      })),
    });
    const spent = await previewAndSend(as(manager), budgetIssue, {
      contractorId: plumber.id,
      body: "Kom på måndag.",
    });
    expect(spent.statusCode).toBe(429);
    expect(spent.json<{ reason: string }>().reason).toBe(
      "work-order-budget-spent",
    );
  });
});

describe("a closed issue", () => {
  it("is offered no work order, in the preview, the sending or the list, until it is reopened", async () => {
    const issueId = await filed(plain, "closed");
    const payload = { contractorId: plumber.id, body: "Kom och titta." };
    const preview = await workOrder(as(board), issueId, payload, "preview");
    const { previewToken } = preview.json<{ previewToken: string }>();

    await prisma.issue.update({
      where: { id: issueId },
      data: { statusId: plain.statusIds.DONE, closedAt: new Date() },
    });

    for (const refused of [
      await workOrder(as(board), issueId, payload, "preview"),
      await workOrder(as(board), issueId, { ...payload, previewToken }),
    ]) {
      expect(refused.statusCode).toBe(409);
      expect(refused.json<{ reason: string }>().reason).toBe("issue-closed");
    }
    expect(await prisma.workOrder.count({ where: { issueId } })).toBe(0);
    const listed = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/work-orders`,
      cookie: as(board),
    });
    expect(listed.json<{ closed: boolean }>().closed).toBe(true);

    // Reopened, the same preview is still good for the same sending.
    await prisma.issue.update({
      where: { id: issueId },
      data: { statusId: plain.statusIds.NEW, closedAt: null },
    });
    expect(
      (await workOrder(as(board), issueId, { ...payload, previewToken }))
        .statusCode,
    ).toBe(201);
    const relisted = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/work-orders`,
      cookie: as(board),
    });
    expect(relisted.json<{ closed: boolean }>().closed).toBe(false);
  });
});

describe("the ring-fence", () => {
  it("is set by the board alone, audited, and refuses work orders while it holds", async () => {
    const type = await createIssueTypeFixture(prisma, {
      id: `wo-type-fence-${suffix}`,
      name: `Grannar ${suffix}`,
      reporters: ["RESIDENTS"],
    });
    typeIds.fence = type.id;
    const issueId = await filed(type, "fence");
    const payload = { contractorId: plumber.id, body: "Kom och titta." };
    const fence = (cookie: string, body: object) =>
      inject({
        method: "PUT",
        url: `/api/issue-types/${type.id}/ring-fence`,
        payload: body,
        cookie,
      });

    // A handler who configures nothing cannot lift or set it.
    expect((await fence(as(manager), { ringFenced: true })).statusCode).toBe(
      403,
    );
    // Strict: a request that says anything else is refused.
    expect(
      (await fence(as(board), { ringFenced: true, name: "x" })).statusCode,
    ).toBe(400);

    const preview = await workOrder(as(board), issueId, payload, "preview");
    expect(preview.statusCode).toBe(200);

    const set = await fence(as(board), { ringFenced: true });
    expect(set.statusCode).toBe(200);
    expect(set.json<{ ringFenced: boolean }>().ringFenced).toBe(true);
    // Setting it again changes nothing and writes nothing.
    expect((await fence(as(board), { ringFenced: true })).statusCode).toBe(200);

    // The preview read before the fence went up sends nothing.
    const refused = await workOrder(as(board), issueId, {
      ...payload,
      previewToken: preview.json<{ previewToken: string }>().previewToken,
    });
    expect(refused.json<{ reason: string }>().reason).toBe(
      "work-order-ring-fenced",
    );
    const listed = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/work-orders`,
      cookie: as(board),
    });
    expect(listed.json<{ ringFenced: boolean }>().ringFenced).toBe(true);

    // An issue has been reported under the type, so the ring-fence stays
    // (ADR 0054, question 5): lifting it would hand that report to whoever it
    // keeps out. `ring-fence.int-spec.ts` covers the rest of the rule.
    const lifted = await fence(as(board), { ringFenced: false });
    expect(lifted.statusCode).toBe(409);
    expect(lifted.json<{ reason: string }>().reason).toBe("ring-fence-in-use");
    expect(
      await prisma.auditLogEntry.findMany({
        where: { targetKind: "issueType", targetId: type.id },
        orderBy: { createdAt: "asc" },
        select: { action: true, actorPersonId: true, context: true },
      }),
    ).toEqual([
      {
        action: "ISSUE_TYPE_RING_FENCE_CHANGED",
        actorPersonId: board.personId,
        context: {
          ringFenced: true,
          handledBy: { before: "EVERY_HANDLER", after: "BOARD" },
        },
      },
    ]);
  });
});

describe("the sending", () => {
  it("records a work order as not sent when no mail server is configured, and not a null message identifier as such", async () => {
    const issueId = await filed(plain, "unconfigured");
    const sent = (
      await previewAndSend(as(board), issueId, {
        contractorId: plumber.id,
        body: "Byt filtret i ventilationen.",
      })
    ).json<WorkOrderRow>();

    const send = vi
      .spyOn(mail, "send")
      .mockResolvedValue({ messageId: null, suppressed: true });
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
    ).toEqual({
      deliveryStatus: "FAILED",
      deliveryFailure: "mail-not-configured",
    });

    // Nothing left this instance, so the timeline may say it was not sent.
    const timeline = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/timeline`,
      cookie: as(board),
    });
    expect(
      timeline.json<{ kind: string; delivery?: string }[]>(),
    ).toContainEqual(
      expect.objectContaining({ kind: "workOrder", delivery: "failed" }),
    );
  });

  it("records an address that cannot be read back as not sent, and hands nothing to the mail server", async () => {
    const issueId = await filed(plain, "unreadable");
    const sent = (
      await previewAndSend(as(board), issueId, {
        contractorId: plumber.id,
        body: "Byt packningen i kranen.",
      })
    ).json<WorkOrderRow>();

    const decrypt = vi
      .spyOn(encryption, "decrypt")
      .mockRejectedValueOnce(new Error("bad decrypt"));
    const send = vi.spyOn(mail, "send");
    try {
      expect(await mailer.send(sent.id)).toBe("failed");
      expect(send).not.toHaveBeenCalled();
    } finally {
      decrypt.mockRestore();
      send.mockRestore();
    }
    expect(
      await prisma.workOrder.findUniqueOrThrow({
        where: { id: sent.id },
        select: { deliveryStatus: true, deliveryFailure: true },
      }),
    ).toEqual({
      deliveryStatus: "FAILED",
      deliveryFailure: "recipient-unreadable",
    });

    // Nothing left this instance, so the timeline says it was not sent.
    const timeline = await inject({
      method: "GET",
      url: `/api/issue-queue/${issueId}/timeline`,
      cookie: as(board),
    });
    expect(
      timeline.json<{ kind: string; delivery?: string }[]>(),
    ).toContainEqual(
      expect.objectContaining({ kind: "workOrder", delivery: "failed" }),
    );
  });

  it("lists the other work orders on an issue when one recipient address cannot be read", async () => {
    const issueId = await filed(plain, "unreadable-list");
    const first = (
      await previewAndSend(as(board), issueId, {
        contractorId: plumber.id,
        body: "Byt packningen i kranen.",
      })
    ).json<WorkOrderRow>();
    const second = (
      await previewAndSend(as(board), issueId, {
        contractorId: plumber.id,
        body: "Kontrollera även elementet.",
      })
    ).json<WorkOrderRow>();
    const url = `/api/issue-queue/${issueId}/work-orders`;
    const before = await inject({ method: "GET", url, cookie: as(board) });
    expect(before.statusCode).toBe(200);

    const { recipientEmailCipher } = await prisma.workOrder.findUniqueOrThrow({
      where: { id: first.id },
      select: { recipientEmailCipher: true },
    });
    expect(recipientEmailCipher).not.toBeNull();
    const realDecrypt = encryption.decrypt.bind(encryption);
    // A failure whose message quotes the address and the cipher it was reading,
    // as a careless one would: the log line must carry neither.
    const decrypt = vi
      .spyOn(encryption, "decrypt")
      .mockImplementation(async (purpose, cipher, rowId) => {
        if (rowId === first.id) {
          throw new Error(
            `bad decrypt of ${plumber.email}: ${String(recipientEmailCipher)}`,
          );
        }
        return realDecrypt(purpose, cipher, rowId);
      });
    const warned = vi.spyOn(Logger.prototype, "warn");
    let listed;
    let lines: string[];
    try {
      listed = await inject({ method: "GET", url, cookie: as(board) });
      lines = warned.mock.calls.map((call) => String(call[0]));
    } finally {
      decrypt.mockRestore();
      warned.mockRestore();
    }
    expect(listed.statusCode).toBe(200);
    const line = lines.find((text) => text.includes(first.id));
    expect(line).toContain("recipient address could not be read");
    expect(line).not.toContain(plumber.email);
    expect(line).not.toContain(String(recipientEmailCipher));
    const { workOrders } = listed.json<{ workOrders: WorkOrderRow[] }>();
    const unchanged = before.json<{ workOrders: WorkOrderRow[] }>().workOrders;
    expect(workOrders.find((row) => row.id === first.id)).toEqual({
      ...unchanged.find((row) => row.id === first.id),
      recipientEmail: null,
    });
    expect(workOrders.find((row) => row.id === second.id)).toEqual(
      unchanged.find((row) => row.id === second.id),
    );
    expect(workOrders.find((row) => row.id === second.id)?.recipientEmail).toBe(
      plumber.email,
    );
  });

  it("leaves a work order untouched for the retry when the association's language cannot be read", async () => {
    const issueId = await filed(plain, "locale-unread");
    const sent = (
      await previewAndSend(as(board), issueId, {
        contractorId: plumber.id,
        body: "Rensa golvbrunnen i tvättstugan.",
      })
    ).json<WorkOrderRow>();

    const read = vi
      .spyOn(prisma.association, "findUnique")
      .mockRejectedValueOnce(new Error("connection lost"));
    const send = vi.spyOn(mail, "send");
    try {
      // The job fails, so the queue retries it, and nothing was recorded as
      // a mail server's refusal.
      await expect(mailer.send(sent.id)).rejects.toThrow("connection lost");
      expect(send).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      send.mockRestore();
    }
    expect(
      await prisma.workOrder.findUniqueOrThrow({
        where: { id: sent.id },
        select: {
          deliveryStatus: true,
          deliveryFailure: true,
          claimedAt: true,
        },
      }),
    ).toEqual({
      deliveryStatus: "PENDING",
      deliveryFailure: null,
      claimedAt: null,
    });
  });

  it("sends nothing to a contractor removed after the worker started and before it claimed the work order", async () => {
    const issueId = await filed(plain, "erased-before-claim");
    const firm = await addContractor({
      name: `Borttagen firma ${suffix}`,
      trade: "Låssmed",
      email: `last-${suffix}@firma.test`,
    });
    const sent = (
      await previewAndSend(as(board), issueId, {
        contractorId: firm.id,
        body: "Byt cylinder i källardörren.",
      })
    ).json<WorkOrderRow>();

    const send = vi.spyOn(mail, "send");
    const hold = holdTheClaim();
    try {
      const running = mailer.send(sent.id);
      await hold.reached;

      // The removal commits while the worker waits at the claim.
      const removed = await inject({
        method: "DELETE",
        url: `/api/contractors/${firm.id}`,
        cookie: as(board),
      });
      expect(removed.statusCode).toBe(204);

      hold.release();
      expect(await running).toBe("failed");
      expect(send).not.toHaveBeenCalled();
    } finally {
      hold.release();
      hold.restore();
      send.mockRestore();
    }
    expect(
      await prisma.workOrder.findUniqueOrThrow({
        where: { id: sent.id },
        select: {
          deliveryStatus: true,
          deliveryFailure: true,
          claimedAt: true,
          recipientName: true,
          recipientEmailCipher: true,
        },
      }),
    ).toEqual({
      deliveryStatus: "FAILED",
      deliveryFailure: "recipient-removed",
      claimedAt: null,
      recipientName: null,
      recipientEmailCipher: null,
    });
  });

  it("sends nothing of a text erased after the worker started and before it claimed the work order", async () => {
    const issueId = await filed(plain, "text-erased-before-claim");
    const sent = (
      await previewAndSend(as(board), issueId, {
        contractorId: plumber.id,
        body: "Spola om värmesystemet.",
      })
    ).json<WorkOrderRow>();
    // Closed long enough ago for the nightly purge to take its texts.
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        statusId: plain.statusIds.DONE,
        closedAt: new Date(
          Date.now() -
            (WORK_ORDER_BODY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
        ),
      },
    });

    const send = vi.spyOn(mail, "send");
    const hold = holdTheClaim();
    try {
      const running = mailer.send(sent.id);
      await hold.reached;

      expect(await purge.purgeWorkOrderTexts(issueId)).toBe(true);

      hold.release();
      expect(await running).toBe("failed");
      expect(send).not.toHaveBeenCalled();
    } finally {
      hold.release();
      hold.restore();
      send.mockRestore();
    }
    expect(
      await prisma.workOrder.findUniqueOrThrow({
        where: { id: sent.id },
        select: {
          deliveryStatus: true,
          deliveryFailure: true,
          claimedAt: true,
          body: true,
        },
      }),
    ).toEqual({
      deliveryStatus: "FAILED",
      deliveryFailure: "text-erased",
      claimedAt: null,
      body: null,
    });
  });

  it("sends nothing of a work order whose type the board ring-fenced after it was written, then or once the ring-fence is gone", async () => {
    const type = await createIssueTypeFixture(prisma, {
      id: `wo-type-fenced-late-${suffix}`,
      name: `Grannar sent ${suffix}`,
      reporters: ["RESIDENTS"],
    });
    typeIds.fencedLate = type.id;
    const issueId = await filed(type, "fenced-before-claim");
    const sent = (
      await previewAndSend(as(board), issueId, {
        contractorId: plumber.id,
        body: "Byt tätningen i entrédörren.",
      })
    ).json<WorkOrderRow>();
    expect(sent.deliveryStatus).toBe("PENDING");

    const send = vi.spyOn(mail, "send");
    try {
      // The ring-fence commits while the work order waits on the queue.
      expect((await setRingFence(type.id, true)).statusCode).toBe(200);
      expect(await mailer.send(sent.id)).toBe("failed");
      expect(send).not.toHaveBeenCalled();

      // Settled: a retry of the job sends nothing either, even with the
      // ring-fence gone. The board cannot lift it from a type with issues, so
      // the column is cleared directly: the settled record is what refuses.
      await prisma.issueType.update({
        where: { id: type.id },
        data: { ringFenced: false },
      });
      expect(await mailer.send(sent.id)).toBe("skipped");
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
    }
    expect(
      await prisma.workOrder.findUniqueOrThrow({
        where: { id: sent.id },
        select: {
          deliveryStatus: true,
          deliveryFailure: true,
          claimedAt: true,
        },
      }),
    ).toEqual({
      deliveryStatus: "FAILED",
      deliveryFailure: "ring-fenced",
      claimedAt: null,
    });
  });

  it("makes a claim wait for a ring-fence being set on the type, and then sends nothing", async () => {
    const type = await createIssueTypeFixture(prisma, {
      id: `wo-type-fencing-${suffix}`,
      name: `Grannar samtidigt ${suffix}`,
      reporters: ["RESIDENTS"],
    });
    typeIds.fencing = type.id;
    const issueId = await filed(type, "fenced-during-claim");
    const sent = (
      await previewAndSend(as(board), issueId, {
        contractorId: plumber.id,
        body: "Laga brevinkastet.",
      })
    ).json<WorkOrderRow>();

    // Holds the ring-fence's transaction open at its audit entry: the type is
    // locked and changed, and nothing of it is committed.
    const audit = app.get(AuditLogService);
    const record = audit.record.bind(audit);
    const fence = gate();
    const recording = vi
      .spyOn(audit, "record")
      .mockImplementation(async (entry, client) => {
        if (
          entry.action === "ISSUE_TYPE_RING_FENCE_CHANGED" &&
          entry.targetId === type.id
        ) {
          fence.reach();
          await fence.opened;
        }
        return record(entry, client);
      });
    const send = vi.spyOn(mail, "send");
    try {
      const fencing = setRingFence(type.id, true);
      await fence.reached;

      // A worker that read the type without its lock would find it open, and
      // claim and mail the work order now.
      const running = mailer.send(sent.id);
      await waitFor(
        async () =>
          (await advisoryLockCount(prisma, `issue-type:${type.id}`, false)) >
          0n,
      );
      expect(send).not.toHaveBeenCalled();

      fence.open();
      expect((await fencing).statusCode).toBe(200);
      expect(await running).toBe("failed");
      expect(send).not.toHaveBeenCalled();
    } finally {
      fence.open();
      recording.mockRestore();
      send.mockRestore();
    }
    expect(
      await prisma.workOrder.findUniqueOrThrow({
        where: { id: sent.id },
        select: {
          deliveryStatus: true,
          deliveryFailure: true,
          claimedAt: true,
        },
      }),
    ).toEqual({
      deliveryStatus: "FAILED",
      deliveryFailure: "ring-fenced",
      claimedAt: null,
    });
  });

  it("makes a sending wait for the lock on its sender", async () => {
    const issueId = await filed(plain, "sender-lock");
    const payload = {
      contractorId: plumber.id,
      body: `Byt packning. ${suffix}`,
    };
    const preview = await workOrder(as(board), issueId, payload, "preview");
    const { previewToken } = preview.json<{ previewToken: string }>();

    // The purge of a handler's data takes this lock before it detaches the
    // sender from their work orders (`purge.int-spec.ts` holds it from the
    // other side). The key is spelled out, so a sending that changed it fails
    // here instead of passing under a new name.
    const key = `work-order-sender:${board.personId}`;
    const holding = gate();
    const held = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        holding.reach();
        await holding.opened;
      },
      { timeout: 30_000 },
    );
    let sending: ReturnType<typeof workOrder> | undefined;
    try {
      // A rejected holder (its lock or update failed) fails the test here, not
      // after the gate times out.
      await Promise.race([holding.reached, held]);
      sending = workOrder(as(board), issueId, { ...payload, previewToken });
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, false)) > 0n,
      );
      // Queued behind the holder, nothing is written yet.
      expect(await prisma.workOrder.count({ where: { issueId } })).toBe(0);
    } finally {
      holding.open();
      await held.catch(() => undefined);
      // A failure above stays the test's own: the queued sending is awaited
      // here, not left to finish while the next test and `afterAll` run.
      await sending?.catch(() => undefined);
    }
    await held;
    expect((await sending)?.statusCode).toBe(201);
    expect(await prisma.workOrder.count({ where: { issueId } })).toBe(1);
  });

  it("checks a board-only issue's access after the lock on its sender, so a seat that ends while the sending waits refuses it", async () => {
    const issueId = await filed(boardOnly, "sender-lock-seat");
    const payload = {
      contractorId: plumber.id,
      body: `Byt kran. ${suffix}`,
    };
    const preview = await workOrder(as(board), issueId, payload, "preview");
    expect(preview.statusCode).toBe(200);
    const { previewToken } = preview.json<{ previewToken: string }>();

    // The board's access is the seat, not a system role, so the seat is what
    // ends while the sending waits. A sending that read the access before it
    // took the lock would still find the seat and write the work order.
    const key = `work-order-sender:${board.personId}`;
    const holding = gate();
    const released = gate();
    const held = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        await tx.boardPosition.updateMany({
          where: { personId: board.personId },
          data: { endedOn: new Date("2025-06-01") },
        });
        holding.reach();
        await released.opened;
      },
      { timeout: 30_000 },
    );
    let sending: ReturnType<typeof workOrder> | undefined;
    try {
      // A rejected holder (its lock or update failed) fails the test here, not
      // after the gate times out.
      await Promise.race([holding.reached, held]);
      sending = workOrder(as(board), issueId, { ...payload, previewToken });
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, false)) > 0n,
      );
      expect(await prisma.workOrder.count({ where: { issueId } })).toBe(0);
      // The commit publishes the ended seat together with the lock's release.
      released.open();
      await held;
      const refused = await sending;
      expect(refused.statusCode).toBe(404);
      expect(refused.json<{ reason: string }>().reason).toBe("issue-not-found");
      expect(await prisma.workOrder.count({ where: { issueId } })).toBe(0);
    } finally {
      released.open();
      await held.catch(() => undefined);
      await sending?.catch(() => undefined);
      // Later tests act as the board.
      await prisma.boardPosition.updateMany({
        where: { personId: board.personId },
        data: { endedOn: null },
      });
    }
  });

  /** The issue's work orders and its entries in the audit log. */
  async function standing(issueId: string) {
    return {
      workOrders: await prisma.workOrder.count({ where: { issueId } }),
      entries: await prisma.auditLogEntry.count({
        where: { targetId: issueId },
      }),
    };
  }

  it("refuses a sender who holds no issues:handle role, past the route's guard", async () => {
    const issueId = await filed(plain, "no-role");
    const payload = {
      contractorId: plumber.id,
      body: `Byt silen. ${suffix}`,
    };
    const orders = app.get(WorkOrderService);
    // The preview only reads. It is asked here so the token is valid, and
    // only the role check is left to refuse the sending.
    const { previewToken } = await orders.preview(
      resident.personId,
      issueId,
      payload,
    );
    const before = await standing(issueId);

    // The resident reads as the narrower scope, which admits every issue of an
    // every-handler type: only the role check refuses.
    await expect(
      orders.send(resident.personId, issueId, { ...payload, previewToken }),
    ).rejects.toMatchObject({ reason: "issue-not-found" });
    expect(await standing(issueId)).toEqual(before);
  });

  it("asks the sender's role after the lock on its sender, so a role withdrawn while the sending waits refuses it", async () => {
    const issueId = await filed(plain, "sender-lock-role");
    const payload = {
      contractorId: plumber.id,
      body: `Byt ventilen. ${suffix}`,
    };
    await prisma.systemRole.create({
      data: { personId: resident.personId, role: "PROPERTY_MANAGER" },
    });
    const key = `work-order-sender:${resident.personId}`;
    const holding = gate();
    const released = gate();
    let held: Promise<void> | undefined;
    let sending: ReturnType<typeof workOrder> | undefined;
    try {
      const preview = await workOrder(
        as(resident),
        issueId,
        payload,
        "preview",
      );
      expect(preview.statusCode).toBe(200);
      const { previewToken } = preview.json<{ previewToken: string }>();
      const before = await standing(issueId);

      // The role is withdrawn under the sender's lock, and the withdrawal
      // commits with the lock's release. The person then reads as the
      // narrower scope, which still admits this issue: a sending that did not
      // ask the role once its locks were held would write the work order.
      held = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
          await tx.systemRole.deleteMany({
            where: { personId: resident.personId },
          });
          holding.reach();
          await released.opened;
        },
        { timeout: 30_000 },
      );
      // A rejected holder fails the test here, not after the gate times out.
      await Promise.race([holding.reached, held]);
      sending = workOrder(as(resident), issueId, { ...payload, previewToken });
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, false)) > 0n,
      );
      released.open();
      await held;
      const refused = await sending;
      expect(refused.statusCode).toBe(404);
      expect(refused.json<{ reason: string }>().reason).toBe("issue-not-found");
      expect(await standing(issueId)).toEqual(before);
    } finally {
      released.open();
      await held?.catch(() => undefined);
      await sending?.catch(() => undefined);
      // Later tests read the resident as a resident.
      await prisma.systemRole.deleteMany({
        where: { personId: resident.personId },
      });
    }
  });

  it("claims a work order once, and mails it once, when two workers run it together", async () => {
    const issueId = await filed(plain, "claimed-once");
    const sent = (
      await previewAndSend(as(board), issueId, {
        contractorId: plumber.id,
        body: "Rensa stuprännorna.",
      })
    ).json<WorkOrderRow>();

    const send = vi
      .spyOn(mail, "send")
      .mockResolvedValue({ messageId: "claimed-once" });
    try {
      const outcomes = await Promise.allSettled([
        mailer.send(sent.id),
        mailer.send(sent.id),
      ]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        outcomes.filter(
          (outcome) =>
            outcome.status === "fulfilled" && outcome.value === "sent",
        ),
      ).toHaveLength(1);
    } finally {
      send.mockRestore();
    }
  });

  it("binds a contractor's address and a work order's recipient to their own rows", async () => {
    const stored = await prisma.contractor.findUniqueOrThrow({
      where: { id: plumber.id },
      select: { emailCipher: true },
    });
    if (stored.emailCipher === null) {
      throw new Error("The plumber has no address.");
    }
    await expect(
      encryption.decrypt("contractor.email", stored.emailCipher, plumber.id),
    ).resolves.toBe(plumber.email);
    // The same cipher moved onto another contractor's row does not decrypt.
    await expect(
      encryption.decrypt("contractor.email", stored.emailCipher, "another-row"),
    ).rejects.toThrow();
  });
});
