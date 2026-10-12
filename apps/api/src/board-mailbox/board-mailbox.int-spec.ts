import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { MAX_REPLY_CHARACTERS } from "@openbrf/shared";
import { DriverAdapterError } from "@prisma/driver-adapter-utils";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { erasureRemainder } from "../retention/erasure-domains";
import { grantErasure } from "../testing/erasure-requests";
import { MailService } from "../mail/mail.service";
import { MediaService } from "../media/media.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import {
  BoardMailboxCollectorService,
  type CollectionSummary,
  MAX_MESSAGES_PER_COLLECTION,
} from "./board-mailbox-collector.service";
import { BoardMailboxMailerService } from "./board-mailbox-mailer.service";
import { BoardMailboxPurgeService } from "./board-mailbox-purge.service";
import { BOARD_MAILBOX_RETENTION_DAYS } from "./board-mailbox-retention";
import { htmlToText, MAX_TEXT_CHARACTERS, readMessage } from "./mime";
import { yesterdayDateHeader } from "./testing/letter-date";
import {
  startPop3TestServer,
  type Pop3TestServer,
} from "./testing/pop3-test-server";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";

/**
 * The shared board mailbox, over HTTP and against a real database.
 *
 * The unit tests pin the protocol and the parser. What only this suite can show
 * is everything that happens between them and the board's screen.
 *
 * That the capability really gates the routes as the class decorator claims: a
 * board member works the mailbox, the external property manager is refused, a
 * resident is refused, and nobody at all is refused without a session. That
 * matters more here than on most modules - what arrives at a board's address is
 * the association's private correspondence, and the promise made about the
 * property manager is that they read issue reports and nothing else.
 *
 * That a letter really becomes a thread: collected over the protocol, stored
 * with the sender's address encrypted, its attachment through the ordinary
 * upload path, and its body as text.
 *
 * That collecting the same mailbox twice stores nothing twice. The unique
 * identifier is the whole mechanism, and only a real constraint can show it.
 *
 * That a follow-up joins the conversation it answers, and that a message
 * carrying somebody else's Message-ID does not. That second one is a security
 * property rather than a nicety: an identifier travels in every copy of a
 * letter, so without the address check anyone who has seen one could post into
 * the board's conversation with a third party.
 *
 * That a reply is recorded on the thread whatever the mail server does, with a
 * code when it refuses - and that a reply is handed over at most once however
 * many times the job runs.
 *
 * That the purge erases a thread whose retention has run out, that a legal hold
 * against the person whose address it is with stops it, and that the audit entry
 * lands in the same transaction.
 *
 * And that the data subject access report answers for the correspondence of the
 * person a thread was established to be with, and for nobody else's: not a
 * household's, where one address is held by two people, and not the next
 * holder's, where an address is recorded for somebody else after the letter
 * arrived. That is the one place the platform goes from a person to a thread,
 * and what it follows is the link the mailbox wrote when the letter came in.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
/** Whether this suite is what created the association, and so owes its removal. */
let associationCreated = false;

let prisma: PrismaService;
let encryption: FieldEncryptionService;
let collector: BoardMailboxCollectorService;
let mailer: BoardMailboxMailerService;
let purge: BoardMailboxPurgeService;
let media: MediaService;
let mail: MailService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";
const DAY_MS = 24 * 60 * 60 * 1000;

const administrator = {
  personId: `mailbox-admin-${suffix}`,
  email: `mailbox-admin-${suffix}@exempel.se`,
};
const boardMember = {
  personId: `mailbox-board-${suffix}`,
  email: `mailbox-board-${suffix}@exempel.se`,
};
/** Protected personal data: named to nobody, in every read. */
const protectedBoardMember = {
  personId: `mailbox-protected-${suffix}`,
  email: `mailbox-protected-${suffix}@exempel.se`,
};
const resident = {
  personId: `mailbox-resident-${suffix}`,
  email: `mailbox-resident-${suffix}@exempel.se`,
};
/** An external property manager: issues:handle and their own account, no more. */
const manager = {
  personId: `mailbox-manager-${suffix}`,
  email: `mailbox-manager-${suffix}@exempel.se`,
};
/**
 * A resident the board has correspondence with, and against whom a hold is
 * placed. Their registered address is what the thread is matched on.
 */
const heldResident = {
  personId: `mailbox-held-${suffix}`,
  /*
   * Registered with capitals, and the letters below arrive in lower case.
   *
   * Which is the ordinary way round: a person types their address into a form
   * however they write it, and a mail client sends the envelope in whatever case
   * it likes. The blind index normalises, so the two still match - and that is
   * exactly the case where the address the association holds on a thread is not
   * the address it holds on the person.
   */
  email: `Mailbox-Held-${suffix}@Exempel.se`,
};

/** The same address as the envelope carries it, which is how a thread stores it. */
const heldResidentEnvelope = heldResident.email.toLowerCase();

/**
 * Two residents of one apartment who gave the association the same address.
 *
 * `Person.emailIndex` carries no unique constraint and this needs no unusual
 * behaviour by anybody: a couple writes one address on the form. Neither of them
 * is identified by it, so a letter from it is in neither of their reports.
 */
const householdAddress = `mailbox-hushall-${suffix}@exempel.se`;
const householdOne = { personId: `mailbox-household-a-${suffix}` };
const householdTwo = { personId: `mailbox-household-b-${suffix}` };

/**
 * An address that changes hands, which is what a role address does: whoever
 * holds the seat writes to the board, moves out, and the address is recorded for
 * whoever took the seat over.
 */
const seatAddress = `mailbox-ordforande-${suffix}@exempel.se`;
const seatFormerHolder = { personId: `mailbox-seat-former-${suffix}` };
const seatNewHolder = { personId: `mailbox-seat-new-${suffix}` };

const actors = [
  administrator,
  boardMember,
  protectedBoardMember,
  resident,
  manager,
];
const personIds = [
  ...actors,
  heldResident,
  householdOne,
  householdTwo,
  seatFormerHolder,
  seatNewHolder,
].map((actor) => actor.personId);

const addressId = `mailbox-address-${suffix}`;
const apartmentIds = [1, 2, 3].map((n) => `mailbox-apartment-${suffix}-${n}`);

/** The name nobody is ever shown. Distinctive, so a leak is unmistakable. */
const PROTECTED_LAST_NAME = `Skyddadsson${suffix}`;

const MAILBOX_USER = `styrelsen-${suffix}`;
const MAILBOX_PASSWORD = "mailbox-password";
const BOARD_ADDRESS = `styrelsen-${suffix}@exempel.se`;

const CORRESPONDENT = `granne-${suffix}@utanfor.example`;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.44.0.0/16 is this suite's.
  return `10.44.${String(subnet)}.${String(host + 1)}`;
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

/**
 * A message as it sits in a mailbox.
 *
 * Assembled by hand rather than composed by a library, for the reason the
 * fixtures in `mime.spec.ts` are: what is under test is a reader of somebody
 * else's output, and a fixture produced by this codebase would only prove that
 * it can read itself.
 */
function letter(options: {
  from: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
  attachment?: boolean;
  /** The Date header. Yesterday unless a test needs another. */
  date?: string;
  /**
   * The date on the Received header the mailbox's own server puts on top, or
   * none at all, which is a letter that did not arrive through a mail server.
   */
  received?: string;
}): string {
  const headers = [
    ...(options.received === undefined
      ? []
      : [
          "Received: from mx.utanfor.example (mx.utanfor.example [192.0.2.7])",
          `\tby pop.exempel.se; ${options.received}`,
        ]),
    `From: Granne <${options.from}>`,
    `To: <${BOARD_ADDRESS}>`,
    `Subject: ${options.subject}`,
    `Message-ID: <${options.messageId}>`,
    `Date: ${options.date ?? yesterdayDateHeader()}`,
    ...(options.inReplyTo === undefined
      ? []
      : [`In-Reply-To: <${options.inReplyTo}>`]),
  ];

  if (options.attachment !== true) {
    return [...headers, "", options.body, ""].join("\r\n");
  }

  return [
    ...headers,
    "Content-Type: multipart/mixed; boundary=SEP",
    "",
    "--SEP",
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.body,
    "--SEP",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="tak.png"',
    "",
    pngBytes().toString("base64"),
    "--SEP--",
    "",
  ].join("\r\n");
}

/** What the mailer hands the mail service for one answer. */
type HandedOver = Parameters<MailService["send"]>[0] & { messageId: string };

/**
 * Sends a reply through the mailer with the transport stubbed, and answers
 * what was handed over.
 */
async function sendAnswer(replyMessageId: string): Promise<HandedOver> {
  const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });
  let input: Parameters<MailService["send"]>[0] | undefined;
  try {
    expect(await mailer.sendReply(replyMessageId)).toBe("sent");
    // Read before the spy is restored, which clears what it recorded.
    input = send.mock.calls[0]?.[0];
  } finally {
    send.mockRestore();
  }
  if (input === undefined || typeof input.messageId !== "string") {
    throw new Error("The mailer handed nothing over.");
  }
  return { ...input, messageId: input.messageId };
}

/**
 * The board's answer as a copy of it comes back into the mailbox.
 *
 * Rendered from what the mailer handed over, the way the mail service sends
 * it, so the copy is the answer the correspondent received rather than this
 * suite's idea of it. Both forms, base64-encoded, the HTML last, the way a mail
 * library writes them.
 *
 * @param options.extraParts Parts a sender adds beside the answer, each as its
 *   header and body lines. Any at all puts the answer inside a
 *   multipart/mixed.
 * @param options.html An HTML form in place of the answer's own.
 * @param options.subject A subject line in place of the answer's own.
 * @param options.text A plain-text form in place of the answer's own.
 */
async function answerCopy(
  input: HandedOver,
  options: {
    extraParts?: readonly (readonly string[])[];
    html?: string;
    subject?: string;
    text?: string;
  } = {},
): Promise<string> {
  const extraParts = options.extraParts ?? [];
  const rendered = await mail.renderMail(input);
  const base64 = (value: string): string =>
    Buffer.from(value, "utf8").toString("base64");
  const alternative = [
    "Content-Type: multipart/alternative; boundary=ALT",
    "",
    "--ALT",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64(options.text ?? rendered.text),
    "--ALT",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64(options.html ?? rendered.html),
    "--ALT--",
  ];
  const headers = [
    `From: Styrelsen <${BOARD_ADDRESS}>`,
    `To: <${input.to}>`,
    `Subject: ${options.subject ?? rendered.subject}`,
    `Message-ID: <${input.messageId}>`,
    `Date: ${yesterdayDateHeader()}`,
    "MIME-Version: 1.0",
  ];

  const body =
    extraParts.length === 0
      ? alternative
      : [
          "Content-Type: multipart/mixed; boundary=MIX",
          "",
          "--MIX",
          ...alternative,
          ...extraParts.flatMap((part) => ["--MIX", ...part]),
          "--MIX--",
        ];
  return [...headers, ...body, ""].join("\r\n");
}

/**
 * A PNG: the signature, an IHDR chunk, and nothing else.
 *
 * The upload path identifies a file from its header, so a real encoder would add
 * pixel data no assertion here looks at.
 */
