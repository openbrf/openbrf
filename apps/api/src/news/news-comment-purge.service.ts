import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockLegalHold } from "../retention/legal-hold-lock";
import {
  NEWS_COMMENT_RETENTION_DAYS,
  newsCommentPurgeCutoff,
} from "./news-comment-retention";

/** Queue the nightly news comment purge runs on. */
export const NEWS_COMMENT_PURGE_QUEUE = "news-comment-purge";

/**
 * When it runs.
 *
 * In the small hours, on a minute of its own. The import session purge takes
 * 03:23, the service data purge 03:41 and the booking purge 03:53, so this one
 * takes 03:11 - twelve minutes clear of the nearest of them, and clear of 03:29
 * as well, which the event sign-up purge is taking. Jobs waking together on one
 * small connection pool is a contention nobody gains anything from.
 */
const PURGE_CRON = "11 3 * * *";

/**
 * The most people one run erases the comments of.
 *
 * A cooperative is 20 to 200 households and a night's worth of expiries is a
 * handful, so this is never reached in ordinary running. It exists for the first
 * run on an instance that has been commenting for years, or the day the
 * retention window is shortened: without a bound that run would erase every
 * comment ever written in one transaction-per-person loop. Nothing is lost by
 * stopping - eligibility is computed from the data rather than marked on it, so
 * the next night's run finds the rest.
 */
const MAX_PERSONS_PER_RUN = 500;

export interface NewsCommentPurgeRunSummary {
  /** People the eligibility scan found erasable comments for. */
  considered: number;
  /** People whose comments were erased. */
  purged: number;
  /** Comments deleted across all of them. */
  commentsDeleted: number;
  /**
   * People whose purge threw. The run carries on past them: one row the
   * database refuses must not stop every later person for good.
   */
  failed: number;
}

/**
 * The news comment purge (gallring av kommentarer).
 *
 * A comment is service-tier personal data - which person wrote which words
 * under which notice - and the purpose it is held for is the conversation about
 * that notice. So it is erased on a date derived from when it was written, a
 * year later, and not on the residency purge's clock: somebody who still lives
 * here has no more use for last spring's exchange about the bicycle room than
 * somebody who has left, and the residency purge would never reach it at all
 * while they stayed. The arithmetic and the reasoning are in
 * `news-comment-retention.ts`.
 *
 * ## What it erases
 *
 * The comment row, whole. There is nothing on it to blank down to: strip the
 * person and what is left is an unattributed sentence under a notice, which is
 * of no use to anybody and is still a record somebody has to keep. A hidden
 * comment goes the same way as one that stands - moderation is not a reason to
 * keep somebody's words longer, and the audit log's entry for the hide is what
 * outlives the row.
 *
 * The news items themselves are never touched. A notice the board published is
 * the association's own account of itself; only the comments under it are
 * personal data on anybody's clock.
 *
 * ## Legal hold
 *
 * A hold standing against the person who wrote the comment stops it, the way it
 * stops the residency purge and the booking purge. The ground under GDPR art.
 * 17.3 is about the person's data rather than about one table, so a dispute that
 * keeps somebody's contact details keeps the comments that may be what the
 * dispute is about - what was said in a thread about a neighbour is exactly the
 * record a hold exists to preserve.
 *
 * The hold is checked twice: once in the scan, and again inside the transaction
 * that deletes. The second one is the one that counts, because a hold placed
 * while the run was in flight has to win, and the board member who clicked that
 * button is entitled to assume it did. That second check is taken under the
 * advisory lock in `retention/legal-hold-lock.ts`, which is what makes it a
 * decision rather than a race: a placement takes the same key, so it either
 * lands before the check and stops the run or waits for it and takes effect from
 * the moment it commits.
 *
 * The scan's check is not a duplicate of it. Held people are excluded by the
 * query rather than dropped from its answer, so they cannot spend a run's bound
 * without anything being erased - see {@link NewsCommentPurgeService.eligible}.
 *
 * ## How it runs
 *
 * One person per transaction, like the residency and booking purges and for the
 * same reasons. A crash halfway through leaves what it finished finished and the
 * rest for tomorrow, because eligibility is computed from `createdAt` and the
 * window rather than from a flag somebody has to keep in step; and a person with
 * nothing left to erase is not selected, so nobody collects an entry a night for
 * ever in a table that cannot be tidied.
 *
 * The entry is SERVICE_DATA_PURGED with a targetKind of "newsComment", rather
 * than an action of its own. It is the same act the log already has a word for -
 * service-tier data past its retention date was erased - and one entry per
 * person is what lets a later access report say which of that person's data went
 * and when. The count says how much; the comments themselves are gone, which is
 * the point.
 */
