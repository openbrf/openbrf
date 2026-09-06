import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { MailService } from "../mail/mail.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { BoardMailboxCollectorService } from "./board-mailbox-collector.service";
import { BoardMailboxMailerService } from "./board-mailbox-mailer.service";
import { BoardMailboxPurgeService } from "./board-mailbox-purge.service";
import {
  startPop3TestServer,
  type Pop3TestServer,
} from "./testing/pop3-test-server";

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
let mail: MailService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

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
}): string {
  const headers = [
    `From: Granne <${options.from}>`,
    `To: <${BOARD_ADDRESS}>`,
    `Subject: ${options.subject}`,
    `Message-ID: <${options.messageId}>`,
    "Date: Tue, 01 Sep 2026 09:15:00 +0200",
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
    } finally {
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
  async function threadWithReply(subject: string): Promise<{
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
      payload: { body: "Tack for ditt brev. Vi tittar pa det." },
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

    const send = vi.spyOn(mail, "send").mockResolvedValue(undefined);
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

    const send = vi.spyOn(mail, "send").mockResolvedValue(undefined);
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

    const reply = await prisma.boardMailboxMessage.findUnique({
      where: { id: replyMessageId },
      select: { messageId: true },
    });
    expect(reply?.messageId).toBeTruthy();

    /*
     * A mailbox can hold what was sent from it as well as what was delivered to
     * it - a board that copies its own address, a provider that files sent mail
     * in the same mailbox, an association's address on a list it also writes to.
     * Collecting one back would open a thread in which the board appears to have
     * been written to by itself.
     */
    const server = await serveMailbox([
      {
        uid: "uid-own-answer",
        raw: letter({
          from: BOARD_ADDRESS,
          subject: `Sv: ${subject}`,
          body: "Tack for ditt brev.",
          messageId: reply?.messageId ?? "",
        }),
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
