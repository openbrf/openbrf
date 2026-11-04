import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createHash } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { AuthService } from "../auth/auth.service";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { registerMultipart } from "../http/multipart";
import { PrismaService } from "../database/prisma.service";
import { IssueConversationService } from "../issues/issue-conversation.service";
import { IssuePurgeService } from "../issues/issue-purge.service";
import {
  REPORTER_LINK_MAILS_PER_ADDRESS_PER_DAY,
  REPORTER_LINK_MESSAGES_PER_HOUR,
  REPORTER_LINK_MESSAGES_PER_ISSUE,
  REPORTER_LINK_QUEUE,
  IssueReporterLinkService,
} from "../issues/issue-reporter-link.service";
import { IssueService } from "../issues/issue.service";
import type { SendMailInput } from "../mail/mail.service";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import type { SentMail } from "../mail/mail-driver";
import {
  type IssueReporterLinkMailProps,
  issueReporterLinkMail,
} from "../mail/templates";
import { lockLegalHoldRegistry } from "../retention/legal-hold-lock";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import {
  createIssueTypeFixture,
  type IssueTypeFixture,
} from "../testing/issue-fixtures";
import { LINK_READS_PER_MINUTE } from "./site-issue-link.controller";

/**
 * The page a reporter's private link opens, through the application as it
 * boots (`createApplication`, so the header hooks are the real ones), a real
 * database and the real rate limiter (ADR 0055).
 *
 * Each `describe` is one group of the controls the threat review of the link
 * required (APT-9360, A to J), and each test fails when the control it names
 * is taken out. The mail server is replaced by a recorder, which is how the
 * suite learns the token: the same way a reporter does, from the mail.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let issues: IssueService;
let links: IssueReporterLinkService;
let conversation: IssueConversationService;
let mail: MailService;

const suffix = process.hrtime.bigint().toString(36);
const PASSWORD = "a-long-enough-password";

const board = {
  personId: `rl-board-${suffix}`,
  email: `rl-board-${suffix}@exempel.se`,
  firstName: "Berit",
  lastName: `Kanariestyrelse${suffix}`,
};

let publicType: IssueTypeFixture;

/** Every mail the application handed to the mail server, in order. */
const sent: SendMailInput<unknown>[] = [];

/**
 * A distinct forwarded address per request, inside this suite's own block:
 * 10.211.0.0/16. The limiter buckets by address, and the tests that spend a
 * budget on purpose name a fixed address of their own.
 */
let ipCounter = 0;
function nextAddress(): string {
  ipCounter += 1;
  return `10.211.${String(Math.floor(ipCounter / 254) % 254)}.${String((ipCounter % 254) + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "HEAD";
  url: string;
  payload?: string | Buffer;
  headers?: Record<string, string>;
  address?: string;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        "x-forwarded-for": options.address ?? nextAddress(),
        "accept-language": "sv-SE,sv;q=0.9",
        ...options.headers,
      },
    });
}

/** A message, as the page's form posts it. */
function post(
  token: string,
  body: string,
  options: { headers?: Record<string, string>; address?: string } = {},
) {
  return inject({
    method: "POST",
    url: `/arende/${token}`,
    payload: new URLSearchParams({ body }).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...options.headers,
    },
    ...(options.address === undefined ? {} : { address: options.address }),
  });
}

function page(token: string, address?: string) {
  return inject({
    method: "GET",
    url: `/arende/${token}`,
    ...(address === undefined ? {} : { address }),
  });
}

let reportCounter = 0;

/**
 * A report from the website's form with an address, its link delivered: what
 * the reporter holds once the mail arrives.
 */
async function reported(
  options: { email?: string; description?: string; name?: string } = {},
): Promise<{ issueId: string; token: string; email: string }> {
  reportCounter += 1;
  const email =
    options.email ??
    `rl-reporter-${String(reportCounter)}-${suffix}@exempel.se`;
  const { id } = await issues.reportPublicly({
    typeId: publicType.id,
    location: null,
    description: options.description ?? `Porten låser inte ${suffix}`,
    reporterName: options.name ?? null,
    reporterEmail: email,
  });
  const before = sent.length;
  expect(await links.deliver(id)).toBe(true);
  const mailed = sent[before];
  if (mailed === undefined) {
    throw new Error("The link was not mailed.");
  }
  return { issueId: id, token: tokenIn(mailed), email };
}

function tokenIn(mailed: SendMailInput<unknown>): string {
  const props = mailed.props as IssueReporterLinkMailProps;
  const match = /\/arende\/(obrf_rl_[A-Za-z0-9_-]{43})$/.exec(props.linkUrl);
  if (match?.[1] === undefined) {
    throw new Error("No token in the link.");
  }
  return match[1];
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: JSON.stringify({ email, password: PASSWORD }),
    headers: { "content-type": "application/json" },
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

/** Every header but the ones that vary with the moment. */
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
  // F4, E3: nothing that lets an answer be cached by a validator, read from
  // another origin, or tied to a session.
  expect(headers.etag).toBeUndefined();
  expect(headers["last-modified"]).toBeUndefined();
  expect(headers["access-control-allow-origin"]).toBeUndefined();
  expect(headers["set-cookie"]).toBeUndefined();
}

async function auditFor(issueId: string) {
  return prisma.auditLogEntry.findMany({
    where: { targetKind: "issue", targetId: issueId },
    orderBy: { createdAt: "asc" },
  });
}

/** Everything a GET could write, for one issue (E1). */
async function snapshot(issueId: string) {
  const [issue, link, messages, audit, jobs] = await Promise.all([
    prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { updatedAt: true, statusId: true, closedAt: true },
    }),
    prisma.issueReporterLink.findUniqueOrThrow({ where: { issueId } }),
    prisma.issueMessage.count({ where: { issueId } }),
    prisma.auditLogEntry.count({ where: { targetId: issueId } }),
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS "count" FROM pgboss.job WHERE data->>'issueId' = ${issueId}`,
  ]);
  return { issue, link, messages, audit, jobs: Number(jobs[0]?.count ?? 0) };
}