@Injectable()
export class NewsCommentPurgeService implements OnModuleInit {
  private readonly logger = new Logger(NewsCommentPurgeService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the purge with a clock of their own, so a
      // worker must not race them with the real one.
      return;
    }
    await this.startPurgeWorker();
  }

  /** Registers the purge. Public so an integration test can drive the job. */
  async startPurgeWorker(): Promise<void> {
    await this.jobs.work(NEWS_COMMENT_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(NEWS_COMMENT_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every comment past its purge date, person by person.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting a year.
   * @param retentionDays How long a comment is kept.
   */
  async run(
    now: Date = new Date(),
    retentionDays: number = NEWS_COMMENT_RETENTION_DAYS,
  ): Promise<NewsCommentPurgeRunSummary> {
    const personIds = await this.eligible(now, retentionDays);

    let purged = 0;
    let commentsDeleted = 0;
    let failed = 0;
    for (const personId of personIds) {
      try {
        const deleted = await this.purgePerson(personId, now, retentionDays);
        if (deleted > 0) {
          purged += 1;
          commentsDeleted += deleted;
        }
      } catch (error) {
        // The class of the failure and the person id, and nothing the failure
        // was holding: an exception message here can be quoting a row.
        failed += 1;
        this.logger.error(
          `News comment purge failed for person ${personId}: ${failureName(
            error,
          )}`,
        );
      }
    }

    if (commentsDeleted > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(commentsDeleted)} news comments for ${String(
          purged,
        )} of ${String(personIds.length)} eligible persons`,
      );
    }
    if (personIds.length === MAX_PERSONS_PER_RUN) {
      this.logger.log(
        `News comment purge stopped at its per-run bound of ${String(
          MAX_PERSONS_PER_RUN,
        )}; the rest are erased by the next run.`,
      );
    }

    return { considered: personIds.length, purged, commentsDeleted, failed };
  }

  /**
   * The people who wrote at least one comment whose retention has run out.
   *
   * Grouped by the author rather than listing comments, because the unit of work
   * is a person: one transaction, one audit entry, one answer to "what of mine
   * was erased and when".
   *
   * A person under an open legal hold is excluded by the query itself rather
   * than filtered out of its answer, and that ordering is the whole reason for
   * the extra round trip. The per-run bound is applied by the database, so held
   * people removed afterwards would still have spent it: five hundred held
   * people sorting ahead of everybody else would fill every run for as long as
   * their holds stood, and the comments behind them would outlive their
   * retention window with nothing reporting a fault. The residency purge states
   * the same rule as `legalHolds: { none: { releasedAt: null } }` inside its own
   * scan, and the booking purge states it exactly as this one does.
   *
   * `authorPersonId` is a plain column and not a relation, so the holds are read
   * first and passed in rather than joined - the same trade the audit log makes,
   * and the reason a purge can reach this table at all. The list is bounded by
   * the register, since at most one hold stands per person, and a hold is a
   * dispute rather than an ordinary state.
   *
   * The hold is checked again inside the transaction that deletes. That is the
   * check that counts.
   */
  async eligible(now: Date, retentionDays: number): Promise<string[]> {
    const cutoff = newsCommentPurgeCutoff(now, retentionDays);
    const held = await this.heldPersonIds();

    const groups = await this.prisma.newsComment.groupBy({
      by: ["authorPersonId"],
      where: {
        createdAt: { lte: cutoff },
        // Spelled conditionally rather than as an empty `notIn`, so what the
        // query asks does not depend on how the client renders a list of none.
        ...(held.length > 0 ? { authorPersonId: { notIn: held } } : {}),
      },
      orderBy: [{ authorPersonId: "asc" }],
      take: MAX_PERSONS_PER_RUN,
    });

    return groups.map((group) => group.authorPersonId);
  }

  /**
   * Erases one person's expired comments, and answers how many went.
   *
   * The deletion and the entry that records it are one transaction. An audit log
   * claiming a purge that rolled back would be worse than no log: the entry is
   * the only evidence that data which no longer exists ever did, and it is
   * written into a table nobody can correct.
   */
  async purgePerson(
    personId: string,
    now: Date = new Date(),
    retentionDays: number = NEWS_COMMENT_RETENTION_DAYS,
  ): Promise<number> {
    const cutoff = newsCommentPurgeCutoff(now, retentionDays);

    return this.prisma.$transaction(async (tx) => {
      /*
       * Before the hold is read, so that reading it settles the question.
       * Everything below runs at READ COMMITTED, where a placement committing
       * between the read and the delete would leave this transaction erasing the
       * rows the hold was placed to preserve - and the board member would have
       * been told the person was held. `LegalHoldService.place` takes the same
       * key, which is what makes the two orderable at all.
       */
      await lockLegalHold(tx, personId);

      const held = await tx.legalHold.findFirst({
        where: { personId, releasedAt: null },
        select: { id: true },
      });
      if (held !== null) {
        /*
         * Re-checked here rather than trusted from the scan. A hold placed
         * between the scan and this transaction has to win: the board member who
         * placed it is entitled to assume it took effect, and this is the moment
         * where that is either true or a promise nobody kept.
         */
        return 0;
      }

      const { count } = await tx.newsComment.deleteMany({
        where: { authorPersonId: personId, createdAt: { lte: cutoff } },
      });
      if (count === 0) {
        // The scan filters these out, so reaching here means the last of them
        // went while this ran. An entry for an erasure that erased nothing would
        // be a false record in a table that cannot be corrected.
        return 0;
      }

      await this.audit.record(
        {
          action: "SERVICE_DATA_PURGED",
          // No actor: nobody clicked this. The job ran because a date arrived,
          // which is what the retention window promised would happen.
          actorPersonId: null,
          targetPersonId: personId,
          targetKind: "newsComment",
          /*
           * How many, and the window they fell out of. Not which news item, and
           * not a word of what any of them said - the retention rule on
           * AuditLogService. This entry names the person and outlives the rows
           * it describes by design, and the log is exempt from every purge, so
           * text copied in here would be a permanent record of what somebody
           * said about a neighbour, inside the entry that says it was erased.
           */
          context: {
            newsComments: count,
            retentionDaysAfterComment: retentionDays,
          },
        },
        tx,
      );

      return count;
    });
  }

  /**
   * Everybody a legal hold currently stands against.
   *
   * Read whole rather than asked about a shortlist, because the scan needs them
   * before it chooses its shortlist rather than after. One row per held person
   * at most, and a hold is a dispute the board entered deliberately, so this is
   * a handful of ids in a cooperative that has any at all.
   */
  private async heldPersonIds(): Promise<string[]> {
    const holds = await this.prisma.legalHold.findMany({
      where: { releasedAt: null },
      select: { personId: true },
      distinct: ["personId"],
    });
    return holds.map((hold) => hold.personId);
  }
}