function pngBytes(): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(24, 16);
  bytes.writeUInt32BE(24, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

/** Points the instance at a mailbox holding exactly these messages. */
async function serveMailbox(
  messages: readonly { uid: string; raw: string }[],
): Promise<Pop3TestServer> {
  const server = await startPop3TestServer({
    user: MAILBOX_USER,
    password: MAILBOX_PASSWORD,
    messages,
  });

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

interface ThreadBody {
  id: string;
  subject: string;
  correspondent: { email: string; name: string | null };
  status: "NEW" | "TAKEN" | "ANSWERED" | "CLOSED";
  olderCursor?: string | null;
  takenBy:
    | { kind: "member"; personId: string; name: string }
    | { kind: "protected"; personId: string }
    | { kind: "unknown" }
    | null;
  messageCount: number;
  erasableFrom: string;
  messages?: {
    id: string;
    direction: "INBOUND" | "OUTBOUND";
    body: string;
    bodyFromHtml: boolean;
    attachmentsDropped: number;
    delivery: { status: string; failure: string | null } | null;
    attachments: { id: string; url: string; fileName: string }[];
  }[];
}

/**
 * A subject as the local part of a Message-ID.
 *
 * The subjects here carry a run suffix behind a space, and a space is outside
 * the identifier grammar RFC 5322 gives: a header holding one is not a
 * Message-ID, and the reader answers null for it rather than composing it back
 * into the board's own In-Reply-To.
 */
function identifierOf(subject: string): string {
  return subject.replaceAll(" ", "-");
}

/**
 * The whole inbox, following the pages.
 *
 * Every page and not the first one, because the database is shared: another
 * suite's threads and any left behind by a run that was interrupted sit in the
 * same list, and this file's own fixtures are found by subject somewhere in it.
 * A page bound this suite does not fill today is one it could fill tomorrow, and
 * a helper that read only the first page would start failing to find a thread
 * that is there.
 */
async function listThreads(cookie: string): Promise<ThreadBody[]> {
  const all: ThreadBody[] = [];
  let after: string | null = null;

  // Bounded, so a cursor that stopped advancing ends the test rather than the
  // worker: at the page size this is far more inbox than any run builds.
  for (let page = 0; page < 50; page += 1) {
    const url: string =
      after === null
        ? "/api/board-mailbox/threads"
        : `/api/board-mailbox/threads?after=${encodeURIComponent(after)}`;
    const response = await inject({ method: "GET", url, headers: { cookie } });
    expect(response.statusCode, response.body).toBe(200);

    const body = response.json() as {
      threads: ThreadBody[];
      more: boolean;
      nextCursor: string | null;
    };
    all.push(...body.threads);
    if (!body.more) {
      return all;
    }
    after = body.nextCursor;
    expect(after).not.toBeNull();
  }

  throw new Error("The board mailbox inbox did not end within 50 pages.");
}

async function readThread(
  cookie: string,
  threadId: string,
): Promise<ThreadBody> {
  const response = await inject({
    method: "GET",
    url: `/api/board-mailbox/threads/${threadId}`,
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ThreadBody;
}

/** The one thread whose subject this test wrote, insisting there is exactly one. */
async function threadBySubject(subject: string): Promise<ThreadBody> {
  const threads = await listThreads(boardCookie);
  const matching = threads.filter((thread) => thread.subject === subject);
  expect(
    matching,
    `expected exactly one thread with the subject "${subject}"`,
  ).toHaveLength(1);
  return matching[0] as ThreadBody;
}

interface StatusBody {
  configured: boolean;
  setAside: {
    reason: string;
    letterDate: string | null;
    setAsideAt: string;
    retryAt: string | null;
  }[];
  setAsideCount: number;
}

/** The mailbox's status, as the board's screen reads it. */
async function mailboxStatus(): Promise<StatusBody> {
  const response = await inject({
    method: "GET",
    url: "/api/board-mailbox/status",
    headers: { cookie: boardCookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

/**
 * A failure Prisma reports for a driver adapter error, built from the classes
 * it builds one from: the adapter's DriverAdapterError inside the client's
 * PrismaClientKnownRequestError.
 */
function adapterError(
  code: string,
  cause: ConstructorParameters<typeof DriverAdapterError>[0],
): Error {
  return new Prisma.PrismaClientKnownRequestError(`failed with ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
    meta: { driverAdapterError: new DriverAdapterError(cause) },
  });
}

/**
 * Records an address on a person, or takes the one they had away.
 *
 * The register's own writes are what this stands in for: the ciphertext and the
 * blind index, written together, because a person carrying one without the
 * other is a row no path in the product produces.
 */
async function registerAddress(
  personId: string,
  email: string | null,
): Promise<void> {
  const address =
    email === null ? null : await encryption.encrypt("person.email", email);
  await prisma.person.update({
    where: { id: personId },
    data: {
      emailCipher: address?.cipher ?? null,
      emailIndex: address?.index ?? null,
    },
  });
}

let administratorCookie: string;
let boardCookie: string;
let protectedCookie: string;
let residentCookie: string;
let managerCookie: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(baseEnv satisfies Env)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  collector = app.get(BoardMailboxCollectorService);
  media = app.get(MediaService);
  mailer = app.get(BoardMailboxMailerService);
  purge = app.get(BoardMailboxPurgeService);
  mail = app.get(MailService);

  /*
   * The association this suite needs, made the way every other suite in this
   * directory makes its own: nothing seeds it. An existing row is left as it is
   * - a suite that ran first is entitled to its own.
   */
  const associationBefore = await prisma.association.findUnique({
    where: { id: 1 },
    select: { id: true },
  });
  if (associationBefore === null) {
    associationCreated = true;
    await prisma.association.create({
      data: { id: 1, name: "Brf Eksemplet" },
    });
  }

  await prisma.person.createMany({
    data: [
      {
        id: administrator.personId,
        firstName: "Holger",
        lastName: `Brevlada${suffix}`,
      },
      {
        id: boardMember.personId,
        firstName: "Bo",
        lastName: `Brevlada${suffix}`,
      },
      {
        id: protectedBoardMember.personId,
        firstName: "Siv",
        lastName: PROTECTED_LAST_NAME,
        protectedPersonalData: true,
      },
      {
        id: resident.personId,
        firstName: "Nils",
        lastName: `Brevlada${suffix}`,
      },
      {
        id: manager.personId,
        firstName: "Mats",
        lastName: `Brevlada${suffix}`,
      },
      {
        id: heldResident.personId,
        firstName: "Harald",
        lastName: `Brevlada${suffix}`,
      },
      {
        id: householdOne.personId,
        firstName: "Hanna",
        lastName: `Hushall${suffix}`,
      },
      {
        id: householdTwo.personId,
        firstName: "Henrik",
        lastName: `Hushall${suffix}`,
      },
      {
        id: seatFormerHolder.personId,
        firstName: "Sigrid",
        lastName: `Ordforande${suffix}`,
      },
      {
        id: seatNewHolder.personId,
        firstName: "Sten",
        lastName: `Ordforande${suffix}`,
      },
    ],
  });

  await prisma.boardPosition.createMany({
    data: [
      {
        personId: boardMember.personId,
        position: "BOARD_MEMBER",
        electedOn: new Date("2026-01-01"),
      },
      {
        personId: protectedBoardMember.personId,
        position: "BOARD_MEMBER",
        electedOn: new Date("2026-01-01"),
      },
    ],
  });
  await prisma.systemRole.createMany({
    data: [
      { personId: administrator.personId, role: "ADMIN" },
      { personId: manager.personId, role: "PROPERTY_MANAGER" },
    ],
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Brevladegatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: {
        create: apartmentIds.map((id, index) => ({
          id,
          number: String(1001 + index),
          floor: 0,
        })),
      },
    },
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: resident.personId,
        apartmentId: apartmentIds[0] as string,
        role: "MEMBER",
        movedInOn: new Date("2026-01-01"),
      },
      {
        personId: heldResident.personId,
        apartmentId: apartmentIds[1] as string,
        role: "MEMBER",
        movedInOn: new Date("2026-01-01"),
      },
      {
        personId: boardMember.personId,
        apartmentId: apartmentIds[2] as string,
        role: "MEMBER",
        movedInOn: new Date("2026-01-01"),
      },
    ],
  });

  const auth = app.get(AuthService);
  for (const actor of actors) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  /*
   * The registered addresses. The held resident's is what the purge matches a
   * thread against, and every one of them is what the collector asks the
   * register about as a letter arrives.
   *
   * Written through the register's own field encryption rather than through an
   * endpoint, because the register offers none that sets an address on an
   * existing person - and because what has to be right here is the ciphertext
   * and the index, which is exactly what those paths read.
   */
  encryption = app.get(FieldEncryptionService);
  await registerAddress(heldResident.personId, heldResident.email);
  // One address, two people, and neither of them identified by it.
  await registerAddress(householdOne.personId, householdAddress);
  await registerAddress(householdTwo.personId, householdAddress);
  // The seat's address, held by whoever holds it now. It changes hands in the
  // test that needs it to.
  await registerAddress(seatFormerHolder.personId, seatAddress);

  administratorCookie = await signIn(administrator.email);
  boardCookie = await signIn(boardMember.email);
  protectedCookie = await signIn(protectedBoardMember.email);
  residentCookie = await signIn(resident.email);
  managerCookie = await signIn(manager.email);
}, 180_000);

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    await run().catch((cause: unknown) => failures.push(cause));
  };

  // This run's threads and no others. The database is shared, so an unfiltered
  // delete would take away what another suite is in the middle of - and every
  // thread this file makes carries the run suffix in its subject.
  await step(() =>
    prisma.boardMailboxThread.deleteMany({
      where: { subject: { contains: suffix } },
    }),
  );
  // The ledger of letters read and not stored outlives the threads, so this run
  // takes its own rows with it. Every identifier it wrote carries the suffix.
  await step(() =>
    prisma.boardMailboxIgnoredMessage.deleteMany({
      where: { sourceUid: { contains: suffix } },
    }),
  );
  await step(() =>
    prisma.boardMailboxCollectionFailure.deleteMany({
      where: { sourceUid: { contains: suffix } },
    }),
  );
  await step(() =>
    prisma.association.update({
      where: { id: 1 },
      data: {
        boardMailboxAddress: null,
        boardMailboxPop3Host: null,
        boardMailboxPop3Port: null,
        boardMailboxPop3User: null,
        boardMailboxPop3PasswordCipher: null,
      },
    }),
  );
  await step(() =>
    prisma.legalHold.deleteMany({ where: { personId: { in: personIds } } }),
  );
  await step(() =>
    prisma.residency.deleteMany({ where: { personId: { in: personIds } } }),
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
    prisma.apartment.deleteMany({ where: { id: { in: apartmentIds } } }),
  );
  await step(() => prisma.address.deleteMany({ where: { id: addressId } }));
  await step(() =>
    prisma.person.deleteMany({ where: { id: { in: personIds } } }),
  );
  if (associationCreated) {
    await step(() => prisma.association.deleteMany({ where: { id: 1 } }));
  }
  await step(() => app.close());

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "The board mailbox suite could not clean up after itself.",
    );
  }
}, 120_000);

describe("who may work the board's mailbox", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/board-mailbox/threads",
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident", async () => {
    // Every resident may write to the board; none of them may read what the
    // neighbours wrote.
    const response = await inject({
      method: "GET",
      url: "/api/board-mailbox/threads",
      headers: { cookie: residentCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses the external property manager", async () => {
    /*
     * The promise the platform makes a housing cooperative about an outside
     * party with an account (decision 11). They handle the association's issue
     * reports; what arrives at the board's own address is whatever a resident, a
     * bank or an authority chose to write to their association, and a contractor
     * engaged to fix the building has no business in it.
     */
    const response = await inject({
      method: "GET",
      url: "/api/board-mailbox/threads",
      headers: { cookie: managerCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a board member the settings the administrator holds", async () => {
    // Credentials for a mail server are instance configuration. A board that
    // could write these fields could point the instance at any mailbox on the
    // internet it had a password for.
    const response = await inject({
      method: "PUT",
      url: "/api/settings/board-mailbox",
      payload: {
        address: BOARD_ADDRESS,
        host: "127.0.0.1",
        port: 1110,
        secure: false,
        user: MAILBOX_USER,
        password: MAILBOX_PASSWORD,
      },
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("lets a board member read the inbox", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/board-mailbox/threads",
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("collecting the mailbox", () => {
  it("says the mailbox is not configured rather than failing", async () => {
    // A board that has not set it up is not an error condition, and an empty
    // inbox has to be distinguishable from an instance collecting nothing.
    const summary = await collector.collect();
    expect(summary.configured).toBe(false);
  });

  it("turns a letter into a thread, with its attachment", async () => {
    const subject = `Vattenlacka ${suffix}`;
    const server = await serveMailbox([
      {
        uid: "uid-first",
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Det rinner vatten i tvattstugan.",
          messageId: `first-${suffix}@utanfor.example`,
          attachment: true,
        }),
      },
    ]);

    try {
      const summary = await collector.collect();
      expect(summary.configured).toBe(true);
      expect(summary.collected).toBe(1);

      const thread = await threadBySubject(subject);
      expect(thread.status).toBe("NEW");
      expect(thread.takenBy).toBeNull();
      // The address the envelope asserted, decrypted for the board to answer.
      expect(thread.correspondent.email).toBe(CORRESPONDENT);
      expect(thread.correspondent.name).toBe("Granne");

      const full = await readThread(boardCookie, thread.id);
      expect(full.messages?.[0]?.direction).toBe("INBOUND");
      expect(full.messages?.[0]?.body).toContain("Det rinner vatten");
      expect(full.messages?.[0]?.bodyFromHtml).toBe(false);
      expect(full.messages?.[0]?.attachmentsDropped).toBe(0);

      // Through the ordinary upload path, so it is served from this instance's
      // own origin and never from a storage endpoint.
      const attachment = full.messages?.[0]?.attachments[0];
      expect(attachment?.fileName).toBe("tak.png");
      expect(attachment?.url).toMatch(/^\/api\/media\//);

      // A letter to the board is read by whoever handles its mail: a
      // resident or the property manager holding the address reads nothing.
      const read = (cookie: string) =>
        inject({
          method: "GET",
          url: attachment?.url ?? "",
          headers: { cookie },
        });
      expect((await read(residentCookie)).statusCode).toBe(404);
      expect((await read(managerCookie)).statusCode).toBe(404);
      expect((await read(boardCookie)).statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("stores nothing twice when the mailbox is collected again", async () => {
    const subject = `Upprepning ${suffix}`;
    const server = await serveMailbox([
      {
        uid: "uid-repeat",
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Ett brev.",
          messageId: `repeat-${suffix}@utanfor.example`,
        }),
      },
    ]);

    try {
      const first = await collector.collect();
      expect(first.collected).toBe(1);

      // Nothing is deleted from the mailbox, so the letter is still there. What
      // stops it being collected twice is its unique identifier.
      const second = await collector.collect();
      expect(second.collected).toBe(0);
      expect(second.alreadyHeld).toBe(1);

      await threadBySubject(subject);
    } finally {
      await server.close();
    }
  });

  it("leaves a message with no readable sender in the mailbox, and reads it once", async () => {
    const server = await serveMailbox([
      {
        uid: `uid-headless-${suffix}`,
        raw: [
          `Subject: Ingen avsandare ${suffix}`,
          "Message-ID: <headless@utanfor.example>",
          "",
          "Hej",
          "",
        ].join("\r\n"),
      },
    ]);

    try {
      const summary = await collector.collect();
      // A thread whose correspondent cannot be answered would be a conversation
      // with nobody, and the letter is still in the mailbox for a board member
      // to open in a mail client.
      expect(summary.collected).toBe(0);
      expect(summary.skipped).toBe(1);

      const threads = await listThreads(boardCookie);
      expect(
        threads.some((thread) => thread.subject.startsWith("Ingen avsandare")),
      ).toBe(false);

      // And the next run does not fetch it again. Nothing about the letter will
      // ever change, so a collection that read it afresh every five minutes
      // would spend the per-run bound on it for as long as the mailbox kept it -
      // and enough of these at the head of a mailbox stop the run before it
      // reaches the mail behind them, which is the board receiving nothing.
      const again = await collector.collect();
      expect(again.skipped).toBe(0);
      expect(again.alreadyHeld).toBe(1);

      // The board is told there is a letter here that it has not read, and
      // only about the letters this mailbox still holds.
      const status = await mailboxStatus();
      expect(status.setAsideCount).toBe(1);
      expect(status.setAside[0]?.reason).toBe("no-sender-address");
      expect(status.setAside[0]?.retryAt).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("does not store a letter already past the retention window", async () => {
    const subject = `Forntida ${suffix}`;
    const server = await serveMailbox([
      {
        uid: `uid-ancient-${suffix}`,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Ett brev fran for lange sedan.",
          messageId: `ancient-${suffix}@utanfor.example`,
          date: "Wed, 01 Jan 2020 09:15:00 +0100",
        }),
      },
    ]);

    try {
      // Stored, it would be a thread the purge erases the same night: the date
      // it is anchored on is already more than two years before now.
      const summary = await collector.collect(
        new Date("2026-09-28T12:00:00.000Z"),
      );
      expect(summary.collected).toBe(0);
      expect(summary.skipped).toBe(1);

      const threads = await listThreads(boardCookie);
      expect(threads.some((thread) => thread.subject === subject)).toBe(false);

      // And recorded as read, so the next run does not fetch it again.
      const again = await collector.collect(
        new Date("2026-09-28T12:05:00.000Z"),
      );
      expect(again.collected).toBe(0);
      expect(again.alreadyHeld).toBe(1);

      // Not a letter the board is told to go and read: it was never to be kept.
      expect((await mailboxStatus()).setAsideCount).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("holds a sender's date to when the mailbox received the letter", async () => {
    const now = new Date("2026-09-28T12:00:00.000Z");
    const recent = `Sent-klocka ${suffix}`;
    const old = `Gammal-post ${suffix}`;
    const server = await serveMailbox([
      {
        // Sent this morning from a device whose clock is years behind - or by
        // somebody who set the header so. Read by its date alone, it would be
        // set aside unseen as past the retention window.
        uid: `uid-sent-klocka-${suffix}`,
        raw: letter({
          from: CORRESPONDENT,
          subject: recent,
          body: "Ett brev fran i dag.",
          messageId: `sent-klocka-${suffix}@utanfor.example`,
          date: "Wed, 01 Jan 2020 09:15:00 +0100",
          received: "Mon, 28 Sep 2026 09:00:00 +0000",
        }),
      },
      {
        // The other way round: the mailbox took it in years ago, and its date
        // says this week. It is a mailbox's old mail, read for the first time.
        uid: `uid-gammal-post-${suffix}`,
        raw: letter({
          from: CORRESPONDENT,
          subject: old,
          body: "Ett brev fran for lange sedan.",
          messageId: `gammal-post-${suffix}@utanfor.example`,
          date: "Sun, 27 Sep 2026 09:00:00 +0000",
          received: "Wed, 01 Jan 2020 09:15:00 +0100",
        }),
      },
    ]);

    try {
      const summary = await collector.collect(now);
      expect(summary.collected).toBe(1);
      expect(summary.skipped).toBe(1);

      // Stored, and dated by its arrival, so the purge does not take it that
      // night either.
      const thread = await prisma.boardMailboxThread.findFirst({
        where: { subject: recent },
        select: { lastMessageAt: true },
      });
      expect(thread?.lastMessageAt.toISOString()).toBe(
        "2026-09-28T09:00:00.000Z",
      );

      const setAside = await prisma.boardMailboxIgnoredMessage.findMany({
        where: { sourceUid: { endsWith: `:uid-gammal-post-${suffix}` } },
        select: { reason: true },
      });
      expect(setAside.map((row) => row.reason)).toStrictEqual([
        "past-retention",
      ]);
      expect(
        await prisma.boardMailboxThread.count({ where: { subject: old } }),
      ).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("draws the retention line where the purge draws it", async () => {
    // A thread is erasable when its last message is on or before the cutoff, so
    // a letter dated exactly on it is left and one a millisecond after is kept.
    // A Date header has whole seconds, so the clock moves rather than the letter.
    const sentAt = new Date("2024-09-28T12:00:00.000Z");
    const retention = BOARD_MAILBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const onTheCutoff = new Date(sentAt.getTime() + retention);
    const justInside = new Date(onTheCutoff.getTime() - 1);

    const collectAt = async (
      name: string,
      now: Date,
    ): Promise<CollectionSummary> => {
      const server = await serveMailbox([
        {
          uid: `uid-${name}-${suffix}`,
          raw: letter({
            from: CORRESPONDENT,
            subject: `${name} ${suffix}`,
            body: "Ett brev vid gransen.",
            messageId: `${name}-${suffix}@utanfor.example`,
            date: sentAt.toUTCString(),
          }),
        },
      ]);
      try {
        return await collector.collect(now);
      } finally {
        await server.close();
      }
    };

    const skipped = await collectAt("Pa-gransen", onTheCutoff);
    expect(skipped.collected).toBe(0);
    expect(skipped.skipped).toBe(1);

    const kept = await collectAt("Innanfor", justInside);
    expect(kept.collected).toBe(1);
    expect(kept.skipped).toBe(0);
    const thread = await threadBySubject(`Innanfor ${suffix}`);
    const stored = await prisma.boardMailboxThread.findUnique({
      where: { id: thread.id },
      select: { lastMessageAt: true },
    });
    expect(stored?.lastMessageAt).toEqual(sentAt);
  });

  it("stores a letter whose body carries control characters", async () => {
    // A text column holds no NUL, so a body that kept one would be refused by
    // the database rather than stored.
    const subject = `Styrtecken ${suffix}`;
    const server = await serveMailbox([
      {
        uid: `uid-control-${suffix}`,
        raw: [
          `From: Granne <${CORRESPONDENT}>`,
          `To: <${BOARD_ADDRESS}>`,
          `Subject: ${subject}`,
          `Message-ID: <control-${suffix}@utanfor.example>`,
          "Content-Type: text/html; charset=utf-8",
          "",
          "<p>Det\u0000 rinner&#0; vatten</p>",
          "",
        ].join("\r\n"),
      },
    ]);

    try {
      const summary = await collector.collect();
      expect(summary.collected).toBe(1);

      const thread = await threadBySubject(subject);
      const full = await readThread(boardCookie, thread.id);
      expect(full.messages?.[0]?.body).toBe("Det rinner vatten");
    } finally {
      await server.close();
    }
  });

  it("sets aside a letter the database refuses and collects the ones either side of it", async () => {
    const before = `Fore ${suffix}`;
    const refused = `Vagrad ${suffix}`;
    const after = `Efter ${suffix}`;
    const dated = yesterdayDateHeader();
    const server = await serveMailbox(
      [before, refused, after].map((subject, position) => ({
        uid: `uid-unstorable-${String(position)}-${suffix}`,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Ett brev.",
          messageId: `unstorable-${String(position)}-${suffix}@utanfor.example`,
          date: dated,
        }),
      })),
    );

    /*
     * The second letter's write is refused by PostgreSQL itself, with a value
     * it will not store in a text column. The reader now removes the one value
     * a letter could carry to that effect, so the refusal is produced here for
     * whatever it has not foreseen - through a model's own write, which is the
     * path a letter takes and the shape of error the collector has to read.
     */
    const transaction = prisma.$transaction.bind(prisma);
    let writes = 0;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((
      ...args: unknown[]
    ) => {
      writes += 1;
      if (writes === 2) {
        return transaction(async (tx) => {
          await tx.boardMailboxIgnoredMessage.create({
            data: { sourceUid: `refusal-${suffix}`, reason: "\u0000" },
          });
        });
      }
      return (transaction as (...rest: unknown[]) => unknown)(...args);
    }) as typeof prisma.$transaction);

    try {
      const summary = await collector.collect();
      expect(summary.collected).toBe(2);
      expect(summary.skipped).toBe(1);

      await threadBySubject(before);
      await threadBySubject(after);
      const threads = await listThreads(boardCookie);
      expect(threads.some((thread) => thread.subject === refused)).toBe(false);

      const ignored = await prisma.boardMailboxIgnoredMessage.findFirst({
        where: { sourceUid: { endsWith: `:uid-unstorable-1-${suffix}` } },
      });
      expect(ignored?.reason).toBe("unstorable");
      expect(ignored?.letterDate?.toISOString()).toBe(
        new Date(dated).toISOString(),
      );

      // The board is told there is a letter it has not read, and when it was
      // dated, so it can be found in a mail client.
      const status = await mailboxStatus();
      expect(status.setAsideCount).toBe(1);
      expect(status.setAside[0]).toMatchObject({
        reason: "unstorable",
        letterDate: new Date(dated).toISOString(),
        // Refused for its own values, so never tried again.
        retryAt: null,
      });

      // And the next run does not fetch it again.
      const again = await collector.collect();
      expect(again.skipped).toBe(0);
      expect(again.alreadyHeld).toBe(3);
      expect(writes).toBe(3);
    } finally {
      spy.mockRestore();
      await server.close();
    }
  });

  it.each([
    [
      // A server a failover demoted, which still takes a connection and
      // refuses every write on it. PostgreSQL's own error, through a model's
      // own write.
      "a read-only server",
      "read-only",
      (): Promise<unknown> =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.boardMailboxIgnoredMessage.create({
            data: { sourceUid: `read-only-${suffix}`, reason: "read-only" },
          });
        }),
    ],
    [
      // A statement the server cancelled for taking too long.
      "a statement timeout",
      "timeout",
      (): Promise<unknown> =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = 1`;
          await tx.$executeRaw`SELECT pg_sleep(1)`;
        }),
    ],
    [
      // New code ahead of its migration during a deploy. Built from the
      // classes Prisma builds it from, because a real one needs a column this
      // schema does not have.
      "a column the migration has not made yet",
      "column",
      (): Promise<unknown> =>
        Promise.reject(
          adapterError("P2022", { kind: "ColumnNotFound", column: "body" }),
        ),
    ],
    [
      "an unreachable database",
      "unreachable",
      (): Promise<unknown> =>
        Promise.reject(adapterError("P1001", { kind: "DatabaseNotReachable" })),
    ],
    [
      // The driver's own error, which Prisma passes on without a code.
      "a dropped connection",
      "dropped",
      (): Promise<unknown> =>
        Promise.reject(new Error("Connection terminated unexpectedly")),
    ],
  ])("tries a letter again after %s", async (_failure, tag, failure) => {
    const subject = `Senare ${tag} ${suffix}`;
    const uid = `uid-transient-${tag}-${suffix}`;
    const server = await serveMailbox([
      {
        uid,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Ett brev.",
          messageId: `transient-${tag}-${suffix}@utanfor.example`,
        }),
      },
    ]);

    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementationOnce((() => failure()) as typeof prisma.$transaction);

    try {
      const first = await collector.collect();
      expect(first.collected).toBe(0);
      expect(first.skipped).toBe(1);
      expect(
        await prisma.boardMailboxIgnoredMessage.count({
          where: { sourceUid: { endsWith: `:${uid}` } },
        }),
      ).toBe(0);

      const second = await collector.collect();
      expect(second.collected).toBe(1);
      await threadBySubject(subject);
    } finally {
      spy.mockRestore();
      await server.close();
    }
  });

  it("sets a letter aside that fails on every run, once it has been tried for an hour", async () => {
    const subject = `Envis ${suffix}`;
    const uid = `uid-persistent-${suffix}`;
    const server = await serveMailbox([
      {
        uid,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Ett brev.",
          messageId: `persistent-${suffix}@utanfor.example`,
        }),
      },
    ]);

    // A failure that says nothing about the letter, on every attempt.
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementation((() =>
        Promise.reject(
          adapterError("P2022", { kind: "ColumnNotFound", column: "body" }),
        )) as typeof prisma.$transaction);
    const ignored = (): Promise<number> =>
      prisma.boardMailboxIgnoredMessage.count({
        where: { sourceUid: { endsWith: `:${uid}` } },
      });

    const start = new Date();
    try {
      // However often it is tried within the hour - a board pressing "collect
      // now" during an outage - it is tried again.
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        const summary = await collector.collect(start);
        expect(summary.skipped).toBe(1);
      }
      expect(await ignored()).toBe(0);

      // An hour on, and still failing: set aside, and the board is told.
      const later = new Date(start.getTime() + 60 * 60 * 1000);
      await collector.collect(later);
      expect(await ignored()).toBe(1);
      expect(
        await prisma.boardMailboxCollectionFailure.count({
          where: { sourceUid: { endsWith: `:${uid}` } },
        }),
      ).toBe(0);

      const again = await collector.collect(later);
      expect(again.alreadyHeld).toBe(1);

      // Tried again later, and set aside for as long again on the first
      // failure rather than after another hour of them.
      const retried = new Date(later.getTime() + 6 * 60 * 60 * 1000);
      const retry = await collector.collect(retried);
      expect(retry.skipped).toBe(1);
      const row = await prisma.boardMailboxIgnoredMessage.findFirst({
        where: { sourceUid: { endsWith: `:${uid}` } },
      });
      expect(row?.retryAfter?.getTime()).toBe(
        retried.getTime() + 6 * 60 * 60 * 1000,
      );
      expect((await collector.collect(retried)).alreadyHeld).toBe(1);
    } finally {
      spy.mockRestore();
      await server.close();
    }
  });

  it("does not set a letter aside after an hour of failing, until it has been tried twelve times", async () => {
    // The other half of the bound: a quiet hour with the schedule stopped is
    // not twelve failures.
    const uid = `uid-slow-${suffix}`;
    const server = await serveMailbox([
      {
        uid,
        raw: letter({
          from: CORRESPONDENT,
          subject: `Langsam ${suffix}`,
          body: "Ett brev.",
          messageId: `slow-${suffix}@utanfor.example`,
        }),
      },
    ]);

    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementation((() =>
        Promise.reject(
          new Error("Connection terminated unexpectedly"),
        )) as typeof prisma.$transaction);
    const ignored = (): Promise<number> =>
      prisma.boardMailboxIgnoredMessage.count({
        where: { sourceUid: { endsWith: `:${uid}` } },
      });

    const start = new Date();
    const later = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    try {
      await collector.collect(start);
      for (let attempt = 2; attempt <= 11; attempt += 1) {
        await collector.collect(later);
      }
      expect(await ignored()).toBe(0);

      await collector.collect(later);
      expect(await ignored()).toBe(1);
    } finally {
      spy.mockRestore();
      await server.close();
    }
  });

  it("collects the letters an outage set aside once the instance has recovered", async () => {
    /*
     * Storage down for more than an hour fails every letter with a file, and
     * every one reaches the bound together - although not one of them is at
     * fault. They are set aside, the board is told, and they are stored on a
     * later try once storage answers again.
     */
    const subjects = [`Avbrott ett ${suffix}`, `Avbrott tva ${suffix}`];
    const server = await serveMailbox(
      subjects.map((subject, position) => ({
        uid: `uid-outage-${String(position)}-${suffix}`,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Se bilagan.",
          messageId: `outage-${String(position)}-${suffix}@utanfor.example`,
          attachment: true,
        }),
      })),
    );

    const upload = vi
      .spyOn(media, "upload")
      .mockRejectedValue(new Error("The storage did not answer."));
    const setAside = (): Promise<number> =>
      prisma.boardMailboxIgnoredMessage.count({
        where: {
          sourceUid: { contains: `:uid-outage-`, endsWith: `-${suffix}` },
        },
      });

    const start = new Date();
    const hourOn = new Date(start.getTime() + 65 * 60 * 1000);
    try {
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        await collector.collect(start);
      }
      await collector.collect(hourOn);
      expect(await setAside()).toBe(2);

      const status = await mailboxStatus();
      expect(status.setAsideCount).toBe(2);
      expect(status.setAside.every((row) => row.retryAt !== null)).toBe(true);

      // Storage answers again. Not fetched before the wait is over ...
      upload.mockRestore();
      const soon = await collector.collect(
        new Date(hourOn.getTime() + 5 * 60 * 1000),
      );
      expect(soon.collected).toBe(0);
      expect(soon.alreadyHeld).toBe(2);

      // ... and stored, with their files, once it is.
      const recovered = await collector.collect(
        new Date(hourOn.getTime() + 6 * 60 * 60 * 1000),
      );
      expect(recovered.collected).toBe(2);
      expect(await setAside()).toBe(0);
      expect((await mailboxStatus()).setAsideCount).toBe(0);
      for (const subject of subjects) {
        const thread = await threadBySubject(subject);
        const full = await readThread(boardCookie, thread.id);
        expect(full.messages?.[0]?.attachments).toHaveLength(1);
      }
    } finally {
      upload.mockRestore();
      await server.close();
    }
  });

  it("forgets a set-aside letter once it has left the mailbox", async () => {
    const headless = {
      uid: `uid-departed-${suffix}`,
      raw: [
        `Subject: Borta ${suffix}`,
        "Message-ID: <departed@utanfor.example>",
        "",
        "Hej",
        "",
      ].join("\r\n"),
    };
    const failing = {
      uid: `uid-departed-failing-${suffix}`,
      raw: letter({
        from: CORRESPONDENT,
        subject: `Borta ocksa ${suffix}`,
        body: "Ett brev.",
        messageId: `departed-failing-${suffix}@utanfor.example`,
      }),
    };
    // A row under a mailbox the settings no longer name, which this run cannot
    // say anything about.
    const elsewhere = `0000000000000000:uid-elsewhere-${suffix}`;
    await prisma.boardMailboxIgnoredMessage.create({
      data: { sourceUid: elsewhere, reason: "no-sender-address" },
    });

    const first = await serveMailbox([headless, failing]);
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    try {
      await collector.collect();
      expect((await mailboxStatus()).setAsideCount).toBe(1);
      expect(
        await prisma.boardMailboxCollectionFailure.count({
          where: { sourceUid: { endsWith: `:${failing.uid}` } },
        }),
      ).toBe(1);
    } finally {
      spy.mockRestore();
      await first.close();
    }

    // A board member deleted both in a mail client.
    const second = await serveMailbox([]);
    try {
      await collector.collect();
      expect((await mailboxStatus()).setAsideCount).toBe(0);
      expect(
        await prisma.boardMailboxIgnoredMessage.count({
          where: { sourceUid: { endsWith: `:${headless.uid}` } },
        }),
      ).toBe(0);
      expect(
        await prisma.boardMailboxCollectionFailure.count({
          where: { sourceUid: { endsWith: `:${failing.uid}` } },
        }),
      ).toBe(0);
      expect(
        await prisma.boardMailboxIgnoredMessage.count({
          where: { sourceUid: elsewhere },
        }),
      ).toBe(1);
    } finally {
      await second.close();
    }
  });

  it("forgets the failures of a letter once it is stored", async () => {
    const subject = `Till slut ${suffix}`;
    const uid = `uid-recovered-${suffix}`;
    const server = await serveMailbox([
      {
        uid,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Ett brev.",
          messageId: `recovered-${suffix}@utanfor.example`,
        }),
      },
    ]);

    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

    try {
      await collector.collect();
      const failures = (): Promise<number> =>
        prisma.boardMailboxCollectionFailure.count({
          where: { sourceUid: { endsWith: `:${uid}` } },
        });
      expect(await failures()).toBe(1);

      const second = await collector.collect();
      expect(second.collected).toBe(1);
      expect(await failures()).toBe(0);
    } finally {
      spy.mockRestore();
      await server.close();
    }
  });

  it("leaves no file behind for a letter that was not stored", async () => {
    const subject = `Bilaga kvar ${suffix}`;
    const server = await serveMailbox([
      {
        uid: `uid-orphan-${suffix}`,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Se bilagan.",
          messageId: `orphan-${suffix}@utanfor.example`,
          attachment: true,
        }),
      },
    ]);

    /*
     * The second transaction, not the first: storing the attachment writes its
     * row and the entry that records the upload in a transaction of its own,
     * and that one has to commit for there to be a file to take back out. The
     * one that fails is the one that would have written the letter's rows.
     */
    const transaction = prisma.$transaction.bind(prisma);
    let calls = 0;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((
      ...args: unknown[]
    ) => {
      calls += 1;
      return calls === 2
        ? Promise.reject(new Error("Connection terminated unexpectedly"))
        : (transaction as (...rest: unknown[]) => Promise<unknown>)(...args);
    }) as typeof prisma.$transaction);
    const removed = vi.spyOn(media, "remove");
    const files = await prisma.mediaFile.count();

    try {
      const first = await collector.collect();
      expect(first.skipped).toBe(1);
      // The attachment was stored before the rows that would have named it,
      // and taken back out when they were not written.
      expect(removed).toHaveBeenCalledTimes(1);
      expect(await prisma.mediaFile.count()).toBe(files);

      const second = await collector.collect();
      expect(second.collected).toBe(1);
      expect(await prisma.mediaFile.count()).toBe(files + 1);
    } finally {
      removed.mockRestore();
      spy.mockRestore();
      await server.close();
    }
  });

  it("keeps the files of a letter whose write landed although the answer was lost", async () => {
    /*
     * The COMMIT reaches PostgreSQL and the reply to it does not: a connection
     * dropped just after, a failover. The rows are there, the collector is told
     * they are not, and the attachment rows go with their file - so taking the
     * file back out would empty a stored letter for good.
     */
    const subject = `Svar borta ${suffix}`;
    const uid = `uid-lost-reply-${suffix}`;
    const server = await serveMailbox([
      {
        uid,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Se bilagan.",
          messageId: `lost-reply-${suffix}@utanfor.example`,
          attachment: true,
        }),
      },
    ]);

    // The second transaction, for the reason the test above gives: the first
    // is the attachment's own upload, which has to succeed untouched.
    const transaction = prisma.$transaction.bind(prisma);
    let calls = 0;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((
      ...args: unknown[]
    ) => {
      calls += 1;
      const run = (transaction as (...rest: unknown[]) => Promise<unknown>)(
        ...args,
      );
      return calls === 2
        ? run.then(() => {
            throw new Error("Connection terminated unexpectedly");
          })
        : run;
    }) as typeof prisma.$transaction);
    const removed = vi.spyOn(media, "remove");

    try {
      const first = await collector.collect();
      expect(first.collected).toBe(0);
      expect(first.alreadyHeld).toBe(1);
      expect(removed).not.toHaveBeenCalled();

      const thread = await threadBySubject(subject);
      const full = await readThread(boardCookie, thread.id);
      expect(full.messages?.[0]?.attachments).toHaveLength(1);
      // Stored, so not counted as failing either.
      expect(
        await prisma.boardMailboxCollectionFailure.count({
          where: { sourceUid: { endsWith: `:${uid}` } },
        }),
      ).toBe(0);
    } finally {
      removed.mockRestore();
      spy.mockRestore();
      await server.close();
    }
  });

  it("takes a letter off the set-aside list once another collection has stored it", async () => {
    /*
     * Two collections at once, in the order that leaves a letter as both: this
     * one's write fails and it finds the letter not stored, the other stores
     * it, and this one then sets it aside. Played by one collection whose write
     * commits, as the other's would, while it is told the database refused the
     * letter, and whose check for a stored letter is answered as if it ran
     * before that commit.
     */
    const subject = `Samtidigt ${suffix}`;
    const uid = `uid-overlap-${suffix}`;
    const server = await serveMailbox([
      {
        uid,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Ett brev.",
          messageId: `overlap-${suffix}@utanfor.example`,
        }),
      },
    ]);

    const transaction = prisma.$transaction.bind(prisma);
    const write = vi.spyOn(prisma, "$transaction").mockImplementationOnce(((
      ...args: unknown[]
    ) =>
      (
        (transaction as (...rest: unknown[]) => Promise<unknown>)(
          ...args,
        ) as Promise<unknown>
      ).then(() => {
        throw new Prisma.PrismaClientKnownRequestError("value too long", {
          code: "P2000",
          clientVersion: Prisma.prismaVersion.client,
          meta: {
            driverAdapterError: new DriverAdapterError({
              kind: "LengthMismatch",
              column: "body",
            }),
          },
        });
      })) as typeof prisma.$transaction);
    const findFirst = prisma.boardMailboxMessage.findFirst.bind(
      prisma.boardMailboxMessage,
    );
    const check = vi
      .spyOn(prisma.boardMailboxMessage, "findFirst")
      .mockImplementation(((query: { where?: { sourceUid?: unknown } }) =>
        query.where?.sourceUid === undefined
          ? findFirst(query as Parameters<typeof findFirst>[0])
          : Promise.resolve(
              null,
            )) as unknown as typeof prisma.boardMailboxMessage.findFirst);
    const setAside = (): Promise<number> =>
      prisma.boardMailboxIgnoredMessage.count({
        where: { sourceUid: { endsWith: `:${uid}` } },
      });

    try {
      await collector.collect();
      // Both, which is what the overlap leaves.
      await threadBySubject(subject);
      expect(await setAside()).toBe(1);
    } finally {
      check.mockRestore();
      write.mockRestore();
    }

    try {
      const next = await collector.collect();
      expect(next.alreadyHeld).toBe(1);
      expect(next.collected).toBe(0);
      // Stored, so no longer listed as a letter the board has not read.
      expect(await setAside()).toBe(0);
      expect((await mailboxStatus()).setAsideCount).toBe(0);
      expect(
        await prisma.boardMailboxMessage.count({
          where: { sourceUid: { endsWith: `:${uid}` } },
        }),
      ).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("keeps the record of a purged letter that a collection also finds stored", async () => {
    /*
     * The purge deletes a thread and records its letters as purged in one
     * transaction, and a collection that read the messages before that
     * committed and the ledger after sees the letter as both. The row is what
     * keeps the erased letter erased, so the collection must not take it as a
     * stored letter's stale set-aside entry. Played by recording the row
     * beside a letter that is still stored.
     */
    const subject = `Rensad ${suffix}`;
    const uid = `uid-stored-purged-${suffix}`;
    const server = await serveMailbox([
      {
        uid,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Ett brev.",
          messageId: `stored-purged-${suffix}@utanfor.example`,
        }),
      },
    ]);

    try {
      expect((await collector.collect()).collected).toBe(1);
      const stored = await prisma.boardMailboxMessage.findFirstOrThrow({
        where: { sourceUid: { endsWith: `:${uid}` } },
        select: { sourceUid: true },
      });
      const sourceUid = stored.sourceUid as string;
      await prisma.boardMailboxIgnoredMessage.create({
        data: { sourceUid, reason: "purged" },
      });

      const next = await collector.collect();
      expect(next.alreadyHeld).toBe(1);
      expect(next.collected).toBe(0);
      expect(
        await prisma.boardMailboxIgnoredMessage.findUnique({
          where: { sourceUid },
          select: { reason: true },
        }),
      ).toEqual({ reason: "purged" });
    } finally {
      await server.close();
    }
  });

  it("leaves the files in place when it cannot tell whether a stored row names them", async () => {
    const server = await serveMailbox([
      {
        uid: `uid-unknown-files-${suffix}`,
        raw: letter({
          from: CORRESPONDENT,
          subject: `Okant ${suffix}`,
          body: "Se bilagan.",
          messageId: `unknown-files-${suffix}@utanfor.example`,
          attachment: true,
        }),
      },
    ]);

    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    const lookup = vi
      .spyOn(prisma.boardMailboxAttachment, "findMany")
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    const removed = vi.spyOn(media, "remove");

    try {
      const first = await collector.collect();
      expect(first.skipped).toBe(1);
      // An orphan object, never a lost file.
      expect(removed).not.toHaveBeenCalled();
    } finally {
      removed.mockRestore();
      lookup.mockRestore();
      spy.mockRestore();
      await server.close();
    }
  });

  it("tries a letter again rather than keep it without a file storage would not take", async () => {
    const subject = `Lagring nere ${suffix}`;
    const server = await serveMailbox([
      {
        uid: `uid-storage-${suffix}`,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Se bilagan.",
          messageId: `storage-${suffix}@utanfor.example`,
          attachment: true,
        }),
      },
    ]);

    const spy = vi
      .spyOn(media, "upload")
      .mockRejectedValueOnce(new Error("The storage did not answer."));

    try {
      const first = await collector.collect();
      expect(first.collected).toBe(0);
      expect(first.skipped).toBe(1);

      const second = await collector.collect();
      expect(second.collected).toBe(1);
      const thread = await threadBySubject(subject);
      const full = await readThread(boardCookie, thread.id);
      expect(full.messages?.[0]?.attachmentsDropped).toBe(0);
      expect(full.messages?.[0]?.attachments).toHaveLength(1);
    } finally {
      spy.mockRestore();
      await server.close();
    }
  });

  it("reports a refused sign-in as its own kind of failure", async () => {
    const server = await startPop3TestServer({
      user: MAILBOX_USER,
      password: "not-the-stored-password",
      messages: [],
    });

    try {
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
      expect(saved.statusCode).toBe(200);

      const response = await inject({
        method: "POST",
        url: "/api/board-mailbox/collect",
        headers: { cookie: boardCookie },
      });

      // The board can act on this one: it means the password is wrong.
      expect(response.statusCode).toBe(502);
      expect((response.json() as { reason: string }).reason).toBe(
        "mailbox-sign-in-refused",
      );
    } finally {
      await server.close();
    }
  });
});

