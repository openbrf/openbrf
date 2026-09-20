import { describe, expect, it, vi } from "vitest";

import { Prisma } from "../generated/prisma/client";

import type { AuditLogService } from "../audit/audit-log.service";
import type { Capability, Principal } from "../authorization/capabilities";
import type { PrismaService } from "../database/prisma.service";
import { ChatReportService } from "./chat-report.service";
import type { ChatError } from "./chat.error";

/**
 * The board's one way into a room it cannot see.
 *
 * **A report carries one message and nothing else.** Not the room, not its
 * members, not the line before it. What the queue answers is asserted field by
 * field for that reason: a view that grew a second message would be a view that
 * had opened the room.
 *
 * **Only a group's message can be reported.** The board chat has no
 * strike-through at all - the board is the whole room - and that refusal is said
 * plainly rather than answered as an absence, because it is a rule the product
 * states out loud.
 *
 * **A message in a room this person is not in answers as one that does not
 * exist.** Otherwise a message identifier would be a way to find out what is
 * being said in rooms somebody is not in.
 *
 * **One person reports one message once**, so a room cannot be turned into a
 * flood by one member pressing.
 *
 * **Striking is one act however many reports asked for it.** It closes every
 * open report on that message and writes one audit entry; a second strike on a
 * message already struck writes nothing and records nothing.
 *
 * **Dismissing writes no audit entry at all**, because nothing changed about who
 * can read what - what the board decided is on the report row, which is what the
 * person who reported it is shown. It closes every open report about that
 * message, as striking does: leaving one open would let the message be struck
 * afterwards through a sibling, which is the decision the board has just
 * declined to make.
 *
 * **A capability is not a seat.** The administrator holds `chat:moderate`
 * through the ADMIN grant and holds no board seat, and a report carries a
 * private room's message in full - so every path here asks the register for the
 * seat, and the queue says which of the two empty answers it is giving.
 *
 * What the database does with these rows is `chat-group.int-spec.ts`.
 */

const GROUP_ID = "chat-garden";
const BOARD_ID = "chat-board";
const MESSAGE_ID = "message-1";

const NILS = "person-nils";
const ASTRID = "person-astrid";
const BOARD_MEMBER = "person-bo";

interface MessageFixture {
  id: string;
  chatId: string;
  authorPersonId: string;
  body: string;
  struckAt: Date | null;
  struckByPersonId: string | null;
  createdAt: Date;
}

