import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { PersonService } from "../address-book/person.service";
import { AuditLogService } from "../audit/audit-log.service";
import { AuthService } from "../auth/auth.service";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { registerMultipart } from "../http/multipart";
import { IssueFreeTextService } from "../issues/issue-free-text.service";
import { lockHouseholdProtection } from "../issues/issue-lock";
import {
  type IssueNoticeJob,
  IssueMailer,
} from "../issues/issue-mailer.service";
import {
  mintReporterLinkToken,
  reporterLinkDigest,
} from "../issues/issue-reporter-link-token";
import {
  revokeLinksOfProtectedHousehold,
  WORK_ORDER_LINK_DAYS,
} from "../issues/work-order-link";
import {
  WORK_ORDER_LINK_NOTES_PER_HOUR,
  WORK_ORDER_LINK_PHOTOS_PER_WORK_ORDER,
  WorkOrderLinkService,
} from "../issues/work-order-link.service";
import {
  WORK_ORDER_LINK_TOKEN_PREFIX,
  workOrderLinkDigest,
} from "../issues/work-order-link-token";
import type { SendMailInput } from "../mail/mail.service";
import { MailService } from "../mail/mail.service";
import type { SentMail } from "../mail/mail-driver";
import { MediaService } from "../media/media.service";
import {
  exifWithGps,
  GPS_MARKER,
  gifBytes,
  jpegBytes,
  jpegMetadataSegments,
  pngBytes,
  pngChunk,
  webpLossyBytes,
} from "../media/testing/image-fixtures";
import { MoveService } from "../moves/move.service";
import { StorageService } from "../storage/storage.service";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
} from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { WORK_ORDER_LINK_READS_PER_MINUTE } from "./site-work-order-link.controller";

/**
 * The page a contractor's link to a work order opens, through the application
 * as it boots (`createApplication`, so the header hooks are the real ones), a
 * real database and the real rate limiter (decision 24, ADR 0055).
 *
 * Each `describe` is one group of the controls the threat review of the links
 * required (APT-9360, A to K), and each test fails when the control it names is
 * taken out. The suite runs with the legal gate's switch on, and boots a
 * second application with it off, as a release ships it (B6).
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let off: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let links: WorkOrderLinkService;
let media: MediaService;
let storage: StorageService;
let mail: MailService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

/** Text that may appear on no contractor's page, in any form. */
const CANARY = {
  description: `KanarieBeskrivning${suffix}`,
  location: `KanarieLagenhet${suffix}`,
  message: `KanarieMeddelande${suffix}`,
  note: `KanarieAnteckning${suffix}`,
  otherOrder: `KanarieAnnanOrder${suffix}`,
  otherContractor: `KanarieAnnanFirma${suffix}`,
  reporterName: `KanarieAnmalare${suffix}`,
  assigneeName: `KanarieAnsvarig${suffix}`,
  typeName: `KanarieTyp${suffix}`,
};

function person(key: string, firstName: string, lastName: string) {
  return {
    personId: `wl-${key}-${suffix}`,
    email: `wl-${key}-${suffix}@exempel.se`,
    firstName,
    lastName,
  };
}

const board = person("board", "Bea", CANARY.assigneeName);
const manager = person("manager", "Frida", `Forvaltare${suffix}`);
const resident = person("resident", "Rune", CANARY.reporterName);
const people = [board, manager, resident];
const personIds = people.map((entry) => entry.personId);

let plain: IssueTypeFixture;
let fenced: IssueTypeFixture;
const typeIds = () => [plain.id, fenced.id];

let contractorId: string;

/** Every mail the application handed to the mail server. */
const sent: SendMailInput<unknown>[] = [];

let ipCounter = 0;
/** A distinct forwarded address per request, in this suite's 10.212.0.0/16. */
function nextAddress(): string {
  ipCounter += 1;
  return `10.212.${String(Math.floor(ipCounter / 254) % 254)}.${String((ipCounter % 254) + 1)}`;
}

function inject(
  options: {
    method: "GET" | "POST" | "HEAD" | "PUT" | "DELETE";
    url: string;
    payload?: string | Buffer | object;
    headers?: Record<string, string>;
    address?: string;
    cookie?: string;
  },
  on: NestFastifyApplication = app,
) {
  return on
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        "x-forwarded-for": options.address ?? nextAddress(),
        "accept-language": "sv-SE,sv;q=0.9",
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...options.headers,
      },
    });
}

function page(token: string, on?: NestFastifyApplication, address?: string) {
  return inject(
    {
      method: "GET",
      url: `/arbetsorder/${token}`,
      ...(address === undefined ? {} : { address }),
    },
    on,
  );
}

/** An act as the page's forms post it. */
function act(
  token: string,
  fields: Record<string, string>,
  options: {
    headers?: Record<string, string>;
    address?: string;
    on?: NestFastifyApplication;
  } = {},
) {
  return inject(
    {
      method: "POST",
      url: `/arbetsorder/${token}`,
      payload: new URLSearchParams(fields).toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...options.headers,
      },
      ...(options.address === undefined ? {} : { address: options.address }),
    },
    options.on,
  );
}

const BOUNDARY = "----obrfworkorderlink";

/** A photograph as the page's upload form posts it. */
function upload(
  token: string,
  bytes: Buffer,
  options: {
    fileName?: string;
    contentType?: string;
    address?: string;
    headers?: Record<string, string>;
    on?: NestFastifyApplication;
  } = {},
) {
  const payload = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="photo"; filename="${options.fileName ?? "IMG_0001.jpg"}"\r\nContent-Type: ${options.contentType ?? "image/jpeg"}\r\n\r\n`,
      "latin1",
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "latin1"),
  ]);
  return inject(
    {
      method: "POST",
      url: `/arbetsorder/${token}/foto`,
      payload,
      headers: {
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        ...options.headers,
      },
      ...(options.address === undefined ? {} : { address: options.address }),
    },
    options.on,
  );
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: JSON.stringify({ email, password: PASSWORD }),
    headers: { "content-type": "application/json" },
  });
  const setCookie = response.headers["set-cookie"];
  const values = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return values.map((value) => value.split(";")[0]).join("; ");
}

const cookies: Record<string, string> = {};
const as = (entry: { personId: string }): string =>
  cookies[entry.personId] ?? "";

/** A small image, stored as an issue's photographs are. */
async function storedPhoto(): Promise<string> {
  const file = await media.upload({
    bytes: pngBytes(4, 4),
    fileName: `${CANARY.location}.png`,
    visibility: "INTERNAL",
    requiredCapability: "issues:handle",
    showsIdentifiablePersons: true,
    channel: "SYSTEM",
    recordFileName: false,
  });
  return file.id;
}

interface Arranged {
  issueId: string;
  number: number;
  workOrderId: string;
  /** The reporter's photograph chosen for the link. */
  chosenFileId: string;
  /** The reporter's photograph not chosen. */
  unchosenFileId: string;
  /** A second work order on the same issue, with a photograph of its own. */
  otherWorkOrderId: string;
}

let arranged = 0;

/**
 * An issue a resident reported, with every sensitive field filled with a
 * canary (control H1), two photographs, a note, a message, and two work
 * orders: the one a link is issued for, and another.
 */
async function arrange(
  options: { type?: IssueTypeFixture; boardOnly?: boolean } = {},
): Promise<Arranged> {
  arranged += 1;
  const type = options.type ?? plain;
  const issue = await prisma.issue.create({
    data: {
      id: `wl-issue-${String(arranged)}-${suffix}`,
      typeId: type.id,
      statusId: type.statusIds.IN_PROGRESS,
      reporterPersonId: resident.personId,
      assigneePersonId: board.personId,
      boardOnly: options.boardOnly ?? false,
      location: CANARY.location,
      description: CANARY.description,
      waitingReason: null,
    },
    select: { id: true, number: true },
  });
  await prisma.issueNote.create({
    data: {
      issueId: issue.id,
      authorPersonId: board.personId,
      body: CANARY.note,
    },
  });
  await prisma.issueMessage.create({
    data: {
      issueId: issue.id,
      side: "REPORTER",
      authorPersonId: resident.personId,
      body: CANARY.message,
    },
  });
  const chosenFileId = await storedPhoto();
  const unchosenFileId = await storedPhoto();
  await prisma.issuePhoto.createMany({
    data: [
      { issueId: issue.id, fileId: chosenFileId, sortOrder: 0 },
      { issueId: issue.id, fileId: unchosenFileId, sortOrder: 1 },
    ],
  });
  const order = await prisma.workOrder.create({
    data: {
      issueId: issue.id,
      contractorId,
      recipientName: `Rörfirman ${suffix}`,
      body: `Byt packningen i köksblandaren ${suffix}`,
      sentByPersonId: board.personId,
      deliveryStatus: "SENT",
    },
    select: { id: true },
  });
  const other = await prisma.workOrder.create({
    data: {
      issueId: issue.id,
      contractorId: null,
      recipientName: CANARY.otherContractor,
      body: CANARY.otherOrder,
      sentByPersonId: board.personId,
      deliveryStatus: "SENT",
    },
    select: { id: true },
  });
  return {
    issueId: issue.id,
    number: issue.number,
    workOrderId: order.id,
    chosenFileId,
    unchosenFileId,
    otherWorkOrderId: other.id,
  };
}

function linkUrl(issueId: string, workOrderId: string) {
  return `/api/issue-queue/${issueId}/work-orders/${workOrderId}/link`;
}

/** Issues a link as the board does, and answers its token. */
async function issued(
  issueId: string,
  workOrderId: string,
): Promise<{ token: string; url: string; expiresAt: string }> {
  const response = await inject({
    method: "POST",
    url: linkUrl(issueId, workOrderId),
    cookie: as(board),
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ url: string; expiresAt: string }>();
  const match = /\/arbetsorder\/(obrf_wo_[A-Za-z0-9_-]{43})$/.exec(body.url);
  if (match?.[1] === undefined) {
    throw new Error("No token in the link.");
  }
  return { token: match[1], ...body };
}

/** The board chooses photographs for a work order's link. */
function choose(issueId: string, workOrderId: string, fileIds: string[]) {
  return inject({
    method: "PUT",
    url: `/api/issue-queue/${issueId}/work-orders/${workOrderId}/photos`,
    payload: { fileIds },
    cookie: as(board),
  });
}

/** A work order with a live link, its photograph chosen. */
async function linked(options: Parameters<typeof arrange>[0] = {}) {
  const ids = await arrange(options);
  const chosen = await choose(ids.issueId, ids.workOrderId, [ids.chosenFileId]);
  expect(chosen.statusCode).toBe(204);
  const link = await issued(ids.issueId, ids.workOrderId);
  return { ...ids, ...link };
}

interface ListedWorkOrder {
  id: string;
  contractorLink: {
    link: { state: string; expiresAt: string | null };
    answer: string | null;
    chosenFileIds: string[];
    notes: { id: string; body: string; redactedAt: string | null }[];
    files: { id: string; url: string; fileName: string }[];
  };
}

async function listed(issueId: string, on: NestFastifyApplication = app) {
  const response = await inject(
    {
      method: "GET",
      url: `/api/issue-queue/${issueId}/work-orders`,
      cookie: as(board),
    },
    on,
  );
  expect(response.statusCode).toBe(200);
  return response.json<{
    linksEnabled: boolean;
    choosablePhotos: { fileId: string }[];
    protectedHousehold: boolean;
    workOrders: ListedWorkOrder[];
  }>();
}

async function listedOrder(issueId: string, workOrderId: string) {
  const order = (await listed(issueId)).workOrders.find(
    (row) => row.id === workOrderId,
  );
  if (order === undefined) {
    throw new Error("The work order is not listed.");
  }
  return order;
}

/** Every header but the ones that vary with the moment or the body. */
function stableHeaders(
  headers: Record<string, unknown>,
): Record<string, unknown> {
  const { date: _date, ...rest } = headers;
  return rest;
}

/** The headers every answer on a link's path carries (F1). */
function expectLinkHeaders(headers: Record<string, unknown>): void {
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["x-robots-tag"]).toContain("noindex");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  const policy = String(headers["content-security-policy"]);
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("form-action 'self'");
  expect(policy).toContain("frame-ancestors 'none'");
  // F4, E3.
  expect(headers.etag).toBeUndefined();
  expect(headers["last-modified"]).toBeUndefined();
  expect(headers["access-control-allow-origin"]).toBeUndefined();
  expect(headers["set-cookie"]).toBeUndefined();
}

/** Everything a GET could write, for one work order (E1). */
async function snapshot(issueId: string, workOrderId: string) {
  const [issue, order, linkRows, notes, files, audit, jobs] = await Promise.all(
    [
      prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { updatedAt: true, statusId: true },
      }),
      prisma.workOrder.findUniqueOrThrow({ where: { id: workOrderId } }),
      prisma.workOrderLink.findMany({
        where: { workOrderId },
        orderBy: { id: "asc" },
      }),
      prisma.workOrderNote.count({ where: { workOrderId } }),
      prisma.workOrderFile.count({ where: { workOrderId } }),
      prisma.auditLogEntry.count({ where: { targetId: issueId } }),
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM pgboss.job WHERE data->>'issueId' = ${issueId}`,
    ],
  );
  return {
    issue,
    order,
    linkRows,
    notes,
    files,
    audit,
    jobs: Number(jobs[0]?.count ?? 0),
  };
}

