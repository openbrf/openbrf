import { describe, expect, it, vi } from "vitest";

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
 * person who reported it is shown.
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
}) {
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

  const client = {
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
       * The seat, asked for whenever a room of kind BOARD is reached. Answered
       * yes, so that the board chat's refusal here is about what the room is
       * rather than about the caller not being in it: a fake that answered no
       * would let the wrong refusal pass for the right reason.
       */
      findFirst: vi.fn(async () => ({ id: NILS })),
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
  it("carries one message, who wrote it and who reported it, and no room", async () => {
    const { service } = build({ reports: [openReport()] });

    const queue = await service.queue();

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

    expect(await service.queue()).toEqual([]);
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