interface ReportFixture {
  id: string;
  messageId: string;
  reporterPersonId: string;
  note: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByPersonId: string | null;
  upheld: boolean | null;
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

const THE_MESSAGE: MessageFixture = {
  id: MESSAGE_ID,
  chatId: GROUP_ID,
  authorPersonId: ASTRID,
  body: "Det har borde ingen skriva.",
  struckAt: null,
  struckByPersonId: null,
  createdAt: new Date("2026-03-02T09:00:00.000Z"),
};

/**
 * A database holding these rooms, messages and reports.
 *
 * `members` is who is written into the group, and everybody in this fixture
 * lives here: what a residency decides is `chat-group.service.spec.ts`, and what
 * this file is about is which message reaches the board.
 */
function build(options: {
  messages?: MessageFixture[];
  reports?: ReportFixture[];
  members?: string[];
  /** Who holds a board seat. The board member alone, unless a test says so. */
  seatedPersonIds?: string[];
  /**
   * The other answer, landing while this one waits for the lock.
   *
   * The only moment it can: the claim below is conditional on the report still
   * being open, and the rows it reads are read after the lock.
   */
  whileWaiting?: (reports: ReportFixture[], messages: MessageFixture[]) => void;
  /** The other report, landing between the read for it and the insert. */
  whileReading?: (reports: ReportFixture[]) => void;
}) {
  const seated = options.seatedPersonIds ?? [NILS, BOARD_MEMBER];
  // Copied row by row rather than by the array, so a strike in one test cannot
  // reach the fixture the next one starts from.
  const messages = (options.messages ?? [THE_MESSAGE]).map((message) => ({
    ...message,
  }));
  const reports = (options.reports ?? []).map((report) => ({ ...report }));
  const members = options.members ?? [NILS, ASTRID];

  const chats = [
    {
      id: GROUP_ID,
      kind: "GROUP" as const,
      name: "Trädgårdsgruppen",
      createdByPersonId: NILS,
    },
    {
      id: BOARD_ID,
      kind: "BOARD" as const,
      name: null,
      createdByPersonId: null,
    },
  ];

  const reportRow = (report: ReportFixture) => {
    const message = messages.find((each) => each.id === report.messageId);
    return {
      ...report,
      message: {
        ...message,
        chat: chats.find((chat) => chat.id === message?.chatId),
      },
    };
  };

  /** Every advisory lock key an answer took, in order. */
  const locks: string[] = [];

  const client = {
    /*
     * The lock the board takes on the message before it answers a report about
     * it. Recorded rather than implemented - what one transaction waits for is
     * not something a fake in one process can show - and the hook below is how
     * a test says "the other answer landed while this one waited".
     */
    $executeRaw: vi.fn(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        locks.push(String(values[0]));
        options.whileWaiting?.(reports, messages);
        return 1;
      },
    ),
    chat: {
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          chats.find((chat) => chat.id === args.where.id) ?? null,
      ),
    },
    chatGroupMember: {
      findUnique: vi.fn(
        async (args: {
          where: { chatId_personId: { chatId: string; personId: string } };
        }) =>
          members.includes(args.where.chatId_personId.personId) &&
          args.where.chatId_personId.chatId === GROUP_ID
            ? { chatId: GROUP_ID }
            : null,
      ),
    },
    residency: {
      // Everybody in this fixture lives here.
      findFirst: vi.fn(async () => ({ id: "residency-1" })),
    },
    person: {
      /*
       * A board seat, asked for two different questions: whether a room of kind
       * BOARD may be reached, and whether this account may answer a report.
       * Implemented on the fixture's own list rather than answered yes, because
       * the second question is the boundary between the board and the
       * instance's administrator.
       */
      findFirst: vi.fn(async (args: { where: { id: string } }) =>
        seated.includes(args.where.id) ? { id: args.where.id } : null,
      ),
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        [NILS, ASTRID, BOARD_MEMBER]
          .filter((id) => args.where.id.in.includes(id))
          .map((id) => ({
            id,
            firstName: id === ASTRID ? "Astrid" : id === NILS ? "Nils" : "Bo",
            lastName: "Lindqvist",
            protectedPersonalData: false,
          })),
      ),
    },
    chatMessage: {
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          messages.find((message) => message.id === args.where.id) ?? null,
      ),
      updateMany: vi.fn(
        async (args: {
          where: { id: string; struckAt: null };
          data: { struckAt: Date; struckByPersonId: string };
        }) => {
          const message = messages.find(
            (each) => each.id === args.where.id && each.struckAt === null,
          );
          if (message === undefined) {
            return { count: 0 };
          }
          message.struckAt = args.data.struckAt;
          message.struckByPersonId = args.data.struckByPersonId;
          return { count: 1 };
        },
      ),
    },
    chatMessageReport: {
      findUnique: vi.fn(
        async (args: {
          where: {
            id?: string;
            messageId_reporterPersonId?: {
              messageId: string;
              reporterPersonId: string;
            };
          };
        }) => {
          const pair = args.where.messageId_reporterPersonId;
          const found =
            pair === undefined
              ? reports.find((report) => report.id === args.where.id)
              : reports.find(
                  (report) =>
                    report.messageId === pair.messageId &&
                    report.reporterPersonId === pair.reporterPersonId,
                );
          if (pair !== undefined) {
            /*
             * The other press, landing after this read has answered and before
             * the insert. That is the only gap there is, and what closes it is
             * the constraint rather than the read.
             */
            options.whileReading?.(reports);
          }
          return found === undefined ? null : reportRow(found);
        },
      ),
      findMany: vi.fn(
        async (args: { where: { resolvedAt: null }; take?: number }) => {
          const open = reports
            .filter((report) => report.resolvedAt === args.where.resolvedAt)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map(reportRow);
          return args.take === undefined ? open : open.slice(0, args.take);
        },
      ),
      create: vi.fn(
        async (args: {
          data: {
            messageId: string;
            reporterPersonId: string;
            note: string | null;
          };
        }) => {
          /*
           * The constraint the table carries: one person reports one message
           * once. Raised here rather than assumed, because the read before the
           * insert is only the ordinary path - two presses arriving together
           * both pass it, and what answers the second is this.
           */
          if (
            reports.some(
              (report) =>
                report.messageId === args.data.messageId &&
                report.reporterPersonId === args.data.reporterPersonId,
            )
          ) {
            throw new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed",
              { code: "P2002", clientVersion: "test" },
            );
          }
          const row: ReportFixture = {
            id: `report-${String(reports.length + 1)}`,
            ...args.data,
            createdAt: new Date(),
            resolvedAt: null,
            resolvedByPersonId: null,
            upheld: null,
          };
          reports.push(row);
          return { id: row.id };
        },
      ),
      updateMany: vi.fn(
        async (args: {
          where: { id?: string; messageId?: string; resolvedAt: null };
          data: {
            resolvedAt: Date;
            resolvedByPersonId: string;
            upheld: boolean;
          };
        }) => {
          const matching = reports.filter(
            (report) =>
              report.resolvedAt === null &&
              (args.where.id === undefined || report.id === args.where.id) &&
              (args.where.messageId === undefined ||
                report.messageId === args.where.messageId),
          );
          for (const report of matching) {
            report.resolvedAt = args.data.resolvedAt;
            report.resolvedByPersonId = args.data.resolvedByPersonId;
            report.upheld = args.data.upheld;
          }
          return { count: matching.length };
        },
      ),
    },
  };

  const prisma = {
    ...client,
    $transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) =>
      work(client),
    ),
  };

  const audit = { record: vi.fn(async () => undefined) };

  return {
    service: new ChatReportService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
    ),
    audit,
    messages,
    reports,
    locks,
  };
}

