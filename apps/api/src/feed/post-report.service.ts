import { Injectable, Logger } from "@nestjs/common";
import type { PostReportQueueView, PostReportView } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import { isUniqueViolation } from "../database/unique-violation";
import type { Prisma } from "../generated/prisma/client";
import { holdsBoardSeat } from "../mail/board-recipients";
import { postFor } from "./feed-audience";
import { readAuthors } from "./feed-author";
import { lockPost } from "./feed-lock";
import { FeedError, refusePersonalIdentityNumbers } from "./feed.error";

/**
 * The longest note a report may carry.
 *
 * Shorter than a post on purpose. A note says why this is being put in front
 * of the board - "this is about my apartment", "he has written this four times"
 * - and the post it is about travels with it, so the note is a sentence and
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
 * The one way the board reaches a group.
 *
 * ## A group the board cannot see
 *
 * A group is invisible to anybody who is not in it. It is not listed, and asked
 * for by identifier it is refused exactly as a group that does not exist - so
 * there is no queue of groups for the board to watch, no count of them on any
 * screen, and no way for the board to learn that a group exists at all.
 *
 * What there is, is this: somebody inside the group carries one post out. The
 * report is what makes that post readable by the board, and it makes nothing
 * else readable - not the post before it, not the group's other members, not
 * the group.
 *
 * ## Why the board can moderate a group it cannot read
 *
 * Because somebody in it asked. The association is answerable for what its
 * platform holds, and a resident who is being written about in a private group
 * has nowhere else to go; what they must not have to do to get an answer is hand
 * the board the group. So the report carries one post and the board decides
 * about that post: struck through, or left standing.
 *
 * Behind `chat:moderate` rather than `site:manage`. That capability moderates a
 * comment thread because the thread is part of what the association publishes
 * and the board answers for it - and a group publishes nothing.
 *
 * And behind a board seat as well as that capability, which is the same division
 * the groups themselves live under: the capability opens the endpoint and the
 * register decides whether there is anything behind it. `ADMIN_CAPABILITIES` is
 * every capability, so the instance's administrator holds `chat:moderate` and
 * holds no seat - and a report carries a private group's post in full. The
 * feed already refuses them the group; a queue that handed them the same
 * text would be the promise kept on one path and broken on the other. Every
 * path through this service asks the register for the seat, once, here.
 *
 * ## What striking does and does not do
 *
 * It withholds the text from the other people in the group and from nobody else's
 * copy of it: the row stays where it is, attributed as before, its author still
 * reads it, and the retention clock it was written under is unchanged. Nothing
 * here erases anything.
 *
 * Styrelsen has no strike-through at all and a post there cannot be reported.
 * The board is the whole audience, and a board able to strike a colleague's
 * line would be deciding what the record of its own deliberation says.
 */