describe("threading a follow-up", () => {
  it("joins the conversation it answers", async () => {
    const subject = `Uppfoljning ${suffix}`;
    const opening = `opening-${suffix}@utanfor.example`;

    const first = await serveMailbox([
      {
        uid: "uid-open",
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Forsta brevet.",
          messageId: opening,
        }),
      },
    ]);
    await collector.collect();
    await first.close();

    const second = await serveMailbox([
      {
        uid: "uid-follow",
        raw: letter({
          from: CORRESPONDENT,
          subject: `Re: ${subject}`,
          body: "Och en pafyllning.",
          messageId: `follow-${suffix}@utanfor.example`,
          inReplyTo: opening,
        }),
      },
    ]);

    try {
      await collector.collect();

      // One thread, two messages: the subject line is not what decides this, so
      // the "Re:" prefix produced no second conversation.
      const thread = await threadBySubject(subject);
      expect(thread.messageCount).toBe(2);
      const full = await readThread(boardCookie, thread.id);
      expect(full.messages?.[1]?.body).toContain("Och en pafyllning.");
    } finally {
      await second.close();
    }
  });

  it("keeps the thread's clock at its newest message when a reply is dated earlier", async () => {
    const subject = `Sent svar ${suffix}`;
    const opening = `late-open-${suffix}@utanfor.example`;
    // Relative to the clock the collector reads, so the letters stay inside
    // the retention window whatever day the suite runs on.
    const now = Date.now();
    const recent = new Date(now - DAY_MS);
    const longAgo = new Date(now - 700 * DAY_MS);

    const first = await serveMailbox([
      {
        uid: `uid-late-open-${suffix}`,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Forsta brevet.",
          messageId: opening,
          date: recent.toUTCString(),
        }),
      },
    ]);
    await collector.collect();
    await first.close();

    const second = await serveMailbox([
      {
        uid: `uid-late-reply-${suffix}`,
        raw: letter({
          from: CORRESPONDENT,
          subject: `Re: ${subject}`,
          body: "Ett svar som blev liggande.",
          messageId: `late-reply-${suffix}@utanfor.example`,
          inReplyTo: opening,
          // A reply whose Date header says it was written almost two years ago:
          // a client with a wrong clock, or a letter held up somewhere.
          date: longAgo.toUTCString(),
        }),
      },
    ]);

    try {
      await collector.collect();

      const thread = await threadBySubject(subject);
      expect(thread.messageCount).toBe(2);
      const stored = await prisma.boardMailboxThread.findUniqueOrThrow({
        where: { id: thread.id },
        select: { lastMessageAt: true },
      });
      // Header dates carry whole seconds.
      expect(stored.lastMessageAt.getTime()).toBe(
        Math.floor(recent.getTime() / 1000) * 1000,
      );

      // The first run after the older reply's own window has closed. Had its
      // date become the thread's, this run would erase the conversation.
      await purge.run(new Date(now + 31 * DAY_MS));
      expect(
        await prisma.boardMailboxThread.findUnique({
          where: { id: thread.id },
        }),
      ).not.toBeNull();
    } finally {
      await second.close();
    }
  });

  it("refuses to let a stranger post into somebody else's thread", async () => {
    const subject = `Insprutning ${suffix}`;
    const opening = `injected-open-${suffix}@utanfor.example`;

    const first = await serveMailbox([
      {
        uid: "uid-inject-open",
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "Forsta brevet.",
          messageId: opening,
        }),
      },
    ]);
    await collector.collect();
    await first.close();

    const strangerSubject = `Insprutad ${suffix}`;
    const second = await serveMailbox([
      {
        uid: "uid-inject",
        raw: letter({
          // The same Message-ID, from somebody else. An identifier travels in
          // every copy of a letter and in every reply to it, so without the
          // address check anyone who had seen this conversation could write into
          // it and the board would read it as the correspondent's words.
          from: `okand-${suffix}@annanstans.example`,
          subject: strangerSubject,
          body: "Jag later som om jag ar nagon annan.",
          messageId: `injected-${suffix}@annanstans.example`,
          inReplyTo: opening,
        }),
      },
    ]);

    try {
      await collector.collect();

      const original = await threadBySubject(subject);
      expect(original.messageCount).toBe(1);

      const stranger = await threadBySubject(strangerSubject);
      expect(stranger.id).not.toBe(original.id);
      expect(stranger.correspondent.email).toBe(
        `okand-${suffix}@annanstans.example`,
      );
    } finally {
      await second.close();
    }
  });
});

