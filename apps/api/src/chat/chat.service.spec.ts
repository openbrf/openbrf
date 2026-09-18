import { describe, expect, it, vi } from "vitest";

import type { Capability, Principal } from "../authorization/capabilities";
import type { PrismaService } from "../database/prisma.service";
import { ChatError } from "./chat.error";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  ChatService,
  MESSAGES_PER_PAGE,
  MESSAGES_PER_WRITE_WINDOW,
  WRITE_WINDOW_MINUTES,
  chatCursor,
  parseChatCursor,
  refusePersonalIdentityNumbers,
} from "./chat.service";

/**
 * The rules the chat lives under, decided before any row is written.
 *
 * Every one of them is a rule a database cannot be asked about.
 *
 * **Membership is the security boundary, and it is derived.** A person holding
 * the capability and no board seat is in no room, a seat that ended takes the
 * room away on the next call, and a seat ending in the future keeps it - the
 * half of the predicate that a clause testing only for a null end date would
 * drop, and the half that costs somebody elected last week their seat in the
 * room. Asserted against the clock the call takes rather than against a stored
 * flag, because that is what the service actually asks.
 *
 * **One refusal for two cases.** A room that does not exist and a room this
 * person is not in answer identically, down to the reason code, or the
 * identifier space can be walked to learn what rooms the association has. The
 * GROUP kind is refused the same way, which is what makes the value safe to have
 * shipped in the enum before anything answers it.
 *
 * **A page is cut from the newest end and a cursor survives the row it names.**
 * Asserted by walking a whole room backwards and insisting every message came
 * back exactly once - including the case where every message shares an instant,
 * which is the case a cursor on the instant alone gets wrong - and then by
 * deleting the row a cursor points at and reading the next page anyway.
 *
 * **The poll is the mirror of the page and is bounded.** A screen closed for a
 * week must not ask for a week of messages in one response, so the answer
 * carries a page, a cursor and the flag that says to ask again at once.
 *
 * **The write budget is per person and counted from the table.** The window it
 * asks for is asserted, not only the refusal, because a count over the wrong
 * window refuses and permits exactly when a correct one would in a fixture of
 * one.
 *
 * **The personal identity number scan names positions and never the value.**
 * What the scan caught is exactly what must not travel back into a response
 * body, a log, or a screen somebody else is looking at.
 *
 * **The read marker never moves backwards**, so two tabs cannot un-read each
 * other, and a person's own messages are never unread to them.
 *
 * What the database itself does with these rows is `chat.int-spec.ts`.
 */

/**
 * Shaped like a personal identity number, valid by its checksum, and belonging
 * to nobody. It has to pass the checksum or the guardrail would have nothing to
 * refuse.
 */
const LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER = "19811218-9876";

const BOARD_CHAT_ID = "chat-board";
const NOW = new Date("2026-09-17T09:00:00.000Z");

interface ChatFixture {
  id: string;
  kind: "BOARD" | "GROUP";
  name: string | null;
}

interface MessageFixture {
  id: string;
  chatId: string;
  authorPersonId: string;
  body: string;
  createdAt: Date;
}

interface PersonFixture {
  id: string;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
  /**
   * When this person's board term ended, or null while they still hold it.
   *
   * `undefined` is somebody who has never been on the board at all, which is a
   * third case rather than a spelling of the second: a person with no row is who
   * the membership query has to answer "no" for.
   */
  seatEndedOn?: Date | null;
}

/** How the service orders a room: by instant, with the identifier as the tie. */
type MessageOrderBy = { createdAt: "asc" | "desc" } | { id: "asc" | "desc" };

/**
 * The keyset the service compares a cursor with, as the query carries it.
 *
 * Two branches: everything on one side of the instant, and everything in that
 * instant whose identifier sorts the same way. The second is the whole reason
 * the type is written out here rather than left as unknown - a fake that dropped
 * it would answer the tie either way and a test about the tie could not fail.
 */
type MessageKeyset = [
  { createdAt: { lt: Date } | { gt: Date } },
  { createdAt: Date; id: { lt: string } | { gt: string } },
];

interface MessageWhere {
  chatId?: string;
  authorPersonId?: string | { not: string };
  createdAt?: { gte?: Date; gt?: Date };
  OR?: MessageKeyset;
}

