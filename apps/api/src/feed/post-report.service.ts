import { Injectable, Logger } from "@nestjs/common";
import type { PostReportQueueView, PostReportView } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import { isUniqueViolation } from "../database/unique-violation";
import type { Prisma } from "../generated/prisma/client";
import { mediaUrl } from "../media/media.service";
import {
  type FeedDbClient,
  postFor,
  type ReachablePost,
  refuseErasedPost,
} from "./feed-audience";
import { readAuthors } from "./feed-author";
import { type FeedCursor, feedCursor, newerThan } from "./feed-cursor";
import { lockComment, lockFeedPerson, lockPost } from "./feed-lock";
import { FeedError, refusePersonalIdentityNumbers } from "./feed.error";
import type { ReachedComment } from "./post-comment.service";
import {
  answersReports,
  isModerated,
  type ModeratedThing,
  moderatedComment,
  moderatedPost,
  moderationOf,
  OPEN_REPORT,
  strikesWithoutReport,
} from "./post-report-access";

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
 * Bounded like every other read here, and paged forwards from a cursor like
 * the feed: a board that has let fifty reports stand reads the next fifty after
 * them rather than never seeing them.
 */
export const REPORTS_PER_PAGE = 50;

/**
 * How many reports one person may make in {@link REPORT_WINDOW_MINUTES}.
 *
 * One report per post and per comment is the constraint's rule, and it bounds
 * nothing about one person: every comment under every post in Alla is a thing
 * they may report, and each would be a row in the board's queue. Ten in an
 * hour is more than anybody with something to tell the board needs, and keeps
 * one reader from filling the queue with a thread.
 *
 * Counted from the rows and again under the reporter's own lock, on the
 * comments' terms, so reports in flight together cannot all pass it.
 */
export const REPORTS_PER_WINDOW = 10;

/** The window {@link REPORTS_PER_WINDOW} is counted over. */
export const REPORT_WINDOW_MINUTES = 60;

/** What a report is about: one post, or one comment. */
export type ReportSubject = { postId: string } | { commentId: string };

/**
 * The board's moderation of the feed: reports, and striking through.
 *
 * ## Alla, and a group
 *
 * A post or a comment in Alla, or in a group, can be reported to the board,
 * and the board strikes it through or leaves it standing. What differs between
 * the two is how the board gets there.
 *
 * In Alla the board is part of the audience. It reads everything said there and
 * answers for it, so it strikes a resident's post or a comment through without
 * waiting for anybody to ask, and a neighbour's report is a way of making sure
 * it looks.
 *
 * A group is invisible to anybody who is not in it. It is not listed, and asked
 * for by identifier it is refused exactly as a group that does not exist - so
 * there is no queue of groups for the board to watch, no count of them on any
 * screen, and no way for the board to learn that a group exists at all. What
 * there is, is this: somebody inside the group carries one post or one comment
 * out. The report is what makes that one thing readable by the board, and it
 * makes nothing else readable - not the post before it, not the post a comment
 * answers, not the group's other members, not the group.
 *
 * ## Why the board can moderate a group it cannot read
 *
 * Because somebody in it asked. The association is answerable for what its
 * platform holds, and a resident who is being written about in a private group
 * has nowhere else to go; what they must not have to do to get an answer is hand
 * the board the group. So the report carries one post or one comment and the
 * board decides about that: struck through, or left standing.
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
 * path through this service asks the register for the seat, and the media
 * route asks the same question before it serves a reported post's images -
 * `post-report-access.ts`, so the two cannot answer it differently.
 *
 * ## What striking does and does not do
 *
 * It withholds the text from the rest of the audience and from nobody else's
 * copy of it: the row stays where it is, attributed as before, its author still
 * reads it, the board still reads it, and the retention clock it was written
 * under is unchanged. Nothing here erases anything, and nothing clears a strike.
 *
 * Styrelsen and Administratörer have no strike-through at all, and nothing in
 * them can be reported. The board is the whole of the one and half of the
 * other, and a board able to strike a colleague's line would be deciding what
 * the record of its own deliberation says. A post written as Styrelsen is a
 * news item, which the board takes down on the news screen rather than strikes.
 */