describe("working a thread", () => {
  async function collectedThread(subject: string): Promise<ThreadBody> {
    const server = await serveMailbox([
      {
        uid: `uid-${subject}`,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "En fraga till styrelsen.",
          messageId: `${identifierOf(subject)}@utanfor.example`,
        }),
      },
    ]);
    try {
      await collector.collect();
      return await threadBySubject(subject);
    } finally {
      await server.close();
    }
  }

  it("names the board member who took it, so every seat can see", async () => {
    const thread = await collectedThread(`Ta-hand-om ${suffix}`);

    const taken = await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/take`,
      headers: { cookie: boardCookie },
    });
    expect(taken.statusCode, taken.body).toBe(201);

    const body = taken.json() as ThreadBody;
    expect(body.status).toBe("TAKEN");
    expect(body.takenBy).toEqual({
      kind: "member",
      personId: boardMember.personId,
      name: `Bo Brevlada${suffix}`,
    });

    // And the act is in the audit log, against the thread rather than against a
    // person: the correspondent is an address the envelope asserted.
    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "BOARD_MAILBOX_THREAD_TAKEN", targetId: thread.id },
      select: { actorPersonId: true, targetPersonId: true, targetKind: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorPersonId).toBe(boardMember.personId);
    expect(entries[0]?.targetPersonId).toBeNull();
    expect(entries[0]?.targetKind).toBe("boardMailboxThread");
  });

  it("reads a conversation back a page at a time", async () => {
    const thread = await collectedThread(`Bakat ${suffix}`);

    // Five messages written straight onto the thread. The page bound is far
    // above that, so what is under test is the continuation itself rather than
    // the bound: a cursor has to answer with the messages older than it, in
    // order, and with nothing on either side of them.
    const written = await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) =>
        prisma.boardMailboxMessage.create({
          data: {
            threadId: thread.id,
            direction: "INBOUND" as const,
            body: `Meddelande ${String(n)}`,
            occurredAt: new Date(`2026-02-0${String(n)}T09:00:00.000Z`),
            sourceUid: `uid-page-${suffix}-${String(n)}`,
          },
          select: { id: true },
        }),
      ),
    );

    const whole = await readThread(boardCookie, thread.id);
    const ids = (whole.messages ?? []).map((message) => message.id);
    // The letter that opened the thread, and the five written onto it.
    expect(ids).toHaveLength(written.length + 1);
    // Nothing is behind a conversation this short.
    expect(whole.olderCursor).toBeNull();

    // Asking for what is before the fourth message answers with the three
    // before it, in the same order, and stops there. The ids are read out of
    // the answer above rather than assumed: where the collected letter falls
    // among the five depends on the Date header it carried, and the cursor's
    // contract is about the order the thread is read in rather than about that.
    const page = await inject({
      method: "GET",
      url: `/api/board-mailbox/threads/${thread.id}?before=${ids[3] ?? ""}`,
      headers: { cookie: boardCookie },
    });
    expect(page.statusCode, page.body).toBe(200);
    const earlier = page.json() as ThreadBody;
    expect((earlier.messages ?? []).map((message) => message.id)).toStrictEqual(
      ids.slice(0, 3),
    );
    // And the count is the whole conversation, not the page.
    expect(earlier.messageCount).toBe(written.length + 1);
  });

  it("refuses a cursor that this API did not issue", async () => {
    const thread = await collectedThread(`Falsk ${suffix}`);

    const page = await inject({
      method: "GET",
      url: `/api/board-mailbox/threads/${thread.id}?before=${encodeURIComponent("' OR 1=1 --")}`,
      headers: { cookie: boardCookie },
    });

    // Shaped before it reaches a query. A cursor is always an id this API
    // answered with, and nothing else is one.
    expect(page.statusCode).toBe(400);
  });

  it("does not name a board member with protected personal data", async () => {
    const thread = await collectedThread(`Skyddad ${suffix}`);

    const taken = await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/take`,
      headers: { cookie: protectedCookie },
    });
    expect(taken.statusCode, taken.body).toBe(201);

    // The other seats read "a board member". The address book is where that
    // question is answered, under an audited reveal; this screen has none.
    const body = taken.json() as ThreadBody;
    expect(body.takenBy).toEqual({
      kind: "protected",
      personId: protectedBoardMember.personId,
    });
    expect(JSON.stringify(body)).not.toContain(PROTECTED_LAST_NAME);

    const listed = await listThreads(boardCookie);
    expect(JSON.stringify(listed)).not.toContain(PROTECTED_LAST_NAME);
  });

  it("puts a thread back for every seat", async () => {
    const thread = await collectedThread(`Aterlamnad ${suffix}`);

    await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/take`,
      headers: { cookie: boardCookie },
    });
    const released = await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/release`,
      headers: { cookie: boardCookie },
    });
    expect(released.statusCode, released.body).toBe(201);

    const body = released.json() as ThreadBody;
    expect(body.status).toBe("NEW");
    expect(body.takenBy).toBeNull();
  });

  it("lets a second seat take a thread the first is holding", async () => {
    // Not a lock, deliberately: a letter held by whoever opened it first, who
    // then goes on holiday, is precisely mail stuck with an individual.
    const thread = await collectedThread(`Overtagen ${suffix}`);

    await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/take`,
      headers: { cookie: boardCookie },
    });
    const second = await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/take`,
      headers: { cookie: protectedCookie },
    });

    expect(second.statusCode).toBe(201);
    expect((second.json() as ThreadBody).takenBy).toEqual({
      kind: "protected",
      personId: protectedBoardMember.personId,
    });
  });

  it("records a closed thread and reopens it where it stood", async () => {
    const thread = await collectedThread(`Avslutad ${suffix}`);

    const closed = await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/closed`,
      payload: { closed: true },
      headers: { cookie: boardCookie },
    });
    expect((closed.json() as ThreadBody).status).toBe("CLOSED");

    const reopened = await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/closed`,
      payload: { closed: false },
      headers: { cookie: boardCookie },
    });
    // Nobody had taken it and nobody had answered it, so it goes back to new.
    expect((reopened.json() as ThreadBody).status).toBe("NEW");
  });

  it("refuses a reply to a closed thread", async () => {
    const thread = await collectedThread(`Stangd ${suffix}`);

    await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/closed`,
      payload: { closed: true },
      headers: { cookie: boardCookie },
    });

    const reply = await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/reply`,
      payload: { body: "Ett svar." },
      headers: { cookie: boardCookie },
    });

    // The screen shows no reply form on a closed thread, so this is the server
    // refusing a control it never offered.
    expect(reply.statusCode).toBe(409);
    expect((reply.json() as { reason: string }).reason).toBe("thread-closed");
  });
});