/** Whether a row is on the side of the cursor the keyset asked for. */
function matchesKeyset(
  row: MessageFixture,
  keyset: MessageKeyset | undefined,
): boolean {
  if (keyset === undefined) {
    return true;
  }
  const [byInstant, byIdentifier] = keyset;
  const instant = row.createdAt.getTime();

  if ("lt" in byInstant.createdAt) {
    const boundary = byInstant.createdAt.lt.getTime();
    const tie = byIdentifier.id as { lt: string };
    return (
      instant < boundary ||
      (instant === byIdentifier.createdAt.getTime() && row.id < tie.lt)
    );
  }
  const boundary = byInstant.createdAt.gt.getTime();
  const tie = byIdentifier.id as { gt: string };
  return (
    instant > boundary ||
    (instant === byIdentifier.createdAt.getTime() && row.id > tie.gt)
  );
}

function matchesWhere(row: MessageFixture, where: MessageWhere): boolean {
  if (where.chatId !== undefined && row.chatId !== where.chatId) {
    return false;
  }
  if (typeof where.authorPersonId === "string") {
    if (row.authorPersonId !== where.authorPersonId) {
      return false;
    }
  } else if (
    where.authorPersonId !== undefined &&
    row.authorPersonId === where.authorPersonId.not
  ) {
    return false;
  }
  if (
    where.createdAt?.gte !== undefined &&
    row.createdAt.getTime() < where.createdAt.gte.getTime()
  ) {
    return false;
  }
  if (
    where.createdAt?.gt !== undefined &&
    row.createdAt.getTime() <= where.createdAt.gt.getTime()
  ) {
    return false;
  }
  return matchesKeyset(row, where.OR);
}

/** The comparator the query asked for, term by term. */
function byOrder(orderBy: readonly MessageOrderBy[]) {
  return (a: MessageFixture, b: MessageFixture): number => {
    for (const term of orderBy) {
      const ascending =
        ("createdAt" in term ? term.createdAt : term.id) === "asc";
      const difference =
        "createdAt" in term
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0;
      if (difference !== 0) {
        return ascending ? difference : -difference;
      }
    }
    return 0;
  };
}

/** The seat clause as the service spells it, read back out of the query. */
interface SeatWhere {
  id?: string;
  boardPositions?: {
    some: { OR: [{ endedOn: null }, { endedOn: { gt: Date } }] };
  };
}

/**
 * Whether this person's seat satisfies the clause, at the clock it carries.
 *
 * Implemented rather than stubbed, because the two halves of the predicate are
 * exactly what the tests below are about: a service asking only for a null end
 * date would pass every assertion a stub made true.
 */
function holdsSeat(person: PersonFixture, where: SeatWhere): boolean {
  if (where.boardPositions === undefined) {
    return true;
  }
  if (person.seatEndedOn === undefined) {
    return false;
  }
  const [never, future] = where.boardPositions.some.OR;
  void never;
  return (
    person.seatEndedOn === null ||
    person.seatEndedOn.getTime() > future.endedOn.gt.getTime()
  );
}

function principal(personId: string, capabilities: Capability[]): Principal {
  return {
    personId,
    capabilities: new Set(capabilities),
    isAdmin: false,
    isBoardMember: false,
    isPropertyManager: false,
    isResident: true,
    isMember: true,
  };
}

/**
 * A database holding these rooms, messages, people and read markers.
 *
 * Every query is implemented rather than stubbed with an answer, because what is
 * under test is what the service asks of it. A `count` that ignored its `where`
 * would let the budget test pass whatever window the service asked for, and a
 * `findMany` that ignored its `chatId` would let a read return another room's
 * messages and still look right.
 */
