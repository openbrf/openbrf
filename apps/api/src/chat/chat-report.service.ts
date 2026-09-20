import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import { holdsBoardSeat, roomFor } from "./chat-membership";
import { ChatError } from "./chat.error";
import {
  authorViewOf,
  refusePersonalIdentityNumbers,
  type ChatAuthorView,
} from "./chat.service";

/**
 * The longest note a report may carry.
 *
 * Shorter than a message on purpose. A note says why this is being put in front
 * of the board - "this is about my apartment", "he has written this four times"
 * - and the message it is about travels with it, so the note is a sentence and
 * not a second account of what happened.
 */
export const REPORT_NOTE_MAX_LENGTH = 500;

/**
 * How many open reports one read of the queue answers with.
 *
 * Bounded like every other read here. A board that has let fifty reports stand
 * has a queue to work through rather than a page to read, and the oldest are the
 * ones waiting longest.
 */
export const REPORTS_PER_PAGE = 50;

/**
 * The board's queue, and whether this account is the board.
 *
 * Two answers in one payload, on the room list's own reasoning: an empty queue
 * and a queue this account may not read are different facts, and a screen shown
 * the first when the second is true would tell the instance's administrator that
 * nothing has been reported - which is a statement about a private room, made to
 * somebody who is not allowed one.
 */
export interface ChatReportQueueView {
  reports: ChatReportView[];
  /**
   * Whether this account may answer a report.
   *
   * Holding `chat:moderate` is not enough: the administrator holds every
   * capability and no seat, and the board is the elected board.
   */
  mayModerate: boolean;
}

/** One reported message, as the board is shown it. */
export interface ChatReportView {
  reportId: string;
  /** ISO instant the report was made. */
  reportedAt: string;
  /** Who reported it, on the same terms an author is named. */
  reporter: ChatAuthorView;
  /** What they wanted to say about it, or null when they said nothing. */
  note: string | null;
  /**
   * Which room it came out of.
   *
   * The name and who made it, and nothing else: no other message, no member
   * list, no count. The board is being shown one message and where it was said,
   * which is what a report carries and the whole of what it carries.
   */
  groupName: string | null;
  groupCreatedBy: ChatAuthorView;
  messageId: string;
  /** Who wrote the message. */
  author: ChatAuthorView;
  /** What they wrote, in full. The board is deciding about this text. */
  body: string;
  /** ISO instant the message was written. */
  writtenAt: string;
  /** ISO instant the board struck it through, or null while it stands. */
  struckAt: string | null;
}

/**
 * The one way the board reaches a group.
 *
 * ## A room the board cannot see
 *
 * A group is invisible to anybody who is not in it. It is not listed, and asked
 * for by identifier it is refused exactly as a room that does not exist - so
 * there is no queue of rooms for the board to watch, no count of them on any
 * screen, and no way for the board to learn that a group exists at all.
 *
 * What there is, is this: somebody inside the room carries one message out. The
 * report is what makes that message readable by the board, and it makes nothing
 * else readable - not the message before it, not the room's other members, not
 * the room.
 *
 * ## Why the board can moderate a room it cannot read
 *
 * Because somebody in it asked. The association is answerable for what its
 * platform holds, and a resident who is being written about in a private room
 * has nowhere else to go; what they must not have to do to get an answer is hand
 * the board the room. So the report carries one message and the board decides
 * about that message: struck through, or left standing.
 *
 * Behind `chat:moderate` rather than `site:manage`. That capability moderates a
 * comment thread because the thread is part of what the association publishes
 * and the board answers for it - and a group publishes nothing.
 *
 * And behind a board seat as well as that capability, which is the same division
 * the rooms themselves live under: the capability opens the endpoint and the
 * register decides whether there is anything behind it. `ADMIN_CAPABILITIES` is
 * every capability, so the instance's administrator holds `chat:moderate` and
 * holds no seat - and a report carries a private room's message in full. The
 * board chat already refuses them the room; a queue that handed them the same
 * text would be the promise kept on one path and broken on the other. Every
 * path through this service asks the register for the seat, once, here.
 *
 * ## What striking does and does not do
 *
 * It withholds the text from the other people in the room and from nobody else's
 * copy of it: the row stays where it is, attributed as before, its author still
 * reads it, and the retention clock it was written under is unchanged. Nothing
 * here erases anything.
 *
 * The board chat has no strike-through at all and a message in it cannot be
 * reported. The board is the whole room, and a board able to strike a
 * colleague's line would be deciding what the record of its own deliberation
 * says.
 */