describe("answering a letter", () => {
  async function threadWithReply(
    subject: string,
    answer = "Tack for ditt brev. Vi tittar pa det.",
  ): Promise<{
    thread: ThreadBody;
    replyMessageId: string;
  }> {
    const server = await serveMailbox([
      {
        uid: `uid-${subject}`,
        raw: letter({
          from: CORRESPONDENT,
          subject,
          body: "En fraga.",
          messageId: `${identifierOf(subject)}@utanfor.example`,
        }),
      },
    ]);
    try {
      await collector.collect();
    } finally {
      await server.close();
    }

    const thread = await threadBySubject(subject);
    const replied = await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/reply`,
      payload: { body: answer },
      headers: { cookie: boardCookie },
    });
    expect(replied.statusCode, replied.body).toBe(201);

    const body = replied.json() as ThreadBody;
    const outbound = body.messages?.find(
      (message) => message.direction === "OUTBOUND",
    );
    expect(outbound).toBeDefined();
    return { thread: body, replyMessageId: outbound?.id ?? "" };
  }

  it("writes the answer onto the thread with its delivery pending", async () => {
    const { thread, replyMessageId } = await threadWithReply(`Svar ${suffix}`);

    expect(thread.status).toBe("ANSWERED");
    // Replying takes the thread, because pressing send is the clearest possible
    // statement that somebody is dealing with it.
    expect(thread.takenBy).toEqual({
      kind: "member",
      personId: boardMember.personId,
      name: `Bo Brevlada${suffix}`,
    });

    const outbound = thread.messages?.find(
      (message) => message.id === replyMessageId,
    );
    expect(outbound?.delivery?.status).toBe("PENDING");

    // The audit entry names the thread and carries not a word of the answer.
    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "BOARD_MAILBOX_REPLY_SENT", targetId: thread.id },
      select: { context: true },
    });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]?.context)).not.toContain("Tack for");
  });

  it("sends it to the address on the thread, answerable to the board", async () => {
    const { replyMessageId } = await threadWithReply(`Utskick ${suffix}`);

    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });
    let sent: Parameters<MailService["send"]>[0] | undefined;
    try {
      expect(await mailer.sendReply(replyMessageId)).toBe("sent");
      // Read before the spy is restored: restoring clears what it recorded, so
      // an assertion after the `finally` would be about an empty call list and
      // would pass whatever the code did.
      sent = send.mock.calls[0]?.[0];
    } finally {
      send.mockRestore();
    }

    expect(sent?.to).toBe(CORRESPONDENT);
    // The conversation comes back to the board's own address rather than to
    // whatever relay this instance sends through.
    expect(sent?.replyTo).toBe(BOARD_ADDRESS);
    // And it threads in the correspondent's own client.
    expect(sent?.inReplyTo).toContain("@utanfor.example");

    const stored = await prisma.boardMailboxMessage.findUnique({
      where: { id: replyMessageId },
      select: { deliveryStatus: true, sentAt: true },
    });
    expect(stored?.deliveryStatus).toBe("SENT");
    expect(stored?.sentAt).not.toBeNull();
  });

  it("hands one answer over at most once, however often the job runs", async () => {
    const { replyMessageId } = await threadWithReply(`Enformig ${suffix}`);

    const send = vi.spyOn(mail, "send").mockResolvedValue({ messageId: null });
    try {
      expect(await mailer.sendReply(replyMessageId)).toBe("sent");
      // The claim is a conditional update from PENDING, so a retried job reaches
      // nobody twice. An association appearing to answer the same letter twice
      // reads as a mistake in the answer rather than in the software.
      expect(await mailer.sendReply(replyMessageId)).toBe("skipped");

      // Counted before the spy is restored, which clears what it recorded.
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
  });

  it("records a refusal as a code and never in the mail server's words", async () => {
    const { replyMessageId } = await threadWithReply(`Refuserad ${suffix}`);

    const send = vi
      .spyOn(mail, "send")
      .mockRejectedValue(
        new Error(`550 5.1.1 <${CORRESPONDENT}>: recipient rejected`),
      );
    try {
      expect(await mailer.sendReply(replyMessageId)).toBe("failed");
    } finally {
      send.mockRestore();
    }

    const stored = await prisma.boardMailboxMessage.findUnique({
      where: { id: replyMessageId },
      select: { deliveryStatus: true, deliveryFailure: true, sentAt: true },
    });
    expect(stored?.deliveryStatus).toBe("FAILED");
    expect(stored?.deliveryFailure).toBe("send-failed");
    // A rejection quotes the envelope back, and the envelope is an address.
    expect(stored?.deliveryFailure).not.toContain("@");
    expect(stored?.sentAt).toBeNull();
  });

  it("does not collect the board's own answer back as a letter", async () => {
    const subject = `Eget-svar ${suffix}`;
    const { replyMessageId } = await threadWithReply(subject);

    /*
     * A mailbox can hold what was sent from it as well as what was delivered to
     * it - a board that copies its own address, a provider that files sent mail
     * in the same mailbox, an association's address on a list it also writes to.
     * Collecting one back would open a thread in which the board appears to have
     * been written to by itself.
     */
    const server = await serveMailbox([
      {
        uid: `uid-own-answer-${suffix}`,
        raw: await answerCopy(await sendAnswer(replyMessageId)),
      },
    ]);

    try {
      // The threads themselves rather than how many there are. A count is equal
      // again when one thread was opened and another went away, which is the
      // outcome this test exists to catch; and scoped to this run, because the
      // database is shared and another suite's threads move under it.
      const ours = {
        where: { subject: { contains: suffix } },
        select: { id: true },
        orderBy: { id: "asc" },
      } as const;
      const before = await prisma.boardMailboxThread.findMany(ours);
      const summary = await collector.collect();
      const after = await prisma.boardMailboxThread.findMany(ours);

      expect(summary.collected).toBe(0);
      expect(after).toStrictEqual(before);

      // Held under the answer itself, so it is not read again.
      const answer = await prisma.boardMailboxMessage.findUnique({
        where: { id: replyMessageId },
        select: { sourceUid: true },
      });
      expect(answer?.sourceUid).toContain(`uid-own-answer-${suffix}`);
    } finally {
      await server.close();
    }
  });

  it("does not take a letter that borrows an answer's identifier for the board's own", async () => {
    const subject = `Lanat-id ${suffix}`;
    const { replyMessageId } = await threadWithReply(subject);

    /*
     * The identifier is no secret: it reached the correspondent with the answer
     * and is named in every reply they make. A letter carrying it is the board's
     * own only when it also says what the board said and nothing more - so
     * each of these is somebody writing to the board, and each is stored.
     */
    const sent = await sendAnswer(replyMessageId);
    const rendered = await mail.renderMail(sent);
    const [firstWord] = htmlToText(rendered.html).trim().split(/\s+/);
    const borrowed = (name: string, raw: string) => ({
      uid: `uid-${name}-${suffix}`,
      raw,
    });
    const server = await serveMailbox([
      // Other words under the answer's identifier.
      borrowed(
        "lanat-annat",
        letter({
          from: CORRESPONDENT,
          subject: `Annat ${subject}`,
          body: "Det har ar inte styrelsens svar.",
          messageId: sent.messageId,
        }),
      ),
      // The answer word for word, and a file beside it.
      borrowed(
        "lanat-bilaga",
        await answerCopy(sent, {
          extraParts: [
            [
              "Content-Type: image/png",
              "Content-Transfer-Encoding: base64",
              'Content-Disposition: attachment; filename="tak.png"',
              "",
              pngBytes().toString("base64"),
            ],
          ],
        }),
      ),
      // The answer word for word, and a second text part beside it, which the
      // reader reads into the letter's text.
      borrowed(
        "lanat-del",
        await answerCopy(sent, {
          extraParts: [
            ["Content-Type: text/plain; charset=utf-8", "", "Och en sak till."],
          ],
        }),
      ),
      // The answer as its plain text, and another letter as its HTML. The
      // reader reads the plain text, and a client that shows HTML shows the
      // other letter.
      borrowed(
        "lanat-html",
        await answerCopy(sent, {
          html: "<p>Det har ar ett helt annat brev till styrelsen.</p>",
        }),
      ),
      // The answer word for word under another subject line.
      borrowed(
        "lanat-amne",
        await answerCopy(sent, { subject: `Nytt arende ${subject}` }),
      ),
      // The answer, then a gap longer than the reader keeps, then another
      // letter. A client shows all of it; the reader keeps the answer and the
      // gap, and is told the letter goes on.
      borrowed(
        "lanat-utfyllnad",
        await answerCopy(sent, {
          text: `${rendered.text}${" ".repeat(MAX_TEXT_CHARACTERS)}Det har ar ett annat brev.`,
        }),
      ),
      // The same in HTML: the answer's first word, then a comment longer than
      // the reader reads, then another letter.
      borrowed(
        "lanat-kommentar",
        await answerCopy(sent, {
          html: `<p>${firstWord}<!--${" ".repeat(4 * MAX_TEXT_CHARACTERS)}-->Det har ar ett annat brev.</p>`,
        }),
      ),
      // Another letter as a picture in the HTML, which has no words at all.
      borrowed(
        "lanat-bild",
        await answerCopy(sent, {
          html: '<img src="data:image/png;base64,iVBORw0KGgo=">',
        }),
      ),
      // Another letter written by a style sheet, which has no words either.
      borrowed(
        "lanat-stil",
        await answerCopy(sent, {
          html: '<style>body::before { content: "Det har ar ett annat brev."; }</style>',
        }),
      ),
      // The answer's HTML word for word, and a picture among its words.
      borrowed(
        "lanat-bild-i-svaret",
        await answerCopy(sent, {
          html: rendered.html.replace(
            "</body>",
            '<img src="data:image/png;base64,iVBORw0KGgo="></body>',
          ),
        }),
      ),
    ]);

    try {
      const summary = await collector.collect();
      expect(summary.collected).toBe(10);

      const stored = await prisma.boardMailboxMessage.findMany({
        where: {
          sourceUid: { endsWith: `-${suffix}`, contains: "uid-lanat-" },
        },
        select: { direction: true },
      });
      expect(stored).toHaveLength(10);
      expect(stored.every((row) => row.direction === "INBOUND")).toBe(true);

      // The second text is in the letter the board reads, not left out of it.
      const withPart = await prisma.boardMailboxMessage.findFirst({
        where: { sourceUid: { endsWith: `uid-lanat-del-${suffix}` } },
        select: { body: true },
      });
      expect(withPart?.body).toContain("Och en sak till.");

      // And the answer itself is not marked as any of them.
      const answer = await prisma.boardMailboxMessage.findUnique({
        where: { id: replyMessageId },
        select: { sourceUid: true },
      });
      expect(answer?.sourceUid).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("recognises a copy of an answer longer than the reader keeps", async () => {
    const subject = `Langt-svar ${suffix}`;
    // As long as the board may write. With the greeting and the closing line
    // around it, the answer is longer than the reader keeps of a letter.
    const words = "Vi har gatt igenom ert brev. ";
    const { replyMessageId } = await threadWithReply(
      subject,
      words
        .repeat(Math.ceil(MAX_REPLY_CHARACTERS / words.length))
        .slice(0, MAX_REPLY_CHARACTERS),
    );
    const copy = await answerCopy(await sendAnswer(replyMessageId));
    // What the test is about: the copy is read cut.
    expect(readMessage(Buffer.from(copy, "utf8")).textTruncated).toBe(true);

    const server = await serveMailbox([
      { uid: `uid-langt-svar-${suffix}`, raw: copy },
    ]);
    try {
      const summary = await collector.collect();
      expect(summary.collected).toBe(0);

      const answer = await prisma.boardMailboxMessage.findUnique({
        where: { id: replyMessageId },
        select: { sourceUid: true },
      });
      expect(answer?.sourceUid).toContain(`uid-langt-svar-${suffix}`);
    } finally {
      await server.close();
    }
  });

  it("fetches no copy of the board's own answer twice, however many come back", async () => {
    const subject = `Kopior ${suffix}`;
    const { replyMessageId } = await threadWithReply(subject);

    /*
     * A provider that files sent mail, and a board that copies its own address
     * on the answer, leave two copies of it in the mailbox. The first is held
     * under the answer itself. The second has no row of its own to be held
     * under, and was fetched again on every run for as long as the mailbox
     * kept it.
     */
    const copy = await answerCopy(await sendAnswer(replyMessageId));
    const server = await serveMailbox([
      { uid: `uid-kopia-1-${suffix}`, raw: copy },
      { uid: `uid-kopia-2-${suffix}`, raw: copy },
    ]);
    const retrievals = (): number =>
      server.received.filter((line) => line.startsWith("RETR ")).length;

    try {
      const first = await collector.collect();
      expect(first.collected).toBe(0);
      expect(retrievals()).toBe(2);

      const second = await collector.collect();
      expect(second.collected).toBe(0);
      expect(second.alreadyHeld).toBe(2);
      expect(retrievals()).toBe(2);

      const recorded = await prisma.boardMailboxIgnoredMessage.findFirst({
        where: { sourceUid: { endsWith: `:uid-kopia-2-${suffix}` } },
        select: { reason: true, retryAfter: true },
      });
      expect(recorded).toEqual({ reason: "own-answer-copy", retryAfter: null });
      // Not a letter for the board to go and open, so not listed as one.
      expect(
        (await mailboxStatus()).setAside.map((row) => row.reason),
      ).not.toContain("own-answer-copy");
    } finally {
      await server.close();
    }
  });

  it("reaches a letter behind more copies of an answer than one collection fetches", async () => {
    const subject = `Kopiehog ${suffix}`;
    const { replyMessageId } = await threadWithReply(subject);
    const copy = await answerCopy(await sendAnswer(replyMessageId));

    const behind = `Bakom kopiorna ${suffix}`;
    const server = await serveMailbox([
      ...Array.from(
        { length: MAX_MESSAGES_PER_COLLECTION + 1 },
        (_, index) => ({
          uid: `uid-kopiehog-${String(index)}-${suffix}`,
          raw: copy,
        }),
      ),
      {
        uid: `uid-bakom-kopiorna-${suffix}`,
        raw: letter({
          from: CORRESPONDENT,
          subject: behind,
          body: "Hej styrelsen.",
          messageId: `${identifierOf(behind)}@utanfor.example`,
        }),
      },
    ]);

    try {
      // The first run spends every fetch it has on the copies. The second
      // fetches none of them again, so it reaches the letter.
      await collector.collect();
      await collector.collect();

      expect((await threadBySubject(behind)).subject).toBe(behind);
    } finally {
      await server.close();
    }
  });

  it("marks a reply the queue gave up on as failed", async () => {
    const { replyMessageId } = await threadWithReply(`Avbruten ${suffix}`);

    await mailer.recordAbandoned(replyMessageId);

    const stored = await prisma.boardMailboxMessage.findUnique({
      where: { id: replyMessageId },
      select: { deliveryStatus: true, deliveryFailure: true },
    });
    expect(stored?.deliveryStatus).toBe("FAILED");
    expect(stored?.deliveryFailure).toBe("reply-sending-interrupted");
  });
});

describe("the purge", () => {
  /**
   * How many transactions hold, or are queued behind, the legal hold registry
   * key, in this worker's database only: the key is the same string in every
   * worker's, and `pg_locks` shows the whole cluster.
   */
  async function registryLockCount(granted: boolean): Promise<bigint> {
    return advisoryLockCount(prisma, "legal-hold:registry", granted);
  }

  /** A thread written directly, so its clock can be put where a test needs it. */
  async function agedThread(
    correspondent: string,
    lastMessageAt: Date,
  ): Promise<string> {
    const collectorServer = await serveMailbox([
      {
        uid: `uid-aged-${correspondent}`,
        raw: letter({
          from: correspondent,
          subject: `Gammal ${correspondent}`,
          body: "Ett gammalt brev.",
          messageId: `aged-${correspondent}`,
        }),
      },
    ]);
    try {
      await collector.collect();
    } finally {
      await collectorServer.close();
    }

    const thread = await threadBySubject(`Gammal ${correspondent}`);
    await prisma.boardMailboxThread.update({
      where: { id: thread.id },
      data: { lastMessageAt },
    });
    return thread.id;
  }

  it("erases a thread whose retention has run out, and records it", async () => {
    const threadId = await agedThread(
      `gammal-${suffix}@utanfor.example`,
      new Date("2020-01-01T00:00:00.000Z"),
    );

    const summary = await purge.run(new Date("2026-01-01T00:00:00.000Z"));
    expect(summary.purged).toBeGreaterThan(0);

    expect(
      await prisma.boardMailboxThread.findUnique({ where: { id: threadId } }),
    ).toBeNull();
    // The messages went with it by the cascade, which is how the purge reaches
    // them by deleting the thread alone.
    expect(
      await prisma.boardMailboxMessage.count({ where: { threadId } }),
    ).toBe(0);

    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "SERVICE_DATA_PURGED", targetId: threadId },
      select: { targetPersonId: true, targetKind: true, context: true },
    });
    expect(entries).toHaveLength(1);
    // No subject: a correspondent is an address an envelope asserted, and
    // naming the register person whose address matched would be the attribution
    // this module refuses, written into a table that cannot be corrected.
    expect(entries[0]?.targetPersonId).toBeNull();
    expect(entries[0]?.targetKind).toBe("boardMailboxThread");
    // The window it fell out of, and nothing about the correspondence.
    expect(JSON.stringify(entries[0]?.context)).not.toContain("@");
  });

  it("does not collect a purged letter again from the mailbox", async () => {
    const subject = `Utgallrad ${suffix}`;
    const messageId = `purged-${suffix}@utanfor.example`;
    // The same mailbox before and after the purge: nothing is ever deleted from
    // it, so the letter is still there once its thread is gone.
    const server = await serveMailbox([
      {
        uid: `uid-purged-${suffix}`,
        raw: letter({
          from: `utgallrad-${suffix}@utanfor.example`,
          subject,
          body: "Ett brev som ska gallras.",
          messageId,
        }),
      },
    ]);

    try {
      const first = await collector.collect();
      expect(first.collected).toBe(1);

      const thread = await threadBySubject(subject);
      await prisma.boardMailboxThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: new Date("2020-01-01T00:00:00.000Z") },
      });
      expect(
        await purge.purgeThread(
          thread.id,
          new Date("2026-01-01T00:00:00.000Z"),
        ),
      ).toBe(true);

      const again = await collector.collect();
      expect(again.collected).toBe(0);
      expect(again.alreadyHeld).toBe(1);

      // Nothing of the letter is stored again, under any thread.
      expect(
        await prisma.boardMailboxMessage.count({ where: { messageId } }),
      ).toBe(0);
      const threads = await listThreads(boardCookie);
      expect(threads.some((listed) => listed.subject === subject)).toBe(false);

      // Remembered so it stays erased, and not listed as a letter set aside:
      // the board read it, and the association no longer keeps it.
      expect((await mailboxStatus()).setAsideCount).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("keeps every letter of a purged conversation out of the mailbox's next collection", async () => {
    const subject = `Samtal ${suffix}`;
    const from = `samtal-${suffix}@utanfor.example`;
    const openingId = `samtal-${suffix}@utanfor.example`;
    const opening = {
      uid: `uid-samtal-${suffix}`,
      raw: letter({
        from,
        subject,
        body: "En fraga.",
        messageId: openingId,
      }),
    };

    const first = await serveMailbox([opening]);
    try {
      expect((await collector.collect()).collected).toBe(1);
    } finally {
      await first.close();
    }

    const thread = await threadBySubject(subject);
    const replied = await inject({
      method: "POST",
      url: `/api/board-mailbox/threads/${thread.id}/reply`,
      payload: { body: "Tack, vi tittar pa det." },
      headers: { cookie: boardCookie },
    });
    expect(replied.statusCode, replied.body).toBe(201);
    const answer = await prisma.boardMailboxMessage.findFirst({
      where: { threadId: thread.id, direction: "OUTBOUND" },
      select: { id: true },
    });
    expect(answer).not.toBeNull();
    const answerSent = await sendAnswer(answer?.id ?? "");

    // The whole conversation as a mailbox holds it: the opening letter, the
    // correspondent's follow-up, and the board's own answer filed back into the
    // same mailbox, which the collector recognises and marks as held.
    const mailbox = [
      opening,
      {
        uid: `uid-samtal-foljd-${suffix}`,
        raw: letter({
          from,
          subject: `Sv: ${subject}`,
          body: "Och en fraga till.",
          messageId: `samtal-foljd-${suffix}@utanfor.example`,
          inReplyTo: openingId,
        }),
      },
      {
        uid: `uid-samtal-svar-${suffix}`,
        raw: await answerCopy(answerSent),
      },
    ];

    const server = await serveMailbox(mailbox);
    try {
      expect((await collector.collect()).collected).toBe(1);
      const held = await prisma.boardMailboxMessage.findMany({
        where: { threadId: thread.id, sourceUid: { not: null } },
        select: { sourceUid: true },
      });
      expect(held).toHaveLength(3);
      const heldUids = held.map((row) => row.sourceUid ?? "");

      await prisma.boardMailboxThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: new Date("2020-01-01T00:00:00.000Z") },
      });
      expect(
        await purge.purgeThread(
          thread.id,
          new Date("2026-01-01T00:00:00.000Z"),
        ),
      ).toBe(true);

      // Each of the three is remembered as purged, the board's answer included,
      // so none of them is read again.
      const ignored = await prisma.boardMailboxIgnoredMessage.findMany({
        where: { sourceUid: { in: heldUids } },
        select: { reason: true },
      });
      expect(ignored.map((row) => row.reason)).toStrictEqual([
        "purged",
        "purged",
        "purged",
      ]);

      const again = await collector.collect();
      expect(again.collected).toBe(0);
      expect(again.alreadyHeld).toBe(3);
      const threads = await listThreads(boardCookie);
      expect(threads.some((listed) => listed.subject.includes(subject))).toBe(
        false,
      );
    } finally {
      await server.close();
    }
  });

  it("takes an attachment's file and its bytes with the thread", async () => {
    const correspondent = `bilaga-${suffix}@utanfor.example`;
    const collectorServer = await serveMailbox([
      {
        uid: `uid-aged-attachment-${suffix}`,
        raw: letter({
          from: correspondent,
          subject: `Gammal bilaga ${suffix}`,
          body: "Ett gammalt brev med bilaga.",
          messageId: `aged-attachment-${suffix}@utanfor.example`,
          attachment: true,
        }),
      },
    ]);
    try {
      await collector.collect();
    } finally {
      await collectorServer.close();
    }

    const thread = await threadBySubject(`Gammal bilaga ${suffix}`);
    const stored = await prisma.boardMailboxAttachment.findMany({
      where: { message: { threadId: thread.id } },
      select: { fileId: true },
    });
    expect(stored).toHaveLength(1);
    const fileId = stored[0]?.fileId ?? "";
    expect(
      await prisma.mediaFile.findUnique({ where: { id: fileId } }),
    ).not.toBeNull();

    await prisma.boardMailboxThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: new Date("2020-01-01T00:00:00.000Z") },
    });
    await purge.run(new Date("2026-01-01T00:00:00.000Z"));

    expect(
      await prisma.boardMailboxThread.findUnique({ where: { id: thread.id } }),
    ).toBeNull();
    /*
     * And the file with it. The cascade reaches the attachment row and stops
     * there - a row points at a file, and that direction cascades the other way
     * - so without the purge removing the media itself the bytes of a letter
     * would outlive the letter, and the retention window would be kept for
     * everything on a thread except the part somebody outside the association
     * chose to attach.
     */
    expect(
      await prisma.mediaFile.findUnique({ where: { id: fileId } }),
    ).toBeNull();
  });

  it("erases a thread carrying no correspondent index while a hold stands", async () => {
    const threadId = await agedThread(
      `oindexerad-${suffix}@utanfor.example`,
      new Date("2020-01-01T00:00:00.000Z"),
    );
    // A thread whose correspondent carries no index. The collector will not
    // write one today, and the column is nullable, and the two halves of the
    // purge have to agree about what a null means: `purgeThread` reads it as
    // nobody held, so the scan has to offer it.
    await prisma.boardMailboxThread.update({
      where: { id: threadId },
      data: { correspondentEmailIndex: null },
    });

    /*
     * And a hold standing somewhere in the association, which is what used to
     * hide it. With no hold the scan asks no question about the index at all;
     * with one it asked `NOT IN`, and SQL does not answer that true for a null -
     * it answers null, and the row is dropped. The window would then pass with
     * the thread never offered to a run and nothing saying so.
     */
    const hold = await prisma.legalHold.create({
      data: {
        // Somebody whose registered address does index, so the scan really does
        // build a list to exclude. A held person the register holds no address
        // for contributes nothing to it, and the query would take the branch
        // that asks nothing about the index at all.
        personId: heldResident.personId,
        reason: `Oindexerad ${suffix}`,
        placedByPersonId: administrator.personId,
      },
      select: { id: true },
    });

    try {
      await purge.run(new Date("2026-01-01T00:00:00.000Z"));

      expect(
        await prisma.boardMailboxThread.findUnique({ where: { id: threadId } }),
      ).toBeNull();
    } finally {
      await prisma.legalHold.delete({ where: { id: hold.id } });
    }
  });

  it("leaves a thread whose conversation is still recent", async () => {
    const threadId = await agedThread(
      `farsk-${suffix}@utanfor.example`,
      new Date("2025-12-01T00:00:00.000Z"),
    );

    await purge.run(new Date("2026-01-01T00:00:00.000Z"));

    expect(
      await prisma.boardMailboxThread.findUnique({ where: { id: threadId } }),
    ).not.toBeNull();
  });

  it("keeps a restricted person's correspondence past its window until the restriction is lifted", async () => {
    /*
     * Art. 18(2): under a restriction the association may store the data and
     * little else, so erasing it is the one act the person asked it not to
     * perform. Matched on the registered address the way a hold is, and lifting
     * the restriction hands the thread back to the window.
     *
     * The resident is given an address for this case only, so no hold from the
     * cases around it stands against them.
     */
    const address = `mailbox-restricted-${suffix}@exempel.se`;
    await registerAddress(resident.personId, address);
    await prisma.person.update({
      where: { id: resident.personId },
      data: { processingRestrictedAt: new Date() },
    });

    try {
      const threadId = await agedThread(
        address,
        new Date("2020-01-01T00:00:00.000Z"),
      );

      expect(
        await purge.eligible(new Date("2026-01-01T00:00:00.000Z"), 730),
      ).not.toContain(threadId);
      await purge.run(new Date("2026-01-01T00:00:00.000Z"));
      expect(
        await prisma.boardMailboxThread.findUnique({ where: { id: threadId } }),
      ).not.toBeNull();

      await prisma.person.update({
        where: { id: resident.personId },
        data: { processingRestrictedAt: null },
      });
      await purge.run(new Date("2026-01-01T00:00:00.000Z"));
      expect(
        await prisma.boardMailboxThread.findUnique({ where: { id: threadId } }),
      ).toBeNull();
    } finally {
      await prisma.person.update({
        where: { id: resident.personId },
        data: { processingRestrictedAt: null },
      });
      await registerAddress(resident.personId, null);
    }
  });

  it.each([
    {
      cause: "restricted person's",
      slug: "restricted",
      subjectWord: "Begransad",
      protect: async () => {
        await prisma.person.update({
          where: { id: resident.personId },
          data: { processingRestrictedAt: new Date() },
        });
        return async () => {
          await prisma.person.update({
            where: { id: resident.personId },
            data: { processingRestrictedAt: null },
          });
        };
      },
    },
    {
      cause: "held person's",
      slug: "held",
      subjectWord: "Spaerrad",
      protect: async () => {
        const hold = await prisma.legalHold.create({
          data: {
            personId: resident.personId,
            reason: `Tvist ${suffix}`,
            placedByPersonId: administrator.personId,
          },
          select: { id: true },
        });
        return async () => {
          await prisma.legalHold.delete({ where: { id: hold.id } });
        };
      },
    },
  ])(
    "collects an old-dated reply to a $cause thread rather than leaving it",
    async ({ slug, subjectWord, protect }) => {
      /*
       * A letter past the window is left in the mailbox for good, which is right
       * for correspondence the purge would erase that night and wrong for one it
       * keeps. Under a restriction or a legal hold the association may not erase
       * this person's data, so leaving the letter loses it from the record that
       * is being preserved.
       */
      const address = `mailbox-${slug}-reply-${suffix}@exempel.se`;
      const subject = `${subjectWord} ${suffix}`;
      const opening = `${slug}-opening-${suffix}@utanfor.example`;
      await registerAddress(resident.personId, address);
      const release = await protect();

      try {
        const first = await serveMailbox([
          {
            uid: `uid-${slug}-opening-${suffix}`,
            raw: letter({
              from: address,
              subject,
              body: "Forsta brevet.",
              messageId: opening,
            }),
          },
        ]);
        try {
          await collector.collect();
        } finally {
          await first.close();
        }
        const thread = await threadBySubject(subject);
        const before = await prisma.boardMailboxThread.findUnique({
          where: { id: thread.id },
          select: { lastMessageAt: true },
        });

        const second = await serveMailbox([
          {
            uid: `uid-${slug}-reply-${suffix}`,
            raw: letter({
              from: address,
              subject: `Re: ${subject}`,
              body: "Ett svar fran for lange sedan.",
              messageId: `${slug}-reply-${suffix}@utanfor.example`,
              inReplyTo: opening,
              date: "Wed, 01 Jan 2020 09:15:00 +0100",
            }),
          },
        ]);
        try {
          const summary = await collector.collect();
          expect(summary.collected).toBe(1);
          expect(summary.skipped).toBe(0);
        } finally {
          await second.close();
        }

        expect((await threadBySubject(subject)).messageCount).toBe(2);
        // And the thread's clock stays on its newest letter, or the old date
        // would hand the recent one to the purge the night the restriction lifts.
        const after = await prisma.boardMailboxThread.findUnique({
          where: { id: thread.id },
          select: { lastMessageAt: true },
        });
        expect(after?.lastMessageAt).toEqual(before?.lastMessageAt);
      } finally {
        await release();
        await registerAddress(resident.personId, null);
      }
    },
  );

  it("is stopped by a restriction granted while the run is already in flight", async () => {
    /*
     * The purge cannot name the person a thread is with, so it takes the
     * registry key and the grant takes it as well as the person's own. A
     * restriction that committed between the scan and the delete would
     * otherwise lose the correspondence it was granted to keep. The wait is
     * read out of `pg_locks` rather than inferred from a delay.
     */
    const address = `mailbox-restricted-race-${suffix}@exempel.se`;
    await registerAddress(resident.personId, address);

    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holder: Promise<void> | undefined;

    try {
      const threadId = await agedThread(
        address,
        new Date("2020-01-01T00:00:00.000Z"),
      );

      // Longer than the waits below, so the transaction held open on purpose
      // is not aborted by the five-second default and its lock released early.
      holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`legal-hold:${resident.personId}`}))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"legal-hold:registry"}))`;
          await tx.person.update({
            where: { id: resident.personId },
            data: { processingRestrictedAt: new Date() },
          });
          await holderDone;
        },
        { timeout: 60_000, maxWait: 20_000 },
      );

      await waitFor(async () => (await registryLockCount(true)) > 0n);

      const running = purge.purgeThread(
        threadId,
        new Date("2026-01-01T00:00:00.000Z"),
      );
      await waitFor(async () => (await registryLockCount(false)) > 0n);

      releaseHolder?.();
      await holder;

      // It erased nothing, because by the time it got the key the restriction
      // stood.
      await expect(running).resolves.toBe(false);
      expect(
        await prisma.boardMailboxThread.findUnique({ where: { id: threadId } }),
      ).not.toBeNull();
    } finally {
      releaseHolder?.();
      await holder?.catch(() => undefined);
      await prisma.person.update({
        where: { id: resident.personId },
        data: { processingRestrictedAt: null },
      });
      await registerAddress(resident.personId, null);
    }
  }, 60_000);

  it("is stopped by a legal hold against the person the address belongs to", async () => {
    const threadId = await agedThread(
      heldResident.email,
      new Date("2020-01-01T00:00:00.000Z"),
    );

    const placed = await inject({
      method: "POST",
      url: `/api/legal-holds/persons/${heldResident.personId}`,
      payload: { reason: `Tvist ${suffix}` },
      headers: { cookie: administratorCookie },
    });
    expect(placed.statusCode, placed.body).toBe(201);

    /*
     * Excluded by the scan rather than filtered out of its answer, so a held
     * thread cannot spend the run's bound without anything being erased - and
     * refused again inside the transaction, which is the check that counts.
     */
    expect(
      await purge.eligible(new Date("2026-01-01T00:00:00.000Z"), 730),
    ).not.toContain(threadId);
    expect(
      await purge.purgeThread(threadId, new Date("2026-01-01T00:00:00.000Z")),
    ).toBe(false);

    expect(
      await prisma.boardMailboxThread.findUnique({ where: { id: threadId } }),
    ).not.toBeNull();
  });

  /**
   * A thread linked to a person as it was opened, with the address it was
   * opened with, which need not be the one the register holds for them now.
   */
  async function linkedThread(
    personId: string,
    address: string,
    lastMessageAt: Date,
  ): Promise<string> {
    const correspondent = await encryption.encrypt(
      "boardMailboxThread.correspondentEmail",
      address,
    );
    const thread = await prisma.boardMailboxThread.create({
      data: {
        subject: `Kopplad ${personId} ${String(lastMessageAt.getTime())} ${suffix}`,
        correspondentEmailCipher: correspondent.cipher,
        correspondentEmailIndex: correspondent.index,
        correspondentPersonId: personId,
        lastMessageAt,
      },
      select: { id: true },
    });
    return thread.id;
  }

  it("is stopped by a hold against the person a thread is linked to, whatever their address is now", async () => {
    // Written from an address the person has since changed. The hold matches
    // their current address, which is on no thread of theirs.
    const threadId = await linkedThread(
      householdOne.personId,
      `mailbox-tidigare-${suffix}@exempel.se`,
      new Date("2020-01-01T00:00:00.000Z"),
    );
    const hold = await prisma.legalHold.create({
      data: {
        personId: householdOne.personId,
        reason: `Tvist ${suffix}`,
        placedByPersonId: administrator.personId,
      },
    });

    try {
      const at = new Date("2026-01-01T00:00:00.000Z");
      expect(await purge.eligible(at, 730)).not.toContain(threadId);
      expect(await purge.purgeThread(threadId, at)).toBe(false);
      expect(
        await prisma.boardMailboxThread.findUnique({ where: { id: threadId } }),
      ).not.toBeNull();
    } finally {
      await prisma.legalHold.delete({ where: { id: hold.id } });
    }
  });

  it("erases the threads linked to a person on a granted erasure request, however recent", async () => {
    const now = new Date();
    const erased = await linkedThread(seatNewHolder.personId, seatAddress, now);
    // Still lives here, so the request is not in force and the thread stays
    // on its own two years.
    const kept = await linkedThread(resident.personId, resident.email, now);
    const requests = [
      await grantErasure(
        prisma,
        seatNewHolder.personId,
        boardMember.personId,
        now,
      ),
      await grantErasure(prisma, resident.personId, boardMember.personId, now),
    ];

    try {
      await purge.run(now);

      expect(
        await prisma.boardMailboxThread.findUnique({ where: { id: erased } }),
      ).toBeNull();
      expect(
        await prisma.boardMailboxThread.findUnique({ where: { id: kept } }),
      ).not.toBeNull();
      await expect(
        erasureRemainder(prisma, seatNewHolder.personId, now, encryption),
      ).resolves.toEqual([]);
    } finally {
      await prisma.dataSubjectRequest.deleteMany({
        where: { id: { in: requests.map((request) => request.id) } },
      });
    }
  });

  it("keeps a requested thread whose address a held person holds, and says it is kept", async () => {
    /*
     * The address changed hands: the thread is linked to the seat's new holder,
     * whose erasure is granted, and the address on it is the one the register
     * holds for the former holder, who is under a hold. The hold wins, as it
     * does on the window. What it must not do is leave the thread selected
     * ahead of the bound every night, refused every night, and counted as an
     * erasure the job has not got through yet - which keeps the request open
     * with the wrong reason for as long as the hold stands.
     */
    const now = new Date();
    const threadId = await linkedThread(
      seatNewHolder.personId,
      seatAddress,
      now,
    );
    const request = await grantErasure(
      prisma,
      seatNewHolder.personId,
      boardMember.personId,
      now,
    );
    const hold = await prisma.legalHold.create({
      data: {
        personId: seatFormerHolder.personId,
        reason: `Tvist ${suffix}`,
        placedByPersonId: administrator.personId,
      },
    });

    try {
      expect(await purge.eligible(now, 730)).not.toContain(threadId);
      await purge.run(now);
      expect(
        await prisma.boardMailboxThread.findUnique({ where: { id: threadId } }),
      ).not.toBeNull();

      await expect(
        erasureRemainder(prisma, seatNewHolder.personId, now, encryption),
      ).resolves.toEqual([
        {
          domain: "board mailbox threads",
          owed: 0,
          kept: 1,
          keptBecause: expect.stringContaining("hold") as unknown,
        },
      ]);
    } finally {
      await prisma.legalHold.delete({ where: { id: hold.id } });
      await prisma.dataSubjectRequest.delete({ where: { id: request.id } });
      await prisma.boardMailboxThread.deleteMany({ where: { id: threadId } });
    }
  });
});