function build(options: {
  chats?: ChatFixture[];
  messages?: MessageFixture[];
  persons?: PersonFixture[];
  reads?: { chatId: string; personId: string; readAt: Date }[];
}) {
  const chats = [...(options.chats ?? [])];
  const messages = [...(options.messages ?? [])];
  const persons = options.persons ?? [];
  const reads = [...(options.reads ?? [])];

  const chatCreate = vi.fn(
    async (args: { data: { kind: "BOARD" | "GROUP" } }) => {
      if (
        args.data.kind === "BOARD" &&
        chats.some((chat) => chat.kind === "BOARD")
      ) {
        // The partial unique index, stated in the fake: a second board chat is
        // the one insert this table refuses.
        throw new Error("duplicate key value violates unique constraint");
      }
      const row: ChatFixture = {
        id: `chat-${String(chats.length + 1)}`,
        kind: args.data.kind,
        name: null,
      };
      chats.push(row);
      return row;
    },
  );

  const messageCreate = vi.fn(
    async (args: {
      data: { chatId: string; authorPersonId: string; body: string };
    }) => {
      const row: MessageFixture = {
        id: `message-${String(messages.length + 1)}`,
        chatId: args.data.chatId,
        authorPersonId: args.data.authorPersonId,
        body: args.data.body,
        createdAt: NOW,
      };
      messages.push(row);
      return row;
    },
  );

  const messageCount = vi.fn(async (args: { where: MessageWhere }) => {
    return messages.filter((row) => matchesWhere(row, args.where)).length;
  });

  const prisma = {
    chat: {
      findFirst: vi.fn(
        async (args: { where: { kind: "BOARD" | "GROUP" } }) =>
          chats.find((chat) => chat.kind === args.where.kind) ?? null,
      ),
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          chats.find((chat) => chat.id === args.where.id) ?? null,
      ),
      create: chatCreate,
    },
    chatMessage: {
      findMany: vi.fn(
        async (args: {
          where: MessageWhere;
          orderBy: readonly MessageOrderBy[];
          take?: number;
        }) => {
          const rows = messages
            .filter((row) => matchesWhere(row, args.where))
            .sort(byOrder(args.orderBy));
          return args.take === undefined ? rows : rows.slice(0, args.take);
        },
      ),
      findFirst: vi.fn(
        async (args: {
          where: MessageWhere;
          orderBy: readonly MessageOrderBy[];
        }) =>
          messages
            .filter((row) => matchesWhere(row, args.where))
            .sort(byOrder(args.orderBy))[0] ?? null,
      ),
      count: messageCount,
      create: messageCreate,
    },
    chatRead: {
      findUnique: vi.fn(
        async (args: {
          where: { chatId_personId: { chatId: string; personId: string } };
        }) =>
          reads.find(
            (row) =>
              row.chatId === args.where.chatId_personId.chatId &&
              row.personId === args.where.chatId_personId.personId,
          ) ?? null,
      ),
    },
    person: {
      findFirst: vi.fn(
        async (args: { where: SeatWhere }) =>
          persons.find(
            (person) =>
              person.id === args.where.id && holdsSeat(person, args.where),
          ) ?? null,
      ),
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        persons.filter((person) => args.where.id.in.includes(person.id)),
      ),
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          persons.find((person) => person.id === args.where.id) ?? null,
      ),
    },
    /*
     * The upsert that never moves the marker backwards, which is one statement
     * in SQL and so is one statement here: the comparison is the whole of what
     * the test is about, and a fake that merely recorded the call would let a
     * service overwriting the row unconditionally pass.
     */
    $executeRaw: vi.fn(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const [chatId, personId, readAt] = values as [string, string, Date];
        const standing = reads.find(
          (row) => row.chatId === chatId && row.personId === personId,
        );
        if (standing === undefined) {
          reads.push({ chatId, personId, readAt });
          return 1;
        }
        if (readAt.getTime() > standing.readAt.getTime()) {
          standing.readAt = readAt;
        }
        return 1;
      },
    ),
  };

  return {
    service: new ChatService(prisma as unknown as PrismaService),
    prisma,
    chats,
    messages,
    reads,
    messageCount,
    messageCreate,
  };
}

/** The one room every test but the membership ones starts from. */
const BOARD_CHAT: ChatFixture = {
  id: BOARD_CHAT_ID,
  kind: "BOARD",
  name: null,
};

const SEATED: PersonFixture = {
  id: "person-astrid",
  firstName: "Astrid",
  lastName: "Lindqvist",
  protectedPersonalData: false,
  seatEndedOn: null,
};

const NO_SEAT: PersonFixture = {
  id: "person-nils",
  firstName: "Nils",
  lastName: "Lindqvist",
  protectedPersonalData: false,
};