/** A report standing open against the message above. */
function openReport(
  reporterPersonId = NILS,
  note: string | null = "Det har handlar om min lagenhet.",
): ReportFixture {
  return {
    id: "report-1",
    messageId: MESSAGE_ID,
    reporterPersonId,
    note,
    createdAt: new Date("2026-03-03T08:00:00.000Z"),
    resolvedAt: null,
    resolvedByPersonId: null,
    upheld: null,
  };
}

describe("reporting a message", () => {
  it("is open to somebody in the room", async () => {
    const { service, reports } = build({});

    const made = await service.report(
      principal(NILS, ["chat:participate"]),
      MESSAGE_ID,
      "Det har handlar om min lagenhet.",
    );

    expect(made.reportId).toBe("report-1");
    expect(reports).toHaveLength(1);
  });

  it("refuses somebody who is not in the room, as a message that is not there", async () => {
    const { service, reports } = build({ members: [ASTRID] });

    await expect(
      service.report(principal(NILS, ["chat:participate"]), MESSAGE_ID, null),
    ).rejects.toMatchObject({ reason: "message-not-found" });
    expect(reports).toEqual([]);
  });

  it("refuses a message in the board chat, and says why", async () => {
    /*
     * The board is the whole room, so there is nobody to report a colleague's
     * line to. Said plainly rather than answered as an absence: it is a rule the
     * product states, and nobody in that room learns anything from hearing it.
     */
    const { service } = build({
      messages: [{ ...THE_MESSAGE, chatId: BOARD_ID }],
    });

    await expect(
      service.report(principal(NILS, ["chat:participate"]), MESSAGE_ID, null),
    ).rejects.toMatchObject({ reason: "not-reportable" });
  });

  it("refuses a second report of the same message by the same person", async () => {
    const { service, reports } = build({ reports: [openReport()] });

    await expect(
      service.report(principal(NILS, ["chat:participate"]), MESSAGE_ID, null),
    ).rejects.toMatchObject({ reason: "already-reported" });
    expect(reports).toHaveLength(1);
  });

  it("refuses a note carrying a personal identity number, naming the field", async () => {
    /*
     * The note is resident-written text like every other piece here, and the
     * refusal names where the number is and never what it was.
     */
    const { service, reports } = build({});

    const refused = (await service
      .report(
        principal(NILS, ["chat:participate"]),
        MESSAGE_ID,
        "Han skrev 19811218-9876 i rummet.",
      )
      .catch((error: unknown) => error)) as ChatError;

    expect(refused.reason).toBe("personal-identity-number");
    expect(JSON.stringify(refused.details())).toContain('"note"');
    expect(JSON.stringify(refused.details())).not.toContain("19811218");
    expect(reports).toEqual([]);
  });

  it("answers a second press that arrives at the same moment with the refusal", async () => {
    /*
     * Two presses on one button, both past the read and into the insert. The
     * constraint is what settles it, and what the second one gets has to be the
     * sentence the first would have got rather than a fault: a reporter who
     * double-clicked has done nothing wrong, and the board has the message
     * either way.
     */
    const { service, reports } = build({
      whileReading: (held) => {
        held.push({ ...openReport(), id: "report-raced" });
      },
    });

    await expect(
      service.report(principal(NILS, ["chat:participate"]), MESSAGE_ID, null),
    ).rejects.toMatchObject({ reason: "already-reported" });
    // One row, which is the whole of what the constraint is for.
    expect(reports).toHaveLength(1);
  });

  it("writes no audit entry, because the report row is the record", async () => {
    const { service, audit } = build({});

    await service.report(
      principal(NILS, ["chat:participate"]),
      MESSAGE_ID,
      null,
    );

    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe("the queue the board reads", () => {
  const board = principal(BOARD_MEMBER, ["chat:moderate"]);

  it("carries one message, who wrote it and who reported it, and no room", async () => {
    const { service } = build({ reports: [openReport()] });

    const { reports: queue } = await service.queue(board);

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      reportId: "report-1",
      groupName: "Trädgårdsgruppen",
      messageId: MESSAGE_ID,
      body: "Det har borde ingen skriva.",
      note: "Det har handlar om min lagenhet.",
      struckAt: null,
    });
    expect(queue[0]?.reporter).toMatchObject({ name: "Nils Lindqvist" });
    expect(queue[0]?.author).toMatchObject({ name: "Astrid Lindqvist" });
    // The room is named and never opened: nothing here is a way to ask for it.
    expect(Object.keys(queue[0] ?? {})).not.toContain("chatId");
  });

  it("leaves out what the board has already answered", async () => {
    const { service } = build({
      reports: [
        {
          ...openReport(),
          resolvedAt: new Date("2026-03-03T09:00:00.000Z"),
          resolvedByPersonId: BOARD_MEMBER,
          upheld: false,
        },
      ],
    });

    expect((await service.queue(board)).reports).toEqual([]);
  });
});

describe("an account with the capability and no seat", () => {
  /*
   * The instance's administrator. They hold every capability, they hold no seat,
   * and the board chat already refuses them the room - so a queue that handed
   * them a private room's message in full would keep the promise on one path and
   * break it on the other.
   */
  const administrator = principal("person-admin", [
    "chat:participate",
    "chat:moderate",
  ]);

  it("is answered no queue, and told that the queue is not theirs", async () => {
    const { service } = build({ reports: [openReport()] });

    const answer = await service.queue(administrator);

    expect(answer.reports).toEqual([]);
    // Not "nothing has been reported": that is a statement about rooms this
    // account may not be told exist.
    expect(answer.mayModerate).toBe(false);
  });

  it("cannot strike or dismiss, and the message stands", async () => {
    const { service, messages, reports } = build({ reports: [openReport()] });

    await expect(
      service.strike(administrator, "report-1"),
    ).rejects.toMatchObject({ reason: "report-not-found" });
    await expect(
      service.dismiss(administrator, "report-1"),
    ).rejects.toMatchObject({ reason: "report-not-found" });

    expect(messages[0]?.struckAt).toBeNull();
    expect(reports[0]?.resolvedAt).toBeNull();
  });

  it("is refused the same way a report that does not exist is", async () => {
    // One refusal for two cases, as everywhere else here: anything that told
    // them apart would say whether a private room has been reported.
    const { service } = build({ reports: [openReport()] });
    const board = principal(BOARD_MEMBER, ["chat:moderate"]);

    const withoutSeat = (await service
      .strike(administrator, "report-1")
      .catch((error: unknown) => error)) as ChatError;
    const notThere = (await service
      .strike(board, "report-9")
      .catch((error: unknown) => error)) as ChatError;

    expect(withoutSeat.reason).toBe(notThere.reason);
    expect(withoutSeat.status).toBe(notThere.status);
  });
});

describe("striking a message through", () => {
  const board = principal(BOARD_MEMBER, ["chat:moderate"]);

  it("marks the message, closes the report and records the act", async () => {
    const { service, audit, messages, reports } = build({
      reports: [openReport()],
    });

    const answered = await service.strike(board, "report-1");

    expect(messages[0]?.struckAt).not.toBeNull();
    expect(messages[0]?.struckByPersonId).toBe(BOARD_MEMBER);
    expect(reports[0]?.upheld).toBe(true);
    expect(reports[0]?.resolvedByPersonId).toBe(BOARD_MEMBER);
    expect(answered.struckAt).not.toBeNull();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CHAT_MESSAGE_STRUCK",
        actorPersonId: BOARD_MEMBER,
        // The subject is whoever wrote it: a moderation somebody else decided.
        targetPersonId: ASTRID,
        targetId: MESSAGE_ID,
      }),
      expect.anything(),
    );
  });

  it("keeps what was said out of the audit entry", async () => {
    const { service, audit } = build({ reports: [openReport()] });

    await service.strike(board, "report-1");

    const entry = audit.record.mock.calls.at(0)?.at(0) as unknown as {
      context: Record<string, unknown>;
    };
    expect(entry.context).toEqual({ chatId: GROUP_ID });
  });

  it("closes every other open report on the same message", async () => {
    // They were asking the same question and it has been answered; a queue that
    // kept asking would have the board decide one message twice.
    const { service, reports } = build({
      reports: [openReport(), { ...openReport(ASTRID, null), id: "report-2" }],
    });

    await service.strike(board, "report-1");

    expect(reports.every((report) => report.resolvedAt !== null)).toBe(true);
    expect(reports.every((report) => report.upheld === true)).toBe(true);
  });

  it("records nothing when the message was already struck", async () => {
    const { service, audit } = build({
      messages: [
        {
          ...THE_MESSAGE,
          struckAt: new Date("2026-03-03T09:00:00.000Z"),
          struckByPersonId: BOARD_MEMBER,
        },
      ],
      reports: [{ ...openReport(), id: "report-2" }],
    });

    await service.strike(board, "report-2");

    // Nothing written, nothing recorded - and the second report is closed all
    // the same, because it has been answered.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses a report the board has already answered", async () => {
    const { service } = build({
      reports: [
        {
          ...openReport(),
          resolvedAt: new Date("2026-03-03T09:00:00.000Z"),
          resolvedByPersonId: BOARD_MEMBER,
          upheld: false,
        },
      ],
    });

    await expect(service.strike(board, "report-1")).rejects.toMatchObject({
      reason: "report-resolved",
    });
  });

  it("refuses a report that does not exist", async () => {
    const { service } = build({});

    await expect(service.strike(board, "report-9")).rejects.toMatchObject({
      reason: "report-not-found",
    });
  });
});