describe("the data subject access report", () => {
  /**
   * One letter in the mailbox, collected.
   *
   * The server is closed whatever the collection did, because a test that left
   * one listening would take the port into the next one.
   */
  async function collectLetter(options: {
    from: string;
    subject: string;
    body: string;
  }): Promise<void> {
    const server = await serveMailbox([
      {
        uid: `uid-${identifierOf(options.subject)}`,
        raw: letter({
          from: options.from,
          subject: options.subject,
          body: options.body,
          messageId: `${identifierOf(options.subject)}@exempel.se`,
        }),
      },
    ]);
    try {
      await collector.collect();
    } finally {
      await server.close();
    }
  }

  /** The subjects of the threads one person's report answers for. */
  async function reportedSubjects(personId: string): Promise<string[]> {
    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${personId}`,
      headers: { cookie: administratorCookie },
    });
    expect(response.statusCode, response.body).toBe(200);

    const report = response.json() as {
      boardMailboxThreads: { subject: string }[];
    };
    return report.boardMailboxThreads.map((thread) => thread.subject);
  }

  it("answers for correspondence the association holds with this address", async () => {
    const subject = `Registerutdrag ${suffix}`;
    const server = await serveMailbox([
      {
        uid: "uid-report",
        raw: letter({
          from: heldResidentEnvelope,
          subject,
          body: "En fraga fran en boende.",
          messageId: `report-${suffix}@exempel.se`,
        }),
      },
    ]);
    try {
      await collector.collect();
    } finally {
      await server.close();
    }

    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${heldResident.personId}`,
      headers: { cookie: administratorCookie },
    });
    expect(response.statusCode, response.body).toBe(200);

    const report = response.json() as {
      boardMailboxThreads: {
        subject: string;
        correspondentEmail: string;
        messages: { direction: string; body: string }[];
        erasableFrom: string;
      }[];
    };

    const listed = report.boardMailboxThreads.find(
      (thread) => thread.subject === subject,
    );
    expect(listed).toBeDefined();
    // The address on the thread, not the one on the person. They index the same,
    // which is what found this section at all, but only one of them is what the
    // association is holding on the row the document is answering for - and a
    // report that printed the registered spelling back would be stating a value
    // it does not have, about a correspondent it deliberately does not resolve.
    expect(listed?.correspondentEmail).toBe(heldResidentEnvelope);
    expect(listed?.correspondentEmail).not.toBe(heldResident.email);
    expect(listed?.messages[0]?.body).toContain("En fraga fran en boende.");
    // The date the purge will reach it, derived rather than stored.
    expect(listed?.erasableFrom).not.toBe("");

    // And what put it there: the person the register held that address for when
    // the letter arrived, written onto the thread as it was opened. The report
    // asks for that link and never for the address, so this is the whole of what
    // decides whose document a letter is in.
    expect(
      await prisma.boardMailboxThread.findFirst({
        where: { subject },
        select: { correspondentPersonId: true },
      }),
    ).toEqual({ correspondentPersonId: heldResident.personId });
  });

  it("answers for nobody when one address is two people's", async () => {
    const subject = `Delad adress ${suffix}`;
    await collectLetter({
      from: householdAddress,
      subject,
      body: "En fraga om balkongen.",
    });

    /*
     * Nobody was established, so the thread carries no link - which is the
     * answer that discloses nothing rather than the one that guesses. Reporting
     * it to either resident would hand them the other's letter to the board, and
     * the board's answer about them, inside the document the association
     * produces to show it handles personal data properly.
     */
    expect(
      await prisma.boardMailboxThread.findFirst({
        where: { subject },
        select: { correspondentPersonId: true },
      }),
    ).toEqual({ correspondentPersonId: null });

    expect(await reportedSubjects(householdOne.personId)).not.toContain(
      subject,
    );
    expect(await reportedSubjects(householdTwo.personId)).not.toContain(
      subject,
    );
  });

  it("answers to the person the address belonged to when the letter arrived", async () => {
    const subject = `Overlamnad adress ${suffix}`;
    await collectLetter({
      from: seatAddress,
      subject,
      body: "En fraga fran ordforanden.",
    });

    // The seat changes hands: the address leaves the person who wrote from it
    // and is recorded for whoever took the seat over.
    await registerAddress(seatFormerHolder.personId, null);
    await registerAddress(seatNewHolder.personId, seatAddress);

    // The letter is still the person's who wrote it. Their own address is gone
    // from the register, and the report answers for the correspondence anyway,
    // because what it follows is the link and not the address.
    expect(await reportedSubjects(seatFormerHolder.personId)).toContain(
      subject,
    );
    // And the new holder's report is about the new holder.
    expect(await reportedSubjects(seatNewHolder.personId)).not.toContain(
      subject,
    );
  });
});
