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
 * Groups against a real database.
 *
 * Seven properties that only a real run can show, and each is a statement the
 * rest of the change rests on.
 *
 *   The round trip over HTTP. Making a group, being put into one and leaving
 *   one are guarded by the global guard, so who reaches them at all is a
 *   property of a served request rather than of a service call.
 *
 *   A group is invisible from outside. A room somebody is not in and a room that
 *   does not exist answer identically - the same status and the same body - so
 *   the identifier space cannot be walked to learn what rooms the house has
 *   made.
 *
 *   A place in a group ends when the residency does. The membership row is still
 *   there and answers nothing, which a unit test can state and only a real
 *   register write can show.
 *
 *   The board reaches a group only through a report. There is no route that
 *   lists rooms, and the queue carries the message that was reported and nothing
 *   else about where it came from.
 *
 *   A struck message is withheld from the room and readable to its author, as
 *   two served requests rather than as one decision in a view.
 *
 *   The audit log records the three acts that change who can read a room, and
 *   the write of a message records nothing. The table refuses UPDATE and DELETE
 *   from the application's own role, so counting entries is the assertion.
 *
 *   The access report carries the group, the struck message and the report, in
 *   the transaction the rest of the report is gathered in.
 *
 * The rules decided before any row is written are `chat-group.service.spec.ts`
 * and `chat-report.service.spec.ts`.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let purge: ChatPurgeService;
let reports: DataSubjectReportService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

/** Lives here, and makes the group. */
const nils = {
  personId: `group-nils-${suffix}`,
  email: `group-nils-${suffix}@exempel.se`,
};
/** Lives here, and is put into it. */
const astrid = {
  personId: `group-astrid-${suffix}`,
  email: `group-astrid-${suffix}@exempel.se`,
};
/** Lives here, and is in no group at all. */
const stranger = {
  personId: `group-stranger-${suffix}`,
  email: `group-stranger-${suffix}@exempel.se`,
};
/** Holds a board seat and lives nowhere: the moderation half. */
const boardMember = {
  personId: `group-board-${suffix}`,
  email: `group-board-${suffix}@exempel.se`,
};

const personIds = [
  nils.personId,
  astrid.personId,
  stranger.personId,
  boardMember.personId,
];