beforeAll(async () => {
  const env: Env = { ...baseEnv, OPENBRF_PLUGINS_ENABLED: false };
  app = await createApplication(await loadPluginsAtBoot(env));
  // As main.ts does: the parser is global, which is why the link's route has
  // to refuse a file itself (G13).
  await registerMultipart(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  encryption = app.get(FieldEncryptionService);
  issues = app.get(IssueService);
  links = app.get(IssueReporterLinkService);
  conversation = app.get(IssueConversationService);
  mail = app.get(MailService);

  vi.spyOn(mail, "send").mockImplementation(async (input) => {
    sent.push(input as SendMailInput<unknown>);
    return { messageId: `<rl-${String(sent.length)}@exempel.se>` } as SentMail;
  });

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      setupCompletedAt: new Date(),
      issueReportingPublic: true,
    },
    update: { setupCompletedAt: new Date(), issueReportingPublic: true },
  });

  publicType = await createIssueTypeFixture(prisma, {
    id: `rl-type-${suffix}`,
    name: `Trasig port ${suffix}`,
    reporters: ["PUBLIC"],
    sortOrder: 950,
  });

  const email = await encryption.encrypt("person.email", board.email);
  await prisma.person.create({
    data: {
      id: board.personId,
      firstName: board.firstName,
      lastName: board.lastName,
      emailCipher: email.cipher,
      emailIndex: email.index,
    },
  });
  await app.get(AuthService).createAccountForPerson({
    personId: board.personId,
    email: board.email,
    name: `${board.firstName} ${board.lastName}`,
    password: PASSWORD,
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2025-05-15"),
    },
  });
}, 180_000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(mail, "send").mockImplementation(async (input) => {
    sent.push(input as SendMailInput<unknown>);
    return { messageId: `<rl-${String(sent.length)}@exempel.se>` } as SentMail;
  });
});

afterAll(async () => {
  const personIds = [
    board.personId,
    `rl-restricted-${suffix}`,
    `rl-restricted-late-${suffix}`,
  ];
  await prisma.issue.deleteMany({ where: { typeId: publicType.id } });
  await prisma.issueType.deleteMany({ where: { id: publicType.id } });
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
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await app.close();
});