/** A room with `count` messages, one an hour, oldest first. */
function messagesOverHours(count: number, authorPersonId: string) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${String(index + 1).padStart(3, "0")}`,
    chatId: BOARD_CHAT_ID,
    authorPersonId,
    body: `Rad ${String(index + 1)}.`,
    createdAt: new Date(Date.UTC(2026, 0, 1, index)),
  }));
}

describe("who is in the room", () => {
  it("offers the board chat to somebody holding a seat", async () => {
    const { service } = build({ chats: [BOARD_CHAT], persons: [SEATED] });

    const rooms = await service.rooms(
      principal(SEATED.id, ["chat:participate"]),
    );

    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.id).toBe(BOARD_CHAT_ID);
    expect(rooms[0]?.kind).toBe("BOARD");
  });

  it("offers nothing to somebody holding the capability and no seat", async () => {
    /*
     * The administrator's case, and the one the screen has to put into words.
     * They hold every capability and no seat, so they reach the endpoint and
     * find no room - which is an answer rather than a fault.
     */
    const { service } = build({ chats: [BOARD_CHAT], persons: [NO_SEAT] });

    expect(
      await service.rooms(principal(NO_SEAT.id, ["chat:participate"])),
    ).toEqual([]);
  });

  it("creates the board chat on the first read by somebody holding a seat", async () => {
    const { service, chats } = build({ persons: [SEATED] });

    const rooms = await service.rooms(
      principal(SEATED.id, ["chat:participate"]),
    );

    expect(chats).toHaveLength(1);
    expect(chats[0]?.kind).toBe("BOARD");
    expect(rooms[0]?.id).toBe(chats[0]?.id);
  });

  it("does not create a room for somebody who could not read it", async () => {
    const { service, chats, prisma } = build({ persons: [NO_SEAT] });

    await service.rooms(principal(NO_SEAT.id, ["chat:participate"]));

    expect(chats).toEqual([]);
    expect(prisma.chat.create).not.toHaveBeenCalled();
  });

  it("keeps the room for a term that ends in the future", async () => {
    /*
     * A board can minute in April that a term runs to the annual meeting, and
     * that person is on the board until the date arrives. A membership clause
     * testing only for a null end date would throw them out of the room the day
     * the minute was written.
     */
    const { service } = build({
      chats: [BOARD_CHAT],
      persons: [{ ...SEATED, seatEndedOn: new Date("2027-05-01T00:00:00Z") }],
    });

    expect(
      await service.rooms(principal(SEATED.id, ["chat:participate"])),
    ).toHaveLength(1);
  });

  it("takes the room away on the next call after the term has ended", async () => {
    const { service } = build({
      chats: [BOARD_CHAT],
      persons: [{ ...SEATED, seatEndedOn: new Date("2026-05-01T00:00:00Z") }],
    });

    expect(
      await service.rooms(principal(SEATED.id, ["chat:participate"])),
    ).toEqual([]);
  });
});

describe("the one refusal", () => {
  it("answers a room this person is not in exactly as one that does not exist", async () => {
    const { service } = build({
      chats: [BOARD_CHAT],
      persons: [SEATED, NO_SEAT],
    });
    const stranger = principal(NO_SEAT.id, ["chat:participate"]);

    const notIn = await service
      .readChat(BOARD_CHAT_ID, stranger)
      .catch((error: unknown) => error);
    const notThere = await service
      .readChat("chat-nothing", stranger)
      .catch((error: unknown) => error);

    expect(notIn).toBeInstanceOf(ChatError);
    expect(notThere).toBeInstanceOf(ChatError);
    expect((notIn as ChatError).reason).toBe("chat-not-found");
    expect((notThere as ChatError).reason).toBe((notIn as ChatError).reason);
    expect((notThere as ChatError).status).toBe((notIn as ChatError).status);
  });

  it("refuses a room of the kind nothing answers yet, as one that does not exist", async () => {
    /*
     * The GROUP value ships in the enum so that adding groups is not a
     * migration over live rows. Until a service answers it, a row of that kind
     * is refused exactly as a row that is not there - which is what makes
     * shipping the value safe rather than merely early.
     */
    const { service } = build({
      chats: [BOARD_CHAT, { id: "chat-group", kind: "GROUP", name: "Gården" }],
      persons: [SEATED],
    });

    await expect(
      service.readChat(
        "chat-group",
        principal(SEATED.id, ["chat:participate"]),
      ),
    ).rejects.toMatchObject({ reason: "chat-not-found" });
  });

  it("refuses the write with the same answer", async () => {
    const { service, messageCreate } = build({
      chats: [BOARD_CHAT],
      persons: [NO_SEAT],
    });

    await expect(
      service.write({
        chatId: BOARD_CHAT_ID,
        authorPersonId: NO_SEAT.id,
        body: "Hej.",
      }),
    ).rejects.toMatchObject({ reason: "chat-not-found" });
    // And nothing was written: a service that refused with the right code after
    // having inserted the row would satisfy a test that only read the error.
    expect(messageCreate).not.toHaveBeenCalled();
  });
});

describe("reading a room", () => {
  it("answers the newest page, oldest first inside it", async () => {
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: messagesOverHours(MESSAGES_PER_PAGE + 10, SEATED.id),
      persons: [SEATED],
    });

    const page = await service.readChat(
      BOARD_CHAT_ID,
      principal(SEATED.id, ["chat:participate"]),
    );

    expect(page.messages).toHaveLength(MESSAGES_PER_PAGE);
    // The newest end: the last message written is the last one on the page.
    expect(page.messages.at(-1)?.body).toBe(
      `Rad ${String(MESSAGES_PER_PAGE + 10)}.`,
    );
    expect(page.messages[0]?.body).toBe("Rad 11.");
    expect(page.earlier).not.toBeNull();
    expect(page.latest).not.toBeNull();
  });

  it("says there is nothing earlier when the room fits on one page", async () => {
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: messagesOverHours(3, SEATED.id),
      persons: [SEATED],
    });

    const page = await service.readChat(
      BOARD_CHAT_ID,
      principal(SEATED.id, ["chat:participate"]),
    );

    // Null is the whole of the answer to "is there more", so a reader is never
    // left inferring it from a page that came back short.
    expect(page.earlier).toBeNull();
    expect(page.messages).toHaveLength(3);
  });

  it("walks a whole room backwards, showing every message exactly once", async () => {
    const total = MESSAGES_PER_PAGE * 2 + 7;
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: messagesOverHours(total, SEATED.id),
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);

    const seen: string[] = [];
    let cursor = null as string | null;
    for (;;) {
      const page: Awaited<ReturnType<typeof service.readChat>> =
        await service.readChat(
          BOARD_CHAT_ID,
          reader,
          cursor === null ? null : parseChatCursor(cursor),
        );
      seen.unshift(...page.messages.map((message) => message.id));
      if (page.earlier === null) {
        break;
      }
      cursor = page.earlier;
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("walks a room whose messages all share one instant", async () => {
    /*
     * The case a cursor on the instant alone gets wrong. The column keeps
     * milliseconds and its default is the transaction's own clock, so rows
     * written together carry the same instant exactly - and the boundary then
     * falls between two of them in whichever order the database answered.
     */
    const instant = new Date("2026-03-01T10:00:00.000Z");
    const total = MESSAGES_PER_PAGE + 5;
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: Array.from({ length: total }, (_, index) => ({
        id: `message-${String(index + 1).padStart(3, "0")}`,
        chatId: BOARD_CHAT_ID,
        authorPersonId: SEATED.id,
        body: `Rad ${String(index + 1)}.`,
        createdAt: instant,
      })),
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);

    const first = await service.readChat(BOARD_CHAT_ID, reader);
    const second = await service.readChat(
      BOARD_CHAT_ID,
      reader,
      parseChatCursor(first.earlier ?? ""),
    );

    const seen = [
      ...second.messages.map((message) => message.id),
      ...first.messages.map((message) => message.id),
    ];
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("pages past a message purged out from under the reader", async () => {
    /*
     * The whole reason the comparison is written out rather than handed to the
     * query builder's own cursor option. That one names a row and reads the
     * boundary values back out of it; a room is erased on its own clock a year
     * at a time, so between one page and the next the row can be gone - and a
     * cursor whose row has gone matches nothing at all.
     */
    const { service, messages } = build({
      chats: [BOARD_CHAT],
      messages: messagesOverHours(MESSAGES_PER_PAGE + 4, SEATED.id),
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);

    const first = await service.readChat(BOARD_CHAT_ID, reader);
    const boundary = parseChatCursor(first.earlier ?? "");
    // The purge reaches the row the cursor names between the two reads.
    const index = messages.findIndex((row) => row.id === boundary?.id);
    messages.splice(index, 1);

    const second = await service.readChat(BOARD_CHAT_ID, reader, boundary);

    // The four older than the boundary, all of them, although the row the
    // cursor was taken from is no longer there to be read back.
    expect(second.messages).toHaveLength(4);
    expect(second.messages.map((message) => message.id)).not.toContain(
      boundary?.id,
    );
    expect(second.earlier).toBeNull();
  });

  it("attributes a message whose author the register no longer holds", async () => {
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: [
        {
          id: "message-1",
          chatId: BOARD_CHAT_ID,
          authorPersonId: "person-erased",
          body: "Skrivet av nagon som ar borta.",
          createdAt: NOW,
        },
      ],
      persons: [SEATED],
    });

    const page = await service.readChat(
      BOARD_CHAT_ID,
      principal(SEATED.id, ["chat:participate"]),
    );

    // The room says "we no longer know" rather than showing an empty name or
    // breaking: a message is service tier and a person can be purged out from
    // under one.
    expect(page.messages[0]?.author).toEqual({ kind: "unknown" });
    expect(page.messages[0]?.body).toBe("Skrivet av nagon som ar borta.");
  });

  it("names nobody with protected personal data, the board included", async () => {
    /*
     * Withheld from every reader of the room although every one of them holds
     * `protectedData:reveal` with their seat. That capability is what lets
     * somebody perform an act of revealing and be recorded doing it; a name
     * that simply appeared in a payload nothing audits is not that act, and the
     * association's own record of processing says these people are masked
     * everywhere.
     */
    const protectedColleague: PersonFixture = {
      id: "person-skyddad",
      firstName: "Elisabet",
      lastName: "Rydberg",
      protectedPersonalData: true,
      seatEndedOn: null,
    };
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: [
        {
          id: "message-1",
          chatId: BOARD_CHAT_ID,
          authorPersonId: protectedColleague.id,
          body: "Jag tar offerten.",
          createdAt: NOW,
        },
      ],
      persons: [SEATED, protectedColleague],
    });

    const page = await service.readChat(
      BOARD_CHAT_ID,
      principal(SEATED.id, ["chat:participate", "protectedData:reveal"]),
    );

    expect(page.messages[0]?.author).toEqual({
      kind: "protected",
      personId: protectedColleague.id,
    });
    // The words stay: what is withheld is the attribution and never the line.
    expect(page.messages[0]?.body).toBe("Jag tar offerten.");
  });
});

describe("the poll", () => {
  it("answers only what was written after the cursor", async () => {
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: messagesOverHours(5, SEATED.id),
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);

    const page = await service.readChat(BOARD_CHAT_ID, reader);
    const update = await service.messagesSince(
      BOARD_CHAT_ID,
      reader,
      parseChatCursor(page.latest ?? "") ?? { createdAt: NOW, id: "" },
    );

    expect(update.messages).toEqual([]);
    expect(update.more).toBe(false);
    // The cursor handed in comes back, so a screen polling an idle room keeps
    // its place rather than restarting from the beginning of the room.
    expect(update.cursor).toBe(page.latest);
  });

  it("brings in what somebody else wrote, oldest first", async () => {
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: messagesOverHours(2, SEATED.id),
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);
    const page = await service.readChat(BOARD_CHAT_ID, reader);

    await service.write({
      chatId: BOARD_CHAT_ID,
      authorPersonId: SEATED.id,
      body: "Nagot nytt.",
    });

    const update = await service.messagesSince(
      BOARD_CHAT_ID,
      reader,
      parseChatCursor(page.latest ?? "") ?? { createdAt: NOW, id: "" },
    );

    expect(update.messages.map((message) => message.body)).toEqual([
      "Nagot nytt.",
    ]);
    expect(update.cursor).not.toBe(page.latest);
  });

  it("bounds a screen that has been closed for a week", async () => {
    /*
     * A cursor read that is not bounded is an outage. The answer is a page, a
     * cursor and the flag that says to ask again at once, so catching up is
     * several small reads rather than one that times out.
     */
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: messagesOverHours(MESSAGES_PER_PAGE * 2, SEATED.id),
      persons: [SEATED],
    });

    const update = await service.messagesSince(
      BOARD_CHAT_ID,
      principal(SEATED.id, ["chat:participate"]),
      { createdAt: new Date(Date.UTC(2025, 0, 1)), id: "" },
    );

    expect(update.messages).toHaveLength(MESSAGES_PER_PAGE);
    expect(update.more).toBe(true);
  });
});

describe("writing", () => {
  it("refuses the message past the window budget, counted over the window", async () => {
    const { service, messageCount } = build({
      chats: [BOARD_CHAT],
      messages: Array.from(
        { length: MESSAGES_PER_WRITE_WINDOW },
        (_, index) => ({
          id: `message-${String(index)}`,
          chatId: BOARD_CHAT_ID,
          authorPersonId: SEATED.id,
          body: "Rad.",
          createdAt: new Date(),
        }),
      ),
      persons: [SEATED],
    });

    await expect(
      service.write({
        chatId: BOARD_CHAT_ID,
        authorPersonId: SEATED.id,
        body: "En till.",
      }),
    ).rejects.toMatchObject({ reason: "too-many-messages" });

    /*
     * The window it asked for, and not only that it refused. A count over the
     * wrong window refuses and permits exactly when a correct one would in a
     * fixture of one.
     */
    const asked = messageCount.mock.calls.at(-1)?.[0].where;
    expect(asked?.authorPersonId).toBe(SEATED.id);
    const since = asked?.createdAt?.gte;
    expect(since).toBeInstanceOf(Date);
    expect(Date.now() - (since as Date).getTime()).toBeCloseTo(
      WRITE_WINDOW_MINUTES * 60 * 1000,
      -3,
    );
  });

  it("counts only this person's messages against the budget", async () => {
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: Array.from(
        { length: MESSAGES_PER_WRITE_WINDOW },
        (_, index) => ({
          id: `message-${String(index)}`,
          chatId: BOARD_CHAT_ID,
          authorPersonId: "person-somebody-else",
          body: "Rad.",
          createdAt: new Date(),
        }),
      ),
      persons: [SEATED],
    });

    await expect(
      service.write({
        chatId: BOARD_CHAT_ID,
        authorPersonId: SEATED.id,
        body: "Min forsta.",
      }),
    ).resolves.toMatchObject({ body: "Min forsta." });
  });

  it("refuses a personal identity number, naming the offset and never the digits", async () => {
    const { service, messageCreate } = build({
      chats: [BOARD_CHAT],
      persons: [SEATED],
    });
    const body = `Det ar ${LOOKS_LIKE_A_PERSONAL_IDENTITY_NUMBER} som star i registret.`;

    const error = await service
      .write({ chatId: BOARD_CHAT_ID, authorPersonId: SEATED.id, body })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ChatError);
    expect((error as ChatError).reason).toBe("personal-identity-number");
    const details = (error as ChatError).details();
    expect(details.locations).toEqual([
      { part: "body", offset: body.indexOf("19811218") },
    ]);
    /*
     * The value is exactly what must not travel back. Asserted over the whole
     * serialised refusal rather than over the locations alone, because the
     * message and the details are both answered to the caller.
     */
    expect(
      JSON.stringify({ ...details, message: (error as Error).message }),
    ).not.toContain("19811218");
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("attributes the written message to its author", async () => {
    const { service } = build({ chats: [BOARD_CHAT], persons: [SEATED] });

    const written = await service.write({
      chatId: BOARD_CHAT_ID,
      authorPersonId: SEATED.id,
      body: "Taket ar klart.",
    });

    expect(written.author).toEqual({
      kind: "person",
      personId: SEATED.id,
      name: "Astrid Lindqvist",
    });
    expect(written.body).toBe("Taket ar klart.");
  });
});

describe("the read marker", () => {
  it("counts what this person has not read, and never their own", async () => {
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: [
        ...messagesOverHours(3, "person-somebody-else"),
        {
          id: "message-own",
          chatId: BOARD_CHAT_ID,
          authorPersonId: SEATED.id,
          body: "Min egen.",
          createdAt: new Date(Date.UTC(2026, 0, 1, 9)),
        },
      ],
      persons: [SEATED],
    });

    const rooms = await service.rooms(
      principal(SEATED.id, ["chat:participate"]),
    );

    // Somebody who has just written a line does not have an unread one.
    expect(rooms[0]?.unread).toBe(3);
    expect(rooms[0]?.lastMessageAt).toBe(
      new Date(Date.UTC(2026, 0, 1, 9)).toISOString(),
    );
  });

  it("counts only what arrived after the marker", async () => {
    const { service } = build({
      chats: [BOARD_CHAT],
      messages: messagesOverHours(4, "person-somebody-else"),
      persons: [SEATED],
      reads: [
        {
          chatId: BOARD_CHAT_ID,
          personId: SEATED.id,
          readAt: new Date(Date.UTC(2026, 0, 1, 1)),
        },
      ],
    });

    const rooms = await service.rooms(
      principal(SEATED.id, ["chat:participate"]),
    );

    expect(rooms[0]?.unread).toBe(2);
  });

  it("never moves backwards", async () => {
    /*
     * Two tabs open on one room would otherwise un-read each other, and a
     * marker that went backwards would announce messages the person had already
     * read.
     */
    const later = new Date("2026-09-17T10:00:00.000Z");
    const earlier = new Date("2026-09-17T08:00:00.000Z");
    const { service, reads } = build({
      chats: [BOARD_CHAT],
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);

    await service.markRead(BOARD_CHAT_ID, reader, later);
    const answer = await service.markRead(BOARD_CHAT_ID, reader, earlier);

    expect(reads[0]?.readAt).toEqual(later);
    // And the loser is told the marker that actually stands rather than the
    // instant it sent.
    expect(answer.readAt).toBe(later.toISOString());
  });

  it("never marks further ahead than the server's own clock", async () => {
    /*
     * The marker is forward-only, which is what makes an instant from the future
     * a one-way door: a device with a wrong clock, or a request somebody
     * composed, would set a marker no later call could lower, and from then on
     * every message counts as read for that person - including ones written
     * afterwards. Nothing moves a marker backwards, so there is no repair.
     *
     * Capped at the server's clock instead. A marker can only ever say somebody
     * has read as far as something that already exists.
     */
    const { service, reads } = build({
      chats: [BOARD_CHAT],
      persons: [SEATED],
    });
    const reader = principal(SEATED.id, ["chat:participate"]);
    const wellPastNow = new Date(Date.now() + 60 * 60 * 1000);

    const answer = await service.markRead(BOARD_CHAT_ID, reader, wellPastNow);

    const marked = reads[0]?.readAt;
    expect(marked).toBeInstanceOf(Date);
    expect((marked as Date).getTime()).toBeLessThan(wellPastNow.getTime());
    expect(answer.readAt).toBe((marked as Date).toISOString());

    // And the room is not silently all-read from now on: a message written
    // after the call is still counted.
    const rooms = await service.rooms(reader);
    expect(rooms[0]?.unread).toBe(0);
  });

  it("marks an instant in the past exactly as it was given", async () => {
    // The cap is a ceiling and not a rewrite: the ordinary case is the newest
    // message on screen, which is always already in the past.
    const { service, reads } = build({
      chats: [BOARD_CHAT],
      persons: [SEATED],
    });
    const shownAt = new Date(Date.now() - 5 * 60 * 1000);

    await service.markRead(
      BOARD_CHAT_ID,
      principal(SEATED.id, ["chat:participate"]),
      shownAt,
    );

    expect(reads[0]?.readAt).toEqual(shownAt);
  });

  it("is refused for a room this person is not in", async () => {
    const { service, reads } = build({
      chats: [BOARD_CHAT],
      persons: [NO_SEAT],
    });

    await expect(
      service.markRead(
        BOARD_CHAT_ID,
        principal(NO_SEAT.id, ["chat:participate"]),
        NOW,
      ),
    ).rejects.toMatchObject({ reason: "chat-not-found" });
    expect(reads).toEqual([]);
  });
});

describe("the cursor", () => {
  it("round-trips a message", () => {
    const row = { id: "message-1", createdAt: NOW };

    expect(parseChatCursor(chatCursor(row))).toEqual({
      createdAt: NOW,
      id: "message-1",
    });
  });

  it.each([
    ["", "empty"],
    ["not-a-cursor", "one half"],
    ["2026-09-17T09:00:00.000Z|message|extra", "a second separator"],
    ["|message-1", "no instant"],
    ["2026-09-17T09:00:00.000Z|", "no identifier"],
    ["2026-09-17|message-1", "a date rather than an instant"],
    ["not-an-instant|message-1", "a value that is not a moment"],
  ])("refuses %s (%s)", (value) => {
    /*
     * Null rather than a lenient reading, and the controller turns it into a
     * refusal. Answering the newest page to somebody who asked for an older one
     * would tell a reader the room ends where it does not.
     */
    expect(parseChatCursor(value)).toBeNull();
  });
});

describe("the guardrail on its own", () => {
  it("permits a message with no personal identity number in it", () => {
    expect(() =>
      refusePersonalIdentityNumbers("Vi far tre offerter pa taket."),
    ).not.toThrow();
  });

  it("permits a message at the cap", () => {
    expect(() =>
      refusePersonalIdentityNumbers("a".repeat(CHAT_MESSAGE_MAX_LENGTH)),
    ).not.toThrow();
  });
});
