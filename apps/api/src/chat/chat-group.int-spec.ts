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
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { GROUPS_PER_PERSON } from "./chat-group.service";
import { lockChatPerson } from "./chat-lock";
import { ChatPurgeService } from "./chat-purge.service";

/**
 * Groups against a real database.
 *
 * Eight properties that only a real run can show, and each is a statement the
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
 *   A second press on somebody's last group place waits for the first and then
 *   answers as the idempotent add it is, which holds only while the person's
 *   own lock is taken before the count is.
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

/** Holds every capability through the ADMIN grant, and holds no seat. */
const administrator = {
  personId: `group-admin-${suffix}`,
  email: `group-admin-${suffix}@exempel.se`,
};

const personIds = [
  nils.personId,
  astrid.personId,
  stranger.personId,
  boardMember.personId,
  administrator.personId,
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
let administratorCookie: string;

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
      {
        id: administrator.personId,
        firstName: "Holger",
        lastName: `Grupp${suffix}`,
      },
    ],
  });
  await prisma.systemRole.create({
    data: { personId: administrator.personId, role: "ADMIN" },
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
  for (const who of [nils, astrid, stranger, boardMember, administrator]) {
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
  administratorCookie = await signIn(administrator.email);
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
    await prisma.systemRole.deleteMany({
      where: { personId: { in: personIds } },
    });
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

      // Nor is the room's member list: it asks the register too, and does not
      // count them against the room.
      const listed = await inject({
        method: "GET",
        url: `/api/chat-groups/${chatId}/members`,
        headers: { cookie: nilsCookie },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.body).not.toContain(stranger.personId);

      /*
       * And the night's purge takes the row, as the act it is. What they wrote
       * stays in the room attributed as before, because attribution is the
       * message's own `authorPersonId` and not this row - which, left, would
       * put them back in the room unannounced if they moved in again.
       */
      const summary = await purge.run(new Date());
      expect(summary.formerResidentsRemoved).toBeGreaterThanOrEqual(1);
      expect(
        await prisma.chatGroupMember.count({
          where: { chatId, personId: stranger.personId },
        }),
      ).toBe(0);
      expect(
        await prisma.auditLogEntry.findFirst({
          where: {
            action: "CHAT_GROUP_MEMBER_REMOVED",
            actorPersonId: null,
            targetPersonId: stranger.personId,
            targetId: chatId,
          },
        }),
      ).not.toBeNull();
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

describe("who a room can be offered", () => {
  /** The picker, asked with the maker's session. */
  async function candidatesFor(
    chatId: string,
    search: string,
  ): Promise<{ personId: string; name: string }[]> {
    const response = await inject({
      method: "GET",
      url: `/api/chat-groups/${chatId}/candidates?search=${encodeURIComponent(search)}`,
      headers: { cookie: nilsCookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ personId: string; name: string }[]>();
  }

  it("finds a neighbour by their whole name, in either order", async () => {
    /*
     * What somebody types into the search is a name, and a name is two words.
     * Every word has to match a part of it, as it does in the resident
     * directory the picker's rule is taken from - so "Sven Grupp" finds Sven
     * Grupp, and so does "Grupp Sven". Matched against a single column instead,
     * the whole name is in neither and the picker offers nobody.
     */
    const chatId = await makeGroup(nilsCookie, "Sökgruppen");
    const surname = `Grupp${suffix}`;

    for (const search of [
      `Sven ${surname}`,
      `${surname} Sven`,
      "Sven",
      "sven",
    ]) {
      const offered = await candidatesFor(chatId, search);
      expect(
        offered.map((each) => each.personId),
        `searching for "${search}"`,
      ).toContain(stranger.personId);
    }

    // A word that matches nobody's name narrows the list to nobody, rather than
    // being ignored.
    const narrowed = await candidatesFor(chatId, `Sven Nobody${suffix}`);
    expect(narrowed.map((each) => each.personId)).not.toContain(
      stranger.personId,
    );
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
    const { reports: rows } = queue.json<{
      reports: { messageId: string; body: string; groupName: string | null }[];
    }>();
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

describe("an account holding every capability and no seat", () => {
  it("is refused the queue, and is told the queue is not theirs", async () => {
    /*
     * The instance's administrator. `ADMIN_CAPABILITIES` is every capability,
     * so they hold `chat:moderate` and pass the guard - and a report carries a
     * private room's message in full. The board chat already refuses them the
     * room; a queue that handed them the same text would keep the promise on
     * one path and break it on the other.
     */
    const chatId = await makeGroup(nilsCookie, "Insynsgruppen");
    await inject({
      method: "POST",
      url: `/api/chat-groups/${chatId}/members`,
      payload: { personId: astrid.personId },
      headers: { cookie: nilsCookie },
    });
    const messageId = await write(astridCookie, chatId, "Rad i rummet.");
    const reported = await inject({
      method: "POST",
      url: "/api/chat-reports",
      payload: { messageId },
      headers: { cookie: nilsCookie },
    });
    const reportId = reported.json<{ reportId: string }>().reportId;

    const queue = await inject({
      method: "GET",
      url: "/api/chat-reports",
      headers: { cookie: administratorCookie },
    });

    expect(queue.statusCode).toBe(200);
    const answer = queue.json<{
      reports: unknown[];
      mayModerate: boolean;
    }>();
    expect(answer.reports).toEqual([]);
    // Not "nothing has been reported": that is a fact about a room they may not
    // be told exists.
    expect(answer.mayModerate).toBe(false);

    // And neither act is theirs, answered as a report that is not there.
    for (const act of ["strike", "dismiss"]) {
      const refused = await inject({
        method: "POST",
        url: `/api/chat-reports/${reportId}/${act}`,
        headers: { cookie: administratorCookie },
      });
      expect(refused.statusCode).toBe(404);
      expect(refused.json<{ reason: string }>().reason).toBe(
        "report-not-found",
      );
    }

    const message = await prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { struckAt: true },
    });
    expect(message?.struckAt).toBeNull();
  });
});

describe("a message two people reported", () => {
  it("is answered once: dismissing one closes the other", async () => {
    /*
     * The board decides about the message rather than about one person's report
     * of it. A sibling left open would let the same message be struck through
     * afterwards - the decision the board has just declined to make, made by
     * whoever pressed next.
     */
    const chatId = await makeGroup(nilsCookie, "Tvåanmälningar");
    await inject({
      method: "POST",
      url: `/api/chat-groups/${chatId}/members`,
      payload: { personId: astrid.personId },
      headers: { cookie: nilsCookie },
    });
    await inject({
      method: "POST",
      url: `/api/chat-groups/${chatId}/members`,
      payload: { personId: stranger.personId },
      headers: { cookie: nilsCookie },
    });
    const messageId = await write(
      astridCookie,
      chatId,
      "Rad som anmäls två gånger.",
    );

    const first = await inject({
      method: "POST",
      url: "/api/chat-reports",
      payload: { messageId },
      headers: { cookie: nilsCookie },
    });
    const second = await inject({
      method: "POST",
      url: "/api/chat-reports",
      payload: { messageId },
      headers: { cookie: strangerCookie },
    });
    expect(second.statusCode).toBe(201);
    const secondId = second.json<{ reportId: string }>().reportId;

    const dismissed = await inject({
      method: "POST",
      url: `/api/chat-reports/${first.json<{ reportId: string }>().reportId}/dismiss`,
      headers: { cookie: boardCookie },
    });
    expect(dismissed.statusCode).toBe(200);

    // The other one is closed with it, and says the board left the message
    // standing rather than staying open for somebody to press again.
    const sibling = await prisma.chatMessageReport.findUnique({
      where: { id: secondId },
      select: { resolvedAt: true, upheld: true },
    });
    expect(sibling?.resolvedAt).not.toBeNull();
    expect(sibling?.upheld).toBe(false);

    const struck = await inject({
      method: "POST",
      url: `/api/chat-reports/${secondId}/strike`,
      headers: { cookie: boardCookie },
    });
    expect(struck.statusCode).toBe(422);
    expect(struck.json<{ reason: string }>().reason).toBe("report-resolved");

    const message = await prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { struckAt: true },
    });
    expect(message?.struckAt).toBeNull();
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

describe("the last place in somebody's groups", () => {
  /**
   * Tops Astrid up to one place short of the cap, with rooms the afterAll
   * sweep and the finally of each test below both own. She is in groups from
   * the tests above, so what is missing is counted first.
   */
  async function fillToOnePlaceShort(): Promise<string[]> {
    const held = await prisma.chatGroupMember.count({
      where: { personId: astrid.personId, chat: { kind: "GROUP" } },
    });
    const filler = await Promise.all(
      Array.from({ length: GROUPS_PER_PERSON - 1 - held }, (_, index) =>
        prisma.chat.create({
          data: {
            kind: "GROUP",
            name: `Fyllnad ${String(index)}`,
            createdByPersonId: nils.personId,
            members: {
              create: {
                personId: astrid.personId,
                addedByPersonId: nils.personId,
              },
            },
          },
          select: { id: true },
        }),
      ),
    );
    return filler.map((room) => room.id);
  }

  /**
   * Nils adds Astrid to `chatId` while another press holds her lock.
   *
   * The other press is a transaction that holds Astrid's lock, so the request
   * has to wait behind it. It is let go only once `pg_locks` shows the request
   * queued behind that lock, and it commits `commit` first - the order two
   * presses reach the database in when one of them is the slower. Without the
   * person's lock the request does not wait, counts the rooms before the other
   * press has committed and acts on a count that is no longer true.
   *
   * The request is settled before this returns or throws, so that a caller's
   * cleanup never deletes the rooms from under a request still running: if the
   * wait or `commit` fails, the holder rolls back, the request is let through
   * and awaited here, and the failure that surfaces is the original one.
   */
  async function addWhileLockHeld(
    chatId: string,
    commit: (tx: Parameters<typeof lockChatPerson>[0]) => Promise<void>,
  ) {
    let request: ReturnType<typeof inject> | undefined;
    try {
      // Longer than the wait below, so the transaction held open on purpose is
      // not aborted by the five-second default and its lock released early.
      await prisma.$transaction(
        async (tx) => {
          await lockChatPerson(tx, astrid.personId);
          request = inject({
            method: "POST",
            url: `/api/chat-groups/${chatId}/members`,
            payload: { personId: astrid.personId },
            headers: { cookie: nilsCookie },
          });
          await waitFor(
            async () =>
              (await advisoryLockCount(
                prisma,
                `chat-person:${astrid.personId}`,
                false,
              )) > 0n,
          );
          await commit(tx);
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
    } catch (error) {
      // The holder has rolled back and its lock is gone. Let the request run
      // out; its own outcome is of no interest next to the failure above.
      await request?.then(
        () => undefined,
        () => undefined,
      );
      throw error;
    }
    return request;
  }

  it("answers a second press on the same name as an add, not as a refusal", async () => {
    const filler = await fillToOnePlaceShort();
    const chatId = await makeGroup(nilsCookie, "Sista platsen");
    const roomIds = [chatId, ...filler];

    try {
      const entriesBefore = await prisma.auditLogEntry.count({
        where: { actorPersonId: nils.personId },
      });

      // The other press commits the very membership the request is adding.
      const response = await addWhileLockHeld(chatId, async (tx) => {
        await tx.chatGroupMember.create({
          data: {
            chatId,
            personId: astrid.personId,
            addedByPersonId: stranger.personId,
          },
        });
      });
      expect(response?.statusCode).toBe(200);
      expect(response?.json<unknown[]>()).toHaveLength(2);
      expect(
        await prisma.chatGroupMember.count({
          where: { chatId, personId: astrid.personId },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLogEntry.count({
          where: { actorPersonId: nils.personId },
        }),
      ).toBe(entriesBefore);
    } finally {
      // She is at the cap here, and the tests below put her into more rooms.
      await prisma.chat.deleteMany({ where: { id: { in: roomIds } } });
    }
  }, 60_000);

  it("refuses an add to one group when the last place went to another meanwhile", async () => {
    const filler = await fillToOnePlaceShort();
    const groupA = await makeGroup(nilsCookie, "Sista platsen A");
    const groupB = await makeGroup(nilsCookie, "Sista platsen B");
    const roomIds = [groupA, groupB, ...filler];

    try {
      // The other press takes the last place, in a different group.
      const response = await addWhileLockHeld(groupA, async (tx) => {
        await tx.chatGroupMember.create({
          data: {
            chatId: groupB,
            personId: astrid.personId,
            addedByPersonId: stranger.personId,
          },
        });
      });
      expect(response?.statusCode).toBe(422);
      expect(response?.json<{ reason: string }>().reason).toBe(
        "too-many-groups",
      );
      expect(
        await prisma.chatGroupMember.count({
          where: { personId: astrid.personId, chat: { kind: "GROUP" } },
        }),
      ).toBe(GROUPS_PER_PERSON);
      expect(
        await prisma.chatGroupMember.count({
          where: { chatId: groupA, personId: astrid.personId },
        }),
      ).toBe(0);
    } finally {
      await prisma.chat.deleteMany({ where: { id: { in: roomIds } } });
    }
  }, 60_000);
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
    /*
     * Opened and marked read without anything being written in it, which is
     * the state that leaves a read marker behind on an otherwise empty room.
     * The sweep used to delete these by hand; now the room's own foreign key
     * cascades them, and this is the only place that can be shown.
     */
    const marked = await inject({
      method: "POST",
      url: `/api/chat/${chatId}/read`,
      headers: { cookie: nilsCookie },
      payload: { readAt: new Date("2024-01-02T00:00:00.000Z").toISOString() },
    });
    expect(marked.statusCode).toBe(200);
    expect(await prisma.chatRead.count({ where: { chatId } })).toBe(1);

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
    expect(await prisma.chatRead.count({ where: { chatId } })).toBe(0);
  });

  it("leaves a group somebody made this morning alone", async () => {
    const chatId = await makeGroup(nilsCookie, "Ny grupp");

    await purge.run(new Date("2026-09-18T03:59:00.000Z"));

    expect(await prisma.chat.count({ where: { id: chatId } })).toBe(1);
  });
});