@Injectable()
export class PostReportService {
  private readonly logger = new Logger(PostReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Reports a post or a comment to the board.
   *
   * Writes no audit entry, and the departure from the rule beside it is
   * deliberate: the report row is the record. It says who reported what, when,
   * and what the board did about it, which is more than an entry naming the act
   * could carry - and unlike an entry it is erased with what it is about, so a
   * report does not outlive the words it was about.
   */
  async report(
    reporter: Principal,
    subject: ReportSubject,
    note: string | null,
  ): Promise<{ reportId: string }> {
    const now = new Date();
    const target =
      "postId" in subject
        ? await this.requireReportablePost(subject.postId, reporter, now)
        : await this.requireReportableComment(subject.commentId, reporter, now);

    if (note !== null) {
      refusePersonalIdentityNumbers(note, "note");
    }

    const existing = await this.prisma.postReport.findFirst({
      where: { ...target.key, reporterPersonId: reporter.personId },
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
      throw alreadyReported();
    }
    await refuseTooManyReports(this.prisma, reporter.personId);

    const created = await this.prisma
      .$transaction(async (tx) => {
        // The reporter's own lock first, as every write here takes it before
        // the lock on what it writes about.
        await lockFeedPerson(tx, reporter.personId);
        await refuseTooManyReports(tx, reporter.personId);

        /*
         * Inserted under the lock the board takes to answer a report, with the
         * strike-through read again under it. A report arriving while a strike
         * commits would otherwise be inserted after the strike closed every
         * open report, and a later dismissal of it would record the board
         * leaving standing something that carries a strike.
         */
        if ("postId" in target.key) {
          await lockPost(tx, target.key.postId);
          // Under a share lock as well, so a report never lands on a post the
          // purge erased while it was on its way, after the purge took the
          // others.
          const current = await refuseErasedPost(tx, target.key.postId);
          if (current.struckAt !== null) {
            throw alreadyStruck();
          }
        } else {
          await lockComment(tx, target.key.commentId);
          // Under a row lock, so a report never lands on a comment the purge
          // deleted while it was on its way.
          const current = await readCommentLocked(tx, target.key.commentId);
          if (current === null) {
            throw new FeedError(
              "There is no such comment.",
              "comment-not-found",
            );
          }
          if (current.struckAt !== null) {
            throw alreadyStruck();
          }
        }

        return tx.postReport.create({
          data: {
            ...target.key,
            reporterPersonId: reporter.personId,
            note,
          },
          select: { id: true },
        });
      })
      .catch((cause: unknown) => {
        /*
         * The read above narrows the window; the unique constraint on the
         * subject and the reporter closes it. Two presses on one button arrive
         * together, both pass the read, and the second insert raises P2002 -
         * which without this reaches the reporter as a fault where the refusal
         * the sentence above promises belongs.
         */
        if (isUniqueViolation(cause)) {
          throw alreadyReported();
        }
        throw cause;
      });

    // The audience and the kind of thing, and nothing that was said in it.
    this.logger.log(
      `A ${"postId" in target.key ? "post" : "comment"} in audience ${target.audienceId} was reported to the board`,
    );

    return { reportId: created.id };
  }

  /**
   * What the board has been asked to look at, oldest first, a page at a time.
   *
   * Open reports only. A resolved one is the record of a decision and stays on
   * the row; a queue that kept showing it would be a queue that never empties.
   *
   * Paged forwards on `(createdAt, id)`, the feed's own cursor, written out so
   * a report the board answered - or the purge took - between two pages does
   * not lose the board its place. Answering a report on the first page moves
   * nothing on the next one: the cursor names an instant and an identifier,
   * not a position in a list that is getting shorter.
   */
  async queue(
    reader: Principal,
    after: FeedCursor | null,
  ): Promise<PostReportQueueView> {
    if (!(await this.holdsSeat(reader))) {
      /*
       * Nothing, and the screen is told why rather than being handed an empty
       * queue: "nothing has been reported" is a fact about groups this account
       * may not know anything about.
       */
      return { reports: [], next: null, mayModerate: false };
    }

    const rows = await this.prisma.postReport.findMany({
      where: { ...OPEN_REPORT, ...(after === null ? {} : newerThan(after)) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      // One more than a page, so the answer can say whether there is another
      // without a count of the whole queue.
      take: REPORTS_PER_PAGE + 1,
      select: REPORT_COLUMNS,
    });
    const page = rows.slice(0, REPORTS_PER_PAGE);
    const last = page.at(-1);

    return {
      reports: await this.toViews(page),
      next:
        rows.length > REPORTS_PER_PAGE && last !== undefined
          ? feedCursor(last)
          : null,
      mayModerate: true,
    };
  }

  /**
   * Strikes the reported post or comment through, and closes every open report
   * on it.
   *
   * In a group the board reaches what it strikes through the report and never
   * by its own identifier, which is what keeps the board's way in to one thing:
   * a board member cannot strike a group's post nobody has reported, because
   * the only route that takes a post strikes in Alla alone.
   *
   * Every other open report on the same post or comment is closed with it. They
   * were asking the same question and it has been answered, and a queue that
   * kept asking it would have the board decide the same thing twice.
   */
  async strike(actor: Principal, reportId: string): Promise<PostReportView> {
    await this.requireSeat(actor);

    const { subject, struck, row } = await this.prisma.$transaction(
      async (tx) => {
        const claimed = await this.claim(tx, reportId, actor, true);
        return {
          subject: claimed.kind,
          struck: await strikeIn(tx, this.audit, claimed, actor),
          row: await answeredRow(tx, reportId),
        };
      },
    );

    if (struck) {
      this.logger.log(`A ${subject} reported to the board was struck through`);
    }

    return this.viewOf(row);
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

    const row = await this.prisma.$transaction(async (tx) => {
      const claimed = await this.claim(tx, reportId, actor, false);

      /*
       * Every open report about the same post or comment, exactly as striking
       * closes every one of them. They were asking the same question and the
       * board has answered it; a sibling left open would let the same thing be
       * struck through afterwards, which is the decision the board has just
       * declined to make.
       */
      await tx.postReport.updateMany({
        where: { ...reportKey(claimed), resolvedAt: null },
        data: {
          resolvedAt: new Date(),
          resolvedByPersonId: actor.personId,
          upheld: false,
        },
      });

      return answeredRow(tx, reportId);
    });

    return this.viewOf(row);
  }

  /**
   * Strikes a resident's post in Alla through, without a report.
   *
   * The board is in Alla and answers for what is said there, so it does not
   * wait to be asked. Everywhere else is refused: a group is reached only
   * through a report (ADR 0012), Styrelsen and Administratörer have no
   * strike-through, and a post written as Styrelsen is a news item, taken down
   * on the news screen.
   *
   * A post the board may not read is refused exactly as one that does not
   * exist, before anything else is asked of it.
   *
   * Striking one already struck changes nothing and writes nothing, as a second
   * press on a report's strike does not.
   */
  async strikePost(actor: Principal, postId: string): Promise<void> {
    const now = new Date();
    const post = await postFor(this.prisma, postId, actor.personId, now);
    if (post === null) {
      throw new FeedError("There is no such post.", "post-not-found");
    }
    await this.requireBoard(actor, now);
    if (!strikesWithoutReport(post.audience.kind) || post.byBoard) {
      throw notStrikeable();
    }
    if (post.erasedAt !== null) {
      throw new FeedError("This post has been erased.", "post-erased");
    }

    const struck = await this.prisma.$transaction(async (tx) => {
      await lockPost(tx, post.id);
      // Read again under a share lock, on the report's own argument: the
      // purge can erase the post while this was on its way.
      await refuseErasedPost(tx, post.id);
      return strikeIn(
        tx,
        this.audit,
        {
          kind: "post",
          id: post.id,
          audienceId: post.audience.id,
          authorPersonId: post.authorPersonId,
        },
        actor,
      );
    });

    if (struck) {
      this.logger.log(
        `A post in audience ${post.audience.id} was struck through`,
      );
    }
  }

  /**
   * Strikes a comment under a post in Alla through, without a report: on
   * {@link strikePost}'s terms, one level down.
   *
   * Whoever wrote the post it is under, the board included: a comment is one
   * person's words, and the comment under a notice is a neighbour's like any
   * other.
   *
   * Answers the comment it reached, and the post that let it, so the comment
   * can be shown as the board now reads it without asking that again.
   */
  async strikeComment(
    actor: Principal,
    commentId: string,
  ): Promise<ReachedComment> {
    const now = new Date();
    const comment = await this.prisma.postComment.findUnique({
      where: { id: commentId },
      select: { id: true, postId: true, authorPersonId: true },
    });
    const post =
      comment === null
        ? null
        : await postFor(this.prisma, comment.postId, actor.personId, now);
    if (comment === null || post === null) {
      throw new FeedError("There is no such comment.", "comment-not-found");
    }
    await this.requireBoard(actor, now);
    if (!strikesWithoutReport(post.audience.kind)) {
      throw notStrikeable();
    }

    const struck = await this.prisma.$transaction(async (tx) => {
      await lockComment(tx, comment.id);
      if ((await readCommentLocked(tx, comment.id)) === null) {
        // Gone to the purge while this was on its way.
        throw new FeedError("There is no such comment.", "comment-not-found");
      }
      return strikeIn(
        tx,
        this.audit,
        {
          kind: "comment",
          id: comment.id,
          audienceId: post.audience.id,
          authorPersonId: comment.authorPersonId,
        },
        actor,
      );
    });

    if (struck) {
      this.logger.log(
        `A comment in audience ${post.audience.id} was struck through`,
      );
    }

    return { id: comment.id, authorPersonId: comment.authorPersonId, post };
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
   * Two presses on two reports of the same post or comment are settled by the
   * lock. The decision is about what was reported: one answer closes every
   * report of it, so two answers arriving together could otherwise leave the
   * record saying the board left a post standing while the post carries a
   * strike. Nothing about one row can state that, so the key is the post or the
   * comment.
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
  ): Promise<StruckThing> {
    const report = await tx.postReport.findUnique({
      where: { id: reportId },
      select: {
        id: true,
        post: { select: { id: true, audienceId: true, authorPersonId: true } },
        comment: {
          select: {
            id: true,
            authorPersonId: true,
            post: { select: { audienceId: true } },
          },
        },
      },
    });
    if (report === null) {
      throw reportNotFound();
    }

    /*
     * The reported row before the report's, which is the order the purge takes
     * them in: it updates or deletes the post or the comment, and the reports
     * on it go after. Claiming the report first would have each holding the
     * row the other waits for. An erasure that committed while this waited took
     * the report with it, and is answered as the report having gone.
     */
    let claimed: StruckThing;
    if (report.post !== null) {
      await lockPost(tx, report.post.id);
      await refuseErasedPost(tx, report.post.id).catch((cause: unknown) => {
        throw cause instanceof FeedError ? reportNotFound() : cause;
      });
      claimed = { kind: "post", ...report.post };
    } else if (report.comment !== null) {
      await lockComment(tx, report.comment.id);
      if ((await readCommentLocked(tx, report.comment.id)) === null) {
        throw reportNotFound();
      }
      claimed = {
        kind: "comment",
        id: report.comment.id,
        audienceId: report.comment.post.audienceId,
        authorPersonId: report.comment.authorPersonId,
      };
    } else {
      // Unreachable: a check constraint holds exactly one of the two.
      throw reportNotFound();
    }

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

    return claimed;
  }

  /** Whether this account answers reports: the capability and a seat today. */
  private async holdsSeat(actor: Principal): Promise<boolean> {
    return answersReports(this.prisma, actor, new Date());
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
      throw reportNotFound();
    }
  }

  /**
   * Refuses a strike without a report by somebody who is not the board.
   *
   * Said plainly, unlike {@link requireSeat}: it is asked only about a post the
   * caller already reads in Alla, so it tells them nothing about any group.
   */
  private async requireBoard(actor: Principal, now: Date): Promise<void> {
    if (!(await answersReports(this.prisma, actor, now))) {
      throw new FeedError(
        "Only somebody holding a board seat strikes a post through.",
        "not-board",
      );
    }
  }

  /**
   * The post this person may report, or the one refusal.
   *
   * It has to exist and be in an audience this person is in, and those two
   * collapse into one answer. That the audience is one where reports are taken
   * is answered plainly rather than as an absence: Styrelsen and
   * Administratörer having no strike-through is a published rule and not a
   * fact about any group, and so is a post written as Styrelsen being a news
   * item - and so is a report of one's own words, or the board's in Alla,
   * which the feed never offers ({@link refuseUnoffered}).
   */
  private async requireReportablePost(
    postId: string,
    reporter: Principal,
    now: Date,
  ): Promise<ReportTarget> {
    const post = await postFor(this.prisma, postId, reporter.personId, now);
    if (post === null) {
      throw new FeedError("There is no such post.", "post-not-found");
    }
    if (post.erasedAt !== null) {
      // Nothing is left on it to report, and the reports already made went
      // with the text.
      throw new FeedError("This post has been erased.", "post-erased");
    }
    refuseUnmoderated(post);
    if (post.byBoard) {
      throw new FeedError(
        "A post written as Styrelsen is a news item and is not reported.",
        "not-reportable",
      );
    }
    if (post.struckAt !== null) {
      throw alreadyStruck();
    }
    await this.refuseUnoffered(moderatedPost(post), reporter, now);

    return { key: { postId: post.id }, audienceId: post.audience.id };
  }

  /**
   * The comment this person may report, or the one refusal: on
   * {@link requireReportablePost}'s terms, asked of the post it is under.
   *
   * Under an erased post as well. The purge erased the post's text on its
   * writer's clock, and the comment stands on its own: somebody can still be
   * written about in it.
   */
  private async requireReportableComment(
    commentId: string,
    reporter: Principal,
    now: Date,
  ): Promise<ReportTarget> {
    const comment = await this.prisma.postComment.findUnique({
      where: { id: commentId },
      select: { id: true, postId: true, authorPersonId: true, struckAt: true },
    });
    const post =
      comment === null
        ? null
        : await postFor(this.prisma, comment.postId, reporter.personId, now);
    if (comment === null || post === null) {
      throw new FeedError("There is no such comment.", "comment-not-found");
    }
    refuseUnmoderated(post);
    if (comment.struckAt !== null) {
      throw alreadyStruck();
    }
    await this.refuseUnoffered(
      moderatedComment(comment, post.audience.kind),
      reporter,
      now,
    );

    return { key: { commentId: comment.id }, audienceId: post.audience.id };
  }

  /**
   * Refuses a report the feed does not offer this reader
   * (`post-report-access.ts`): of their own words, and from the board in Alla,
   * which strikes there rather than reporting to itself.
   *
   * Asked after the refusals that have a sentence of their own, so those are
   * the ones a reader meets, and with "already reported" left to its own
   * sentence below.
   */
  private async refuseUnoffered(
    thing: ModeratedThing,
    reporter: Principal,
    now: Date,
  ): Promise<void> {
    const { mayReport } = moderationOf(thing, {
      personId: reporter.personId,
      // Asked of the register only in Alla, where the answer turns on it.
      moderates:
        strikesWithoutReport(thing.kind) &&
        (await answersReports(this.prisma, reporter, now)),
      reported: false,
    });
    if (!mayReport) {
      throw new FeedError(
        "Nobody reports their own words to the board, and the board strikes through in Alla rather than reporting to itself.",
        "not-reportable",
      );
    }
  }

  /** One report as the board is shown it, once the board has answered it. */
  private async viewOf(row: ReportRow): Promise<PostReportView> {
    const [view] = await this.toViews([row]);
    if (view === undefined) {
      // Unreachable: a check constraint holds exactly one of the two.
      throw reportNotFound();
    }
    return view;
  }

  /** Every report in a page, with the people in it resolved in one read. */
  private async toViews(rows: readonly ReportRow[]): Promise<PostReportView[]> {
    const attribute = await readAuthors(
      this.prisma,
      rows.flatMap((row) => {
        const audience = audienceOf(row);
        return [
          row.reporterPersonId,
          row.post?.authorPersonId ?? null,
          row.comment?.authorPersonId ?? null,
          audience?.createdByPersonId ?? null,
        ];
      }),
    );
    const named = (personId: string | null) =>
      personId === null ? ({ kind: "unknown" } as const) : attribute(personId);

    return rows.flatMap((row): PostReportView[] => {
      const audience = audienceOf(row);
      if (audience === null) {
        // Unreachable: a check constraint holds exactly one of the two.
        return [];
      }
      const group = audience.kind === "GROUP";
      const common = {
        reportId: row.id,
        reportedAt: row.createdAt.toISOString(),
        reporter: attribute(row.reporterPersonId),
        note: row.note,
        audienceKind: audience.kind,
        groupName: group ? audience.name : null,
        groupCreatedBy: group ? named(audience.createdByPersonId) : null,
      };

      if (row.comment !== null) {
        return [
          {
            ...common,
            /*
             * The post a comment answers only where the board reads it anyway.
             * From a group the report carries the comment and nothing else:
             * not the post, and not where to find it.
             */
            postId: group ? null : row.comment.postId,
            commentId: row.comment.id,
            author: attribute(row.comment.authorPersonId),
            // In full, as a post's: the board is deciding about this text.
            body: row.comment.body,
            images: [],
            writtenAt: row.comment.createdAt.toISOString(),
            struckAt: row.comment.struckAt?.toISOString() ?? null,
          },
        ];
      }

      const post = row.post;
      if (post === null) {
        return [];
      }
      return [
        {
          ...common,
          postId: post.id,
          commentId: null,
          author: named(post.authorPersonId),
          // In full, and never withheld from this reader: the board is deciding
          // about this text, and a decision about text nobody is shown is not
          // one. A reported post is a resident's, which always carries its own
          // text.
          body: post.body ?? "",
          /*
           * And its pictures, which are part of what was said, while the report
           * is open: that is what lets the board's account fetch a group's at
           * all (`feed-image.ts`). A report the board has answered - the one
           * read back after striking or dismissing - carries none, because the
           * media route would no longer serve a group's through it.
           */
          images:
            row.resolvedAt === null
              ? post.images.map(({ file }) => ({
                  id: file.id,
                  url: mediaUrl(file.id),
                  width: file.width,
                  height: file.height,
                }))
              : [],
          writtenAt: post.createdAt.toISOString(),
          struckAt: post.struckAt?.toISOString() ?? null,
        },
      ];
    });
  }
}

/**
 * Strikes a post or a comment through and closes every open report of it,
 * inside the caller's transaction and under its lock on what is struck: the
 * one act behind a report's strike and the board's own in Alla.
 *
 * Never an erased post: the strike was about text that is gone, and the board
 * member's name would be the one thing left on the row.
 *
 * Answers whether it struck, and false when it was already struck - by an
 * earlier report or an earlier press - and nothing was written and nothing
 * recorded: a second press is not a second act.
 */
async function strikeIn(
  tx: Prisma.TransactionClient,
  audit: AuditLogService,
  thing: StruckThing,
  actor: Principal,
): Promise<boolean> {
  const now = new Date();
  const data = { struckAt: now, struckByPersonId: actor.personId };
  const { count } =
    thing.kind === "post"
      ? await tx.post.updateMany({
          where: { id: thing.id, struckAt: null, erasedAt: null },
          data,
        })
      : await tx.postComment.updateMany({
          where: { id: thing.id, struckAt: null },
          data,
        });

  /*
   * Every open report of it, closed with the strike: they were asking the same
   * question, and the board has answered it about what was reported rather
   * than about one person's report.
   */
  await tx.postReport.updateMany({
    where: { ...reportKey(thing), resolvedAt: null },
    data: { resolvedAt: now, resolvedByPersonId: actor.personId, upheld: true },
  });

  if (count === 0) {
    return false;
  }

  await audit.record(
    {
      action: "CHAT_MESSAGE_STRUCK",
      channel: "WEB",
      actorPersonId: actor.personId,
      // The subject is whoever wrote it: this is something done to them, and
      // their access report has to show a moderation somebody else decided.
      targetPersonId: thing.authorPersonId,
      /*
       * The audit vocabulary the chat wrote for a post, kept so this entry
       * reads as every earlier strike does (ADR 0026), and the comment as the
       * target of the same act one level down: the log names acts rather than
       * tables.
       */
      targetKind: thing.kind === "post" ? "chatMessage" : "postComment",
      targetId: thing.id,
      // Which audience, and never what was said in it: the log is append-only
      // and outside every purge, so a body copied here would outlive the text
      // the purge erased.
      context: { chatId: thing.audienceId },
    },
    tx,
  );
  return true;
}

/** The reports of a post or a comment, as the report rows name it. */
function reportKey(
  thing: StruckThing,
): { postId: string } | { commentId: string } {
  return thing.kind === "post" ? { postId: thing.id } : { commentId: thing.id };
}

/**
 * The report the board has just answered, read inside the transaction that
 * answered it.
 *
 * Inside, because the lock on what was reported is what keeps the row there:
 * the purge erasing the post or deleting the comment takes the reports on it
 * with it, and a read after the commit could find the decision recorded and
 * audited and the row gone, and answer the board member that there is no such
 * report.
 */
async function answeredRow(
  tx: Prisma.TransactionClient,
  reportId: string,
): Promise<ReportRow> {
  const row = await tx.postReport.findUnique({
    where: { id: reportId },
    select: REPORT_COLUMNS,
  });
  if (row === null) {
    // Unreachable: the claim above holds the row under its lock.
    throw reportNotFound();
  }
  return row;
}

/**
 * A comment's row under a lock, or null when the purge has deleted it.
 *
 * The comment's row before a report's, in the order the purge takes them: it
 * deletes the comment, and the reports on it go by cascade. One lock for the
 * reporter and for the board: `FOR NO KEY UPDATE` makes the purge's delete
 * wait and is all a strike's update needs, and unlike `FOR UPDATE` it does not
 * hold up a like, whose foreign key takes a key share on the row.
 *
 * Raw SQL because the client has no locking read.
 */
async function readCommentLocked(
  tx: Prisma.TransactionClient,
  commentId: string,
): Promise<{ struckAt: Date | null } | null> {
  const [row] = await tx.$queryRaw<
    { struckAt: Date | null }[]
  >`SELECT "struckAt" FROM "post_comment" WHERE "id" = ${commentId} FOR NO KEY UPDATE`;
  return row ?? null;
}

/**
 * Refuses a post or a comment in an audience that takes no report: Styrelsen
 * and Administratörer. Said plainly, because it is a published rule and
 * everybody in either knows they are in it.
 */
function refuseUnmoderated(post: ReachablePost): void {
  if (!isModerated(post.audience.kind)) {
    throw new FeedError(
      "Only a post or a comment in Alla or a group can be reported to the board.",
      "not-reportable",
    );
  }
}

/**
 * Refuses a person who has made their allowance of reports for the window
 * ({@link REPORTS_PER_WINDOW}). Counted from the rows: a report the purge has
 * since taken with what it was about no longer counts.
 */
async function refuseTooManyReports(
  db: FeedDbClient,
  reporterPersonId: string,
): Promise<void> {
  const since = new Date(Date.now() - REPORT_WINDOW_MINUTES * 60 * 1000);
  const made = await db.postReport.count({
    where: { reporterPersonId, createdAt: { gte: since } },
  });
  if (made >= REPORTS_PER_WINDOW) {
    throw new FeedError(
      "Too many reports in too short a time. Try again later.",
      "too-many-reports",
    );
  }
}

function reportNotFound(): FeedError {
  return new FeedError("There is no such report.", "report-not-found");
}

function alreadyReported(): FeedError {
  return new FeedError(
    "This has already been reported by this account.",
    "already-reported",
  );
}

function alreadyStruck(): FeedError {
  return new FeedError(
    "The board has already struck this through.",
    "report-resolved",
  );
}

function notStrikeable(): FeedError {
  return new FeedError(
    "The board strikes through without a report only a resident's post or a comment in Alla.",
    "not-strikeable",
  );
}

/** The audience a reported post or comment was said in. */
function audienceOf(row: ReportRow) {
  return row.post?.audience ?? row.comment?.post.audience ?? null;
}

const AUDIENCE_SELECT = {
  select: { kind: true, name: true, createdByPersonId: true },
} as const;

const REPORT_COLUMNS = {
  id: true,
  reporterPersonId: true,
  note: true,
  createdAt: true,
  resolvedAt: true,
  post: {
    select: {
      id: true,
      audienceId: true,
      authorPersonId: true,
      body: true,
      struckAt: true,
      createdAt: true,
      audience: AUDIENCE_SELECT,
      // In the order they were attached, as the feed shows them.
      images: {
        orderBy: [{ sortOrder: "asc" }],
        select: {
          file: { select: { id: true, width: true, height: true } },
        },
      },
    },
  },
  comment: {
    select: {
      id: true,
      postId: true,
      authorPersonId: true,
      body: true,
      struckAt: true,
      createdAt: true,
      post: { select: { audience: AUDIENCE_SELECT } },
    },
  },
} as const satisfies Prisma.PostReportSelect;

/** A post or a comment about to be struck, and where it was said. */
interface StruckThing {
  kind: "post" | "comment";
  id: string;
  audienceId: string;
  authorPersonId: string | null;
}

/** What a report is about, as the row is written, and where it was said. */
interface ReportTarget {
  key: { postId: string } | { commentId: string };
  audienceId: string;
}

type ReportRow = Prisma.PostReportGetPayload<{
  select: typeof REPORT_COLUMNS;
}>;
