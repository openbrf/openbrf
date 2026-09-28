import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { BoardMailboxCollectorService } from "../board-mailbox/board-mailbox-collector.service";
import { BoardMailboxMailerService } from "../board-mailbox/board-mailbox-mailer.service";
import {
  startPop3TestServer,
  type Pop3TestServer,
} from "../board-mailbox/testing/pop3-test-server";
import { ENV } from "../config/config.module";
import { type Env, loadEnv } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { seedRows } from "../data-protection/processing-activity-seed";
import { ProcessorFactsService } from "../data-protection/processor-facts.service";
import { I18nService } from "../i18n/i18n.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import {
  startMailApiTestServer,
  type AcceptedMail,
  type MailApiTestServer,
} from "./testing/mail-api-test-server";

/**
 * Mail set where the instance runs, against a real database and a real HTTP
 * mail API (ADR 0024).
 *
 * The instance is configured the way a hosted one is: an HTTP mail API from the
 * environment, a sender on a domain the association does not own, and no
 * display name or Reply-To of its own - while the board's own SMTP server is
 * also stored, as it would be on an instance that was moved onto a host. What
 * only this suite can show is that the environment wins everywhere the
 * instance names or uses its mail at once:
 *
 * An invitation goes to the mail API, not the stored server, under the
 * association's name, with replies directed to the board mailbox.
 *
 * A board mailbox answer goes out with In-Reply-To and without a Message-ID,
 * which the service refuses; the service's own identifier replaces the minted
 * one on the row; and the correspondent's reply, which names that identifier,
 * joins the same thread when it is collected. That is the property the shared
 * sending domain puts at risk, and the reason the delivered identifier is
 * recorded at all.
 *
 * The settings show the environment's mail and refuse to change it, leaving the
 * stored columns as they were; the test message goes through the mail API; and
 * the processor register and the record of processing activities name the
 * host mail actually goes through.
 */

const suffix = runSuffix();

let api: MailApiTestServer;
let app: NestFastifyApplication;
let prisma: PrismaService;
let encryption: FieldEncryptionService;
let collector: BoardMailboxCollectorService;
let mailer: BoardMailboxMailerService;

/** The association's mail and mailbox columns, which this suite changes. */
const MAIL_COLUMNS = {
  smtpHost: true,
  smtpPort: true,
  smtpSecure: true,
  smtpUser: true,
  smtpPasswordCipher: true,
  smtpFromAddress: true,
  boardMailboxAddress: true,
  boardMailboxPop3Host: true,
  boardMailboxPop3Port: true,
  boardMailboxPop3Secure: true,
  boardMailboxPop3User: true,
  boardMailboxPop3PasswordCipher: true,
} as const;

/** Whether this suite is what created the association, and so owes its removal. */
let associationCreated = false;
/** The mail and mailbox columns as this suite found them, to put back. */
let columnsBefore: Prisma.AssociationGetPayload<{
  select: typeof MAIL_COLUMNS;
}> | null = null;

const PASSWORD = "a-long-enough-password";

const administrator = {
  personId: `mail-env-admin-${suffix}`,
  email: `mail-env-admin-${suffix}@exempel.se`,
};
const boardMember = {
  personId: `mail-env-board-${suffix}`,
  email: `mail-env-board-${suffix}@exempel.se`,
};
/** Somebody in the register without an account, whom the board invites. */
const invitee = {
  personId: `mail-env-invitee-${suffix}`,
  email: `mail-env-invitee-${suffix}@exempel.se`,
};
const personIds = [administrator, boardMember, invitee].map(
  (person) => person.personId,
);

/** The host's sender, on a domain the association does not own. */
const SHARED_SENDER = `utskick-${suffix}@delad.example`;
/** The Message-ID domain the service writes under. */
const SERVICE_DOMAIN = "getpost.se";

const MAILBOX_USER = `styrelsen-${suffix}`;
const MAILBOX_PASSWORD = "mailbox-password";
const BOARD_ADDRESS = `styrelsen-${suffix}@eksemplet.example`;
const CORRESPONDENT = `granne-${suffix}@utanfor.example`;

/**
 * An SMTP server the board stored before the environment set the mail. Nothing
 * listens there: a message that reached it would fail, which is what the
 * precedence is proved against.
 */
const STORED_SMTP = {
  smtpHost: `smtp-${suffix}.stored.invalid`,
  smtpPort: 1,
  smtpSecure: false,
  smtpUser: null,
  smtpPasswordCipher: null,
  smtpFromAddress: `kansliet-${suffix}@eksemplet.example`,
};

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.69.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.69.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": nextForwardedFor(),
        "accept-language": "sv-SE,sv;q=0.9",
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