let addressId: string;
let apartmentId: string;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.52.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.52.${String(subnet)}.${String(host + 1)}`;
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
}

/** The rooms this cookie is offered, and whether it may make one. */
async function roomsFor(
  cookie: string,
): Promise<{ rooms: RoomView[]; mayCreateGroup: boolean }> {
  const response = await inject({
    method: "GET",
    url: "/api/chat",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ rooms: RoomView[]; mayCreateGroup: boolean }>();
}

async function makeGroup(cookie: string, name: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/chat-groups",
    payload: { name },
    headers: { cookie },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ chatId: string }>().chatId;
}

async function write(
  cookie: string,
  chatId: string,
  body: string,
): Promise<string> {
  const response = await inject({
    method: "POST",
    url: `/api/chat/${chatId}`,
    payload: { body },
    headers: { cookie },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

let nilsCookie: string;
let astridCookie: string;
let strangerCookie: string;
let boardCookie: string;

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

  const address = await prisma.address.create({
    data: {
      street: `Gruppgatan ${suffix}`,
      number: "1",
      postalCode: "12345",
      city: "Stockholm",
    },
  });
  addressId = address.id;
  const apartment = await prisma.apartment.create({
    data: { addressId, number: `10${suffix.slice(-2)}` },
  });
  apartmentId = apartment.id;

  await prisma.person.createMany({
    data: [
      { id: nils.personId, firstName: "Nils", lastName: `Grupp${suffix}` },
      { id: astrid.personId, firstName: "Astrid", lastName: `Grupp${suffix}` },
      {
        id: stranger.personId,
        firstName: "Sven",
        lastName: `Grupp${suffix}`,
      },
      { id: boardMember.personId, firstName: "Bo", lastName: `Grupp${suffix}` },
    ],
  });

  /*
   * Three residencies and no seat between them, plus a board member with a seat
   * and no residency: the two halves of the membership question, kept apart so
   * neither can stand in for the other.
   */
  await prisma.residency.createMany({
    data: [nils, astrid, stranger].map((person) => ({
      personId: person.personId,
      apartmentId,
      role: "RESIDENT" as const,
      movedInOn: new Date("2026-01-01"),
    })),
  });
  await prisma.boardPosition.create({
    data: {
      personId: boardMember.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });

  const auth = app.get(AuthService);
  for (const who of [nils, astrid, stranger, boardMember]) {
    await auth.createAccountForPerson({
      personId: who.personId,
      email: who.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  nilsCookie = await signIn(nils.email);
  astridCookie = await signIn(astrid.email);
  strangerCookie = await signIn(stranger.email);
  boardCookie = await signIn(boardMember.email);
});

afterAll(async () => {
  if (prisma !== undefined) {
    const rooms = await prisma.chat.findMany({
      where: { createdByPersonId: { in: personIds } },
      select: { id: true },
    });
    const chatIds = rooms.map((room) => room.id);
    /*
     * The reports and the messages go with the room through the cascade; the
     * read markers carry no foreign key and are named here, exactly as the
     * purge names them.
     */
    await prisma.chatRead.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
    await prisma.chatMessage.deleteMany({
      where: { authorPersonId: { in: personIds } },
    });
    await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.boardPosition.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.residency.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.apartment.deleteMany({ where: { id: apartmentId } });
    await prisma.address.deleteMany({ where: { id: addressId } });
    /*
     * The audit entries are deliberately not cleared. The table is append-only
     * and DELETE is revoked from the application's own role, so a suite that
     * tidied up after itself here would be asserting against a guarantee the
     * product makes - the assertions below count instead.
     */
  }
  await app?.close();
});

describe("making a group and being in one", () => {
  it("offers the maker their room, and the board none of it", async () => {
    const chatId = await makeGroup(nilsCookie, "Trädgårdsgruppen");

    const mine = await roomsFor(nilsCookie);
    expect(mine.mayCreateGroup).toBe(true);
    expect(mine.rooms.map((room) => room.id)).toContain(chatId);

    /*
     * The board member holds a seat and is answered with the board chat alone.
     * Nothing about this cooperative's groups is on any list they can read, and
     * they may not make one either: they do not live here.
     */
    const board = await roomsFor(boardCookie);
    expect(board.rooms.every((room) => room.kind === "BOARD")).toBe(true);
    expect(board.mayCreateGroup).toBe(false);
  });

  it("answers a room somebody is not in exactly as one that is not there", async () => {
    const chatId = await makeGroup(nilsCookie, "Uppgång C");

    const notIn = await inject({
      method: "GET",
      url: `/api/chat/${chatId}`,
      headers: { cookie: strangerCookie },
    });
    const notThere = await inject({
      method: "GET",
      url: "/api/chat/chat-nothing-at-all",
      headers: { cookie: strangerCookie },
    });

    expect(notIn.statusCode).toBe(404);
    expect(notThere.statusCode).toBe(notIn.statusCode);
    expect(notThere.json()).toEqual(notIn.json());
  });

  it("lets anybody in the room put somebody in, and lets them leave", async () => {
    const chatId = await makeGroup(nilsCookie, "Städdagen");

    const added = await inject({
      method: "POST",
      url: `/api/chat-groups/${chatId}/members`,
      payload: { personId: astrid.personId },
      headers: { cookie: nilsCookie },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json<unknown[]>()).toHaveLength(2);

    // She is in the room and can read it.
    const page = await inject({
      method: "GET",
      url: `/api/chat/${chatId}`,
      headers: { cookie: astridCookie },
    });
    expect(page.statusCode).toBe(200);

    const left = await inject({
      method: "DELETE",
      url: `/api/chat-groups/${chatId}/members/me`,
      headers: { cookie: astridCookie },
    });
    expect(left.statusCode).toBe(204);

    const after = await inject({
      method: "GET",
      url: `/api/chat/${chatId}`,
      headers: { cookie: astridCookie },
    });
    expect(after.statusCode).toBe(404);
  });

  it("ends a place in the room the day the residency ends", async () => {
    const chatId = await makeGroup(nilsCookie, "Uppgång A");
    await inject({
      method: "POST",
      url: `/api/chat-groups/${chatId}/members`,
      payload: { personId: stranger.personId },
      headers: { cookie: nilsCookie },
    });
    expect(
      (
        await inject({
          method: "GET",
          url: `/api/chat/${chatId}`,
          headers: { cookie: strangerCookie },
        })
      ).statusCode,
    ).toBe(200);

    // The register decides it, and nobody strikes a name off a list.
    await prisma.residency.updateMany({
      where: { personId: stranger.personId },
      data: { movedOutOn: new Date("2026-06-01") },
    });

    try {
      const refused = await inject({
        method: "GET",
        url: `/api/chat/${chatId}`,
        headers: { cookie: strangerCookie },
      });
      /*
       * The guard, and not the room. Moving out takes the capability itself
       * away - it is a resident's, derived from the same residency the
       * membership rests on - so somebody who has left the building is refused
       * the endpoints before membership is asked about at all. The service's
       * own answer for a person who still lives here and is not in the room is
       * `chat-group.service.spec.ts`, and it is the same refusal as a room that
       * does not exist.
       */
      expect(refused.statusCode).toBe(403);
      // The row is still there and answers nothing, which is what lets what
      // they wrote stay in the room attributed exactly as before.
      expect(
        await prisma.chatGroupMember.count({
          where: { chatId, personId: stranger.personId },
        }),
      ).toBe(1);
    } finally {
      await prisma.residency.updateMany({
        where: { personId: stranger.personId },
        data: { movedOutOn: null },
      });
    }
  });

  it("records the acts that change who can read, and not the writing", async () => {
    const before = await prisma.auditLogEntry.count({
      where: { actorPersonId: nils.personId },
    });

    const chatId = await makeGroup(nilsCookie, "Loppisgruppen");
    await inject({
      method: "POST",
      url: `/api/chat-groups/${chatId}/members`,
      payload: { personId: astrid.personId },
      headers: { cookie: nilsCookie },
    });
    await write(nilsCookie, chatId, "Vi ses pa lordag.");

    const after = await prisma.auditLogEntry.count({
      where: { actorPersonId: nils.personId },
    });
    // Two: the room, and the person put into it. The message is on its author's
    // access report in full, so an entry would restate the row.
    expect(after - before).toBe(2);
  });
});

describe("a message reported to the board", () => {
  it("carries that message to the queue and nothing else about the room", async () => {
    const chatId = await makeGroup(nilsCookie, "Grillkvällen");
    await inject({
      method: "POST",
      url: `/api/chat-groups/${chatId}/members`,
      payload: { personId: astrid.personId },
      headers: { cookie: nilsCookie },
    });
    await write(astridCookie, chatId, "Nagot ingen borde skriva.");
    const other = await write(astridCookie, chatId, "Och nagot vanligt.");

    const messages = await inject({
      method: "GET",
      url: `/api/chat/${chatId}`,
      headers: { cookie: nilsCookie },
    });
    const messageId = messages.json<{ messages: { id: string }[] }>()
      .messages[0]?.id;

    const reported = await inject({
      method: "POST",
      url: "/api/chat-reports",
      payload: { messageId, note: "Det har handlar om min lagenhet." },
      headers: { cookie: nilsCookie },
    });
    expect(reported.statusCode).toBe(201);

    const queue = await inject({
      method: "GET",
      url: "/api/chat-reports",
      headers: { cookie: boardCookie },
    });
    expect(queue.statusCode).toBe(200);
    const rows =
      queue.json<
        { messageId: string; body: string; groupName: string | null }[]
      >();
    const row = rows.find((each) => each.messageId === messageId);
    expect(row?.body).toBe("Nagot ingen borde skriva.");
    expect(row?.groupName).toBe("Grillkvällen");
    // The other message in that room is not in the queue and there is no route
    // that would fetch it: a report carries one message.
    expect(rows.some((each) => each.messageId === other)).toBe(false);
    expect(
      (
        await inject({
          method: "GET",
          url: `/api/chat/${chatId}`,
          headers: { cookie: boardCookie },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("is refused to the board's own room", async () => {
    const board = (await roomsFor(boardCookie)).rooms.find(
      (room) => room.kind === "BOARD",
    );
    const messageId = await write(
      boardCookie,
      board?.id ?? "",
      "Styrelsens egen rad.",
    );

    const refused = await inject({
      method: "POST",
      url: "/api/chat-reports",
      payload: { messageId },
      headers: { cookie: boardCookie },
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ reason: string }>().reason).toBe("not-reportable");
  });

  it("withholds a struck message from the room and keeps it for its author", async () => {
    const chatId = await makeGroup(nilsCookie, "Cykelrummet");
    await inject({
      method: "POST",
      url: `/api/chat-groups/${chatId}/members`,
      payload: { personId: astrid.personId },
      headers: { cookie: nilsCookie },
    });
    const messageId = await write(astridCookie, chatId, "Rad som stryks.");

    const reported = await inject({
      method: "POST",
      url: "/api/chat-reports",
      payload: { messageId },
      headers: { cookie: nilsCookie },
    });
    const reportId = reported.json<{ reportId: string }>().reportId;

    const struck = await inject({
      method: "POST",
      url: `/api/chat-reports/${reportId}/strike`,
      headers: { cookie: boardCookie },
    });
    expect(struck.statusCode).toBe(200);

    const forTheRoom = await inject({
      method: "GET",
      url: `/api/chat/${chatId}`,
      headers: { cookie: nilsCookie },
    });
    const withheld = forTheRoom
      .json<{ messages: { id: string; body: string | null }[] }>()
      .messages.find((message) => message.id === messageId);
    expect(withheld?.body).toBeNull();

    const forTheAuthor = await inject({
      method: "GET",
      url: `/api/chat/${chatId}`,
      headers: { cookie: astridCookie },
    });
    const kept = forTheAuthor
      .json<{ messages: { id: string; body: string | null }[] }>()
      .messages.find((message) => message.id === messageId);
    // A strike is a strike-through and never a disappearance.
    expect(kept?.body).toBe("Rad som stryks.");

    expect(
      await prisma.auditLogEntry.count({
        where: { action: "CHAT_MESSAGE_STRUCK", targetId: messageId },
      }),
    ).toBe(1);
  });

  it("is not something a resident can read or answer", async () => {
    const refusedQueue = await inject({
      method: "GET",
      url: "/api/chat-reports",
      headers: { cookie: nilsCookie },
    });

    expect(refusedQueue.statusCode).toBe(403);
    expect(refusedQueue.json<{ message?: string }>().message).toContain(
      "chat:moderate",
    );
  });
});

describe("what the access report says about a group", () => {
  it("carries the room, the struck message and what was reported", async () => {
    const chatId = await makeGroup(nilsCookie, "Rapportgruppen");
    await inject({
      method: "POST",
      url: `/api/chat-groups/${chatId}/members`,
      payload: { personId: astrid.personId },
      headers: { cookie: nilsCookie },
    });
    const messageId = await write(astridCookie, chatId, "Rad i rapporten.");
    const reported = await inject({
      method: "POST",
      url: "/api/chat-reports",
      payload: { messageId, note: "Anmalt av mig." },
      headers: { cookie: nilsCookie },
    });
    await inject({
      method: "POST",
      url: `/api/chat-reports/${reported.json<{ reportId: string }>().reportId}/strike`,
      headers: { cookie: boardCookie },
    });

    const authors = await reports.generate({
      personId: astrid.personId,
      actorPersonId: boardMember.personId,
    });
    const room = authors.chats.find(
      (chat) => chat.chatName === "Rapportgruppen",
    );
    expect(room?.joinedOn).not.toBeNull();
    const line = room?.messages.find((each) => each.messageId === messageId);
    // Their own words, on their own report, struck or not - and the date that
    // says a moderation about them happened.
    expect(line?.body).toBe("Rad i rapporten.");
    expect(line?.struckAt).not.toBeNull();

    const reporter = await reports.generate({
      personId: nils.personId,
      actorPersonId: boardMember.personId,
    });
    const filed = reporter.chatReports.find(
      (each) => each.groupName === "Rapportgruppen",
    );
    expect(filed?.part).toBe("REPORTED");
    expect(filed?.note).toBe("Anmalt av mig.");
    expect(filed?.struck).toBe(true);
  });
});

describe("the purge", () => {
  it("erases a group that has been empty for a year, with its membership list", async () => {
    const chatId = await makeGroup(nilsCookie, "Gammal grupp");
    await inject({
      method: "POST",
      url: `/api/chat-groups/${chatId}/members`,
      payload: { personId: astrid.personId },
      headers: { cookie: nilsCookie },
    });
    // Nothing was ever written in it, and it was made long enough ago that the
    // list of who was in it is the only thing left.
    await prisma.chat.update({
      where: { id: chatId },
      data: { createdAt: new Date("2024-01-01T00:00:00.000Z") },
    });

    const summary = await purge.run(new Date("2026-09-18T03:59:00.000Z"));

    expect(summary.groupsDeleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.chat.count({ where: { id: chatId } })).toBe(0);
    expect(await prisma.chatGroupMember.count({ where: { chatId } })).toBe(0);
  });

  it("leaves a group somebody made this morning alone", async () => {
    const chatId = await makeGroup(nilsCookie, "Ny grupp");

    await purge.run(new Date("2026-09-18T03:59:00.000Z"));

    expect(await prisma.chat.count({ where: { id: chatId } })).toBe(1);
  });
});