@Injectable()
export class PostReportService {
  private readonly logger = new Logger(PostReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Reports a post to the board.
   *
   * Writes no audit entry, and the departure from the rule beside it is
   * deliberate: the report row is the record. It says who reported what, when,
   * and what the board did about it, which is more than an entry naming the act
   * could carry - and unlike an entry it is erased with the post it is about,
   * so a report does not outlive the words it was about.
   */
  async report(
    reporter: Principal,
    postId: string,
    note: string | null,
  ): Promise<{ reportId: string }> {
    const post = await this.requireReportablePost(postId, reporter);

    if (note !== null) {
      refusePersonalIdentityNumbers(note, "note");
    }

    const existing = await this.prisma.postReport.findUnique({
      where: {
        postId_reporterPersonId: {
          postId: post.id,
          reporterPersonId: reporter.personId,
        },
      },
      select: { id: true },
    });
    if (existing !== null) {
      /*
       * Said rather than answered quietly. Somebody pressing a second time wants
       * to know the board has it, and a silent second report would leave them
       * pressing - while a second row would let one member of a group fill the
       * queue with one post.
       *
       * The read is the ordinary path and the constraint is the whole rule: two
       * presses arriving together both pass this, and the insert below answers
       * the second with the same refusal rather than with a fault.
       */
      throw new FeedError(
        "This post has already been reported by this account.",
        "already-reported",
      );
    }

    const created = await this.prisma
      .$transaction(async (tx) => {
        /*
         * Inserted under the lock the board takes to answer a report, with the
         * strike-through read again under it. A report arriving while a strike
         * commits would otherwise be inserted after the strike closed every
         * open report, and a later dismissal of it would record the board
         * leaving standing a post that carries a strike.
         */
        await lockPost(tx, post.id);
        const current = await tx.post.findUnique({
          where: { id: post.id },
          select: { struckAt: true },
        });
        if (current === null) {
          throw new FeedError("There is no such post.", "post-not-found");
        }
        if (current.struckAt !== null) {
          throw new FeedError(
            "The board has already struck this post through.",
            "report-resolved",
          );
        }

        return tx.postReport.create({
          data: {
            postId: post.id,
            reporterPersonId: reporter.personId,
            note,
          },
          select: { id: true },
        });
      })
      .catch((cause: unknown) => {
        /*
         * The read above narrows the window; the unique constraint on the
         * post and the reporter closes it. Two presses on one button arrive
         * together, both pass the read, and the second insert raises P2002 -
         * which without this reaches the reporter as a fault where the refusal
         * the sentence above promises belongs.
         */
        if (isUniqueViolation(cause)) {
          throw new FeedError(
            "This post has already been reported by this account.",
            "already-reported",
          );
        }
        throw cause;
      });

    // The group and the report, and nothing that was said in either.
    this.logger.log(
      `A post in audience ${post.audienceId} was reported to the board`,
    );

    return { reportId: created.id };
  }

  /**
   * What the board has been asked to look at, oldest first.
   *
   * Open reports only. A resolved one is the record of a decision and stays on
   * the row; a queue that kept showing it would be a queue that never empties.
   */
  async queue(reader: Principal): Promise<PostReportQueueView> {
    if (!(await this.holdsSeat(reader))) {
      /*
       * Nothing, and the screen is told why rather than being handed an empty
       * queue: "nothing has been reported" is a fact about groups this account
       * may not know anything about.
       */
      return { reports: [], mayModerate: false };
    }

    const rows = await this.prisma.postReport.findMany({
      where: { resolvedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: REPORTS_PER_PAGE,
      select: REPORT_COLUMNS,
    });

    return { reports: await this.toViews(rows), mayModerate: true };
  }

  /**
   * Strikes the reported post through, and closes every open report on it.
   *
   * The post is reached through the report and never by its own identifier,
   * which is what keeps the board's way in to one thing: a board member cannot
   * strike a post nobody has reported, because there is no route that takes a
   * post.
   *
   * Every other open report on the same post is closed with it. They were
   * asking the same question and it has been answered, and a queue that kept
   * asking it would have the board decide the same post twice.
   */
  async strike(actor: Principal, reportId: string): Promise<PostReportView> {
    await this.requireSeat(actor);

    const struck = await this.prisma.$transaction(async (tx) => {
      const report = await this.claim(tx, reportId, actor, true);
      const now = new Date();

      const { count } = await tx.post.updateMany({
        where: { id: report.post.id, struckAt: null },
        data: { struckAt: now, struckByPersonId: actor.personId },
      });

      /*
       * Every other report of the same post, closed with the one that was
       * answered: they were asking the same question, and the board has
       * answered it about the post rather than about one person's report.
       */
      await tx.postReport.updateMany({
        where: { postId: report.post.id, resolvedAt: null },
        data: {
          resolvedAt: now,
          resolvedByPersonId: actor.personId,
          upheld: true,
        },
      });

      if (count === 0) {
        /*
         * The post was already struck through by an earlier report. This one
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
          targetPersonId: report.post.authorPersonId,
          // The audit vocabulary the chat wrote, kept so this entry reads as
          // every earlier strike does (ADR 0026).
          targetKind: "chatMessage",
          targetId: report.post.id,
          // Which group, and never what was said in it: the log is append-only
          // and outside every purge, so a body copied here would outlive the
          // post the purge erased.
          context: { chatId: report.post.audienceId },
        },
        tx,
      );

      return report.post;
    });

    if (struck !== null) {
      this.logger.log(
        `A post in audience ${struck.audienceId} was struck through`,
      );
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
  async dismiss(actor: Principal, reportId: string): Promise<PostReportView> {
    await this.requireSeat(actor);

    await this.prisma.$transaction(async (tx) => {
      const report = await this.claim(tx, reportId, actor, false);

      /*
       * Every open report about that post, exactly as striking closes every
       * one of them. They were asking the same question and the board has
       * answered it; a sibling left open would let the same post be struck
       * through afterwards, which is the decision the board has just declined
       * to make.
       */
      await tx.postReport.updateMany({
        where: { postId: report.post.id, resolvedAt: null },
        data: {
          resolvedAt: new Date(),
          resolvedByPersonId: actor.personId,
          upheld: false,
        },
      });
    });

    return this.byId(reportId);
  }

  /**
   * Takes the report, or refuses the board member who arrived second.
   *
   * Two things have to be settled before anything is written, and each needs its
   * own mechanism.
   *
   * Two presses on one report are settled by the claim itself: the update is
   * conditional on the report still being open, so exactly one of them changes a
   * row and the other reads a count of zero. A read followed by an update would
   * let both pass - at READ COMMITTED each sees the row as the other found it.
   *
   * Two presses on two reports of the same post are settled by the lock. The
   * decision is about the post: one answer closes every report of it, so two
   * answers arriving together could otherwise leave the record saying the board
   * left a post standing while the post carries a strike. Nothing about
   * one row can state that, so the key is the post.
   *
   * The refusal for a report that has gone and for one already answered stays
   * two different sentences, because neither says anything a board member did
   * not already know.
   */
  private async claim(
    tx: Prisma.TransactionClient,
    reportId: string,
    actor: Principal,
    upheld: boolean,
  ): Promise<{ id: string; post: ClaimedPost }> {
    const report = await tx.postReport.findUnique({
      where: { id: reportId },
      select: {
        id: true,
        post: { select: { id: true, audienceId: true, authorPersonId: true } },
      },
    });
    if (report === null) {
      throw new FeedError("There is no such report.", "report-not-found");
    }

    await lockPost(tx, report.post.id);

    const { count } = await tx.postReport.updateMany({
      where: { id: report.id, resolvedAt: null },
      data: {
        resolvedAt: new Date(),
        resolvedByPersonId: actor.personId,
        upheld,
      },
    });
    if (count === 0) {
      throw new FeedError(
        "The board has already answered this report.",
        "report-resolved",
      );
    }

    return report;
  }

  /** Whether this account is on the board today. */
  private async holdsSeat(actor: Principal): Promise<boolean> {
    return holdsBoardSeat(this.prisma, actor.personId, new Date());
  }

  /**
   * Refuses an account that holds the capability and no seat.
   *
   * The same refusal as a report that does not exist, on the groups' own rule:
   * an answer that told the two apart would say whether a private group has been
   * reported to somebody who may not be told that it exists.
   */
  private async requireSeat(actor: Principal): Promise<void> {
    if (!(await this.holdsSeat(actor))) {
      throw new FeedError("There is no such report.", "report-not-found");
    }
  }

  /**
   * The post this person may report, or the one refusal.
   *
   * Three things have to hold and they collapse into one answer: the post
   * exists, it is in an audience this person is in, and that audience is a
   * group. The third is not a leak - everybody on the board knows they are in
   * Styrelsen - but it is answered plainly, because it is a published rule and
   * not a fact about any group.
   *
   * A group's post alone, for now. Alla's posts are the board's to moderate
   * directly, and the change that adds that moderation decides how; until then a
   * post there is refused as Styrelsen's is.
   */
  private async requireReportablePost(
    postId: string,
    reporter: Principal,
  ): Promise<{ id: string; audienceId: string }> {
    const post = await postFor(
      this.prisma,
      postId,
      reporter.personId,
      new Date(),
    );
    if (post === null) {
      throw new FeedError("There is no such post.", "post-not-found");
    }

    if (post.audience.kind !== "GROUP") {
      /*
       * Said plainly rather than answered as an absence. Styrelsen has no
       * strike-through, that is a rule the product states, and somebody in
       * either audience is not learning anything about a group here.
       */
      throw new FeedError(
        "Only a post in a group can be reported to the board.",
        "not-reportable",
      );
    }

    if (post.struckAt !== null) {
      throw new FeedError(
        "The board has already struck this post through.",
        "report-resolved",
      );
    }

    return { id: post.id, audienceId: post.audience.id };
  }

  /** One report, read back after the board acted on it. */
  private async byId(reportId: string): Promise<PostReportView> {
    const row = await this.prisma.postReport.findUnique({
      where: { id: reportId },
      select: REPORT_COLUMNS,
    });
    const [view] = row === null ? [] : await this.toViews([row]);
    if (view === undefined) {
      // Unreachable: the act above wrote this row and nothing deletes one
      // except the purge erasing the post it is about.
      throw new FeedError("There is no such report.", "report-not-found");
    }
    return view;
  }

  /** Every report in a page, with the people in it resolved in one read. */
  private async toViews(rows: readonly ReportRow[]): Promise<PostReportView[]> {
    const attribute = await readAuthors(
      this.prisma,
      rows.flatMap((row) => [
        row.reporterPersonId,
        row.post.authorPersonId,
        row.post.audience.createdByPersonId,
      ]),
    );
    const named = (personId: string | null) =>
      personId === null ? ({ kind: "unknown" } as const) : attribute(personId);

    return rows.map((row) => ({
      reportId: row.id,
      reportedAt: row.createdAt.toISOString(),
      reporter: attribute(row.reporterPersonId),
      note: row.note,
      groupName: row.post.audience.name,
      groupCreatedBy: named(row.post.audience.createdByPersonId),
      postId: row.post.id,
      author: named(row.post.authorPersonId),
      // In full, and never withheld from this reader: the board is deciding
      // about this text, and a decision about text nobody is shown is not one.
      // A reported post is a resident's, which always carries its own text.
      body: row.post.body ?? "",
      writtenAt: row.post.createdAt.toISOString(),
      struckAt: row.post.struckAt?.toISOString() ?? null,
    }));
  }
}

const REPORT_COLUMNS = {
  id: true,
  reporterPersonId: true,
  note: true,
  createdAt: true,
  post: {
    select: {
      id: true,
      audienceId: true,
      authorPersonId: true,
      body: true,
      struckAt: true,
      createdAt: true,
      audience: { select: { name: true, createdByPersonId: true } },
    },
  },
} as const satisfies Prisma.PostReportSelect;

/** The post a claimed report is about. */
interface ClaimedPost {
  id: string;
  audienceId: string;
  authorPersonId: string | null;
}

type ReportRow = Prisma.PostReportGetPayload<{
  select: typeof REPORT_COLUMNS;
}>;