async function auditFor(issueId: string) {
  return prisma.auditLogEntry.findMany({
    where: { targetKind: "issue", targetId: issueId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** An unknown token of the right form. */
const unknownToken = () => `${WORK_ORDER_LINK_TOKEN_PREFIX}${"Q".repeat(43)}`;

/** The switch as the suite found it, put back afterwards. */
const SWITCH = "OPENBRF_CONTRACTOR_LINKS_ENABLED";
const switchBefore = process.env[SWITCH];

beforeAll(async () => {
  const env: Env = {
    ...baseEnv,
    OPENBRF_PLUGINS_ENABLED: false,
    OPENBRF_CONTRACTOR_LINKS_ENABLED: true,
  };
  // The application reads its configuration from the environment as it boots.
  process.env[SWITCH] = "true";
  app = await createApplication(await loadPluginsAtBoot(env));
  // As main.ts does: the parser is global, which is why the upload route
  // resolves the token before it reads the body (G1).
  await registerMultipart(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // The release as it ships: the switch off (decision 25, B6).
  const offEnv: Env = { ...env, OPENBRF_CONTRACTOR_LINKS_ENABLED: false };
  process.env[SWITCH] = "false";
  off = await createApplication(await loadPluginsAtBoot(offEnv));
  await registerMultipart(off, offEnv);
  await off.init();
  await off.getHttpAdapter().getInstance().ready();
  restoreEnvironmentVariable(SWITCH, switchBefore);
  expect(app.get(WorkOrderLinkService).enabled).toBe(true);
  expect(off.get(WorkOrderLinkService).enabled).toBe(false);

  prisma = app.get(PrismaService);
  encryption = app.get(FieldEncryptionService);
  links = app.get(WorkOrderLinkService);
  media = app.get(MediaService);
  storage = app.get(StorageService);
  mail = app.get(MailService);
  vi.spyOn(mail, "send").mockImplementation(async (input) => {
    sent.push(input as SendMailInput<unknown>);
    return { messageId: `<wl-${String(sent.length)}@exempel.se>` } as SentMail;
  });

  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet", setupCompletedAt: new Date() },
    update: { setupCompletedAt: new Date() },
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
    id: `wl-type-plain-${suffix}`,
    name: CANARY.typeName,
    reporters: ["RESIDENTS"],
  });
  fenced = await createIssueTypeFixture(prisma, {
    id: `wl-type-fenced-${suffix}`,
    name: `Störningar ${suffix}`,
    reporters: ["RESIDENTS"],
  });
  const contractor = await prisma.contractor.create({
    data: { name: `Rörfirman ${suffix}`, trade: "Rörmokare" },
    select: { id: true },
  });
  contractorId = contractor.id;

  for (const entry of people) {
    cookies[entry.personId] = await signIn(entry.email);
  }
}, 240_000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(mail, "send").mockImplementation(async (input) => {
    sent.push(input as SendMailInput<unknown>);
    return { messageId: `<wl-${String(sent.length)}@exempel.se>` } as SentMail;
  });
});

afterAll(async () => {
  const issues = await prisma.issue.findMany({
    where: { typeId: { in: typeIds() } },
    select: {
      photos: { select: { fileId: true } },
      workOrders: { select: { files: { select: { fileId: true } } } },
    },
  });
  const fileIds = issues.flatMap((issue) => [
    ...issue.photos.map((photo) => photo.fileId),
    ...issue.workOrders.flatMap((order) => order.files.map((f) => f.fileId)),
  ]);
  await prisma.issue.deleteMany({ where: { typeId: { in: typeIds() } } });
  for (const fileId of fileIds) {
    await media.remove(fileId, null, "SYSTEM", { recordFileName: false });
  }
  await prisma.contractor.deleteMany({ where: { id: contractorId } });
  await prisma.issueType.deleteMany({ where: { id: { in: typeIds() } } });
  await prisma.session.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.account.deleteMany({
    where: { user: { personId: { in: personIds } } },
  });
  await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.boardPosition.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.systemRole.deleteMany({
    where: { personId: { in: personIds } },
  });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await off.close();
  await app.close();
});

describe("a contractor with a link", () => {
  it("reads the work order, accepts it, writes a note, adds a photograph and marks it done", async () => {
    const ids = await linked();

    const read = await page(ids.token);
    expect(read.statusCode).toBe(200);
    expect(read.body).toContain(`Byt packningen i köksblandaren ${suffix}`);
    expect(read.body).toContain(
      `/arbetsorder/${ids.token}/foto/${ids.chosenFileId}`,
    );

    const accepted = await act(ids.token, { act: "accept" });
    expect(accepted.statusCode).toBe(303);
    expect(accepted.headers.location).toBe(
      `/arbetsorder/${ids.token}?svar=accepted`,
    );

    const noted = await act(ids.token, {
      act: "note",
      body: `Kommer på torsdag ${suffix}`,
    });
    expect(noted.headers.location).toBe(`/arbetsorder/${ids.token}?svar=noted`);

    const photo = await upload(ids.token, jpegBytes(8, 8));
    expect(photo.statusCode).toBe(303);
    expect(photo.headers.location).toBe(
      `/arbetsorder/${ids.token}?svar=photo-added`,
    );

    const order = await listedOrder(ids.issueId, ids.workOrderId);
    expect(order.contractorLink.link.state).toBe("live");
    expect(order.contractorLink.answer).toBe("ACCEPTED");
    expect(order.contractorLink.notes.map((note) => note.body)).toEqual([
      `Kommer på torsdag ${suffix}`,
    ]);
    expect(order.contractorLink.files).toHaveLength(1);
    // G11: handlers read it through the media route, never inline.
    expect(order.contractorLink.files[0]?.url).toMatch(/^\/api\/media\//);
    const served = await inject({
      method: "GET",
      url: order.contractorLink.files[0]?.url ?? "",
      cookie: as(board),
    });
    expect(served.statusCode).toBe(200);

    const done = await act(ids.token, { act: "done" });
    // E6: answered on the spot, with no address of the link that just ended.
    expect(done.statusCode).toBe(200);
    expect(done.body).not.toContain(ids.token);
    expect(done.body).not.toContain("/arbetsorder/");
    expect((await page(ids.token)).statusCode).toBe(404);

    const after = await listedOrder(ids.issueId, ids.workOrderId);
    expect(after.contractorLink.answer).toBe("DONE");
    expect(after.contractorLink.link.state).toBe("ended");

    const timeline = await inject({
      method: "GET",
      url: `/api/issue-queue/${ids.issueId}/timeline`,
      cookie: as(board),
    });
    expect(timeline.statusCode).toBe(200);
    // The answers, as steps with no actor: whoever held the link gave them.
    expect(JSON.stringify(timeline.json())).toContain(
      '"kind":"workOrderAnswer"',
    );
  });

  it("H7: tells the handlers, with no word the contractor wrote", async () => {
    const ids = await linked();
    const text = `Packningen var sprucken ${suffix}`;
    await act(ids.token, { act: "note", body: text });

    const jobs = await prisma.$queryRaw<{ data: IssueNoticeJob }[]>`
      SELECT data FROM pgboss.job
      WHERE name = 'issue-notice' AND data->>'issueId' = ${ids.issueId}`;
    expect(jobs.map((job) => job.data.event)).toEqual(["contractor"]);
    expect(JSON.stringify(jobs)).not.toContain(text);

    const before = sent.length;
    const job = jobs[0]?.data;
    if (job === undefined) {
      throw new Error("No notice was queued.");
    }
    expect(await app.get(IssueMailer).deliver(job)).toBe(true);
    const mailed = sent.slice(before);
    expect(mailed).toHaveLength(1);
    expect(JSON.stringify(mailed[0]?.props)).not.toContain(text);
    expect(JSON.stringify(mailed[0]?.props)).not.toContain(ids.token);
  });

  it("H7: notes in an hour are told of once, and the answer that ends the link after them is told of too", async () => {
    const ids = await linked();
    await act(ids.token, { act: "note", body: `Kommer klockan tio ${suffix}` });
    await act(ids.token, { act: "note", body: `Blir lite sen ${suffix}` });
    const done = await act(ids.token, { act: "done" });
    expect(done.statusCode).toBe(200);

    const jobs = await prisma.$queryRaw<{ data: IssueNoticeJob }[]>`
      SELECT data FROM pgboss.job
      WHERE name = 'issue-notice' AND data->>'issueId' = ${ids.issueId}
      ORDER BY created_on`;
    // One for the notes, the second note throttled; one for done.
    expect(jobs.map((job) => [job.data.event, job.data.contractor])).toEqual([
      ["contractor", "activity"],
      ["contractor", "answer"],
    ]);
    const before = sent.length;
    for (const job of jobs) {
      expect(await app.get(IssueMailer).deliver(job.data)).toBe(true);
    }
    expect(sent.slice(before)).toHaveLength(2);
  });
});

describe("A. the token", () => {
  it("A1, A6: is 32 random bytes behind the contractor's prefix, in one address built from APP_URL", async () => {
    const ids = await linked();
    expect(ids.url).toBe(
      `${new URL(baseEnv.APP_URL).origin}${new URL(baseEnv.APP_URL).pathname.replace(/\/+$/, "")}/arbetsorder/${ids.token}`,
    );
    expect(
      Buffer.from(
        ids.token.slice(WORK_ORDER_LINK_TOKEN_PREFIX.length),
        "base64url",
      ),
    ).toHaveLength(32);
    // The address is in the path; no query or fragment carries it.
    expect(new URL(ids.url).search).toBe("");
  });

  it("A2: is stored as its SHA-256 digest and nowhere as itself", async () => {
    const logged: string[] = [];
    for (const level of ["log", "warn", "error", "debug"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (...parts: unknown[]) => {
          logged.push(parts.map(String).join(" "));
        },
      );
    }
    const ids = await linked();
    const rows = await prisma.workOrderLink.findMany({
      where: { workOrderId: ids.workOrderId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenDigest).toBe(workOrderLinkDigest(ids.token));
    const everything = JSON.stringify({
      rows,
      audit: await auditFor(ids.issueId),
      jobs: await prisma.$queryRaw`
        SELECT data FROM pgboss.job WHERE data->>'issueId' = ${ids.issueId}`,
      order: await prisma.workOrder.findUnique({
        where: { id: ids.workOrderId },
      }),
    });
    expect(everything).not.toContain(ids.token);
    expect(logged.join("\n")).not.toContain(ids.token);
  });

  it("A3: is read from the path alone, and a malformed one is refused before the database is asked", async () => {
    const ids = await linked();
    // Beside the path, the token opens nothing.
    expect(
      (await inject({ method: "GET", url: `/arbetsorder?token=${ids.token}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await inject({
          method: "GET",
          url: "/arbetsorder/x",
          headers: { authorization: `Bearer ${ids.token}` },
        })
      ).statusCode,
    ).toBe(404);

    const asked = vi.spyOn(prisma, "$transaction");
    for (const value of [
      WORK_ORDER_LINK_TOKEN_PREFIX,
      ids.token.slice(0, -1),
      `${ids.token}A`,
      ids.token.replace("obrf_wo_", "obrf_xx_"),
    ]) {
      expect((await page(encodeURIComponent(value))).statusCode).toBe(404);
    }
    expect(asked).not.toHaveBeenCalled();

    // A post to an address that is not a token's is refused as the read of it
    // is, not by the framework's own 404, which would tell the two apart.
    const refusal = await page(unknownToken());
    for (const url of [
      `/arbetsorder/${WORK_ORDER_LINK_TOKEN_PREFIX}short`,
      "/arbetsorder/x/y",
    ]) {
      const posted = await inject({
        method: "POST",
        url,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "act=accept",
      });
      expect(posted.statusCode).toBe(404);
      expect(posted.headers["content-type"]).toBe(
        refusal.headers["content-type"],
      );
      expect(posted.body).toBe(refusal.body);
    }
  });

  it("A4: a reporter's token here and a contractor's at the reporter's page each get the refusal", async () => {
    const ids = await linked();
    const reporterToken = mintReporterLinkToken();
    const cipher = await encryption.encrypt(
      "issue.reporterEmail",
      `wl-public-${suffix}@exempel.se`,
    );
    const issue = await prisma.issue.create({
      data: {
        typeId: plain.id,
        statusId: plain.statusIds.NEW,
        description: "Porten",
        reporterEmailCipher: cipher.cipher,
        reporterEmailIndex: cipher.index ?? null,
      },
      select: { id: true },
    });
    await prisma.issueReporterLink.create({
      data: {
        issueId: issue.id,
        tokenDigest: reporterLinkDigest(reporterToken),
        mailedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    expect(
      (await inject({ method: "GET", url: `/arende/${reporterToken}` }))
        .statusCode,
    ).toBe(200);

    const unknown = await page(unknownToken());
    const reporterHere = await page(reporterToken);
    expect(reporterHere.statusCode).toBe(404);
    expect(reporterHere.body).toBe(unknown.body);
    expect(
      (await inject({ method: "GET", url: `/arende/${ids.token}` })).statusCode,
    ).toBe(404);
  });

  it("A5: is shown once; a new link revokes the old one, which answers 404 on the next request", async () => {
    const ids = await linked();
    expect(JSON.stringify(await listed(ids.issueId))).not.toContain(ids.token);

    const second = await issued(ids.issueId, ids.workOrderId);
    expect(second.token).not.toBe(ids.token);
    expect((await page(ids.token)).statusCode).toBe(404);
    expect((await page(second.token)).statusCode).toBe(200);

    const actions = (await auditFor(ids.issueId)).map((entry) => entry.action);
    expect(
      actions.filter((a) => a === "ISSUE_WORK_ORDER_LINK_ISSUED"),
    ).toHaveLength(2);
    expect(actions).toContain("ISSUE_WORK_ORDER_LINK_REVOKED");
  });
});

describe("B. lifetime and revocation", () => {
  it("B1: a withdrawn link answers 404 on the very next request", async () => {
    const ids = await linked();
    expect((await page(ids.token)).statusCode).toBe(200);
    const withdrawn = await inject({
      method: "DELETE",
      url: linkUrl(ids.issueId, ids.workOrderId),
      cookie: as(board),
    });
    expect(withdrawn.statusCode).toBe(204);
    expect((await page(ids.token)).statusCode).toBe(404);
    expect(
      (await listedOrder(ids.issueId, ids.workOrderId)).contractorLink.link
        .state,
    ).toBe("ended");
  });

  it("B2: ends 30 days after it was issued, on the database's clock", async () => {
    const ids = await linked();
    const [row] = await prisma.workOrderLink.findMany({
      where: { workOrderId: ids.workOrderId },
    });
    expect(row).toBeDefined();
    expect(
      (row?.expiresAt.getTime() ?? 0) - (row?.issuedAt.getTime() ?? 0),
    ).toBe(WORK_ORDER_LINK_DAYS * 86_400_000);
    await prisma.workOrderLink.updateMany({
      where: { workOrderId: ids.workOrderId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await page(ids.token)).statusCode).toBe(404);
  });

  it("B1, B3: a decline ends the link", async () => {
    const ids = await linked();
    const declined = await act(ids.token, { act: "decline" });
    expect(declined.statusCode).toBe(200);
    expect(declined.body).not.toContain(ids.token);
    expect((await page(ids.token)).statusCode).toBe(404);
    // And no new link opens a declined work order.
    const again = await inject({
      method: "POST",
      url: linkUrl(ids.issueId, ids.workOrderId),
      cookie: as(board),
    });
    expect(again.statusCode).toBe(409);
  });

  it("B3: nothing a contractor sends appears on the reporter's page", async () => {
    const reporterToken = mintReporterLinkToken();
    const cipher = await encryption.encrypt(
      "issue.reporterEmail",
      `wl-public2-${suffix}@exempel.se`,
    );
    const issue = await prisma.issue.create({
      data: {
        typeId: plain.id,
        statusId: plain.statusIds.IN_PROGRESS,
        description: "Läckan",
        reporterEmailCipher: cipher.cipher,
        reporterEmailIndex: cipher.index ?? null,
      },
      select: { id: true },
    });
    await prisma.issueReporterLink.create({
      data: {
        issueId: issue.id,
        tokenDigest: reporterLinkDigest(reporterToken),
        mailedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const order = await prisma.workOrder.create({
      data: {
        issueId: issue.id,
        contractorId,
        recipientName: `Rörfirman ${suffix}`,
        body: `Arbetsordertext ${suffix}`,
        deliveryStatus: "SENT",
      },
      select: { id: true },
    });
    const link = await issued(issue.id, order.id);
    const note = `EntreprenorensOrd${suffix}`;
    await act(link.token, { act: "accept" });
    await act(link.token, { act: "note", body: note });
    await upload(link.token, jpegBytes(8, 8));

    const reporterPage = await inject({
      method: "GET",
      url: `/arende/${reporterToken}`,
    });
    expect(reporterPage.statusCode).toBe(200);
    expect(reporterPage.body).not.toContain(note);
    expect(reporterPage.body).not.toContain(`Arbetsordertext ${suffix}`);
    expect(reporterPage.body).not.toContain("/api/media/");
  });

  it("B1, B5: redacting the work order's text revokes its link in that transaction", async () => {
    const ids = await linked();
    const redacted = await inject({
      method: "POST",
      url: `/api/issue-queue/${ids.issueId}/redactions`,
      payload: { target: "workOrder", id: ids.workOrderId },
      cookie: as(board),
    });
    expect(redacted.statusCode).toBeLessThan(300);
    const rows = await prisma.workOrderLink.findMany({
      where: { workOrderId: ids.workOrderId },
    });
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect((await page(ids.token)).statusCode).toBe(404);
  });

  it("B1, B5, I1: ring-fencing the type revokes its links in that transaction, and lifting it brings none back", async () => {
    const ids = await linked({ type: fenced });
    const set = (ringFenced: boolean) =>
      inject({
        method: "PUT",
        url: `/api/issue-types/${fenced.id}/ring-fence`,
        payload: { ringFenced },
        cookie: as(board),
      });
    expect((await set(true)).statusCode).toBe(200);
    try {
      const rows = await prisma.workOrderLink.findMany({
        where: { workOrderId: ids.workOrderId },
      });
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
      expect((await page(ids.token)).statusCode).toBe(404);

      // I1: no link and no choice of photographs on a ring-fenced issue.
      const refused = await inject({
        method: "POST",
        url: linkUrl(ids.issueId, ids.workOrderId),
        cookie: as(board),
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json<{ reason: string }>().reason).toBe(
        "work-order-ring-fenced",
      );
      expect((await choose(ids.issueId, ids.workOrderId, [])).statusCode).toBe(
        422,
      );

      // The ring-fence is never lifted from a type issues were reported under
      // (ADR 0054), so the API refuses it.
      const lifted = await set(false);
      expect(lifted.statusCode).toBe(409);
      expect(lifted.json<{ reason: string }>().reason).toBe(
        "ring-fence-in-use",
      );
    } finally {
      // Lifted behind the service's back, to see that no link comes back with
      // it and to leave the type as the other cases expect it.
      await prisma.issueType.update({
        where: { id: fenced.id },
        data: { ringFenced: false },
      });
    }
    expect((await page(ids.token)).statusCode).toBe(404);
  });

  it("I1: the lookup refuses a ring-fenced issue whatever the link's row says", async () => {
    const ids = await linked({ type: fenced });
    // Ring-fenced behind the service's back: only the lookup stands between.
    await prisma.issueType.update({
      where: { id: fenced.id },
      data: { ringFenced: true },
    });
    try {
      expect((await page(ids.token)).statusCode).toBe(404);
    } finally {
      await prisma.issueType.update({
        where: { id: fenced.id },
        data: { ringFenced: false },
      });
    }
  });

  it("B1, B5: the free-text purge revokes the links and removes the contractor's notes and photographs", async () => {
    const ids = await linked();
    await act(ids.token, { act: "note", body: `Anteckning ${suffix}` });
    await upload(ids.token, jpegBytes(8, 8));
    const [file] = await prisma.workOrderFile.findMany({
      where: { workOrderId: ids.workOrderId },
      select: { file: { select: { id: true, storageKey: true } } },
    });
    const removed = vi.spyOn(storage, "remove");

    const outcome = await app
      .get(IssueFreeTextService, { strict: false })
      .remove(ids.issueId, new Date(), {
        stillDue: async () => true,
        targetPersonId: null,
        context: {},
      });
    expect(outcome).toBe("removed");
    expect(
      await prisma.workOrderNote.count({
        where: { workOrderId: ids.workOrderId },
      }),
    ).toBe(0);
    expect(
      await prisma.workOrderFile.count({
        where: { workOrderId: ids.workOrderId },
      }),
    ).toBe(0);
    // G12: the object, not only the row.
    expect(removed).toHaveBeenCalledWith(file?.file.storageKey);
    const rows = await prisma.workOrderLink.findMany({
      where: { workOrderId: ids.workOrderId },
    });
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("B1, B5: closing the issue revokes its links in that transaction, and reopening it brings none back", async () => {
    const ids = await linked();
    const move = (statusId: string, outcome?: string) =>
      inject({
        method: "POST",
        url: `/api/issue-queue/${ids.issueId}/status`,
        payload: outcome === undefined ? { statusId } : { statusId, outcome },
        cookie: as(board),
      });

    expect((await move(plain.statusIds.DONE, "FIXED")).statusCode).toBe(201);
    expect((await page(ids.token)).statusCode).toBe(404);
    const rows = await prisma.workOrderLink.findMany({
      where: { workOrderId: { in: [ids.workOrderId, ids.otherWorkOrderId] } },
    });
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    expect((await move(plain.statusIds.IN_PROGRESS)).statusCode).toBe(201);
    expect((await page(ids.token)).statusCode).toBe(404);
    expect(
      (await act(ids.token, { act: "note", body: "Hej igen" })).statusCode,
    ).toBe(404);
    expect(
      (await listedOrder(ids.issueId, ids.workOrderId)).contractorLink.link
        .state,
    ).toBe("ended");
  });

  it("B1, B5: merging the issue into another as a duplicate revokes its links, and reopening it brings none back", async () => {
    const ids = await linked();
    const into = await arrange();

    const merged = await inject({
      method: "POST",
      url: `/api/issue-queue/${ids.issueId}/merge`,
      payload: { intoIssueId: into.issueId },
      cookie: as(board),
    });
    expect(merged.statusCode).toBe(201);
    expect((await page(ids.token)).statusCode).toBe(404);
    const rows = await prisma.workOrderLink.findMany({
      where: { workOrderId: ids.workOrderId },
    });
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    const reopened = await inject({
      method: "POST",
      url: `/api/issue-queue/${ids.issueId}/status`,
      payload: { statusId: plain.statusIds.IN_PROGRESS },
      cookie: as(board),
    });
    expect(reopened.statusCode).toBe(201);
    expect((await page(ids.token)).statusCode).toBe(404);
    expect(
      (await listedOrder(ids.issueId, ids.workOrderId)).contractorLink.link
        .state,
    ).toBe("ended");
  });

  it("B1: a closed issue, a removed contractor and a recipient erased each end the link", async () => {
    const closed = await linked();
    // Closed under the handlers' feet, with no revocation: the lookup refuses
    // it all the same.
    await prisma.issue.update({
      where: { id: closed.issueId },
      data: { statusId: plain.statusIds.DONE, closedAt: new Date() },
    });
    expect((await page(closed.token)).statusCode).toBe(404);

    const erased = await linked();
    await prisma.workOrder.update({
      where: { id: erased.workOrderId },
      data: { recipientName: null },
    });
    expect((await page(erased.token)).statusCode).toBe(404);

    const removed = await linked();
    const contractor = await prisma.contractor.create({
      data: { name: `Tillfällig ${suffix}`, trade: "Elektriker" },
      select: { id: true },
    });
    await prisma.workOrder.update({
      where: { id: removed.workOrderId },
      data: { contractorId: contractor.id },
    });
    const deleted = await inject({
      method: "DELETE",
      url: `/api/contractors/${contractor.id}`,
      cookie: as(board),
    });
    expect(deleted.statusCode).toBe(204);
    expect((await page(removed.token)).statusCode).toBe(404);
    const rows = await prisma.workOrderLink.findMany({
      where: { workOrderId: removed.workOrderId },
    });
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it("H4: a protected reporter fails closed: no link is issued, and one issued before stops answering", async () => {
    const before = await linked();
    await prisma.person.update({
      where: { id: resident.personId },
      data: { protectedPersonalData: true },
    });
    try {
      expect((await page(before.token)).statusCode).toBe(404);
      // The handlers' record says so too, and offers no withdrawal of a link
      // that opens nothing.
      const list = await listed(before.issueId);
      expect(list.protectedHousehold).toBe(true);
      expect(
        list.workOrders.find((row) => row.id === before.workOrderId)
          ?.contractorLink.link,
      ).toEqual({ state: "ended", expiresAt: null });
      const ids = await arrange();
      const refused = await inject({
        method: "POST",
        url: linkUrl(ids.issueId, ids.workOrderId),
        cookie: as(board),
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json<{ reason: string }>().reason).toBe(
        "work-order-protected",
      );
    } finally {
      await prisma.person.update({
        where: { id: resident.personId },
        data: { protectedPersonalData: false },
      });
    }
  });
});

describe("H5. the photographs a link has shown, counted for the access report", () => {
  it("counts each photograph once from the act that exposes it, and keeps the count when the choice changes or a file goes", async () => {
    const ids = await arrange();
    const exposures = () =>
      prisma.workOrderPhotoExposure.count({
        where: { workOrderId: ids.workOrderId },
      });

    // Chosen with no link standing: never shown, so not counted.
    expect(
      (await choose(ids.issueId, ids.workOrderId, [ids.chosenFileId]))
        .statusCode,
    ).toBe(204);
    expect(await exposures()).toBe(0);

    // Issuing serves the photographs already chosen.
    await issued(ids.issueId, ids.workOrderId);
    expect(await exposures()).toBe(1);

    // Emptying the choice takes nothing back; choosing again counts only the
    // photograph that is new.
    expect((await choose(ids.issueId, ids.workOrderId, [])).statusCode).toBe(
      204,
    );
    expect(await exposures()).toBe(1);
    expect(
      (
        await choose(ids.issueId, ids.workOrderId, [
          ids.chosenFileId,
          ids.unchosenFileId,
        ])
      ).statusCode,
    ).toBe(204);
    expect(await exposures()).toBe(2);

    // A photograph removed from the issue leaves its count behind.
    await prisma.mediaFile.delete({ where: { id: ids.chosenFileId } });
    expect(await exposures()).toBe(2);
    expect(
      await prisma.workOrderPhotoExposure.count({
        where: { workOrderId: ids.workOrderId, fileId: null },
      }),
    ).toBe(1);
  });
});

describe("H5b. a photograph chosen once the link opens nothing is not counted", () => {
  it("counts nothing for a choice made after the contractor declined", async () => {
    const ids = await linked();
    const exposures = () =>
      prisma.workOrderPhotoExposure.count({
        where: { workOrderId: ids.workOrderId },
      });
    const before = await exposures();
    expect((await act(ids.token, { act: "decline" })).statusCode).toBe(200);

    expect(
      (
        await choose(ids.issueId, ids.workOrderId, [
          ids.chosenFileId,
          ids.unchosenFileId,
        ])
      ).statusCode,
    ).toBe(204);

    // The link opens nothing now, so the new photograph was never shown.
    expect(await exposures()).toBe(before);
  });
});

describe("H4. marking a person protected", () => {
  it("ends the links of their issues on the row, so clearing the protection brings none back", async () => {
    const ids = await linked();
    expect((await page(ids.token)).statusCode).toBe(200);
    const persons = app.get(PersonService);
    try {
      await persons.setProtectedPersonalData({
        personId: resident.personId,
        protectedPersonalData: true,
        actorPersonId: board.personId,
      });
      const rows = await prisma.workOrderLink.findMany({
        where: { workOrderId: ids.workOrderId },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
      const entries = (await auditFor(ids.issueId)).filter(
        (entry) => entry.action === "ISSUE_WORK_ORDER_LINK_REVOKED",
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.channel).toBe("WEB");
      expect(JSON.stringify(entries)).not.toContain(resident.personId);
    } finally {
      await persons.setProtectedPersonalData({
        personId: resident.personId,
        protectedPersonalData: false,
        actorPersonId: board.personId,
      });
    }
    // The protection is gone, and the address stays dead.
    expect((await page(ids.token)).statusCode).toBe(404);
  });

  it("is serialised with issuing: a link issued while the protection is written is refused, never left standing", async () => {
    const ids = await arrange();
    const audit = app.get(AuditLogService);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      // The protection's write, held open after it has looked for links to
      // end and found none.
      const marking = prisma.$transaction(
        async (tx) => {
          await tx.person.update({
            where: { id: resident.personId },
            data: { protectedPersonalData: true },
          });
          await revokeLinksOfProtectedHousehold(tx, audit, {
            personId: resident.personId,
            actorPersonId: board.personId,
            channel: "WEB",
          });
          entered();
          await held;
        },
        { timeout: 20_000 },
      );
      await inside;
      const issuing = Promise.resolve(
        inject({
          method: "POST",
          url: linkUrl(ids.issueId, ids.workOrderId),
          cookie: as(board),
        }),
      );
      // Unserialised, the issuing reads the protection as not yet there and
      // commits its link in this time; serialised, it waits for the protection.
      await Promise.race([
        issuing,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      release();
      await marking;
      const response = await issuing;

      expect(
        await prisma.workOrderLink.count({
          where: { workOrderId: ids.workOrderId, revokedAt: null },
        }),
      ).toBe(0);
      expect(response.statusCode).toBe(422);
      expect(response.json<{ reason: string }>().reason).toBe(
        "work-order-protected",
      );
    } finally {
      release();
      await prisma.person.update({
        where: { id: resident.personId },
        data: { protectedPersonalData: false },
      });
    }
  });

  it("outlasts Prisma's five seconds while an import chunk holds the lock: issuing a link and marking a person protected wait for it and then succeed", async () => {
    const ids = await arrange();
    const strangerId = `wl-stranger-${suffix}`;
    await prisma.person.create({
      data: { id: strangerId, firstName: "Siv", lastName: `Lås${suffix}` },
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      // An import chunk with a residency holds the lock to its commit, for up
      // to its own limit; this one holds it past Prisma's default timeout.
      const holding = prisma.$transaction(
        async (tx) => {
          await lockHouseholdProtection(tx);
          entered();
          await held;
        },
        { timeout: 20_000 },
      );
      await inside;
      const waiting = Promise.allSettled([
        Promise.resolve(
          inject({
            method: "POST",
            url: linkUrl(ids.issueId, ids.workOrderId),
            cookie: as(board),
          }),
        ),
        app.get(PersonService).setProtectedPersonalData({
          personId: strangerId,
          protectedPersonalData: true,
          actorPersonId: board.personId,
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      release();
      await holding;
      const [issuing, protecting] = await waiting;

      expect(issuing.status).toBe("fulfilled");
      expect(
        issuing.status === "fulfilled" ? issuing.value.statusCode : null,
      ).toBe(201);
      expect(protecting).toEqual({
        status: "fulfilled",
        value: { protectedPersonalData: true },
      });
    } finally {
      release();
      await prisma.person.deleteMany({ where: { id: strangerId } });
    }
  });

  it("is serialised with a move-in in the one order: a protection waits for the lock, not on the person's row, so a move-in that writes the person afterwards is never a deadlock victim", async () => {
    const addressId = `wl-addr3-${suffix}`;
    const apartmentId = `wl-apt3-${suffix}`;
    const moverId = `wl-mover3-${suffix}`;
    await prisma.address.create({
      data: {
        id: addressId,
        street: "Låsgatan",
        number: `${suffix}c`,
        postalCode: "11122",
        city: "Stockholm",
        sortOrder: 923,
      },
    });
    await prisma.apartment.create({
      data: { id: apartmentId, addressId, number: "1203", floor: 3 },
    });
    await prisma.person.create({
      data: { id: moverId, firstName: "Mats", lastName: `Flytt3${suffix}` },
    });
    const persons = app.get(PersonService);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      // A move-in that holds the protection's lock, as it does from the
      // residency on, and writes the person whose protection is waiting.
      const moving = prisma.$transaction(
        async (tx) => {
          await app.get(MoveService).enterResidency(tx, {
            actorPersonId: board.personId,
            personId: moverId,
            apartmentId,
            role: "RESIDENT",
            movedInOn: new Date("2999-01-01T00:00:00.000Z"),
          });
          entered();
          await held;
          await tx.person.update({
            where: { id: resident.personId },
            data: { preferredLocale: "sv" },
          });
        },
        { timeout: 20_000 },
      );
      await inside;
      const protecting = persons.setProtectedPersonalData({
        personId: resident.personId,
        protectedPersonalData: true,
        actorPersonId: board.personId,
      });
      // Past Postgres's deadlock check (a second): a protection that had
      // already taken the person's row would be waiting on the move-in while
      // the move-in waits on it.
      await Promise.race([
        protecting,
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      release();
      await moving;
      await protecting;
      expect(
        (
          await prisma.person.findUniqueOrThrow({
            where: { id: resident.personId },
            select: { protectedPersonalData: true },
          })
        ).protectedPersonalData,
      ).toBe(true);
    } finally {
      release();
      await prisma.person.update({
        where: { id: resident.personId },
        data: { protectedPersonalData: false },
      });
      await prisma.residency.deleteMany({ where: { personId: moverId } });
      await prisma.person.deleteMany({ where: { id: moverId } });
      await prisma.apartment.deleteMany({ where: { id: apartmentId } });
      await prisma.address.deleteMany({ where: { id: addressId } });
    }
  });

  it("ends the links of an apartment's issues when a protected person's residency is recorded there", async () => {
    const ids = await linked();
    const addressId = `wl-addr2-${suffix}`;
    const apartmentId = `wl-apt2-${suffix}`;
    const neighbourId = `wl-neigh2-${suffix}`;
    await prisma.address.create({
      data: {
        id: addressId,
        street: "Länkgatan",
        number: `${suffix}b`,
        postalCode: "11122",
        city: "Stockholm",
        sortOrder: 922,
      },
    });
    await prisma.apartment.create({
      data: { id: apartmentId, addressId, number: "1202", floor: 2 },
    });
    await prisma.issue.update({
      where: { id: ids.issueId },
      data: { apartmentId },
    });
    await prisma.person.create({
      data: {
        id: neighbourId,
        firstName: "Nora",
        lastName: `Granne2${suffix}`,
        protectedPersonalData: true,
      },
    });
    try {
      await prisma.$transaction(async (tx) => {
        await app.get(MoveService).enterResidency(tx, {
          actorPersonId: board.personId,
          personId: neighbourId,
          apartmentId,
          role: "RESIDENT",
          // Ahead of today: held by nobody yet, and the link ends all the same.
          movedInOn: new Date("2999-01-01T00:00:00.000Z"),
        });
      });
      const rows = await prisma.workOrderLink.findMany({
        where: { workOrderId: ids.workOrderId },
      });
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    } finally {
      await prisma.residency.deleteMany({ where: { personId: neighbourId } });
      await prisma.person.deleteMany({ where: { id: neighbourId } });
      await prisma.issue.update({
        where: { id: ids.issueId },
        data: { apartmentId: null },
      });
      await prisma.apartment.deleteMany({ where: { id: apartmentId } });
      await prisma.address.deleteMany({ where: { id: addressId } });
    }
  });
});

describe("H4. a protected household", () => {
  it("a protected resident of the apartment ends the link, and the handlers' record says it has ended", async () => {
    const ids = await linked();
    const addressId = `wl-address-${suffix}`;
    const apartmentId = `wl-apartment-${suffix}`;
    const neighbourId = `wl-neighbour-${suffix}`;
    await prisma.address.create({
      data: {
        id: addressId,
        street: "Länkgatan",
        number: suffix,
        postalCode: "11122",
        city: "Stockholm",
        sortOrder: 921,
      },
    });
    await prisma.apartment.create({
      data: { id: apartmentId, addressId, number: "1201", floor: 2 },
    });
    await prisma.issue.update({
      where: { id: ids.issueId },
      data: { apartmentId },
    });
    try {
      expect((await page(ids.token)).statusCode).toBe(200);
      const live = await listed(ids.issueId);
      expect(live.protectedHousehold).toBe(false);
      expect(
        live.workOrders.find((row) => row.id === ids.workOrderId)
          ?.contractorLink.link.state,
      ).toBe("live");

      // Somebody moves in whose personal data is protected; the reporter is not.
      await prisma.person.create({
        data: {
          id: neighbourId,
          firstName: "Nora",
          lastName: `Granne${suffix}`,
          protectedPersonalData: true,
        },
      });
      await prisma.residency.create({
        data: {
          personId: neighbourId,
          apartmentId,
          role: "RESIDENT",
          movedInOn: new Date("2024-01-01T00:00:00.000Z"),
        },
      });

      expect((await page(ids.token)).statusCode).toBe(404);
      const after = await listed(ids.issueId);
      expect(after.protectedHousehold).toBe(true);
      expect(
        after.workOrders.find((row) => row.id === ids.workOrderId)
          ?.contractorLink.link,
      ).toEqual({ state: "ended", expiresAt: null });
    } finally {
      await prisma.residency.deleteMany({ where: { personId: neighbourId } });
      await prisma.person.deleteMany({ where: { id: neighbourId } });
      await prisma.issue.update({
        where: { id: ids.issueId },
        data: { apartmentId: null },
      });
      await prisma.apartment.deleteMany({ where: { id: apartmentId } });
      await prisma.address.deleteMany({ where: { id: addressId } });
    }
  });
  it("counts a protected household recorded ahead of its move-in date: the link stops answering and no new one is issued", async () => {
    const ids = await linked();
    const addressId = `wl-address4-${suffix}`;
    const apartmentId = `wl-apartment4-${suffix}`;
    const neighbourId = `wl-neighbour4-${suffix}`;
    await prisma.address.create({
      data: {
        id: addressId,
        street: "Länkgatan",
        number: `${suffix}d`,
        postalCode: "11122",
        city: "Stockholm",
        sortOrder: 924,
      },
    });
    await prisma.apartment.create({
      data: { id: apartmentId, addressId, number: "1204", floor: 4 },
    });
    await prisma.issue.update({
      where: { id: ids.issueId },
      data: { apartmentId },
    });
    try {
      expect((await page(ids.token)).statusCode).toBe(200);

      // Recorded by a write that ends no link, so only the check on every
      // request and on issuing stands between the household and the link.
      await prisma.person.create({
        data: {
          id: neighbourId,
          firstName: "Nora",
          lastName: `Granne4${suffix}`,
          protectedPersonalData: true,
        },
      });
      await prisma.residency.create({
        data: {
          personId: neighbourId,
          apartmentId,
          role: "RESIDENT",
          movedInOn: new Date("2999-01-01T00:00:00.000Z"),
        },
      });

      expect((await page(ids.token)).statusCode).toBe(404);
      expect((await listed(ids.issueId)).protectedHousehold).toBe(true);
      const again = await inject({
        method: "POST",
        url: linkUrl(ids.issueId, ids.workOrderId),
        cookie: as(board),
      });
      expect(again.statusCode).toBe(422);
      expect(again.json<{ reason: string }>().reason).toBe(
        "work-order-protected",
      );
    } finally {
      await prisma.residency.deleteMany({ where: { personId: neighbourId } });
      await prisma.person.deleteMany({ where: { id: neighbourId } });
      await prisma.issue.update({
        where: { id: ids.issueId },
        data: { apartmentId: null },
      });
      await prisma.apartment.deleteMany({ where: { id: apartmentId } });
      await prisma.address.deleteMany({ where: { id: addressId } });
    }
  });
});

describe("B6. the legal gate's switch, off", () => {
  it("answers every route with the one refusal, refuses to issue, and ends links issued while it was on", async () => {
    const ids = await linked();
    expect((await page(ids.token)).statusCode).toBe(200);
    const unknown = await page(unknownToken());

    const reads = [
      await page(ids.token, off),
      await inject(
        { method: "GET", url: `/arbetsorder/${ids.token}/foto` },
        off,
      ),
      await inject(
        {
          method: "GET",
          url: `/arbetsorder/${ids.token}/foto/${ids.chosenFileId}`,
        },
        off,
      ),
      await act(ids.token, { act: "accept" }, { on: off }),
      await act(ids.token, { act: "note", body: "Hej" }, { on: off }),
    ];
    for (const read of reads) {
      expect(read.statusCode).toBe(404);
      expect(read.body).toBe(unknown.body);
      expectLinkHeaders(read.headers);
    }

    const put = vi.spyOn(off.get(StorageService), "put");
    const photo = await upload(ids.token, jpegBytes(8, 8), { on: off });
    expect(photo.statusCode).toBe(404);
    expect(put).not.toHaveBeenCalled();

    const issuing = await inject(
      {
        method: "POST",
        url: linkUrl(ids.issueId, ids.otherWorkOrderId),
        cookie: as(board),
      },
      off,
    );
    expect(issuing.statusCode).toBe(404);
    expect(issuing.json<{ reason: string }>().reason).toBe(
      "work-order-links-off",
    );
    const list = await listed(ids.issueId, off);
    expect(list.linksEnabled).toBe(false);
    expect(list.choosablePhotos).toEqual([]);

    const state = await snapshot(ids.issueId, ids.workOrderId);
    expect(state.order.answer).toBeNull();
    expect(state.notes).toBe(0);
  });

  it("lists a link issued while it was on as live, and lets the handlers withdraw it for good", async () => {
    const ids = await linked();
    const standing = (await listed(ids.issueId, off)).workOrders.find(
      (row) => row.id === ids.workOrderId,
    );
    // Shut by the switch, not ended: switched on again, it would open.
    expect(standing?.contractorLink.link).toEqual({
      state: "live",
      expiresAt: ids.expiresAt,
    });

    const withdrawn = await inject(
      {
        method: "DELETE",
        url: linkUrl(ids.issueId, ids.workOrderId),
        cookie: as(board),
      },
      off,
    );
    expect(withdrawn.statusCode).toBe(204);
    const after = (await listed(ids.issueId, off)).workOrders.find(
      (row) => row.id === ids.workOrderId,
    );
    expect(after?.contractorLink.link.state).toBe("ended");
    // The switch on again opens nothing through it.
    expect((await page(ids.token)).statusCode).toBe(404);
  });
});

describe("C. no enumeration", () => {
  it("C1, C2: every link that opens nothing gets the same status, bytes and headers", async () => {
    const declined = await linked();
    await act(declined.token, { act: "decline" });
    const done = await linked();
    await act(done.token, { act: "done" });
    const revoked = await linked();
    await inject({
      method: "DELETE",
      url: linkUrl(revoked.issueId, revoked.workOrderId),
      cookie: as(board),
    });
    const expired = await linked();
    await prisma.workOrderLink.updateMany({
      where: { workOrderId: expired.workOrderId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const ringFenced = await linked({ type: fenced });
    await prisma.issueType.update({
      where: { id: fenced.id },
      data: { ringFenced: true },
    });
    const gateOff = await linked();

    try {
      const answers = [
        await page(unknownToken()),
        await page("obrf_wo_short"),
        await page(mintReporterLinkToken()),
        await page(declined.token),
        await page(done.token),
        await page(revoked.token),
        await page(expired.token),
        await page(ringFenced.token),
        await page(gateOff.token, off),
      ];
      const [first, ...rest] = answers;
      expect(first?.statusCode).toBe(404);
      for (const answer of rest) {
        expect(answer.statusCode).toBe(first?.statusCode);
        expect(answer.body).toBe(first?.body);
        expect(stableHeaders(answer.headers)).toEqual(
          stableHeaders(first?.headers ?? {}),
        );
      }
    } finally {
      await prisma.issueType.update({
        where: { id: fenced.id },
        data: { ringFenced: false },
      });
    }
  });

  it("C3: a file beside the token is served only inside the token's grant", async () => {
    const ids = await linked();
    const other = await linked();
    await upload(other.token, jpegBytes(8, 8));
    const [otherOwn] = await prisma.workOrderFile.findMany({
      where: { workOrderId: other.workOrderId },
    });
    // The control is that this file is out of reach: a nonexistent id would
    // be refused whatever the grant, so the file has to exist first.
    expect(otherOwn?.fileId).toEqual(expect.any(String));
    const photo = (fileId: string) =>
      inject({
        method: "GET",
        url: `/arbetsorder/${ids.token}/foto/${encodeURIComponent(fileId)}`,
      });

    const chosen = await photo(ids.chosenFileId);
    expect(chosen.statusCode).toBe(200);
    expect(chosen.headers["content-type"]).toBe("image/png");
    expectLinkHeaders(chosen.headers);

    const refusal = await page(unknownToken());
    for (const fileId of [
      // The report's own photograph, not chosen for this work order.
      ids.unchosenFileId,
      // Another issue's photograph, chosen for that issue's work order.
      other.chosenFileId,
      // Another work order's contractor's photograph.
      otherOwn?.fileId ?? "",
      // No file at all.
      "no-such-file",
    ]) {
      const answer = await photo(fileId);
      expect(answer.statusCode).toBe(404);
      expect(answer.body).toBe(refusal.body);
    }

    // A photograph chosen for the other work order on the same issue is
    // that work order's, not this one's.
    await choose(ids.issueId, ids.otherWorkOrderId, [ids.unchosenFileId]);
    expect((await photo(ids.unchosenFileId)).statusCode).toBe(404);

    // And the reporter's page serves no file at all.
    expect(
      (
        await inject({
          method: "GET",
          url: `/arende/${mintReporterLinkToken()}/foto/${otherOwn?.fileId ?? ""}`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("C4, H1, H3: shows the work order and nothing of the issue, its people or its other work orders", async () => {
    const ids = await linked();
    await choose(ids.issueId, ids.otherWorkOrderId, [ids.unchosenFileId]);
    const read = await page(ids.token);
    expect(read.statusCode).toBe(200);
    const everything = `${read.body}\n${JSON.stringify(read.headers)}`;
    for (const canary of Object.values(CANARY)) {
      expect(everything).not.toContain(canary);
    }
    expect(everything).not.toContain(ids.issueId);
    expect(everything).not.toContain(ids.otherWorkOrderId);
    expect(everything).not.toContain(ids.unchosenFileId);
    expect(everything).not.toContain(`Ärende ${String(ids.number)}`);
    // Every form posts to the token's own address and nothing else.
    for (const action of read.body.matchAll(/action="([^"]*)"/g)) {
      expect(action[1]?.startsWith(`/arbetsorder/${ids.token}`)).toBe(true);
    }
  });
});

describe("D. rate limits and abuse", () => {
  it("D2, D3: the 31st read from one address is refused, alike for a live token and an unknown one", async () => {
    const ids = await linked();
    const refusals = [];
    for (const [token, address] of [
      [ids.token, "10.212.250.1"],
      [unknownToken(), "10.212.250.2"],
    ] as const) {
      for (let n = 0; n < WORK_ORDER_LINK_READS_PER_MINUTE; n += 1) {
        expect((await page(token, app, address)).statusCode).not.toBe(429);
      }
      const refused = await page(token, app, address);
      expect(refused.statusCode).toBe(429);
      expectLinkHeaders(refused.headers);
      refusals.push(refused);
    }
    // Spent before the token is resolved: the same answer for both.
    expect(refusals[0]?.body).toBe(refusals[1]?.body);
  });

  it("D4: a link's notes share one budget whatever address they come from", async () => {
    const ids = await linked();
    for (let n = 0; n < WORK_ORDER_LINK_NOTES_PER_HOUR; n += 1) {
      const sentNote = await act(ids.token, {
        act: "note",
        body: `Anteckning ${String(n)}`,
      });
      expect(sentNote.headers.location).toContain("svar=noted");
    }
    const refused = await act(ids.token, { act: "note", body: "En till" });
    expect(refused.headers.location).toContain("svar=note-limited");
    expect(
      await prisma.workOrderNote.count({
        where: { workOrderId: ids.workOrderId },
      }),
    ).toBe(WORK_ORDER_LINK_NOTES_PER_HOUR);
  });

  it("D5: strangers' failed guesses never lock a live link", async () => {
    const ids = await linked();
    for (let n = 0; n < 20; n += 1) {
      await page(
        `${WORK_ORDER_LINK_TOKEN_PREFIX}${String(n).padStart(43, "x")}`,
      );
      await act(unknownToken(), { act: "done" });
    }
    expect((await page(ids.token)).statusCode).toBe(200);
  });

  it("D7: a note too long or carrying an identity number is refused; a body past the limit is refused before it is read", async () => {
    const ids = await linked();
    const long = await act(ids.token, { act: "note", body: "x".repeat(2001) });
    expect(long.headers.location).toContain("svar=refused");
    const identity = await act(ids.token, {
      act: "note",
      body: "Ring 19121212-1212 om porten",
    });
    expect(identity.headers.location).toContain("svar=identity");
    // Measured as it would be stored: nothing but a zero-width space is
    // empty, and 1,000 ellipses are 3,000 characters once NFKC has them.
    for (const body of ["\u200b", "\u2026".repeat(1000)]) {
      const normalized = await act(ids.token, { act: "note", body });
      expect(normalized.statusCode).toBe(303);
      expect(normalized.headers.location).toContain("svar=refused");
    }
    const huge = await act(ids.token, {
      act: "note",
      body: "x".repeat(70_000),
    });
    expect(huge.statusCode).toBe(413);
    expectLinkHeaders(huge.headers);
    expect(
      await prisma.workOrderNote.count({
        where: { workOrderId: ids.workOrderId },
      }),
    ).toBe(0);
  });
});

describe("E. what a request may do", () => {
  it("E1, E2: a GET and a HEAD with a live token write nothing, and a GET to an action's address shows the page", async () => {
    const ids = await linked();
    const before = await snapshot(ids.issueId, ids.workOrderId);
    expect((await page(ids.token)).statusCode).toBe(200);
    expect(
      (await inject({ method: "HEAD", url: `/arbetsorder/${ids.token}` }))
        .statusCode,
    ).toBe(200);
    const actionAddress = await inject({
      method: "GET",
      url: `/arbetsorder/${ids.token}/foto?act=done`,
    });
    expect(actionAddress.statusCode).toBe(200);
    expect(actionAddress.body).toContain("<form");
    await page(`${ids.token}?act=decline`);
    expect(
      (
        await inject({
          method: "GET",
          url: `/arbetsorder/${ids.token}/foto/${ids.chosenFileId}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(await snapshot(ids.issueId, ids.workOrderId)).toEqual(before);
  });

  it("E3: a session cookie changes nothing, and the act is on the link's channel", async () => {
    const ids = await linked();
    const without = await page(ids.token);
    const withCookie = await inject({
      method: "GET",
      url: `/arbetsorder/${ids.token}`,
      cookie: as(board),
    });
    expect(withCookie.body).toBe(without.body);
    await act(ids.token, { act: "accept" }, { headers: { cookie: as(board) } });
    const entry = (await auditFor(ids.issueId)).find(
      (row) => row.action === "ISSUE_WORK_ORDER_ANSWERED",
    );
    expect(entry?.channel).toBe("LINK");
    expect(entry?.actorPersonId).toBeNull();
  });

  it("E5: a post from another origin, or of another type, is refused and stores nothing", async () => {
    const ids = await linked();
    const before = await snapshot(ids.issueId, ids.workOrderId);
    const refusal = await page(unknownToken());
    for (const answer of [
      await act(
        ids.token,
        { act: "accept" },
        { headers: { origin: "https://elsewhere.test" } },
      ),
      await inject({
        method: "POST",
        url: `/arbetsorder/${ids.token}`,
        payload: JSON.stringify({ act: "accept" }),
        headers: { "content-type": "application/json" },
      }),
      await upload(ids.token, jpegBytes(8, 8), {
        headers: { origin: "https://elsewhere.test" },
      }),
      await inject({
        method: "POST",
        url: `/arbetsorder/${ids.token}/foto`,
        payload: new URLSearchParams({ photo: "x" }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    ]) {
      expect(answer.statusCode).toBe(404);
      expect(answer.body).toBe(refusal.body);
    }
    // The page's own form, under no-referrer, posts with the null origin.
    const own = await act(
      ids.token,
      { act: "accept" },
      { headers: { origin: "null" } },
    );
    expect(own.statusCode).toBe(303);
    const after = await snapshot(ids.issueId, ids.workOrderId);
    expect(after.files).toBe(before.files);
    expect(after.notes).toBe(before.notes);
  });
});

describe("F. response headers", () => {
  it("F1, E4: every answer carries the link's headers, the 200, 303, 404, 413 and a 500 included", async () => {
    const ids = await linked();
    expectLinkHeaders((await page(ids.token)).headers);
    expectLinkHeaders((await act(ids.token, { act: "accept" })).headers);
    expectLinkHeaders((await page(unknownToken())).headers);
    expectLinkHeaders(
      (await inject({ method: "GET", url: "/arbetsorder/a/b/c" })).headers,
    );

    vi.spyOn(links, "open").mockRejectedValueOnce(new Error("forced"));
    const failed = await page(ids.token);
    expect(failed.statusCode).toBe(500);
    expectLinkHeaders(failed.headers);
  });

  it("F2, F3: the page loads nothing from another origin, and its title says nothing", async () => {
    const ids = await linked();
    const read = await page(ids.token);
    expect(read.body).not.toMatch(/(?:href|src|action)="(?:https?:)?\/\//);
    const title = /<title>([^<]*)<\/title>/.exec(read.body)?.[1];
    expect(title).toBe("Arbetsorder - Brf Eksemplet");
    expect(
      /<title>([^<]*)<\/title>/.exec((await page(unknownToken())).body)?.[1],
    ).toBe(title);
  });
});

describe("G. the contractor's photographs", () => {
  it("G1: a token that opens nothing stores nothing and reads no body", async () => {
    const ids = await linked();
    await inject({
      method: "DELETE",
      url: linkUrl(ids.issueId, ids.workOrderId),
      cookie: as(board),
    });
    const put = vi.spyOn(storage, "put");
    const stored = vi.spyOn(media, "upload");
    const answer = await upload(ids.token, jpegBytes(8, 8));
    expect(answer.statusCode).toBe(404);
    expect(put).not.toHaveBeenCalled();
    expect(stored).not.toHaveBeenCalled();
  });

  it("G2: uploads sent together at the cap less one store exactly one", async () => {
    const ids = await linked();
    for (let n = 0; n < WORK_ORDER_LINK_PHOTOS_PER_WORK_ORDER - 1; n += 1) {
      const fileId = await storedPhoto();
      await prisma.workOrderFile.create({
        data: {
          workOrderId: ids.workOrderId,
          fileId,
          sortOrder: n,
          // Older than the hour, so only the total counts.
          createdAt: new Date(Date.now() - 2 * 3_600_000),
        },
      });
    }
    const answers = await Promise.all(
      [1, 2, 3].map(() => upload(ids.token, jpegBytes(8, 8))),
    );
    const notices = answers.map((answer) => String(answer.headers.location));
    expect(notices.filter((n) => n.endsWith("svar=photo-added"))).toHaveLength(
      1,
    );
    expect(notices.filter((n) => n.endsWith("svar=photo-full"))).toHaveLength(
      2,
    );
    expect(
      await prisma.workOrderFile.count({
        where: { workOrderId: ids.workOrderId },
      }),
    ).toBe(WORK_ORDER_LINK_PHOTOS_PER_WORK_ORDER);
  });

  it("G2: an upload that raced a revocation stores no row and removes its object", async () => {
    const ids = await linked();
    const original = media.upload.bind(media);
    let storedId: string | null = null;
    vi.spyOn(media, "upload").mockImplementation(async (input) => {
      const file = await original(input);
      storedId = file.id;
      // The board withdraws the link while the photograph is being stored.
      await prisma.workOrderLink.updateMany({
        where: { workOrderId: ids.workOrderId },
        data: { revokedAt: new Date() },
      });
      return file;
    });
    const removed = vi.spyOn(storage, "remove");
    const answer = await upload(ids.token, jpegBytes(8, 8));
    expect(answer.statusCode).toBe(404);
    expect(storedId).not.toBeNull();
    expect(
      await prisma.workOrderFile.count({
        where: { workOrderId: ids.workOrderId },
      }),
    ).toBe(0);
    expect(
      await prisma.mediaFile.findUnique({ where: { id: storedId ?? "" } }),
    ).toBeNull();
    expect(removed).toHaveBeenCalled();
  });

  it("G3: a work order takes no more bytes than its cap", async () => {
    const ids = await linked();
    const fileId = await storedPhoto();
    await prisma.workOrderFile.create({
      data: { workOrderId: ids.workOrderId, fileId },
    });
    await prisma.mediaFile.update({
      where: { id: fileId },
      data: { byteSize: 30 * 1024 * 1024 },
    });
    const answer = await upload(ids.token, jpegBytes(8, 8));
    expect(answer.headers.location).toContain("svar=photo-full");
  });

  it("G3b: a photograph above the text limit is accepted, which only the upload route is exempt from", async () => {
    const ids = await linked();
    // Comment segments (at most 64 KiB each) take the file past the 64 KiB
    // that every other link route reads, and are stripped from what is stored.
    const comment = (length: number) => {
      const segment = Buffer.alloc(4 + length, 0x41);
      segment.writeUInt16BE(0xfffe, 0);
      segment.writeUInt16BE(length + 2, 2);
      return segment;
    };
    const large = jpegBytes(8, 8, [comment(60000), comment(60000)]);
    expect(large.length).toBeGreaterThan(64 * 1024);
    const answer = await upload(ids.token, large);
    expect(answer.headers.location).toContain("svar=photo-added");
    expect(
      await prisma.workOrderFile.count({
        where: { workOrderId: ids.workOrderId },
      }),
    ).toBe(1);
  });

  it("G4: the type is the bytes', and anything but a whole image is refused", async () => {
    const ids = await linked();
    const refusals: [string, Buffer][] = [
      [
        "svg",
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>',
        ),
      ],
      ["html", Buffer.from("<!doctype html><script>alert(1)</script>")],
      ["pdf", Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF")],
      ["zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
      [
        "polyglot",
        Buffer.concat([
          gifBytes(1, 1).subarray(0, 13),
          Buffer.from("<script>alert(1)</script>"),
        ]),
      ],
      ["empty", Buffer.alloc(0)],
      ["truncated", jpegBytes(8, 8).subarray(0, 20)],
    ];
    for (const [name, bytes] of refusals) {
      const answer = await upload(ids.token, bytes, {
        fileName: `${name}.jpg`,
      });
      expect(answer.headers.location, name).toContain("svar=photo-refused");
    }
    expect(
      await prisma.workOrderFile.count({
        where: { workOrderId: ids.workOrderId },
      }),
    ).toBe(0);

    const trailer = Buffer.from("<script>trailing</script>");
    const withTrailer = Buffer.concat([jpegBytes(8, 8), trailer]);
    expect(
      (await upload(ids.token, withTrailer, { contentType: "text/html" }))
        .headers.location,
    ).toContain("svar=photo-added");
    const [own] = await prisma.workOrderFile.findMany({
      where: { workOrderId: ids.workOrderId },
      select: { file: { select: { id: true, contentType: true } } },
    });
    expect(own?.file.contentType).toBe("image/jpeg");
    const served = await inject({
      method: "GET",
      url: `/arbetsorder/${ids.token}/foto/${own?.file.id ?? ""}`,
    });
    expect(served.rawPayload.includes(trailer)).toBe(false);
  });

  it("G5: the metadata of every format is gone from what is stored", async () => {
    const ids = await linked();
    const riff = (type: string, data: Buffer) => {
      const head = Buffer.alloc(8);
      head.write(type, 0, "latin1");
      head.writeUInt32LE(data.length, 4);
      return Buffer.concat([
        head,
        data,
        data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0),
      ]);
    };
    const canvas = Buffer.alloc(10);
    canvas[0] = 0x08 | 0x04;
    canvas.writeUIntLE(63, 4, 3);
    canvas.writeUIntLE(31, 7, 3);
    const webpBody = Buffer.concat([
      Buffer.from("WEBP", "latin1"),
      riff("VP8X", canvas),
      webpLossyBytes(64, 32).subarray(12),
      riff("EXIF", exifWithGps()),
      riff(
        "XMP ",
        Buffer.from(`<x:xmpmeta>${GPS_MARKER}</x:xmpmeta>`, "latin1"),
      ),
    ]);
    const webpHead = Buffer.alloc(8);
    webpHead.write("RIFF", 0, "latin1");
    webpHead.writeUInt32LE(webpBody.length, 4);

    const images: [string, Buffer][] = [
      ["jpeg", jpegBytes(8, 8, jpegMetadataSegments())],
      [
        "png",
        pngBytes(4, 4, 4, [
          pngChunk("tEXt", Buffer.from(`Comment\0${GPS_MARKER}`, "latin1")),
          pngChunk(
            "iTXt",
            Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${GPS_MARKER}`, "latin1"),
          ),
          pngChunk("eXIf", exifWithGps()),
        ]),
      ],
      ["webp", Buffer.concat([webpHead, webpBody])],
      [
        "gif",
        gifBytes(1, 1, [
          Buffer.concat([
            Buffer.from([0x21, 0xfe, GPS_MARKER.length]),
            Buffer.from(GPS_MARKER, "latin1"),
            Buffer.from([0]),
          ]),
          Buffer.concat([
            Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
            Buffer.from([2, 2, 0x44, 0x01, 0]),
          ]),
        ]),
      ],
    ];
    for (const [name, bytes] of images) {
      expect(bytes.includes(Buffer.from(GPS_MARKER, "latin1")), name).toBe(
        true,
      );
      const answer = await upload(ids.token, bytes, { fileName: `x.${name}` });
      expect(answer.headers.location, name).toContain("svar=photo-added");
    }
    const own = await prisma.workOrderFile.findMany({
      where: { workOrderId: ids.workOrderId },
      orderBy: { sortOrder: "asc" },
      select: { fileId: true },
    });
    expect(own).toHaveLength(images.length);
    for (const { fileId } of own) {
      const served = await inject({
        method: "GET",
        url: `/arbetsorder/${ids.token}/foto/${fileId}`,
      });
      expect(served.statusCode).toBe(200);
      expect(
        served.rawPayload.includes(Buffer.from(GPS_MARKER, "latin1")),
      ).toBe(false);
    }
  });

  it("G6: an image declaring more pixels than a photograph may have is refused", async () => {
    const ids = await linked();
    const answer = await upload(ids.token, pngBytes(20_000, 20_000), {
      fileName: "x.png",
    });
    expect(answer.headers.location).toContain("svar=photo-too-large");
    expect(
      await prisma.workOrderFile.count({
        where: { workOrderId: ids.workOrderId },
      }),
    ).toBe(0);
  });

  it("G7, G8, J2: the stored name is the server's, the file is declared as showing people, and no log keeps a name", async () => {
    const ids = await linked();
    const named = `Familjen ${CANARY.reporterName} badrum.jpg`;
    await upload(ids.token, jpegBytes(8, 8), { fileName: named });
    const [own] = await prisma.workOrderFile.findMany({
      where: { workOrderId: ids.workOrderId },
      select: { file: true },
    });
    expect(own?.file.fileName).toBe("work-order-photo.jpg");
    expect(own?.file.showsIdentifiablePersons).toBe(true);
    expect(own?.file.visibility).toBe("INTERNAL");
    expect(own?.file.requiredCapability).toBe("issues:handle");
    expect(own?.file.uploadedByPersonId).toBeNull();
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        OR: [{ targetId: ids.issueId }, { targetId: own?.file.id ?? "" }],
      },
    });
    expect(JSON.stringify(entries)).not.toContain(CANARY.reporterName);
    expect(
      entries.find((entry) => entry.action === "MEDIA_UPLOADED")?.channel,
    ).toBe("LINK");
  });

  it("G9, G10: only the handlers the issue lets in read a contractor's photograph", async () => {
    const ids = await linked({ boardOnly: true });
    await upload(ids.token, jpegBytes(8, 8));
    const order = await listedOrder(ids.issueId, ids.workOrderId);
    const url = order.contractorLink.files[0]?.url ?? "";
    expect(
      (await inject({ method: "GET", url, cookie: as(board) })).statusCode,
    ).toBe(200);
    // Anonymous, the reporter, and a property manager whom the board-only
    // issue does not let in, though they hold issues:handle.
    expect((await inject({ method: "GET", url })).statusCode).toBe(404);
    expect(
      (await inject({ method: "GET", url, cookie: as(resident) })).statusCode,
    ).toBe(404);
    expect(
      (await inject({ method: "GET", url, cookie: as(manager) })).statusCode,
    ).toBe(404);
  });

  it("G12: a handler removing a contractor's photograph or note removes it, the object from storage", async () => {
    const ids = await linked();
    await upload(ids.token, jpegBytes(8, 8));
    await act(ids.token, { act: "note", body: `Bort med mig ${suffix}` });
    const order = await listedOrder(ids.issueId, ids.workOrderId);
    const [file] = await prisma.workOrderFile.findMany({
      where: { workOrderId: ids.workOrderId },
      select: { id: true, file: { select: { storageKey: true } } },
    });
    const removed = vi.spyOn(storage, "remove");
    const redact = (payload: object) =>
      inject({
        method: "POST",
        url: `/api/issue-queue/${ids.issueId}/redactions`,
        payload,
        cookie: as(board),
      });
    expect(
      (await redact({ target: "workOrderFile", id: file?.id ?? "" }))
        .statusCode,
    ).toBeLessThan(300);
    expect(removed).toHaveBeenCalledWith(file?.file.storageKey);
    expect(
      (
        await redact({
          target: "workOrderNote",
          id: order.contractorLink.notes[0]?.id ?? "",
        })
      ).statusCode,
    ).toBeLessThan(300);
    const after = await listedOrder(ids.issueId, ids.workOrderId);
    expect(after.contractorLink.files).toEqual([]);
    expect(after.contractorLink.notes[0]?.body).toBe("");
    expect(after.contractorLink.notes[0]?.redactedAt).not.toBeNull();
    expect((await page(ids.token)).body).not.toContain(
      `Bort med mig ${suffix}`,
    );
  });
});

describe("H. what the page shows", () => {
  it("H1, J2: a photograph of the report is served under the server's name, never the one the reporter's file had", async () => {
    const ids = await linked();
    const served = await inject({
      method: "GET",
      url: `/arbetsorder/${ids.token}/foto/${ids.chosenFileId}`,
    });
    expect(served.statusCode).toBe(200);
    // Stored under a name made of the canary, as a reporter's phone might
    // name it after the apartment.
    const stored = await prisma.mediaFile.findUniqueOrThrow({
      where: { id: ids.chosenFileId },
      select: { fileName: true },
    });
    expect(stored.fileName).toContain(CANARY.location);
    expect(JSON.stringify(served.headers)).not.toContain(CANARY.location);
    expect(served.headers["content-disposition"]).toContain(
      "work-order-photo.png",
    );
  });

  it("H5: taking a photograph out of the choice, or off the issue, ends access to it on the next request", async () => {
    const ids = await linked();
    const photo = () =>
      inject({
        method: "GET",
        url: `/arbetsorder/${ids.token}/foto/${ids.chosenFileId}`,
      });
    expect((await photo()).statusCode).toBe(200);
    expect((await choose(ids.issueId, ids.workOrderId, [])).statusCode).toBe(
      204,
    );
    expect((await photo()).statusCode).toBe(404);

    await choose(ids.issueId, ids.workOrderId, [ids.chosenFileId]);
    expect((await photo()).statusCode).toBe(200);
    const [row] = await prisma.issuePhoto.findMany({
      where: { fileId: ids.chosenFileId },
      select: { id: true },
    });
    const redacted = await inject({
      method: "POST",
      url: `/api/issue-queue/${ids.issueId}/redactions`,
      payload: { target: "photo", id: row?.id ?? "" },
      cookie: as(board),
    });
    expect(redacted.statusCode).toBeLessThan(300);
    expect((await photo()).statusCode).toBe(404);
  });

  it("H5: a photograph of another issue cannot be chosen", async () => {
    const ids = await linked();
    const other = await arrange();
    const refused = await choose(ids.issueId, ids.workOrderId, [
      other.chosenFileId,
    ]);
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ reason: string }>().reason).toBe(
      "work-order-photo-not-found",
    );
  });

  it("H6: what a contractor wrote is shown as text, with no markup and no link made of it", async () => {
    const ids = await linked();
    await act(ids.token, {
      act: "note",
      body: '<script>alert(1)</script> https://elsewhere.test/x <b onclick="x">',
    });
    const read = await page(ids.token);
    expect(read.body).not.toContain("<script>alert(1)</script>");
    expect(read.body).toContain("&lt;script&gt;");
    expect(read.body).not.toContain('href="https://elsewhere.test');
  });
});

describe("J. logging and audit", () => {
  it("J1: a failure on a token route logs no token and no path", async () => {
    const ids = await linked();
    const logged: string[] = [];
    for (const level of [
      "log",
      "debug",
      "verbose",
      "warn",
      "error",
      "fatal",
    ] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (...parts: unknown[]) => {
          logged.push(parts.map(String).join(" "));
        },
      );
    }
    vi.spyOn(links, "open").mockRejectedValueOnce(
      new Error(`failed for ${ids.token}`),
    );
    expect((await page(ids.token)).statusCode).toBe(500);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(ids.token);
    expect(logged.join("\n")).not.toContain("/arbetsorder/");
  });

  it("J2, J4: entries name the link and the work order, never the token or a word; a refused request writes none", async () => {
    const ids = await linked();
    const text = `Ord som inte loggas ${suffix}`;
    await act(ids.token, { act: "accept" });
    await act(ids.token, { act: "note", body: text });
    const entries = (await auditFor(ids.issueId)).filter((entry) =>
      entry.action.startsWith("ISSUE_WORK_ORDER_"),
    );
    const linkId = (
      await prisma.workOrderLink.findFirstOrThrow({
        where: { workOrderId: ids.workOrderId },
      })
    ).id;
    for (const action of [
      "ISSUE_WORK_ORDER_PHOTOS_CHOSEN",
      "ISSUE_WORK_ORDER_LINK_ISSUED",
      "ISSUE_WORK_ORDER_ANSWERED",
      "ISSUE_WORK_ORDER_NOTE_ADDED",
    ]) {
      const entry = entries.find((row) => row.action === action);
      expect(entry, action).toBeDefined();
      const context = (entry?.context ?? {}) as { workOrderId?: string };
      expect(context.workOrderId).toBe(ids.workOrderId);
    }
    expect(
      entries
        .filter((row) => row.channel === "LINK")
        .map((row) => (row.context as { linkId?: string }).linkId),
    ).toEqual([linkId, linkId]);
    const all = JSON.stringify(entries);
    expect(all).not.toContain(ids.token);
    expect(all).not.toContain(workOrderLinkDigest(ids.token));
    expect(all).not.toContain(text);

    // What a link's refusal could write: an entry on the link's channel, from
    // this moment on, on the database's clock, which stamps an entry.
    const [window] = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS now`;
    const since = window?.now ?? new Date();
    await page(unknownToken());
    await act(unknownToken(), { act: "accept" });
    await upload(unknownToken(), jpegBytes(8, 8));
    expect(
      await prisma.auditLogEntry.count({
        where: { channel: "LINK", createdAt: { gte: since } },
      }),
    ).toBe(0);
  });
});

describe("the board's side of the link", () => {
  it("lists where each work order's link stands and the photographs it may show", async () => {
    const ids = await arrange();
    const before = await listed(ids.issueId);
    expect(before.linksEnabled).toBe(true);
    expect(before.choosablePhotos.map((photo) => photo.fileId)).toEqual([
      ids.chosenFileId,
      ids.unchosenFileId,
    ]);
    const order = before.workOrders.find((row) => row.id === ids.workOrderId);
    expect(order?.contractorLink.link).toEqual({
      state: "none",
      expiresAt: null,
    });

    const link = await issued(ids.issueId, ids.workOrderId);
    const live = await listedOrder(ids.issueId, ids.workOrderId);
    expect(live.contractorLink.link.state).toBe("live");
    expect(live.contractorLink.link.expiresAt).toBe(link.expiresAt);
  });

  it("refuses a work order of another issue, and a stranger to the issue", async () => {
    const ids = await arrange();
    const other = await arrange();
    const wrong = await inject({
      method: "POST",
      url: linkUrl(ids.issueId, other.workOrderId),
      cookie: as(board),
    });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json<{ reason: string }>().reason).toBe(
      "work-order-not-found",
    );

    const boardOnly = await arrange({ boardOnly: true });
    const stranger = await inject({
      method: "POST",
      url: linkUrl(boardOnly.issueId, boardOnly.workOrderId),
      cookie: as(manager),
    });
    expect(stranger.statusCode).toBe(404);
    expect(
      await prisma.workOrderLink.count({
        where: { workOrderId: boardOnly.workOrderId },
      }),
    ).toBe(0);
  });

  it("refuses a link for a work order whose text is erased", async () => {
    const ids = await arrange();
    await prisma.workOrder.update({
      where: { id: ids.workOrderId },
      data: { body: null },
    });
    const refused = await inject({
      method: "POST",
      url: linkUrl(ids.issueId, ids.workOrderId),
      cookie: as(board),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ reason: string }>().reason).toBe(
      "work-order-text-erased",
    );
  });
});