@Injectable()
export class ChatReportService {
  private readonly logger = new Logger(ChatReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Reports a message to the board.
   *
   * Writes no audit entry, and the departure from the rule beside it is
   * deliberate: the report row is the record. It says who reported what, when,
   * and what the board did about it, which is more than an entry naming the act
   * could carry - and unlike an entry it is erased with the message it is about,
   * so a report does not outlive the words it was about.
   */
  async report(
    reporter: Principal,
    messageId: string,
    note: string | null,
  ): Promise<{ reportId: string }> {
    const message = await this.requireReportableMessage(messageId, reporter);

    if (note !== null) {
      refusePersonalIdentityNumbers(note, "note");
    }

    const existing = await this.prisma.chatMessageReport.findUnique({
      where: {
        messageId_reporterPersonId: {
          messageId: message.id,
          reporterPersonId: reporter.personId,
        },
      },
      select: { id: true },
    });
    if (existing !== null) {
      /*
       * Said rather than answered quietly. Somebody pressing a second time wants
       * to know the board has it, and a silent second report would leave them
       * pressing - while a second row would let one member of a room fill the
       * queue with one message.
       */
      throw new ChatError(
        "This message has already been reported by this account.",
        "already-reported",
      );
    }

    const created = await this.prisma.chatMessageReport.create({
      data: {
        messageId: message.id,
        reporterPersonId: reporter.personId,
        note,
      },
      select: { id: true },
    });

    // The room and the report, and nothing that was said in either.
    this.logger.log(
      `A message in chat ${message.chatId} was reported to the board`,
    );

    return { reportId: created.id };
  }

  /**
   * What the board has been asked to look at, oldest first.
   *
   * Open reports only. A resolved one is the record of a decision and stays on
   * the row; a queue that kept showing it would be a queue that never empties.
   */
  async queue(reader: Principal): Promise<ChatReportQueueView> {
    if (!(await this.holdsSeat(reader))) {
      /*
       * Nothing, and the screen is told why rather than being handed an empty
       * queue: "nothing has been reported" is a fact about rooms this account
       * may not know anything about.
       */
      return { reports: [], mayModerate: false };
    }

    const rows = await this.prisma.chatMessageReport.findMany({
      where: { resolvedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: REPORTS_PER_PAGE,
      select: REPORT_COLUMNS,
    });

    return { reports: await this.toViews(rows), mayModerate: true };
  }

  /**
   * Strikes the reported message through, and closes every open report on it.
   *
   * The message is reached through the report and never by its own identifier,
   * which is what keeps the board's way in to one thing: a board member cannot
   * strike a message nobody has reported, because there is no route that takes a
   * message.
   *
   * Every other open report on the same message is closed with it. They were
   * asking the same question and it has been answered, and a queue that kept
   * asking it would have the board decide the same message twice.
   */
  async strike(actor: Principal, reportId: string): Promise<ChatReportView> {
    await this.requireSeat(actor);

    const struck = await this.prisma.$transaction(async (tx) => {
      const report = await tx.chatMessageReport.findUnique({
        where: { id: reportId },
        select: {
          id: true,
          resolvedAt: true,
          message: {
            select: { id: true, chatId: true, authorPersonId: true },
          },
        },
      });
      if (report === null) {
        throw new ChatError("There is no such report.", "report-not-found");
      }
      if (report.resolvedAt !== null) {
        throw new ChatError(
          "The board has already answered this report.",
          "report-resolved",
        );
      }

      const now = new Date();
      const { count } = await tx.chatMessage.updateMany({
        where: { id: report.message.id, struckAt: null },
        data: { struckAt: now, struckByPersonId: actor.personId },
      });

      await tx.chatMessageReport.updateMany({
        where: { messageId: report.message.id, resolvedAt: null },
        data: {
          resolvedAt: now,
          resolvedByPersonId: actor.personId,
          upheld: true,
        },
      });

      if (count === 0) {
        /*
         * The message was already struck through by an earlier report. This one
         * is answered and closed, and nothing else happened: nothing written,
         * nothing recorded, exactly as a second press on a comment's
         * strike-through is not a second act.
         */
        return null;
      }

      await this.audit.record(
        {
          action: "CHAT_MESSAGE_STRUCK",
          channel: "WEB",
          actorPersonId: actor.personId,
          // The subject is whoever wrote it: this is something done to them, and
          // their access report has to show a moderation somebody else decided.
          targetPersonId: report.message.authorPersonId,
          targetKind: "chatMessage",
          targetId: report.message.id,
          // Which room, and never what was said in it: the log is append-only
          // and outside every purge, so a body copied here would outlive the
          // message the purge erased.
          context: { chatId: report.message.chatId },
        },
        tx,
      );

      return report.message;
    });

    if (struck !== null) {
      this.logger.log(`A message in chat ${struck.chatId} was struck through`);
    }

    return this.byId(reportId);
  }

  /**
   * Closes a report without striking anything.
   *
   * Recorded on the report and nowhere else. Nothing changed about who can read
   * what, so there is no audit entry: what the board decided is on the row, and
   * the row is what the person who reported it is shown.
   */
  async dismiss(actor: Principal, reportId: string): Promise<ChatReportView> {
    await this.requireSeat(actor);

    await this.prisma.$transaction(async (tx) => {
      const report = await tx.chatMessageReport.findUnique({
        where: { id: reportId },
        select: { id: true, resolvedAt: true, messageId: true },
      });
      if (report === null) {
        throw new ChatError("There is no such report.", "report-not-found");
      }
      if (report.resolvedAt !== null) {
        throw new ChatError(
          "The board has already answered this report.",
          "report-resolved",
        );
      }

      /*
       * Every open report about that message, exactly as striking closes every
       * one of them. They were asking the same question and the board has
       * answered it; a sibling left open would let the same message be struck
       * through afterwards, which is the decision the board has just declined
       * to make.
       */
      await tx.chatMessageReport.updateMany({
        where: { messageId: report.messageId, resolvedAt: null },
        data: {
          resolvedAt: new Date(),
          resolvedByPersonId: actor.personId,
          upheld: false,
        },
      });
    });

    return this.byId(reportId);
  }

  /** Whether this account is on the board today. */
  private async holdsSeat(actor: Principal): Promise<boolean> {
    return holdsBoardSeat(this.prisma, actor.personId, new Date());
  }

  /**
   * Refuses an account that holds the capability and no seat.
   *
   * The same refusal as a report that does not exist, on the rooms' own rule:
   * an answer that told the two apart would say whether a private room has been
   * reported to somebody who may not be told that it exists.
   */
  private async requireSeat(actor: Principal): Promise<void> {
    if (!(await this.holdsSeat(actor))) {
      throw new ChatError("There is no such report.", "report-not-found");
    }
  }

  /**
   * The message this person may report, or the one refusal.
   *
   * Three things have to hold and they collapse into one answer: the message
   * exists, it is in a room this person is in, and that room is a group. The
   * third is not a leak - the board chat's members all know they are in it - but
   * it is answered the same way anyway, because every answer about a room here
   * is the same answer and an exception is how an identifier space starts being
   * walkable.
   */
  private async requireReportableMessage(
    messageId: string,
    reporter: Principal,
  ): Promise<{ id: string; chatId: string }> {
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, chatId: true, struckAt: true },
    });
    if (message === null) {
      throw new ChatError("There is no such message.", "message-not-found");
    }