describe("a reporter without an account", () => {
  it("is mailed a link, reads the conversation on it and answers there", async () => {
    const { issueId, token } = await reported();

    await conversation.replyAsHandler(
      board.personId,
      issueId,
      "Vi skickar en låssmed i morgon.",
    );

    const read = await page(token);
    expect(read.statusCode).toBe(200);
    expect(read.body).toContain("Vi skickar en låssmed i morgon.");
    // Signed by a role, never by the person (decision 19).
    expect(read.body).toContain("Styrelsen");
    expect(read.body).not.toContain(board.lastName);

    const answered = await post(token, "Tack, jag är hemma efter tolv.");
    expect(answered.statusCode).toBe(303);
    expect(answered.headers.location).toBe(`/arende/${token}?svar=sent`);

    const stored = await prisma.issueMessage.findMany({
      where: { issueId },
      orderBy: { createdAt: "asc" },
    });
    expect(stored.map((message) => [message.side, message.body])).toEqual([
      ["HANDLER", "Vi skickar en låssmed i morgon."],
      ["REPORTER", "Tack, jag är hemma efter tolv."],
    ]);
    // No person behind a link.
    expect(stored[1]?.authorPersonId).toBeNull();

    const after = await inject({
      method: "GET",
      url: String(answered.headers.location),
    });
    expect(after.body).toContain("Tack, jag är hemma efter tolv.");
    expect(after.body).toContain("Ditt meddelande har skickats");
  });

  it("is not mailed, and gets no follow-up, without an address", async () => {
    const before = sent.length;
    const { id } = await issues.reportPublicly({
      typeId: publicType.id,
      location: null,
      description: "Ingen adress",
      reporterName: null,
      reporterEmail: null,
    });

    expect(await links.deliver(id)).toBe(false);
    expect(sent.length).toBe(before);
    expect(
      await prisma.issueReporterLink.count({ where: { issueId: id } }),
    ).toBe(0);
    await expect(
      conversation.replyAsHandler(board.personId, id, "Hej"),
    ).rejects.toMatchObject({ reason: "no-reporter" });
    // And nothing was queued to mail anybody.
    const jobs = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS "count" FROM pgboss.job
      WHERE name = ${REPORTER_LINK_QUEUE} AND data->>'issueId' = ${id}`;
    expect(Number(jobs[0]?.count)).toBe(0);
  });

  it("queues the link mail in the transaction that files the report, carrying no token", async () => {
    const { id } = await issues.reportPublicly({
      typeId: publicType.id,
      location: null,
      description: "Kö",
      reporterName: null,
      reporterEmail: `rl-queued-${suffix}@exempel.se`,
    });
    const jobs = await prisma.$queryRaw<{ data: Record<string, unknown> }[]>`
      SELECT data FROM pgboss.job
      WHERE name = ${REPORTER_LINK_QUEUE} AND data->>'issueId' = ${id}`;
    expect(jobs.map((job) => job.data)).toEqual([
      { issueId: id, locale: null },
    ]);
  });

  it("is mailed in the language the reporter read the form in", async () => {
    const slug = `rl-form-${suffix}`;
    await prisma.page.create({
      data: {
        slug,
        title: "Felanmälan",
        content: { version: 1, blocks: [{ type: "issueReportForm" }] },
        status: "PUBLIC",
        publishedAt: new Date(),
        sortOrder: 950,
      },
    });
    try {
      const description = `På engelska ${suffix}`;
      const answer = await inject({
        method: "POST",
        url: `/${slug}/felanmalan`,
        payload: new URLSearchParams({
          type: publicType.id,
          description,
          email: `rl-english-${suffix}@exempel.se`,
        }).toString(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "accept-language": "en-GB,en;q=0.9",
        },
      });
      expect(answer.statusCode).toBe(303);
      const issue = await prisma.issue.findFirstOrThrow({
        where: { typeId: publicType.id, description },
        select: { id: true },
      });
      const jobs = await prisma.$queryRaw<{ data: Record<string, unknown> }[]>`
        SELECT data FROM pgboss.job
        WHERE name = ${REPORTER_LINK_QUEUE} AND data->>'issueId' = ${issue.id}`;
      expect(jobs.map((job) => job.data)).toEqual([
        { issueId: issue.id, locale: "en" },
      ]);

      const before = sent.length;
      expect(await links.deliver(issue.id, "en")).toBe(true);
      expect(sent[before]?.locale).toBe("en");
      const rendered = await mail.renderMail({
        locale: "en",
        template: issueReporterLinkMail,
        props: sent[before]?.props as IssueReporterLinkMailProps,
      });
      expect(rendered.subject).toMatch(/^Your report to /);
      expect(rendered.html).toContain("Thank you for your report");
      expect(rendered.html).toContain("you reported an issue to");
    } finally {
      await prisma.page.deleteMany({ where: { slug } });
    }
  });
});

describe("A. the token", () => {
  it("A1: is 32 random bytes in base64url behind the reporter's prefix", async () => {
    const { token } = await reported();
    expect(token.startsWith("obrf_rl_")).toBe(true);
    expect(Buffer.from(token.slice(8), "base64url")).toHaveLength(32);
  });

  it("A2: is stored as its SHA-256 digest and nowhere as itself", async () => {
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
    const { issueId, token } = await reported();
    await post(token, "Ett svar");

    const row = await prisma.issueReporterLink.findUniqueOrThrow({
      where: { issueId },
    });
    expect(row.tokenDigest).toBe(
      createHash("sha256").update(token, "utf8").digest("base64url"),
    );
    expect(JSON.stringify(row)).not.toContain(token);

    const audit = await auditFor(issueId);
    expect(audit.length).toBeGreaterThan(0);
    for (const entry of audit) {
      expect(JSON.stringify(entry)).not.toContain(token);
      expect(JSON.stringify(entry)).not.toContain(row.tokenDigest);
    }

    const jobs = await prisma.$queryRaw<{ data: unknown }[]>`
      SELECT data FROM pgboss.job WHERE data->>'issueId' = ${issueId}`;
    expect(jobs.length).toBeGreaterThan(0);
    expect(JSON.stringify(jobs)).not.toContain(token);

    expect(logged.join("\n")).not.toContain(token);
    expect(logged.join("\n")).not.toContain(token.slice(8));
  });

  it("A3: is read from the path alone, and a malformed one is refused before the database is asked", async () => {
    const { token } = await reported();
    const unknown = await page(`obrf_rl_${"A".repeat(43)}`);

    // Every way this code reaches the database: a transaction, a raw
    // statement, or the link's own table.
    const asked = [
      vi.spyOn(prisma, "$transaction"),
      vi.spyOn(prisma, "$queryRaw"),
      vi.spyOn(prisma, "$executeRaw"),
      vi.spyOn(prisma.issueReporterLink, "findUnique"),
      vi.spyOn(prisma.issueReporterLink, "findFirst"),
      vi.spyOn(prisma.issueReporterLink, "findMany"),
    ];
    try {
      for (const malformed of [
        "obrf_dt_" + token.slice(8),
        token.slice(0, -1),
        `${token}A`,
        token.replace(/.$/, "%"),
        "x",
      ]) {
        const answer = await page(encodeURIComponent(malformed));
        expect(answer.statusCode).toBe(404);
        expect(answer.body).toBe(unknown.body);
      }
      for (const spy of asked) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of asked) {
        spy.mockRestore();
      }
    }

    // A token anywhere but the path opens nothing.
    const inQuery = await inject({
      method: "GET",
      url: `/arende/obrf_rl_${"B".repeat(43)}?token=${token}`,
    });
    expect(inQuery.statusCode).toBe(404);
    const inHeader = await inject({
      method: "GET",
      url: `/arende/obrf_rl_${"B".repeat(43)}`,
      headers: { authorization: `Bearer ${token}`, "x-token": token },
    });
    expect(inHeader.statusCode).toBe(404);
  });

  it("A6: is mailed in one address built from APP_URL, in the body and never the subject", async () => {
    const before = sent.length;
    const { token } = await reported();
    const mailed = sent[before];
    expect(mailed?.template).toBe(issueReporterLinkMail);
    const props = mailed?.props as IssueReporterLinkMailProps;
    expect(props.linkUrl).toBe(
      `${baseEnv.APP_URL.replace(/\/+$/, "")}/arende/${token}`,
    );

    const rendered = await mail.renderMail({
      locale: null,
      template: issueReporterLinkMail,
      props,
    });
    expect(rendered.subject).not.toContain(token);
    // The footer says why this mail came, not that the reader is in the
    // address book: the reporter may be nobody the association knows.
    expect(rendered.html).toContain("Du får detta eftersom du har anmält");
    expect(rendered.html).not.toContain("adressboken");
    const hrefs = [...rendered.html.matchAll(/href="([^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(new Set(hrefs)).toEqual(new Set([props.linkUrl]));
    const urls = rendered.text.match(/https?:\/\/\S+/g) ?? [];
    expect(new Set(urls)).toEqual(new Set([props.linkUrl]));
  });
});

describe("B. lifetime and revocation", () => {
  it("B1: a withdrawn link answers 404 on the very next request", async () => {
    const { issueId, token } = await reported();
    expect((await page(token)).statusCode).toBe(200);
    const cookie = await signIn(board.email);

    const withdrawn = await inject({
      method: "POST",
      url: `/api/issue-queue/${issueId}/reporter-link/revoke`,
      headers: { cookie, origin: new URL(baseEnv.APP_URL).origin },
    });
    expect(withdrawn.statusCode).toBe(204);

    expect((await page(token)).statusCode).toBe(404);
    expect((await post(token, "Hallå?")).statusCode).toBe(404);
    // Nobody was mailed about it.
    const audit = await auditFor(issueId);
    expect(audit.at(-1)).toMatchObject({
      action: "ISSUE_REPORTER_LINK_REVOKED",
      channel: "WEB",
      actorPersonId: board.personId,
    });
    // And the handler can no longer write to nobody.
    await expect(
      conversation.replyAsHandler(board.personId, issueId, "Hej"),
    ).rejects.toMatchObject({ reason: "no-reporter" });
  });

  it("B1: an expired link answers 404", async () => {
    const { issueId, token } = await reported();
    await prisma.issueReporterLink.update({
      where: { issueId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await page(token)).statusCode).toBe(404);
  });

  it("B4: reads, without a field to write in, for 30 days after closing, and nothing after", async () => {
    const { issueId, token } = await reported();
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        statusId: publicType.statusIds.DONE,
        outcome: "FIXED",
        closedAt: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000),
      },
    });
    const closed = await page(token);
    expect(closed.statusCode).toBe(200);
    expect(closed.body).not.toContain("<textarea");
    expect(closed.body).toContain("Ärendet är avslutat");

    const refused = await post(token, "En sak till");
    expect(refused.headers.location).toBe(`/arende/${token}?svar=closed`);

    await prisma.issue.update({
      where: { id: issueId },
      data: { closedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    });
    expect((await page(token)).statusCode).toBe(404);
  });

  it("B4: an issue that stays open keeps the link a year after its latest message, and no longer", async () => {
    const { issueId, token } = await reported();
    const issued = await prisma.issueReporterLink.findUniqueOrThrow({
      where: { issueId },
    });
    const year = 365 * 24 * 60 * 60 * 1000;
    expect(issued.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(year);

    await prisma.issueReporterLink.update({
      where: { issueId },
      data: { expiresAt: new Date(Date.now() + 60_000) },
    });
    await conversation.replyAsHandler(
      board.personId,
      issueId,
      "Fortfarande på gång.",
    );
    const extended = await prisma.issueReporterLink.findUniqueOrThrow({
      where: { issueId },
    });
    expect(extended.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + year - 60_000,
    );
    expect(extended.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + year + 60_000,
    );
    expect((await page(token)).statusCode).toBe(200);
  });

  it("B5: the purge that clears the reporter's address removes the link in its transaction", async () => {
    const { issueId, token } = await reported();
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        statusId: publicType.statusIds.DONE,
        outcome: "FIXED",
        closedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      },
    });

    expect(
      await app.get(IssuePurgeService).purgeIssue(issueId, new Date(), 365),
    ).toBe(true);

    expect(await prisma.issueReporterLink.count({ where: { issueId } })).toBe(
      0,
    );
    expect((await page(token)).statusCode).toBe(404);
  });

  it("B1: a link whose report lost its address answers 404 whatever its row says", async () => {
    const { issueId, token } = await reported();
    await prisma.issue.update({
      where: { id: issueId },
      data: { reporterEmailCipher: null, reporterEmailIndex: null },
    });
    expect((await page(token)).statusCode).toBe(404);
  });
});

describe("C. no enumeration", () => {
  it("C1: every link that opens nothing gets the same status, bytes and headers", async () => {
    const revoked = await reported();
    await links.revoke(board.personId, revoked.issueId);
    const expired = await reported();
    await prisma.issueReporterLink.update({
      where: { issueId: expired.issueId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const closedLongAgo = await reported();
    await prisma.issue.update({
      where: { id: closedLongAgo.issueId },
      data: {
        statusId: publicType.statusIds.DONE,
        outcome: "FIXED",
        closedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      },
    });
    const purged = await reported();
    await prisma.issue.update({
      where: { id: purged.issueId },
      data: { reporterEmailCipher: null, reporterEmailIndex: null },
    });
    const unmailed = await reported();
    await prisma.issueReporterLink.update({
      where: { issueId: unmailed.issueId },
      data: { mailedAt: null },
    });

    const answers = await Promise.all(
      [
        `obrf_rl_${"C".repeat(43)}`,
        "not-a-token",
        `obrf_dt_${"C".repeat(43)}`,
        revoked.token,
        expired.token,
        closedLongAgo.token,
        purged.token,
        unmailed.token,
      ].map((token) => page(token)),
    );
    const [first, ...rest] = answers;
    expect(first?.statusCode).toBe(404);
    for (const answer of rest) {
      expect(answer.statusCode).toBe(404);
      expect(answer.body).toBe(first?.body);
      expect(stableHeaders(answer.headers)).toEqual(
        stableHeaders(first?.headers ?? {}),
      );
    }
    expect(first?.headers["set-cookie"]).toBeUndefined();

    // A post is refused with the same document.
    const posted = await post(revoked.token, "Hej");
    expect(posted.statusCode).toBe(404);
    expect(posted.body).toBe(first?.body);
  });

  it("C3: nothing beside the token names an issue", async () => {
    const mine = await reported();
    const other = await reported();
    const answer = await inject({
      method: "POST",
      url: `/arende/${mine.token}`,
      payload: new URLSearchParams({
        body: "Mitt svar",
        issueId: other.issueId,
        id: other.issueId,
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(answer.statusCode).toBe(303);
    expect(
      await prisma.issueMessage.count({ where: { issueId: other.issueId } }),
    ).toBe(0);
    expect(
      await prisma.issueMessage.count({
        where: { issueId: mine.issueId, body: "Mitt svar" },
      }),
    ).toBe(1);
  });
});

describe("the link's path, as the router reads it", () => {
  it("F1: a percent-encoded spelling of the path opens the page and refuses with the link's headers", async () => {
    const { token } = await reported();
    const unknown = await page(`obrf_rl_${"P".repeat(43)}`);

    const read = await inject({ method: "GET", url: `/%61rende/${token}` });
    expect(read.statusCode).toBe(200);
    expectLinkHeaders(read.headers);

    for (const url of [
      `/%61rende/obrf_rl_${"P".repeat(43)}`,
      "/%61rende/not-a-token",
    ]) {
      const refused = await inject({ method: "GET", url });
      expect(refused.statusCode).toBe(404);
      expect(refused.body).toBe(unknown.body);
      expectLinkHeaders(refused.headers);
    }
  });

  it("F1: a post below the path that is not a token's carries the link's headers", async () => {
    const refused = await post("not-a-token", "Hej");
    expect(refused.statusCode).toBe(404);
    expectLinkHeaders(refused.headers);
  });

  it("leaves the forms of a page that kept the slug arende to the website", async () => {
    // The slug is claimed for a new page, so the row is written directly, as a
    // page written before the claim would be.
    const slug = "arende";
    await prisma.page.create({
      data: {
        slug,
        title: "Ärenden",
        content: {
          version: 1,
          blocks: [
            { type: "contactForm", intro: [{ text: "Skriv till oss." }] },
            { type: "issueReportForm" },
          ],
        },
        status: "PUBLIC",
        publishedAt: new Date(),
        sortOrder: 951,
      },
    });
    const message = `Till sidan på arende ${suffix}`;
    const description = `Från sidan på arende ${suffix}`;
    try {
      const shown = await inject({ method: "GET", url: `/${slug}` });
      expect(shown.statusCode).toBe(200);
      expect(shown.body).toContain(`action="/${slug}/kontakt"`);

      const contacted = await inject({
        method: "POST",
        url: `/${slug}/kontakt`,
        payload: new URLSearchParams({
          name: "Bo Ek",
          email: `rl-contact-${suffix}@exempel.se`,
          message,
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(contacted.statusCode).toBe(303);
      expect(contacted.headers.location).toBe(`/${slug}?skickat=kontakt`);
      // The website's answer, not the link's.
      expect(contacted.headers["referrer-policy"]).not.toBe("no-referrer");
      expect(await prisma.contactSubmission.count({ where: { message } })).toBe(
        1,
      );

      const reportedThere = await inject({
        method: "POST",
        url: `/${slug}/felanmalan`,
        payload: new URLSearchParams({
          type: publicType.id,
          description,
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(reportedThere.statusCode).toBe(303);
      expect(reportedThere.headers.location).toBe(
        `/${slug}?skickat=felanmalan`,
      );
      expect(
        await prisma.issue.count({
          where: { typeId: publicType.id, description },
        }),
      ).toBe(1);
    } finally {
      await prisma.contactSubmission.deleteMany({ where: { message } });
      await prisma.page.deleteMany({ where: { slug } });
    }
  });
});

describe("D. rate limits and abuse", () => {
  it("D2, D3: the 31st read from one address is refused, alike for a live token and an unknown one", async () => {
    const { token } = await reported();
    const address = "10.211.250.1";
    for (let n = 0; n < LINK_READS_PER_MINUTE; n += 1) {
      const answer = await page(
        `obrf_rl_${String(n).padStart(43, "D")}`,
        address,
      );
      expect(answer.statusCode).toBe(404);
    }

    const live = await page(token, address);
    const unknown = await page(`obrf_rl_${"E".repeat(43)}`, address);
    expect(live.statusCode).toBe(429);
    expect(unknown.statusCode).toBe(429);
    expect(live.body).toBe(unknown.body);
    expectLinkHeaders(live.headers);
    const { "retry-after": _a, ...liveRest } = stableHeaders(live.headers);
    const { "retry-after": _b, ...unknownRest } = stableHeaders(
      unknown.headers,
    );
    expect(liveRest).toEqual(unknownRest);
  });

  it("D4: a link's messages share one budget whatever address they come from", async () => {
    const { issueId, token } = await reported();
    const addresses = ["10.211.251.1", "10.211.251.2", "10.211.251.3"];
    for (let n = 0; n < REPORTER_LINK_MESSAGES_PER_HOUR; n += 1) {
      const answer = await post(token, `Meddelande ${String(n)}`, {
        address: addresses[n % 2] ?? "",
      });
      expect(answer.headers.location).toBe(`/arende/${token}?svar=sent`);
    }
    const over = await post(token, "Ett till", { address: addresses[2] ?? "" });
    expect(over.headers.location).toBe(`/arende/${token}?svar=limited`);
    expect(await prisma.issueMessage.count({ where: { issueId } })).toBe(
      REPORTER_LINK_MESSAGES_PER_HOUR,
    );
  });

  it("D4: a link that has written all it may is told so, and not to try later", async () => {
    const { issueId, token } = await reported();
    await prisma.issueMessage.createMany({
      data: Array.from(
        { length: REPORTER_LINK_MESSAGES_PER_ISSUE },
        (_, n) => ({
          issueId,
          side: "REPORTER" as const,
          authorPersonId: null,
          body: `Meddelande ${String(n)}`,
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        }),
      ),
    });
    const over = await post(token, "Ett till");
    expect(over.headers.location).toBe(`/arende/${token}?svar=full`);
    // The redirect's target says so in words, not only in its query.
    const told = await inject({
      method: "GET",
      url: String(over.headers.location),
    });
    expect(told.statusCode).toBe(200);
    expect(told.body).toContain(
      "Fler meddelanden kan inte skickas via länken.",
    );
    // ...once: the page does not repeat the notice under the conversation.
    expect(
      told.body.split("Fler meddelanden kan inte skickas via länken.").length -
        1,
    ).toBe(1);
    expect(
      await prisma.issueMessage.count({ where: { issueId, side: "REPORTER" } }),
    ).toBe(REPORTER_LINK_MESSAGES_PER_ISSUE);

    // The page offers no field, and says why: the issue is open, not closed.
    const read = await page(token);
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain("<textarea");
    expect(read.body).toContain(
      "Fler meddelanden kan inte skickas via länken.",
    );
    expect(read.body).not.toContain("är avslutat");
  });

  it("D5: strangers' failed guesses never lock a live link", async () => {
    const { token } = await reported();
    for (let n = 0; n < 40; n += 1) {
      await page(`obrf_rl_${String(n).padStart(43, "F")}`);
    }
    expect((await page(token)).statusCode).toBe(200);
  });

  it("D6: one link mail per issue, never again, and three a day to one address", async () => {
    const email = `rl-capped-${suffix}@exempel.se`;
    const first = await reported({ email });
    expect(await links.deliver(first.issueId)).toBe(false);

    for (let n = 1; n < REPORTER_LINK_MAILS_PER_ADDRESS_PER_DAY; n += 1) {
      await reported({ email });
    }
    const before = sent.length;
    const { id } = await issues.reportPublicly({
      typeId: publicType.id,
      location: null,
      description: "En för mycket",
      reporterName: null,
      reporterEmail: email,
    });
    expect(await links.deliver(id)).toBe(false);
    expect(sent.length).toBe(before);
    expect(
      await prisma.issueReporterLink.count({ where: { issueId: id } }),
    ).toBe(0);
  });

  it("D6: a person who restricted processing is not mailed", async () => {
    const email = `rl-restricted-${suffix}@exempel.se`;
    const sealed = await encryption.encrypt("person.email", email);
    const personId = `rl-restricted-${suffix}`;
    await prisma.person.create({
      data: {
        id: personId,
        firstName: "Rita",
        lastName: `Begränsad${suffix}`,
        emailCipher: sealed.cipher,
        emailIndex: sealed.index,
        processingRestrictedAt: new Date(),
      },
    });
    try {
      const { id } = await issues.reportPublicly({
        typeId: publicType.id,
        location: null,
        description: "Begränsad",
        reporterName: null,
        reporterEmail: email,
      });
      expect(await links.deliver(id)).toBe(false);
    } finally {
      await prisma.person.update({
        where: { id: personId },
        data: { processingRestrictedAt: null },
      });
    }
  });

  it("D6: a restriction granted while the delivery waits for the registry lock is seen, and nothing is mailed", async () => {
    const email = `rl-restricted-late-${suffix}@exempel.se`;
    const sealed = await encryption.encrypt("person.email", email);
    const personId = `rl-restricted-late-${suffix}`;
    await prisma.person.create({
      data: {
        id: personId,
        firstName: "Rolf",
        lastName: `Sen${suffix}`,
        emailCipher: sealed.cipher,
        emailIndex: sealed.index,
      },
    });
    const { id } = await issues.reportPublicly({
      typeId: publicType.id,
      location: null,
      description: "Begränsad senare",
      reporterName: null,
      reporterEmail: email,
    });
    const before = sent.length;

    // Stands in for a restriction's grant, which holds the registry lock until
    // it commits: the delivery gets to the lock and waits there.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const granting = prisma.$transaction(async (tx) => {
      await lockLegalHoldRegistry(tx);
      await tx.person.update({
        where: { id: personId },
        data: { processingRestrictedAt: new Date() },
      });
      locked();
      await held;
    });
    try {
      await lockTaken;
      const delivering = links.deliver(id);
      // Until the delivery has issued its link and waits at the registry
      // lock; releasing earlier would let it pass before it reaches the lock.
      await waitFor(
        async () =>
          (await advisoryLockCount(prisma, "legal-hold:registry", false)) > 0n,
        10_000,
      );
      release();
      await granting;

      expect(await delivering).toBe(false);
      expect(sent.length).toBe(before);
      // Refused, so the link is given up and no longer counts for its address.
      expect(
        await prisma.issueReporterLink.count({ where: { issueId: id } }),
      ).toBe(0);
    } finally {
      release();
      await granting.catch(() => undefined);
      await prisma.person.update({
        where: { id: personId },
        data: { processingRestrictedAt: null },
      });
    }
  });

  it("D6: an issue closed while the delivery waits for the registry lock is not mailed", async () => {
    const { id } = await issues.reportPublicly({
      typeId: publicType.id,
      location: null,
      description: "Stängd medan länken väntar",
      reporterName: null,
      reporterEmail: `rl-closed-late-${suffix}@exempel.se`,
    });
    const before = sent.length;

    // Holds the registry lock as a restriction's grant would, so the delivery
    // has issued its link and waits at the lock of its mail transaction.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = prisma.$transaction(async (tx) => {
      await lockLegalHoldRegistry(tx);
      locked();
      await held;
    });
    try {
      await lockTaken;
      const delivering = links.deliver(id);
      // Wait until the first transaction has committed the link.
      await waitFor(
        async () =>
          (await prisma.issueReporterLink.findUnique({
            where: { issueId: id },
            select: { id: true },
          })) !== null,
        10_000,
      );
      // The link is issued and not yet mailed: the first transaction is done.
      expect(
        await prisma.issueReporterLink.findUnique({
          where: { issueId: id },
          select: { mailedAt: true },
        }),
      ).toEqual({ mailedAt: null });
      await prisma.issue.update({
        where: { id },
        data: {
          statusId: publicType.statusIds.DONE,
          outcome: "FIXED",
          closedAt: new Date(),
        },
      });
      release();
      await holding;

      expect(await delivering).toBe(false);
      expect(sent.length).toBe(before);
      expect(
        await prisma.issueReporterLink.count({ where: { issueId: id } }),
      ).toBe(0);
    } finally {
      release();
      await holding.catch(() => undefined);
    }
  });

  it("D6: a link that was refused or abandoned gives its slot back; one still being retried keeps it", async () => {
    const email = `rl-slots-${suffix}@exempel.se`;
    const report = async () =>
      (
        await issues.reportPublicly({
          typeId: publicType.id,
          location: null,
          description: "Plats i dagsgränsen",
          reporterName: null,
          reporterEmail: email,
        })
      ).id;

    await reported({ email });
    await reported({ email });

    // The mail server refuses (the job will be retried): the link is issued,
    // unmailed, and still counts.
    const retried = await report();
    vi.spyOn(mail, "send").mockRejectedValueOnce(new Error("connection reset"));
    await expect(links.deliver(retried)).rejects.toThrow("connection reset");
    expect(
      await prisma.issueReporterLink.count({ where: { issueId: retried } }),
    ).toBe(1);
    const blocked = await report();
    expect(await links.deliver(blocked)).toBe(false);

    // Retries spent: the slot goes back and the next report is mailed.
    await links.abandon(retried);
    expect(
      await prisma.issueReporterLink.count({ where: { issueId: retried } }),
    ).toBe(0);
    const before = sent.length;
    expect(await links.deliver(blocked)).toBe(true);
    expect(sent.length).toBe(before + 1);
  });

  it("B1: a retried mail runs the link's year from the mail that went", async () => {
    const { id } = await issues.reportPublicly({
      typeId: publicType.id,
      location: null,
      description: "Mejlet skickas på andra försöket",
      reporterName: null,
      reporterEmail: `rl-retried-${suffix}@exempel.se`,
    });
    vi.spyOn(mail, "send").mockRejectedValueOnce(new Error("connection reset"));
    await expect(links.deliver(id)).rejects.toThrow("connection reset");

    // The first attempt set the end; the retry comes later. Make the gap long.
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma.issueReporterLink.update({
      where: { issueId: id },
      data: { expiresAt: soon },
    });

    expect(await links.deliver(id)).toBe(true);
    const link = await prisma.issueReporterLink.findUniqueOrThrow({
      where: { issueId: id },
      select: { expiresAt: true },
    });
    const year = 365 * 24 * 60 * 60 * 1000;
    expect(link.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + year - 60_000,
    );
    expect(link.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + year + 60_000,
    );
  });

  it("D6: an instance without mail settings issues no link that holds a slot", async () => {
    const email = `rl-unconfigured-${suffix}@exempel.se`;
    const { id } = await issues.reportPublicly({
      typeId: publicType.id,
      location: null,
      description: "Ingen e-post inställd",
      reporterName: null,
      reporterEmail: email,
    });
    vi.spyOn(mail, "send").mockRejectedValueOnce(new MailNotConfiguredError());
    expect(await links.deliver(id)).toBe(false);
    expect(
      await prisma.issueReporterLink.count({ where: { issueId: id } }),
    ).toBe(0);
  });

  it("D6: an issue closed while the mail is being sent waits for the stamp", async () => {
    const { id } = await issues.reportPublicly({
      typeId: publicType.id,
      location: null,
      description: "Stängd medan mejlet skickas",
      reporterName: null,
      reporterEmail: `rl-closed-sending-${suffix}@exempel.se`,
    });
    const before = sent.length;

    // The mail server holds the message until released.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const sendEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(mail, "send").mockImplementation(async (input) => {
      entered();
      await held;
      sent.push(input as SendMailInput<unknown>);
      return {
        messageId: `<rl-${String(sent.length)}@exempel.se>`,
      } as SentMail;
    });

    try {
      const delivering = links.deliver(id);
      await sendEntered;

      let closeSettled = false;
      const closing = issues
        .setStatus(
          id,
          { statusId: publicType.statusIds.DONE, outcome: "FIXED" },
          board.personId,
        )
        .finally(() => {
          closeSettled = true;
        });
      // Neither of the two awaits the other here: the delivery holds the
      // issue's lock until the send is released, so awaiting the close first
      // would never return. The close is seen queued on that lock, which a
      // delay could not tell from a close that is merely slow.
      await waitFor(
        async () =>
          (await advisoryLockCount(prisma, `issue:${id}`, false)) > 0n,
        10_000,
      );
      expect(closeSettled).toBe(false);

      // A second transaction holds the link's row, so the stamp that follows
      // the send waits on it: the close must stay behind the stamp, not only
      // behind the send.
      let letStampGo: () => void = () => undefined;
      const stampHeld = new Promise<void>((resolve) => {
        letStampGo = resolve;
      });
      let holderPid = 0;
      let holderLocked: () => void = () => undefined;
      const holderHasRow = new Promise<void>((resolve) => {
        holderLocked = resolve;
      });
      const holder = prisma.$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<{ pid: number }[]>`
            SELECT pg_backend_pid() AS pid`;
          holderPid = row?.pid ?? 0;
          await tx.$queryRaw`
            SELECT id FROM issue_reporter_link
            WHERE "issueId" = ${id} FOR UPDATE`;
          holderLocked();
          await stampHeld;
        },
        { timeout: 30_000 },
      );
      try {
        await holderHasRow;
        release();
        // The stamp is queued behind the holder.
        await waitFor(async () => {
          const [row] = await prisma.$queryRaw<{ blocked: bigint }[]>`
            SELECT count(*) AS blocked FROM pg_stat_activity
            WHERE datname = current_database()
              AND pg_blocking_pids(pid) @> ARRAY[${holderPid}::int]`;
          return (row?.blocked ?? 0n) > 0n;
        }, 10_000);
        expect(closeSettled).toBe(false);
        expect(
          await prisma.issueReporterLink.findUnique({
            where: { issueId: id },
            select: { mailedAt: true },
          }),
        ).toEqual({ mailedAt: null });
      } finally {
        letStampGo();
        await holder;
      }

      expect(await delivering).toBe(true);
      await closing;
      expect(sent.length).toBe(before + 1);
      expect(
        await prisma.issueReporterLink.findUnique({
          where: { issueId: id },
          select: { mailedAt: true },
        }),
      ).toEqual({ mailedAt: expect.any(Date) });
    } finally {
      release();
    }
  });

  it("D7: a message longer than an issue message may be is refused, and a body past the route's limit is refused before it is read", async () => {
    const { issueId, token } = await reported();
    const tooLong = await post(token, "x".repeat(4001));
    expect(tooLong.headers.location).toBe(`/arende/${token}?svar=refused`);

    const huge = await post(token, "x".repeat(70_000));
    expect(huge.statusCode).toBe(413);
    expectLinkHeaders(huge.headers);
    expect(await prisma.issueMessage.count({ where: { issueId } })).toBe(0);
  });

  it("D7: a message carrying a personal identity number is refused, and says so", async () => {
    const { issueId, token } = await reported();
    const answer = await post(token, "Mitt personnummer är 19811218-9876.");
    expect(answer.headers.location).toBe(`/arende/${token}?svar=identity`);
    expect(await prisma.issueMessage.count({ where: { issueId } })).toBe(0);
  });
});

describe("E. what a request may do", () => {
  it("E1, E2: a GET and a HEAD with a live token write nothing at all", async () => {
    const { issueId, token } = await reported();
    const before = await snapshot(issueId);

    expect((await page(token)).statusCode).toBe(200);
    expect(
      (await inject({ method: "HEAD", url: `/arende/${token}` })).statusCode,
    ).toBe(200);
    expect(
      (await inject({ method: "GET", url: `/arende/${token}?svar=sent` }))
        .statusCode,
    ).toBe(200);

    expect(await snapshot(issueId)).toEqual(before);
  });

  it("E3: a session cookie changes nothing, and the act is on the link's channel", async () => {
    const { issueId, token } = await reported();
    const cookie = await signIn(board.email);
    const without = await page(token);
    const withCookie = await inject({
      method: "GET",
      url: `/arende/${token}`,
      headers: { cookie },
    });
    expect(withCookie.body).toBe(without.body);
    expect(withCookie.headers["set-cookie"]).toBeUndefined();

    await post(token, "Med en kaka", { headers: { cookie } });
    const entry = (await auditFor(issueId)).at(-1);
    expect(entry).toMatchObject({
      action: "ISSUE_MESSAGE_SENT",
      channel: "LINK",
      actorPersonId: null,
    });
    expect(entry?.context).toMatchObject({
      linkId: expect.any(String) as string,
      messageId: expect.any(String) as string,
    });
  });

  it("E5, G13: a post from another origin, of another type or with a file is refused and stores nothing", async () => {
    const { issueId, token } = await reported();
    const notFound = await page(`obrf_rl_${"G".repeat(43)}`);
    const fileName = `rl-${suffix}.png`;

    const foreign = await post(token, "Från en annan sajt", {
      headers: { origin: "https://elak.example" },
    });
    const json = await inject({
      method: "POST",
      url: `/arende/${token}`,
      payload: JSON.stringify({ body: "Som JSON" }),
      headers: { "content-type": "application/json" },
    });
    const boundary = "----rlBoundary";
    const multipart = await inject({
      method: "POST",
      url: `/arende/${token}`,
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="body"\r\n\r\nHej\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\nPNG\r\n` +
          `--${boundary}--\r\n`,
      ),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    for (const answer of [foreign, json, multipart]) {
      expect(answer.statusCode).toBe(404);
      expect(answer.body).toBe(notFound.body);
    }
    expect(await prisma.issueMessage.count({ where: { issueId } })).toBe(0);
    expect(await prisma.mediaFile.count({ where: { fileName } })).toBe(0);

    // The page's own form, under no-referrer, posts with Origin: null.
    const own = await post(token, "Från sidan", {
      headers: { origin: "null" },
    });
    expect(own.statusCode).toBe(303);
    const same = await post(token, "Från samma ursprung", {
      headers: { origin: new URL(baseEnv.APP_URL).origin },
    });
    expect(same.statusCode).toBe(303);
  });
});