describe("two answers arriving together", () => {
  const board = principal(BOARD_MEMBER, ["chat:moderate"]);
  const second = principal("person-second-seat", ["chat:moderate"]);

  /** The other answer, landing while this one waits for the lock. */
  function answeredWhileWaiting(upheld: boolean, struck: boolean) {
    return (reports: ReportFixture[], messages: MessageFixture[]): void => {
      for (const report of reports) {
        if (report.resolvedAt === null) {
          report.resolvedAt = new Date("2026-03-03T09:00:00.000Z");
          report.resolvedByPersonId = second.personId;
          report.upheld = upheld;
        }
      }
      const message = messages[0];
      if (struck && message !== undefined) {
        message.struckAt = new Date("2026-03-03T09:00:00.000Z");
        message.struckByPersonId = second.personId;
      }
    };
  }

  it("takes the message's own lock before it claims the report", async () => {
    /*
     * The decision is about the message rather than about one person's report
     * of it: answering one closes every report of that message. Two answers to
     * two reports of one line would otherwise both pass their own check, so the
     * key is the message - and it has to be the same key on both paths.
     */
    const { service, locks } = build({
      reports: [openReport()],
      seatedPersonIds: [NILS, BOARD_MEMBER, second.personId],
    });

    await service.strike(board, "report-1");

    expect(locks).toEqual([`chat-message:${MESSAGE_ID}`]);
  });

  it("refuses the strike that arrives after a dismissal, and leaves the message standing", async () => {
    /*
     * The record is what this protects. A strike that went through after the
     * board had left the message standing would write CHAT_MESSAGE_STRUCK and
     * find no report of its own to update - so the row would say the board left
     * standing a message that carries a strike, which is worse than either
     * answer on its own.
     */
    const { service, messages, reports, audit } = build({
      reports: [openReport()],
      seatedPersonIds: [NILS, BOARD_MEMBER, second.personId],
      whileWaiting: answeredWhileWaiting(false, false),
    });

    await expect(service.strike(board, "report-1")).rejects.toMatchObject({
      reason: "report-resolved",
    });

    expect(messages[0]?.struckAt).toBeNull();
    expect(reports[0]?.upheld).toBe(false);
    expect(reports[0]?.resolvedByPersonId).toBe(second.personId);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses the dismissal that arrives after a strike, and the record says struck", async () => {
    const { service, messages, reports } = build({
      reports: [openReport()],
      seatedPersonIds: [NILS, BOARD_MEMBER, second.personId],
      whileWaiting: answeredWhileWaiting(true, true),
    });

    await expect(service.dismiss(board, "report-1")).rejects.toMatchObject({
      reason: "report-resolved",
    });

    expect(messages[0]?.struckAt).not.toBeNull();
    expect(reports[0]?.upheld).toBe(true);
  });
});

