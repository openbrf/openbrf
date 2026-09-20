import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import { ChatPurgeService } from "./chat-purge.service";

/**
 * The things about the chat purge that are decided before any row is touched,
 * and that a database cannot be asked about.
 *
 * Which people a run selects, which is what decides whether every expired
 * message is eventually reached or some are reached never. The bound on a run
 * exists so the first run on a long-lived instance cannot erase a decade in one
 * loop, and it is applied by the database - so anybody excluded after the query
 * has already spent it. Held people excluded afterwards would fill run after run
 * with work that cannot be done, and the messages behind them would outlive
 * their retention window with nothing reporting a fault. That is the failure a
 * count in a summary looks fine through, which is why it is asserted here.
 *
 * That the hold is read under the lock rather than beside it. Both are ordinary
 * awaits on the transaction client, so nothing about the source says which came
 * first; the order is the whole of the guarantee, and the only way to state it
 * is to record the calls and read them back.
 *
 * And what the audit entry may carry. This is the only entry the chat writes at
 * all - writing a message writes none - so it is the log's whole account of a
 * room, and it must name the person and the count and not a word of what was
 * said: the table is append-only and exempt from every purge, so text copied in
 * here would outlive the rows the entry says were erased.
 *
 * The window arithmetic is `chat-retention.spec.ts`, and what actually happens
 * to the rows is `chat.int-spec.ts`.
 */

const RETENTION_DAYS = 365;
const NOW = new Date("2027-06-01T03:59:00.000Z");

/**
 * A message body, as a database failure would quote it back.
 *
 * Stood in for a real one so the assertion that it does not reach the log has
 * something to look for.
 */
const REVEALING_BODY = "Vi bor saga upp vicevarden i 1202";

/** How many people one run may take, mirrored from the service. */
const MAX_PERSONS_PER_RUN = 500;

interface Message {
  authorPersonId: string;
  createdAt: Date;
}

/**
 * A database holding these messages and these open holds.
 *
 * `groupBy` is implemented rather than stubbed with an answer, because the
 * property under test is what the service asks of it: a fake that returned a
 * fixed list would pass whatever the query said. So this one honours the
 * `createdAt` filter, the `notIn` exclusion, the sort and the bound, which is
 * exactly the contract the real one is being relied on for.
 *
 * `deletedCount` is how many rows the delete reports. Configurable because zero
 * is a branch of its own and the one a database cannot be asked to produce on
 * demand: it is what the service sees when the last of somebody's messages went
 * between the scan and the transaction.
 */