describe("F. response headers", () => {
  it("F1, E4: every answer carries the link's headers, the 200, 303, 404 and a 500 included", async () => {
    const { token } = await reported();
    expectLinkHeaders((await page(token)).headers);
    expectLinkHeaders((await post(token, "Hej")).headers);
    expectLinkHeaders((await page(`obrf_rl_${"H".repeat(43)}`)).headers);

    vi.spyOn(links, "open").mockRejectedValueOnce(new Error("forced"));
    const failed = await page(token);
    expect(failed.statusCode).toBe(500);
    expectLinkHeaders(failed.headers);
  });

  it("F2, F3: the page loads nothing from another origin, and its title says nothing about the issue", async () => {
    const { token } = await reported({ description: `Kanarie ${suffix}` });
    const read = await page(token);
    expect(read.body).not.toMatch(/(?:href|src|action)="(?:https?:)?\/\//);
    const title = /<title>([^<]*)<\/title>/.exec(read.body)?.[1];
    expect(title).toBe("Ditt ärende - Brf Eksemplet");
  });
});

describe("H. what the page shows", () => {
  it("H1, H2: no assignee, note, handler's name, waiting reason or anything the reporter wrote", async () => {
    const canary = `KANARIE${suffix}`;
    const { issueId, token } = await reported({
      description: `${canary}-beskrivning`,
      name: `${canary}-namn`,
    });
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        location: `${canary}-plats`,
        assigneePersonId: board.personId,
        priority: "URGENT",
        statusId: publicType.statusIds.WAITING,
        waitingReason: "CONTRACTOR",
      },
    });
    await conversation.addNote(board.personId, issueId, `${canary}-anteckning`);
    await conversation.replyAsHandler(board.personId, issueId, "Ett svar.");

    const read = await page(token);
    expect(read.statusCode).toBe(200);
    const everything = `${read.body}\n${JSON.stringify(read.headers)}`;
    for (const secret of [
      canary,
      board.firstName,
      board.lastName,
      board.personId,
      issueId,
      "Akut",
      "entreprenör",
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(read.body).toContain("Väntar");
    expect(read.body).toContain("Ett svar.");
  });

  it("H6: what a person wrote is shown as text, with no markup and no link made of it", async () => {
    const { token } = await reported();
    await post(
      token,
      '<script>alert(1)</script> **fet** https://elak.example/<img src=x onerror="1">',
    );
    const read = await page(token);
    expect(read.body).not.toContain("<script>alert(1)");
    expect(read.body).not.toContain("<img src=x");
    expect(read.body).toContain("&lt;script&gt;");
    expect(read.body).toContain("**fet**");
    expect(read.body).not.toContain('href="https://elak.example');
  });

  it("H7: a message a handler redacted is shown as removed, with no text", async () => {
    const { issueId, token } = await reported();
    await conversation.replyAsHandler(
      board.personId,
      issueId,
      `Gallrad${suffix}`,
    );
    await prisma.issueMessage.updateMany({
      where: { issueId, side: "HANDLER" },
      data: { body: "", redactedAt: new Date() },
    });

    const read = await page(token);
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain(`Gallrad${suffix}`);
    expect(read.body).toContain(
      "Föreningen har tagit bort det här meddelandet.",
    );
  });
});

