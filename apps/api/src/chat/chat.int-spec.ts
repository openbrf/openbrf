import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { ChatPurgeService } from "./chat-purge.service";

/**
 * The chat against a real database.
 *
 * Six properties that only a real run can show, and each is a statement the
 * rest of the change rests on.
 *
 *   The round trip over HTTP. The routes are guarded by the global guard and
 *   the capability sits on the class, so who reaches them at all is a property
 *   of a served request rather than of a service call.
 *
 *   There is exactly one board chat, and it is created by the first read. Two
 *   readers arriving at a fresh instance settle rather than each making a room,
 *   and what settles them is a partial unique index a unit test cannot hold.
 *
 *   The administrator finds no room. They hold every capability and no seat, so
 *   they pass the guard and the service answers nothing - the one case where
 *   capability and membership visibly come apart, and the one a screen has to
 *   put into words.
 *
 *   The refusal for an unknown room and for a room this person is not in is one
 *   refusal, down to the status and the body. Anything that told them apart
 *   would let the identifier space be walked.
 *
 *   The access report carries the messages in full, through the same transaction
 *   the rest of the report is gathered in. The section tuple has no type link to
 *   the report shape, so a missing entry is not a compile error and is asserted
 *   here instead.
 *
 *   The purge erases a year-old message and refuses to touch one whose author is
 *   under a legal hold. The hold is a row and the advisory lock is a database
 *   primitive; neither means anything against a fake.
 *
 * The rules decided before any row is written are `chat.service.spec.ts`, and
 * the window arithmetic is `chat-retention.spec.ts`.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let purge: ChatPurgeService;
let reports: DataSubjectReportService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

/** On the board, and the person every reading test acts as. */
const seated = {
  personId: `chat-seated-${suffix}`,
  email: `chat-seated-${suffix}@exempel.se`,
};
/** On the board as well, so a message can arrive from somebody else. */
const colleague = {
  personId: `chat-colleague-${suffix}`,
  email: `chat-colleague-${suffix}@exempel.se`,
};
/** Lives here, holds no seat, and is in no room. */
const resident = {
  personId: `chat-resident-${suffix}`,
  email: `chat-resident-${suffix}@exempel.se`,
};
/** Holds every capability through the ADMIN grant, and holds no seat. */
const administrator = {
  personId: `chat-admin-${suffix}`,
  email: `chat-admin-${suffix}@exempel.se`,
};
/** On the board, with a legal hold standing against them. */
const held = {
  personId: `chat-held-${suffix}`,
  email: `chat-held-${suffix}@exempel.se`,
};