function build(options: {
  messages: Message[];
  heldPersonIds?: string[];
  restrictedPersonIds?: string[];
  erasureRequestedPersonIds?: string[];
  deletedCount?: number;
  /**
   * The rooms this database holds.
   *
   * Of both kinds, and each with however many messages are in it, because the
   * sweep asks for exactly those two things beside the date: a fake holding only
   * empty groups would pass a sweep that had dropped either condition and taken
   * the board's chat or a room somebody is writing in.
   */
  rooms?: {
    id: string;
    kind: "BOARD" | "GROUP";
    createdAt: Date;
    messages?: number;
  }[];
  /** Write into this room the moment the sweep takes its lock. */
  writtenInOnLock?: string;
}) {
  const held = options.heldPersonIds ?? [];
  const restricted = options.restrictedPersonIds ?? [];
  const requested = options.erasureRequestedPersonIds ?? [];
  const withheld = [...new Set([...held, ...restricted])];
  const deletedCount = options.deletedCount ?? 2;
  const rooms = (options.rooms ?? []).map((room) => ({
    messages: 0,
    ...room,
  }));

  const groupBy = vi.fn(
    async (args: {
      where: {
        OR: (
          { createdAt: { lte: Date } } | { authorPersonId: { in: string[] } }
        )[];
        authorPersonId?: { notIn: string[] };
      };
      take: number;
    }) => {
      const excluded = new Set(args.where.authorPersonId?.notIn ?? []);

      /*
       * The OR is honoured rather than assumed, for the reason the whole fake
       * exists: a message is selected either because its own window has run out
       * or because the person was granted erasure, and a fake that only checked
       * the date would pass a service that had forgotten the second half.
       */
      const writtenBefore = args.where.OR.find(
        (clause): clause is { createdAt: { lte: Date } } =>
          "createdAt" in clause,
      )?.createdAt.lte;
      const requestedIds = new Set(
        args.where.OR.find(
          (clause): clause is { authorPersonId: { in: string[] } } =>
            "authorPersonId" in clause,
        )?.authorPersonId.in ?? [],
      );

      const ids = [
        ...new Set(
          options.messages
            .filter(
              (message) =>
                ((writtenBefore !== undefined &&
                  message.createdAt.getTime() <= writtenBefore.getTime()) ||
                  requestedIds.has(message.authorPersonId)) &&
                !excluded.has(message.authorPersonId),
            )
            .map((message) => message.authorPersonId),
        ),
      ]
        .sort()
        .slice(0, args.take);
      return ids.map((authorPersonId) => ({ authorPersonId }));
    },
  );

  /** Every call the transaction made, in the order it made them. */
  const calls: string[] = [];

  /** Every advisory lock key the sweep took, in order. */
  const locks: string[] = [];

  const tx = {
    $executeRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (String(values[0]).startsWith("chat:")) {
          calls.push("lockChat");
          locks.push(String(values[0]));
          /*
           * Somebody writing in the room while the sweep waited for the lock.
           * It is the only moment a room can stop being empty, because the
           * delete below re-reads it under the same key.
           */
          const written = rooms.find(
            (room) => room.id === options.writtenInOnLock,
          );
          if (written !== undefined) {
            written.messages += 1;
          }
          return 1;
        }
        void strings;
        calls.push("lock");
        return 1;
      },
    ),
    person: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        calls.push("readRestriction");
        return {
          processingRestrictedAt: restricted.includes(args.where.id)
            ? new Date("2027-05-01T00:00:00.000Z")
            : null,
        };
      }),
    },
    dataSubjectRequest: {
      findFirst: vi.fn(async (args: { where: { personId: string } }) => {
        calls.push("readRequest");
        return requested.includes(args.where.personId) ? { id: "req-1" } : null;
      }),
    },
    legalHold: {
      findFirst: vi.fn(async () => {
        calls.push("readHold");
        return held.length > 0 ? { id: "hold-1" } : null;
      }),
    },
    chatMessage: {
      deleteMany: vi.fn(async () => {
        calls.push("delete");
        return { count: deletedCount };
      }),
    },
    chatRead: {
      deleteMany: vi.fn(
        async (args: { where: { chatId: { in: string[] } } }) => {
          calls.push("deleteReadMarkers");
          return { count: args.where.chatId.in.length };
        },
      ),
    },
    chat: {
      /*
       * The delete repeats every condition the scan used, and so does this: the
       * lock above it is only worth taking if what the scan found is checked
       * again under it, and a fake that deleted by identifier alone would let
       * that re-check be dropped without a test noticing.
       */
      deleteMany: vi.fn(
        async (args: {
          where: {
            id: string;
            kind: "GROUP";
            createdAt: { lte: Date };
            messages: { none: object };
          };
        }) => {
          calls.push("deleteGroups");
          const index = rooms.findIndex(
            (room) =>
              room.id === args.where.id &&
              room.kind === args.where.kind &&
              room.messages === 0 &&
              args.where.messages.none !== undefined &&
              room.createdAt.getTime() <= args.where.createdAt.lte.getTime(),
          );
          if (index < 0) {
            return { count: 0 };
          }
          rooms.splice(index, 1);
          return { count: 1 };
        },
      ),
    },
  };

  const prisma = {
    chatMessage: { groupBy },
    /*
     * The sweep for a room that holds nothing. Implemented rather than stubbed,
     * because what it asks is the whole of the rule: a group made recently is
     * a room waiting to be written in, and only the cutoff tells the two apart.
     */
    chat: {
      findMany: vi.fn(
        async (args: {
          where: {
            kind: "GROUP";
            createdAt: { lte: Date };
            messages: { none: object };
          };
          take?: number;
        }) =>
          rooms
            .filter(
              (room) =>
                room.kind === args.where.kind &&
                // Answered from the rows rather than assumed: the sweep asks
                // for a room with no message in it, and a fake that ignored
                // that would answer with rooms people are writing in.
                (args.where.messages.none === undefined ||
                  room.messages === 0) &&
                room.createdAt.getTime() <= args.where.createdAt.lte.getTime(),
            )
            .slice(0, args.take)
            .map((room) => ({ id: room.id })),
      ),
    },
    person: {
      findMany: vi.fn(
        async (args: {
          where: { OR?: unknown[]; dataSubjectRequests?: unknown };
        }) =>
          // The two questions withheld-persons.ts asks, told apart by their
          // shape: one asks for a hold or a restriction, the other for a
          // granted erasure request.
          (args.where.dataSubjectRequests === undefined
            ? withheld
            : requested
          ).map((id) => ({ id })),
      ),
    },
    legalHold: {
      findMany: vi.fn(async () => held.map((personId) => ({ personId }))),
    },
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<number>) =>
      run(tx),
    ),
  };

  const audit = {
    record: vi.fn(
      async (_entry: {
        targetPersonId?: string | null;
        context?: Record<string, unknown>;
      }) => undefined,
    ),
  };

  return {
    service: new ChatPurgeService(
      { NODE_ENV: "test" } as Env,
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
      {} as JobQueueService,
    ),
    prisma,
    audit,
    calls,
    groupBy,
    rooms,
    locks,
    deleteMany: tx.chatMessage.deleteMany,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A person with one message written long enough ago to be erasable. */
function expiredMessageFor(authorPersonId: string): Message {
  return {
    authorPersonId,
    createdAt: new Date("2025-01-01T10:00:00.000Z"),
  };
}

describe("choosing who a run erases for", () => {
  it("leaves out the people a legal hold stands against", async () => {
    const { service } = build({
      messages: [expiredMessageFor("aa"), expiredMessageFor("bb")],
      heldPersonIds: ["aa"],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "bb",
    ]);
  });

  it("tells a hold, a restriction and a granted erasure apart", async () => {
    /*
     * The three arms of the scan in one run. A hold and a restriction withhold
     * the person however old their rows are; a granted erasure reaches them
     * however recent, because bringing the purge forward is what the board
     * granted. Asserted together because the query tells the three apart by
     * shape, and one of them silently answering for another is exactly what
     * would not show up in a test that exercised only two.
     */
    const { service } = build({
      messages: [
        expiredMessageFor("held"),
        expiredMessageFor("restricted"),
        // Written this morning, and erasable all the same.
        {
          authorPersonId: "requested",
          createdAt: new Date("2027-06-01T08:00:00.000Z"),
        },
      ],
      heldPersonIds: ["held"],
      restrictedPersonIds: ["restricted"],
      erasureRequestedPersonIds: ["requested"],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "requested",
    ]);
  });

  it("leaves out messages whose window has not run out", async () => {
    const { service } = build({
      messages: [
        expiredMessageFor("aa"),
        // Written the day before this run: a year short of erasable.
        {
          authorPersonId: "bb",
          createdAt: new Date("2027-05-31T10:00:00.000Z"),
        },
      ],
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "aa",
    ]);
  });

  it("reaches people behind a run's worth of held people", async () => {
    /*
     * The starvation case, and the reason the holds are excluded by the query
     * rather than dropped from its answer.
     *
     * The bound is applied by the database, so a person removed afterwards has
     * still spent one of the five hundred places. Fill every place with held
     * people sorting first and a run that filters afterwards selects five
     * hundred people it may not touch, erases nothing, and does exactly the
     * same thing every night the holds stand - while `zz`'s messages sit years
     * past the date this product told them they would be erased on.
     */
    const heldPersonIds = Array.from(
      { length: MAX_PERSONS_PER_RUN },
      (_unused, index) => `held-${String(index).padStart(4, "0")}`,
    );
    const { service } = build({
      messages: [
        ...heldPersonIds.map(expiredMessageFor),
        expiredMessageFor("zz"),
      ],
      heldPersonIds,
    });

    await expect(service.eligible(NOW, RETENTION_DAYS)).resolves.toEqual([
      "zz",
    ]);
  });

  it("asks for no exclusion when nobody is held", async () => {
    // An empty `notIn` is a condition whose meaning depends on how the client
    // renders a list of none, and this query decides what is erased.
    const { service, groupBy } = build({
      messages: [expiredMessageFor("aa")],
    });

    await service.eligible(NOW, RETENTION_DAYS);

    expect(groupBy.mock.calls[0]?.[0].where).not.toHaveProperty(
      "authorPersonId",
    );
  });
});

describe("erasing one person's messages", () => {
  it("takes the hold lock before it reads whether they are held", async () => {
    /*
     * Order, not presence. A lock taken after the read leaves the window it
     * exists to close wide open: a hold committing in between is invisible to
     * the read and the delete goes ahead, and the board member who placed it has
     * been told the person is held.
     */
    const { service, calls } = build({
      messages: [expiredMessageFor("aa")],
    });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    expect(calls).toEqual([
      "lock",
      "readHold",
      "readRestriction",
      "readRequest",
      "delete",
    ]);
  });

  it("erases nothing when a hold stands", async () => {
    const { service, calls, audit } = build({
      messages: [expiredMessageFor("aa")],
      heldPersonIds: ["aa"],
    });

    await expect(service.purgePerson("aa", NOW, RETENTION_DAYS)).resolves.toBe(
      0,
    );
    expect(calls).toEqual(["lock", "readHold", "readRestriction"]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("erases nothing when processing is restricted", async () => {
    // Art. 18(2): the association may store the data, which makes erasing it
    // the one act the person asked it not to perform.
    const { service, audit } = build({
      messages: [expiredMessageFor("aa")],
      restrictedPersonIds: ["aa"],
    });

    await expect(service.purgePerson("aa", NOW, RETENTION_DAYS)).resolves.toBe(
      0,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("records nothing when the rows went while the run was in flight", async () => {
    /*
     * A SERVICE_DATA_PURGED entry claims an erasure happened, the log is
     * append-only and exempt from every purge, so an entry for an erasure that
     * erased nothing is a false record nobody can correct - and a later access
     * report would repeat it to the person it is about.
     */
    const { service, audit } = build({
      messages: [expiredMessageFor("aa")],
      deletedCount: 0,
    });

    await expect(service.purgePerson("aa", NOW, RETENTION_DAYS)).resolves.toBe(
      0,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("names the person and the count, and nothing that was said", async () => {
    const { service, audit } = build({
      messages: [expiredMessageFor("aa")],
      deletedCount: 7,
    });

    await service.purgePerson("aa", NOW, RETENTION_DAYS);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = audit.record.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      targetPersonId: "aa",
      // Nobody clicked this: the job ran because a date arrived.
      actorPersonId: null,
      targetKind: "chatMessage",
      context: { chatMessages: 7, retentionDaysAfterMessage: RETENTION_DAYS },
    });
    // Not which room either: an identifier in a permanent table is a handle on
    // a conversation whose rows are gone.
    expect(JSON.stringify(entry)).not.toContain("chatId");
  });
});

describe("a whole run", () => {
  it("summarises a run over several people", async () => {
    /*
     * The aggregation, asserted here rather than in the integration suite. That
     * one shares a database with every other suite and the run is unscoped, so a
     * count over the whole table there reports another suite's fixture as this
     * purge's work. Here the fake is the whole world and the numbers mean what
     * they say.
     */
    const { service } = build({
      messages: [expiredMessageFor("aa"), expiredMessageFor("bb")],
    });

    await expect(service.run(NOW, RETENTION_DAYS)).resolves.toEqual({
      considered: 2,
      purged: 2,
      messagesDeleted: 4,
      failed: 0,
      groupsDeleted: 0,
    });
  });

  it("carries on past a person whose erasure fails, and names the failure only by its class", async () => {
    /*
     * Two properties of the same catch, and both are silent failures otherwise.
     *
     * One row the database refuses must not stop every person after it: the loop
     * runs person by person, so an unhandled throw would end the run at the
     * first one and everybody sorting later would keep their expired messages
     * until somebody read a log. The summary is what says the run went on.
     *
     * And what reaches the log is the class of the failure, not its message. A
     * constraint violation quotes the row it refused, and this row holds what
     * the board said to itself - so an exception message written out here would
     * put a chat message into a container log, which is outside the masking and
     * outside the audit log that governs every other read of it.
     */
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const { service, deleteMany } = build({
      messages: [expiredMessageFor("aa"), expiredMessageFor("bb")],
    });
    deleteMany.mockRejectedValueOnce(
      new Error(`duplicate key value violates ... (${REVEALING_BODY})`),
    );

    await expect(service.run(NOW, RETENTION_DAYS)).resolves.toEqual({
      considered: 2,
      purged: 1,
      messagesDeleted: 2,
      failed: 1,
      groupsDeleted: 0,
    });

    expect(logged).toHaveBeenCalledOnce();
    const line = String(logged.mock.calls[0]?.[0]);
    // The person id stays: it is the only handle on an erasure that did not
    // happen, and a failed transaction wrote no audit entry to carry it.
    expect(line).toContain("aa");
    expect(line).not.toContain(REVEALING_BODY);
  });
});

describe("a room that holds nothing", () => {
  const A_YEAR_AGO = new Date("2025-01-01T00:00:00.000Z");
  const LAST_WEEK = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);

  it("erases a group the clock has emptied, and leaves every other room", async () => {
    /*
     * The one thing in the chat with no clock of its own. A message carries its
     * own window, and a read marker and a report go with the message - but a
     * membership list says which neighbours were in a room together, and a room
     * whose last message the purge has already erased would go on saying that
     * forever.
     *
     * Three rooms it must not take, one for each condition the sweep asks: the
     * board's own chat, a group somebody is still writing in, and a group made
     * this week.
     */
    const { service, rooms, calls } = build({
      messages: [],
      rooms: [
        { id: "chat-old", kind: "GROUP", createdAt: A_YEAR_AGO },
        { id: "chat-board", kind: "BOARD", createdAt: A_YEAR_AGO },
        { id: "chat-busy", kind: "GROUP", createdAt: A_YEAR_AGO, messages: 1 },
        { id: "chat-new", kind: "GROUP", createdAt: LAST_WEEK },
      ],
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    expect(summary.groupsDeleted).toBe(1);
    expect(rooms.map((room) => room.id)).toEqual([
      "chat-board",
      "chat-busy",
      "chat-new",
    ]);
    /*
     * Not by hand any more: the marker cascades with the room. Asserting the
     * absence is what keeps the constraint load-bearing - a sweep that deleted
     * them here as well would go on passing with the foreign key dropped. That
     * the cascade does clear them is asserted against a real database in
     * chat-group.int-spec.ts, which is the only place it can be.
     */
    expect(calls).not.toContain("deleteReadMarkers");
  });

  it("takes the room's own lock before it decides the room is empty", async () => {
    /*
     * The key `ChatService.write` takes. A message committed between the scan
     * and the delete is erased by the cascade and its author told it was
     * stored, so the emptiness is decided again under this lock - which is only
     * worth anything if both sides spell the key the same way.
     */
    const { service, calls, locks } = build({
      messages: [],
      rooms: [{ id: "chat-old", kind: "GROUP", createdAt: A_YEAR_AGO }],
    });

    await service.run(NOW, RETENTION_DAYS);

    expect(locks).toEqual(["chat:chat-old"]);
    expect(calls.indexOf("lockChat")).toBeLessThan(
      calls.indexOf("deleteGroups"),
    );
  });

  it("counts what it actually erased, not what it selected", async () => {
    // The delete repeats every condition, so a room that stopped being empty
    // between the scan and the delete is left alone - and the run says so.
    const { service, rooms } = build({
      messages: [],
      rooms: [{ id: "chat-old", kind: "GROUP", createdAt: A_YEAR_AGO }],
      writtenInOnLock: "chat-old",
    });

    const summary = await service.run(NOW, RETENTION_DAYS);

    expect(summary.groupsDeleted).toBe(0);
    expect(rooms).toHaveLength(1);
  });
});