describe("J. logging and audit", () => {
  it("J1: a failure on a token route logs no token and no path", async () => {
    const { token } = await reported();
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
      new Error(`failed for ${token}`),
    );

    expect((await page(token)).statusCode).toBe(500);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(token);
    expect(logged.join("\n")).not.toContain("/arende/");
  });

  it("J2, J4: issuing names the link and nothing else; a refused request writes no entry", async () => {
    const { issueId } = await reported();
    const issued = (await auditFor(issueId)).find(
      (entry) => entry.action === "ISSUE_REPORTER_LINK_ISSUED",
    );
    const link = await prisma.issueReporterLink.findUniqueOrThrow({
      where: { issueId },
    });
    expect(issued).toMatchObject({
      channel: "SYSTEM",
      actorPersonId: null,
      context: { linkId: link.id },
    });

    // Selected by what such an entry would be, never by a count of the whole
    // log, which other suites write to at the same time. The start of the
    // window is the database's clock, which stamps an entry: the process's
    // clock can run behind it and let the entry above fall inside the window.
    //
    // A request with a token that opens nothing names no issue, so an entry
    // it wrote would have no target; an entry another suite writes through a
    // link always names its issue. Two selectors then cover both ways the
    // guard could fail: an entry with no target, and one on this issue.
    const [window] = await prisma.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS now
    `;
    const since = window?.now ?? new Date();
    await page(`obrf_rl_${"J".repeat(43)}`);
    await post(`obrf_rl_${"J".repeat(43)}`, "Gissning");
    await page("nonsense");
    const linkEntry = {
      OR: [
        { channel: "LINK" as const },
        {
          action: {
            in: [
              "ISSUE_REPORTER_LINK_ISSUED" as const,
              "ISSUE_REPORTER_LINK_REVOKED" as const,
            ],
          },
        },
      ],
    };
    expect(
      await prisma.auditLogEntry.count({
        where: { createdAt: { gte: since }, targetId: null, ...linkEntry },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLogEntry.count({
        where: { createdAt: { gte: since }, targetId: issueId },
      }),
    ).toBe(0);
  });
});

describe("the board's side of the link", () => {
  it("shows the handlers where the link stands", async () => {
    const { issueId } = await reported();
    const stateOf = async () =>
      (await issues.queuedIssue(board.personId, issueId, "show")).reporter;
    expect(await stateOf()).toMatchObject({ kind: "external", link: "live" });
    await links.revoke(board.personId, issueId);
    expect(await stateOf()).toMatchObject({ kind: "external", link: "ended" });
  });

  it("tells a link whose mail is still on its way from one that was never made", async () => {
    const { issueId } = await reported();
    const stateOf = async () =>
      (await issues.queuedIssue(board.personId, issueId, "show")).reporter;
    // The row exists from the moment the job starts, and `mailedAt` is stamped
    // when the mail server takes the mail: until then the link is pending, and
    // not "none", which tells a handler no mail can be sent.
    await prisma.issueReporterLink.update({
      where: { issueId },
      data: { mailedAt: null },
    });
    expect(await stateOf()).toMatchObject({
      kind: "external",
      link: "pending",
    });
    await expect(links.revoke(board.personId, issueId)).rejects.toMatchObject({
      reason: "no-reporter-link",
    });

    await prisma.issueReporterLink.delete({ where: { issueId } });
    expect(await stateOf()).toMatchObject({ kind: "external", link: "none" });
  });

  it("refuses to withdraw a link that was never mailed, and withdraws a link once", async () => {
    const { id } = await issues.reportPublicly({
      typeId: publicType.id,
      location: null,
      description: "Utan länk",
      reporterName: null,
      reporterEmail: null,
    });
    await expect(links.revoke(board.personId, id)).rejects.toMatchObject({
      reason: "no-reporter-link",
    });

    const { issueId } = await reported();
    await links.revoke(board.personId, issueId);
    await links.revoke(board.personId, issueId);
    const entries = (await auditFor(issueId)).filter(
      (entry) => entry.action === "ISSUE_REPORTER_LINK_REVOKED",
    );
    expect(entries).toHaveLength(1);
  });
});