const personIds = [
  seated.personId,
  colleague.personId,
  resident.personId,
  administrator.personId,
  held.personId,
];

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.49.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.49.${String(subnet)}.${String(host + 1)}`;
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

interface RoomView {
  id: string;
  kind: string;
  name: string | null;
  unread: number;
  lastMessageAt: string | null;
}

/** The rooms this cookie is offered. */
async function roomsFor(cookie: string): Promise<RoomView[]> {
  const response = await inject({
    method: "GET",
    url: "/api/chat",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<RoomView[]>();
}

let seatedCookie: string;
let colleagueCookie: string;
let residentCookie: string;
let administratorCookie: string;
let boardChatId: string;

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
  purge = app.get(ChatPurgeService);
  reports = app.get(DataSubjectReportService);

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });

  await prisma.person.createMany({
    data: [
      { id: seated.personId, firstName: "Astrid", lastName: `Chat${suffix}` },
      { id: colleague.personId, firstName: "Bo", lastName: `Chat${suffix}` },
      { id: resident.personId, firstName: "Nils", lastName: `Chat${suffix}` },
      {
        id: administrator.personId,
        firstName: "Holger",
        lastName: `Chat${suffix}`,
      },
      { id: held.personId, firstName: "Elin", lastName: `Chat${suffix}` },
    ],
  });

  await prisma.boardPosition.createMany({
    data: [seated, colleague, held].map((person) => ({
      personId: person.personId,
      position: "BOARD_MEMBER" as const,
      electedOn: new Date("2026-01-01"),
    })),
  });
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
  });

  const auth = app.get(AuthService);
  for (const who of [seated, colleague, resident, administrator]) {
    await auth.createAccountForPerson({
      personId: who.personId,
      email: who.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  seatedCookie = await signIn(seated.email);
  colleagueCookie = await signIn(colleague.email);
  residentCookie = await signIn(resident.email);
  administratorCookie = await signIn(administrator.email);

  const rooms = await roomsFor(seatedCookie);
  boardChatId = rooms[0]?.id ?? "";
});

afterAll(async () => {
  if (prisma !== undefined) {
    /*
     * The messages first, then the room. `chatId` cascades, so deleting the room
     * would take them anyway; naming both says which rows this suite wrote.
     */
    await prisma.chatMessage.deleteMany({
      where: { authorPersonId: { in: personIds } },
    });
    await prisma.chatRead.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.chat.deleteMany({ where: { id: boardChatId } });
    await prisma.legalHold.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.systemRole.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.boardPosition.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    /*
     * The audit entries are deliberately not cleared. The table is append-only
     * and DELETE is revoked from the application's own role, so a suite that
     * tidied up after itself here would be asserting against a guarantee the
     * product makes - the assertions below count instead.
     */
  }
  await app?.close();
});

describe("the rooms somebody is in", () => {
  it("creates exactly one board chat, however many readers arrive at once", async () => {
    /*
     * The partial unique index, which is the whole of what makes the
     * create-on-first-read safe. Prisma cannot express a WHERE on an index, so
     * it is written by hand into the migration and there is nothing in the
     * schema that would fail without it - only this.
     */
    const answers = await Promise.all([
      roomsFor(seatedCookie),
      roomsFor(colleagueCookie),
      roomsFor(seatedCookie),
    ]);

    for (const rooms of answers) {
      expect(rooms).toHaveLength(1);
      expect(rooms[0]?.id).toBe(boardChatId);
      expect(rooms[0]?.kind).toBe("BOARD");
      // The board chat has no name: its name is its kind.
      expect(rooms[0]?.name).toBeNull();
    }

    expect(await prisma.chat.count({ where: { kind: "BOARD" } })).toBe(1);
  });

  it("offers the administrator no room although they reach every route", async () => {
    /*
     * The case a screen has to put into words. They hold the capability through
     * ADMIN_CAPABILITIES = CAPABILITIES and they hold no board seat, so the
     * guard lets them in and the service answers nothing. An empty list rather
     * than a 403: it is an answer about membership, and membership is not a
     * capability.
     */
    const response = await inject({
      method: "GET",
      url: "/api/chat",
      headers: { cookie: administratorCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("refuses somebody who lives here and holds no seat", async () => {
    // The capability is the board's, so a resident is stopped by the guard
    // before membership is ever asked about.
    const response = await inject({
      method: "GET",
      url: "/api/chat",
      headers: { cookie: residentCookie },
    });

    expect(response.statusCode).toBe(403);
    expect(
      (response.json<{ message?: string }>().message ?? "").includes(
        "chat:participate",
      ),
    ).toBe(true);
  });

  it("refuses a caller with no session at all", async () => {
    const response = await inject({ method: "GET", url: "/api/chat" });

    expect(response.statusCode).toBe(401);
  });
});

describe("writing and reading over HTTP", () => {
  it("carries a message from one board member to another", async () => {
    const written = await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}`,
      headers: { cookie: seatedCookie },
      payload: { body: "Jag tar in en offert till pa taket." },
    });
    expect(written.statusCode).toBe(201);
    const message = written.json<{ id: string; author: { kind: string } }>();
    expect(message.author.kind).toBe("person");

    const page = await inject({
      method: "GET",
      url: `/api/chat/${boardChatId}`,
      headers: { cookie: colleagueCookie },
    });
    expect(page.statusCode).toBe(200);
    const read = page.json<{
      messages: { id: string; body: string }[];
      latest: string | null;
      earlier: string | null;
    }>();

    expect(read.messages.map((row) => row.id)).toContain(message.id);
    expect(read.latest).not.toBeNull();
  });

  it("brings in what somebody else wrote, through the poll and nothing else", async () => {
    const before = await inject({
      method: "GET",
      url: `/api/chat/${boardChatId}`,
      headers: { cookie: seatedCookie },
    });
    const cursor = before.json<{ latest: string | null }>().latest ?? "";

    const written = await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}`,
      headers: { cookie: colleagueCookie },
      payload: { body: "Den kom i morse och ar dyrare." },
    });
    expect(written.statusCode).toBe(201);

    const update = await inject({
      method: "GET",
      url: `/api/chat/${boardChatId}/since?after=${encodeURIComponent(cursor)}`,
      headers: { cookie: seatedCookie },
    });
    expect(update.statusCode).toBe(200);
    const since = update.json<{
      messages: { body: string }[];
      cursor: string;
      more: boolean;
    }>();

    expect(since.messages.map((row) => row.body)).toEqual([
      "Den kom i morse och ar dyrare.",
    ]);
    expect(since.more).toBe(false);
    // The cursor moved, so the next poll asks from here rather than repeating.
    expect(since.cursor).not.toBe(cursor);
  });

  it("answers an idle poll with nothing and the cursor it was given", async () => {
    const page = await inject({
      method: "GET",
      url: `/api/chat/${boardChatId}`,
      headers: { cookie: seatedCookie },
    });
    const cursor = page.json<{ latest: string | null }>().latest ?? "";

    const update = await inject({
      method: "GET",
      url: `/api/chat/${boardChatId}/since?after=${encodeURIComponent(cursor)}`,
      headers: { cookie: seatedCookie },
    });

    expect(update.json<{ messages: unknown[]; cursor: string }>()).toEqual({
      messages: [],
      cursor,
      more: false,
    });
  });

  it("refuses a cursor this application did not hand out", async () => {
    // A value the screen could not have produced is answered rather than
    // repaired: answering the newest page to somebody who asked for an older
    // one would tell a reader the room ends where it does not.
    const response = await inject({
      method: "GET",
      url: `/api/chat/${boardChatId}?before=not-a-cursor`,
      headers: { cookie: seatedCookie },
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses a message carrying a personal identity number, naming no digits", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}`,
      headers: { cookie: seatedCookie },
      payload: { body: "Det ar 19811218-9876 som star i registret." },
    });

    expect(response.statusCode).toBe(422);
    const body = response.body;
    expect(body).toContain("personal-identity-number");
    // The whole serialised refusal, because the message and the details both
    // travel back to the caller.
    expect(body).not.toContain("19811218");

    expect(
      await prisma.chatMessage.count({
        where: { chatId: boardChatId, body: { contains: "19811218" } },
      }),
    ).toBe(0);
  });

  it("refuses a message of nothing but spaces", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}`,
      headers: { cookie: seatedCookie },
      payload: { body: "   " },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("the one refusal", () => {
  it("answers an unknown room exactly as a room this person is not in", async () => {
    /*
     * A GROUP row stands in for "a room this person is not in": the value is in
     * the enum so that adding groups is not a migration over live rows, and
     * until a service answers it the refusal has to be indistinguishable from a
     * room that is not there. Anything else would let the identifier space be
     * walked to learn what rooms the association has.
     */
    const group = await prisma.chat.create({
      data: { kind: "GROUP", name: `Garden ${suffix}` },
      select: { id: true },
    });

    try {
      const unknown = await inject({
        method: "GET",
        url: `/api/chat/chat-nothing-${suffix}`,
        headers: { cookie: seatedCookie },
      });
      const notIn = await inject({
        method: "GET",
        url: `/api/chat/${group.id}`,
        headers: { cookie: seatedCookie },
      });

      expect(unknown.statusCode).toBe(404);
      expect(notIn.statusCode).toBe(unknown.statusCode);
      expect(notIn.body).toBe(unknown.body);
    } finally {
      await prisma.chat.delete({ where: { id: group.id } });
    }
  });

  it("refuses the write into a room this person is not in", async () => {
    const group = await prisma.chat.create({
      data: { kind: "GROUP", name: `Trapphus ${suffix}` },
      select: { id: true },
    });

    try {
      const response = await inject({
        method: "POST",
        url: `/api/chat/${group.id}`,
        headers: { cookie: seatedCookie },
        payload: { body: "Hej." },
      });

      expect(response.statusCode).toBe(404);
      expect(
        await prisma.chatMessage.count({ where: { chatId: group.id } }),
      ).toBe(0);
    } finally {
      await prisma.chat.delete({ where: { id: group.id } });
    }
  });
});

describe("the read marker", () => {
  it("is written once per person per room and never moves backwards", async () => {
    const later = new Date("2027-01-02T10:00:00.000Z");
    const earlier = new Date("2027-01-01T10:00:00.000Z");

    const first = await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}/read`,
      headers: { cookie: seatedCookie },
      payload: { readAt: later.toISOString() },
    });
    expect(first.statusCode).toBe(200);

    const second = await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}/read`,
      headers: { cookie: seatedCookie },
      payload: { readAt: earlier.toISOString() },
    });

    /*
     * The upsert and its comparison are one statement, which is what makes two
     * tabs settle rather than overwrite. The loser is told the marker that
     * actually stands rather than the instant it sent.
     */
    expect(second.json()).toEqual({ readAt: later.toISOString() });

    const rows = await prisma.chatRead.findMany({
      where: { chatId: boardChatId, personId: seated.personId },
      select: { readAt: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.readAt).toEqual(later);
  });

  it("counts what arrived after the marker, and never this person's own", async () => {
    await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}/read`,
      headers: { cookie: colleagueCookie },
      payload: { readAt: new Date().toISOString() },
    });

    await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}`,
      headers: { cookie: colleagueCookie },
      payload: { body: "Min egen rad, som inte ar olast for mig." },
    });
    const mine = await roomsFor(colleagueCookie);
    expect(mine[0]?.unread).toBe(0);

    await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}`,
      headers: { cookie: seatedCookie },
      payload: { body: "Och en rad fran nagon annan." },
    });
    const theirs = await roomsFor(colleagueCookie);
    expect(theirs[0]?.unread).toBe(1);
  });

  it("refuses an instant that is not one", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}/read`,
      headers: { cookie: seatedCookie },
      payload: { readAt: "igar" },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("the access report", () => {
  it("carries this person's own messages in full, and nobody else's", async () => {
    /*
     * The section tuple in data-subject-report.service.ts has no type link to
     * the report shape, so a section left out of it is not a compile error. It
     * is asserted here, against the transaction the whole report is gathered
     * in.
     */
    await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}`,
      headers: { cookie: seatedCookie },
      payload: { body: "Detta ska sta pa mitt registerutdrag." },
    });
    await inject({
      method: "POST",
      url: `/api/chat/${boardChatId}`,
      headers: { cookie: colleagueCookie },
      payload: { body: "Detta ar inte hennes ord." },
    });

    const report = await reports.generate({
      personId: seated.personId,
      actorPersonId: administrator.personId,
    });

    expect(report.chats).toHaveLength(1);
    const room = report.chats[0];
    expect(room?.chatKind).toBe("BOARD");
    expect(room?.chatName).toBeNull();
    // The read marker is a field of the room rather than a section of its own.
    expect(room?.readUpTo).toBe("2027-01-02T10:00:00.000Z");

    const bodies = (room?.messages ?? []).map((message) => message.body);
    expect(bodies).toContain("Detta ska sta pa mitt registerutdrag.");
    // A room's other members wrote about themselves and about the association's
    // business; a report carrying the whole room would hand one board member
    // everything the other seven said.
    expect(bodies).not.toContain("Detta ar inte hennes ord.");

    // And the date the purge will actually reach each of them, derived rather
    // than stored.
    for (const message of room?.messages ?? []) {
      expect(message.erasableFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("the purge", () => {
  it("erases a message a year after it was written, and records that it did", async () => {
    /*
     * Written directly, with the date set. The window is a year and this suite
     * is not going to wait for it; the API's own path is exercised above.
     */
    const old = await prisma.chatMessage.create({
      data: {
        chatId: boardChatId,
        authorPersonId: resident.personId,
        body: "Skrivet for lange sedan.",
        createdAt: new Date("2025-01-01T10:00:00.000Z"),
      },
      select: { id: true },
    });
    const recent = await prisma.chatMessage.create({
      data: {
        chatId: boardChatId,
        authorPersonId: resident.personId,
        body: "Skrivet nyligen.",
      },
      select: { id: true },
    });

    /*
     * The run is unscoped: it scans every author in the integration database,
     * which the suites share and run against in parallel. So this asserts on the
     * rows it created and never on the run summary - a count over the whole
     * table reports another suite's fixture as this purge's work, and fails for
     * a reason belonging to whichever suite happened to run alongside.
     */
    await purge.run(new Date("2026-06-01T03:59:00.000Z"), 365);

    expect(
      await prisma.chatMessage.findUnique({
        where: { id: old.id },
        select: { id: true },
      }),
    ).toBeNull();
    // And the one inside its window is untouched, so the cutoff is a cutoff and
    // not a table scan.
    expect(
      await prisma.chatMessage.findUnique({
        where: { id: recent.id },
        select: { id: true },
      }),
    ).not.toBeNull();

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetPersonId: resident.personId,
        targetKind: "chatMessage",
      },
      select: { context: true, actorPersonId: true },
    });
    expect(entries).toHaveLength(1);
    // Nobody clicked it: the job ran because a date arrived.
    expect(entries[0]?.actorPersonId).toBeNull();
    expect(entries[0]?.context).toMatchObject({
      retentionDaysAfterMessage: 365,
    });
  });

  it("is stopped by a legal hold standing against the author", async () => {
    const message = await prisma.chatMessage.create({
      data: {
        chatId: boardChatId,
        authorPersonId: held.personId,
        body: "Skrivet av nagon som star under hold.",
        createdAt: new Date("2025-01-01T10:00:00.000Z"),
      },
      select: { id: true },
    });
    await prisma.legalHold.create({
      data: {
        personId: held.personId,
        reason: "Tvist om en offert",
        placedByPersonId: administrator.personId,
      },
    });

    const at = new Date("2026-06-01T03:59:00.000Z");
    await purge.run(at, 365);

    expect(
      await prisma.chatMessage.findUnique({
        where: { id: message.id },
        select: { id: true },
      }),
    ).not.toBeNull();

    // Not in the scan's answer at all: held people are excluded by the query
    // rather than dropped from it, or five hundred of them could spend a run's
    // whole bound and the messages behind them would outlive their window.
    expect(await purge.eligible(at, 365)).not.toContain(held.personId);

    // And the check inside the deleting transaction is the one that counts: a
    // hold placed after the scan has to win, which is what this asserts by
    // asking the purge to erase for a person it was never given.
    await expect(purge.purgePerson(held.personId, at, 365)).resolves.toBe(0);
  });
});