    const room = await roomFor(
      this.prisma,
      message.chatId,
      reporter.personId,
      new Date(),
    );
    if (room === null) {
      throw new ChatError("There is no such message.", "message-not-found");
    }

    if (room.kind !== "GROUP") {
      /*
       * Said plainly rather than answered as an absence. The board chat has no
       * strike-through, that is a rule the product states, and somebody holding
       * a seat is not learning anything about it here.
       */
      throw new ChatError(
        "A message in the board chat cannot be reported: the board is the whole room.",
        "not-reportable",
      );
    }

    if (message.struckAt !== null) {
      throw new ChatError(
        "The board has already struck this message through.",
        "report-resolved",
      );
    }

    return { id: message.id, chatId: message.chatId };
  }

  /** One report, read back after the board acted on it. */
  private async byId(reportId: string): Promise<ChatReportView> {
    const row = await this.prisma.chatMessageReport.findUnique({
      where: { id: reportId },
      select: REPORT_COLUMNS,
    });
    const [view] = row === null ? [] : await this.toViews([row]);
    if (view === undefined) {
      // Unreachable: the act above wrote this row and nothing deletes one
      // except the purge erasing the message it is about.
      throw new ChatError("There is no such report.", "report-not-found");
    }
    return view;
  }

  /** Every report in a page, with the people in it resolved in one read. */
  private async toViews(rows: readonly ReportRow[]): Promise<ChatReportView[]> {
    const personIds = [
      ...new Set(
        rows.flatMap((row) => [
          row.reporterPersonId,
          row.message.authorPersonId,
          ...(row.message.chat.createdByPersonId === null
            ? []
            : [row.message.chat.createdByPersonId]),
        ]),
      ),
    ];
    const persons =
      personIds.length === 0
        ? []
        : await this.prisma.person.findMany({
            where: { id: { in: personIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              protectedPersonalData: true,
            },
          });
    const byId = new Map(persons.map((person) => [person.id, person]));

    return rows.map((row) => ({
      reportId: row.id,
      reportedAt: row.createdAt.toISOString(),
      reporter: authorViewOf(
        row.reporterPersonId,
        byId.get(row.reporterPersonId),
      ),
      note: row.note,
      groupName: row.message.chat.name,
      groupCreatedBy: authorViewOf(
        row.message.chat.createdByPersonId ?? "",
        row.message.chat.createdByPersonId === null
          ? undefined
          : byId.get(row.message.chat.createdByPersonId),
      ),
      messageId: row.message.id,
      author: authorViewOf(
        row.message.authorPersonId,
        byId.get(row.message.authorPersonId),
      ),
      // In full, and never withheld from this reader: the board is deciding
      // about this text, and a decision about text nobody is shown is not one.
      body: row.message.body,
      writtenAt: row.message.createdAt.toISOString(),
      struckAt: row.message.struckAt?.toISOString() ?? null,
    }));
  }
}

const REPORT_COLUMNS = {
  id: true,
  reporterPersonId: true,
  note: true,
  createdAt: true,
  message: {
    select: {
      id: true,
      chatId: true,
      authorPersonId: true,
      body: true,
      struckAt: true,
      createdAt: true,
      chat: { select: { name: true, createdByPersonId: true } },
    },
  },
} as const;

interface ReportRow {
  id: string;
  reporterPersonId: string;
  note: string | null;
  createdAt: Date;
  message: {
    id: string;
    chatId: string;
    authorPersonId: string;
    body: string;
    struckAt: Date | null;
    createdAt: Date;
    chat: { name: string | null; createdByPersonId: string | null };
  };
}