/** A message as it sits in a mailbox, assembled by hand. */
function letter(options: {
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
}): string {
  return [
    `From: Granne <${CORRESPONDENT}>`,
    `To: <${BOARD_ADDRESS}>`,
    `Subject: ${options.subject}`,
    `Message-ID: <${options.messageId}>`,
    "Date: Tue, 01 Sep 2026 09:15:00 +0200",
    ...(options.inReplyTo === undefined
      ? []
      : [`In-Reply-To: <${options.inReplyTo}>`]),
    "",
    options.body,
    "",
  ].join("\r\n");
}

/** Points the board mailbox at a server holding exactly these messages. */
async function serveMailbox(
  messages: readonly { uid: string; raw: string }[],
): Promise<Pop3TestServer> {
  const server = await startPop3TestServer({
    user: MAILBOX_USER,
    password: MAILBOX_PASSWORD,
    messages,
  });
  // The board mailbox is the board's to set, whoever sets the mail: it is where
  // letters come in, not where they go out.
  const saved = await inject({
    method: "PUT",
    url: "/api/settings/board-mailbox",
    payload: {
      address: BOARD_ADDRESS,
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      user: MAILBOX_USER,
      password: MAILBOX_PASSWORD,
    },
    headers: { cookie: administratorCookie },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  return server;
}

/** Collects whatever the mailbox holds, once. */
async function collect(
  messages: readonly { uid: string; raw: string }[],
): Promise<void> {
  const server = await serveMailbox(messages);
  try {
    await collector.collect();
  } finally {
    await server.close();
  }
}

interface ThreadSummary {
  id: string;
  subject: string;
  messageCount: number;
}

/** Every thread with this subject, following the pages. */
async function threadsWithSubject(subject: string): Promise<ThreadSummary[]> {
  const found: ThreadSummary[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const url: string =
      after === null
        ? "/api/board-mailbox/threads"
        : `/api/board-mailbox/threads?after=${encodeURIComponent(after)}`;
    const response = await inject({
      method: "GET",
      url,
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      threads: ThreadSummary[];
      more: boolean;
      nextCursor: string | null;
    };
    found.push(...body.threads.filter((thread) => thread.subject === subject));
    if (!body.more) {
      return found;
    }
    after = body.nextCursor;
  }
  throw new Error("The board mailbox inbox did not end within 50 pages.");
}

/** The message the mail API accepted last, insisting there was a new one. */
function acceptedSince(before: number): AcceptedMail {
  expect(api.accepted.length, "the mail API received the message").toBe(
    before + 1,
  );
  return api.accepted.at(-1) as AcceptedMail;
}

async function registerAddress(personId: string, email: string): Promise<void> {
  const address = await encryption.encrypt("person.email", email);
  await prisma.person.update({
    where: { id: personId },
    data: { emailCipher: address.cipher, emailIndex: address.index },
  });
}

let administratorCookie: string;
let boardCookie: string;
let associationName: string;

beforeAll(async () => {
  api = await startMailApiTestServer();

  // Loaded through the schema, so the configuration is one that boots: an http
  // address is accepted on loopback only, and each variable is checked.
  const base = loadEnvForIntegrationTests();
  const env: Env = {
    ...loadEnv({
      ...process.env,
      OPENBRF_MAIL_DRIVER: "http-api",
      OPENBRF_MAIL_FROM_ADDRESS: SHARED_SENDER,
      OPENBRF_MAIL_API_URL: api.baseUrl,
      OPENBRF_MAIL_API_KEY: api.key,
      OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN: SERVICE_DOMAIN,
    }),
    DATABASE_URL: base.DATABASE_URL,
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  encryption = app.get(FieldEncryptionService);
  collector = app.get(BoardMailboxCollectorService);
  mailer = app.get(BoardMailboxMailerService);

  columnsBefore = await prisma.association.findUnique({
    where: { id: 1 },
    select: MAIL_COLUMNS,
  });
  if (columnsBefore === null) {
    associationCreated = true;
    await prisma.association.create({
      data: { id: 1, name: "Brf Eksemplet" },
    });
  }
  // The board's own server, stored before the environment set the mail. Written
  // to the row directly, because the route that would store it is the one this
  // suite proves refuses to.
  const association = await prisma.association.update({
    where: { id: 1 },
    data: STORED_SMTP,
    select: { name: true },
  });
  associationName = association.name;

  await prisma.person.createMany({
    data: [
      {
        id: administrator.personId,
        firstName: "Holger",
        lastName: `Utskick${suffix}`,
        preferredLocale: "sv",
      },
      {
        id: boardMember.personId,
        firstName: "Bo",
        lastName: `Utskick${suffix}`,
      },
      {
        id: invitee.personId,
        firstName: "Ines",
        lastName: `Utskick${suffix}`,
        preferredLocale: "sv",
      },
    ],
  });
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });
  await prisma.boardPosition.create({
    data: {
      personId: boardMember.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });

  const auth = app.get(AuthService);
  for (const actor of [administrator, boardMember]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
  await registerAddress(administrator.personId, administrator.email);
  await registerAddress(invitee.personId, invitee.email);

  administratorCookie = await signIn(administrator.email);
  boardCookie = await signIn(boardMember.email);

  // The board mailbox, so the default Reply-To has somewhere to point.
  const mailbox = await serveMailbox([]);
  await mailbox.close();
}, 180_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    await run().catch((cause: unknown) => failures.push(cause));
  };

  await step(() =>
    prisma.boardMailboxThread.deleteMany({
      where: { subject: { contains: suffix } },
    }),
  );
  await step(() =>
    prisma.boardMailboxIgnoredMessage.deleteMany({
      where: { sourceUid: { contains: suffix } },
    }),
  );
  await step(() =>
    prisma.invitation.deleteMany({ where: { personId: { in: personIds } } }),
  );
  await step(() =>
    prisma.boardPosition.deleteMany({ where: { personId: { in: personIds } } }),
  );
  await step(() =>
    prisma.systemRole.deleteMany({ where: { personId: { in: personIds } } }),
  );
  await step(() =>
    prisma.user.deleteMany({ where: { personId: { in: personIds } } }),
  );
  await step(() =>
    prisma.person.deleteMany({ where: { id: { in: personIds } } }),
  );
  if (associationCreated) {
    await step(() => prisma.association.deleteMany({ where: { id: 1 } }));
  } else if (columnsBefore !== null) {
    const columns = columnsBefore;
    await step(() =>
      prisma.association.update({ where: { id: 1 }, data: columns }),
    );
  }
  await step(() => app.close());
  await step(() => api.close());

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "The mail environment suite could not clean up after itself.",
    );
  }
}, 120_000);