describe("leaving a message standing", () => {
  const board = principal(BOARD_MEMBER, ["chat:moderate"]);

  it("closes the report, touches the message and writes no entry", async () => {
    const { service, audit, messages, reports } = build({
      reports: [openReport()],
    });

    const answered = await service.dismiss(board, "report-1");

    expect(reports[0]?.upheld).toBe(false);
    expect(reports[0]?.resolvedByPersonId).toBe(BOARD_MEMBER);
    expect(messages[0]?.struckAt).toBeNull();
    expect(answered.struckAt).toBeNull();
    // Nothing changed about who can read what, so there is nothing to record.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("closes every other open report on the same message", async () => {
    /*
     * The board has decided about the message, not about one person's report of
     * it. A sibling left open would let the same message be struck through
     * afterwards - the decision this one declined to make, made by whoever
     * pressed next.
     */
    const { service, messages, reports } = build({
      reports: [openReport(), { ...openReport(ASTRID, null), id: "report-2" }],
    });

    await service.dismiss(board, "report-1");

    expect(reports.every((report) => report.resolvedAt !== null)).toBe(true);
    expect(reports.every((report) => report.upheld === false)).toBe(true);
    expect(messages[0]?.struckAt).toBeNull();
    // And the message cannot then be struck through the sibling.
    await expect(service.strike(board, "report-2")).rejects.toMatchObject({
      reason: "report-resolved",
    });
  });

  it("refuses one that is already answered, and one that is not there", async () => {
    const { service } = build({
      reports: [
        {
          ...openReport(),
          resolvedAt: new Date("2026-03-03T09:00:00.000Z"),
          resolvedByPersonId: BOARD_MEMBER,
          upheld: true,
        },
      ],
    });

    await expect(service.dismiss(board, "report-1")).rejects.toMatchObject({
      reason: "report-resolved",
    });
    await expect(service.dismiss(board, "report-9")).rejects.toMatchObject({
      reason: "report-not-found",
    });
  });
});