describe("a message the instance sends", () => {
  it("goes to the mail API under the association's name, answerable to the board", async () => {
    const before = api.accepted.length;

    const invited = await inject({
      method: "POST",
      url: "/api/invitations",
      payload: { personId: invitee.personId },
      headers: { cookie: boardCookie },
    });
    expect(invited.statusCode, invited.body).toBe(202);

    const { payload } = acceptedSince(before);
    expect(payload.to).toEqual([invitee.email]);
    // The host's address, which is not on the association's domain, with the
    // association's registered name so a recipient knows who wrote.
    expect(payload.from).toBe(`"${associationName}" <${SHARED_SENDER}>`);
    // Nothing configured a Reply-To, so replies go to the board mailbox.
    expect(payload.reply_to).toEqual([BOARD_ADDRESS]);
    // Both bodies, and the link in the plain one.
    expect(payload.html).toContain("<html");
    expect(payload.text).toContain("http");
    expect(payload.text).not.toContain("<html");
    // Never the stored server's sender.
    expect(JSON.stringify(payload)).not.toContain(STORED_SMTP.smtpFromAddress);
  });
});

describe("a board mailbox answer from the shared domain", () => {
  it("keeps its thread when the service writes its own Message-ID", async () => {
    const subject = `Balkongen ${suffix}`;
    const opening = `fraga-${suffix}@utanfor.example`;

    await collect([
      {
        uid: `uid-opening-${suffix}`,
        raw: letter({
          subject,
          body: "En fraga om balkongen.",
          messageId: opening,
        }),
      },
    ]);
    const [thread] = await threadsWithSubject(subject);
    expect(thread, "the letter opened a thread").toBeDefined();

    const replied = await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread?.id ?? ""}/reply`,
      payload: { body: "Tack for ditt brev. Vi tittar pa det." },
      headers: { cookie: boardCookie },
    });
    expect(replied.statusCode, replied.body).toBe(201);
    const outbound = (
      replied.json() as {
        messages: { id: string; direction: "INBOUND" | "OUTBOUND" }[];
      }
    ).messages.find((message) => message.direction === "OUTBOUND");
    expect(outbound).toBeDefined();
    const answerId = outbound?.id ?? "";

    const minted = await prisma.boardMailboxMessage.findUniqueOrThrow({
      where: { id: answerId },
      select: { messageId: true },
    });

    const before = api.accepted.length;
    expect(await mailer.sendReply(answerId)).toBe("sent");
    const accepted = acceptedSince(before);

    // It names the letter it answers, and carries no Message-ID: the service
    // owns that header and would refuse the answer if it did.
    expect(accepted.payload.headers).toEqual({
      "In-Reply-To": `<${opening}>`,
      References: `<${opening}>`,
    });
    expect(accepted.payload.from).toBe(
      `"${associationName}" <${SHARED_SENDER}>`,
    );
    expect(accepted.payload.reply_to).toEqual([BOARD_ADDRESS]);

    // The row now holds the identifier the answer was delivered with.
    const delivered = `${accepted.id}@${SERVICE_DOMAIN}`;
    const stored = await prisma.boardMailboxMessage.findUniqueOrThrow({
      where: { id: answerId },
      select: { messageId: true, deliveryStatus: true },
    });
    expect(stored).toEqual({ messageId: delivered, deliveryStatus: "SENT" });
    expect(stored.messageId).not.toBe(minted.messageId);

    // The correspondent answers the board's answer. Their client names the
    // identifier the service wrote, which is the only one it ever saw.
    await collect([
      {
        uid: `uid-follow-up-${suffix}`,
        raw: letter({
          subject: `Sv: ${subject}`,
          body: "Tack, det later bra.",
          messageId: `svar-${suffix}@utanfor.example`,
          inReplyTo: delivered,
        }),
      },
    ]);

    // One conversation: the letter, the answer and the reply to it.
    const after = await threadsWithSubject(subject);
    expect(after).toHaveLength(1);
    expect(after[0]?.messageCount).toBe(3);
    expect(await threadsWithSubject(`Sv: ${subject}`)).toEqual([]);
  });
});

describe("the settings", () => {
  it("show the mail set where the instance runs", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: administratorCookie },
    });
    expect(response.statusCode, response.body).toBe(200);

    expect((response.json() as { smtp: unknown }).smtp).toEqual({
      source: "environment",
      host: api.host,
      fromAddress: SHARED_SENDER,
      configured: true,
    });
  });

  it("refuse to change it, and leave what the board stored as it was", async () => {
    const response = await inject({
      method: "PUT",
      url: "/api/settings/smtp",
      payload: {
        host: "smtp.other.example",
        port: 587,
        secure: false,
        user: null,
        fromAddress: "annan@eksemplet.example",
      },
      headers: { cookie: administratorCookie },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { reason: string }).reason).toBe(
      "mail-managed-by-environment",
    );
    expect(
      await prisma.association.findUniqueOrThrow({
        where: { id: 1 },
        select: {
          smtpHost: true,
          smtpPort: true,
          smtpSecure: true,
          smtpUser: true,
          smtpPasswordCipher: true,
          smtpFromAddress: true,
        },
      }),
    ).toEqual(STORED_SMTP);
  });

  it("send the test message through the mail API", async () => {
    const before = api.accepted.length;

    const response = await inject({
      method: "POST",
      url: "/api/settings/smtp/test",
      headers: { cookie: administratorCookie },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual({
      sentTo: administrator.email,
      host: api.host,
    });

    expect(acceptedSince(before).payload.to).toEqual([administrator.email]);
  });
});

describe("the recipients the instance names", () => {
  it("are the mail API's host in the processor register", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/data-protection/processors",
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode, response.body).toBe(200);

    const processors = response.json() as {
      processorKey: string;
      processorKind: string;
      identity: string | null;
      detail: string | null;
    }[];
    expect(
      processors.find((processor) => processor.processorKey === "mailApi"),
    ).toMatchObject({
      processorKind: "MAIL_API",
      identity: api.host,
      detail: SHARED_SENDER,
    });
    // The board's stored server is not a recipient while the host sends, so
    // nothing the board recorded about it is listed against the host's API.
    expect(processors.map((processor) => processor.processorKey)).not.toContain(
      "smtp",
    );
  });

  it("are the mail API's host in the record of processing activities", async () => {
    // The rows the seed writes, from the facts the record is seeded with.
    const rows = seedRows(
      app.get(I18nService).translatorFor("en"),
      await app.get(ProcessorFactsService).read(),
    );

    const mailings = rows.find((row) => row.sourceKey === "newsMailings");
    expect(mailings?.recipients).toContain(api.host);
    expect(mailings?.recipients).not.toContain(STORED_SMTP.smtpHost);
    // And the board mailbox's answers leave through it.
    const mailbox = rows.find((row) => row.sourceKey === "boardMailbox");
    expect(mailbox?.recipients).toContain(
      `Replies go out through ${api.host}.`,
    );
  });
});
