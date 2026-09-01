import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockLegalHold } from "../retention/legal-hold-lock";
import { MOTION_RETENTION_DAYS, motionPurgeCutoff } from "./motion-retention";

/** Queue the nightly motion purge runs on. */
export const MOTION_PURGE_QUEUE = "motion-purge";

/**
 * When it runs.
 *
 * In the small hours, on a minute of its own: the import session purge takes
 * 03:23, the service data purge 03:41 and the booking purge 03:53, and jobs
 * waking together on one small connection pool is a contention nobody gains
 * anything from.
 */
const PURGE_CRON = "29 3 * * *";

/**
 * The most people one run erases the motions of.
 *
 * A cooperative is 20 to 200 households and a motion is an annual event, so this
 * is never reached in ordinary running. It exists for the first run on an
 * instance that has been taking motions for years, or the day the retention
 * window is shortened. Nothing is lost by stopping - eligibility is computed from
 * the data rather than marked on it, so the next night's run finds the rest.
 */
const MAX_PERSONS_PER_RUN = 500;

export interface MotionPurgeRunSummary {
  /** People the eligibility scan found erasable motions for. */
  considered: number;
  /** People whose motions were erased. */
  purged: number;
  /** Motions deleted across all of them. */
  motionsDeleted: number;
  /**
   * People whose purge threw. The run carries on past them: one row the database
   * refuses must not stop every later person for good.
   */
  failed: number;
}

/**
 * The motion purge (gallring av motioner).
 *
 * A motion is service-tier personal data - which member proposed what, in their
 * own words - and the purpose it is held for ends a while after the motion is
 * closed. So it is erased on a date derived from `closedAt` and not on the
 * residency purge's clock; the arithmetic and the reasoning are in
 * `motion-retention.ts`.
 *
 * ## What it erases
 *
 * The motion row, whole. There is nothing on it to blank down to: strip the
 * member and what is left is an anonymous proposal nobody can act on, still held
 * in a table somebody has to keep. Acknowledged and withdrawn motions go the same
 * way - a withdrawal is a record of a motion that was made, and its purpose ran
 * out on the same clock.
 *
 * An open motion is not touched at all. The scan requires a closing date, so a
 * motion still with the board is out of scope however old it is: the association
 * is processing it, so the purpose it is held for has not ended, and a queue
 * nobody has worked is something for the board to see rather than for a job to
 * erase.
 *
 * ## Legal hold
 *
 * A hold standing against the member who submitted the motion stops it, the way
 * it stops the residency and booking purges. The ground under GDPR art. 17.3 is
 * about the person's data rather than about one table, so a dispute that keeps
 * somebody's contact details keeps the motions that may be what the dispute is
 * about - an item a member put to the meeting and says was never taken up is
 * exactly the record a hold exists to preserve.
 *
 * The hold is checked twice: once in the scan, and again inside the transaction
 * that deletes. The second one is the one that counts, because a hold placed
 * while the run was in flight has to win, and the board member who clicked that
 * button is entitled to assume it did. That second check is taken under the
 * advisory lock in `retention/legal-hold-lock.ts`, which is what makes it a
 * decision rather than a race: a placement takes the same key, so it either lands
 * before the check and stops the run or waits for it and takes effect from the
 * moment it commits. A purge that reads "not held" and then deletes is a defect
 * this codebase has already had.
 *
 * The scan's check is not a duplicate of it. Held people are excluded by the
 * query rather than dropped from its answer, so they cannot spend a run's bound
 * without anything being erased - see {@link MotionPurgeService.eligible}.
 *
 * ## How it runs
 *
 * One person per transaction, like the residency and booking purges and for the
 * same reasons. A crash halfway through leaves what it finished finished and the
 * rest for tomorrow, because eligibility is computed from `closedAt` and the
 * window rather than from a flag somebody has to keep in step; and a person with
 * nothing left to erase is not selected, so nobody collects an entry a night for
 * ever in a table that cannot be tidied.
 *
 * The entry is SERVICE_DATA_PURGED with a targetKind of "motion", rather than an
 * action of its own. It is the same act the log already has a word for - service
 * tier data past its retention date was erased - and one entry per person is what
 * lets a later access report say which of that person's data went and when. The
 * count says how much; the motions themselves are gone, which is the point. What
 * the meeting decided about any of them is in the minutes, which are association
 * records in the document archive and are reached by no purge.
 */
@Injectable()
export class MotionPurgeService implements OnModuleInit {
  private readonly logger = new Logger(MotionPurgeService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the purge with a clock of their own, so a worker
      // must not race them with the real one.
      return;
    }
    await this.startPurgeWorker();
  }

  /** Registers the purge. Public so an integration test can drive the job. */
  async startPurgeWorker(): Promise<void> {
    await this.jobs.work(MOTION_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(MOTION_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every closed motion past its purge date, person by person.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting two years.
   * @param retentionDays How long a closed motion is kept.
   */
  async run(
    now: Date = new Date(),
    retentionDays: number = MOTION_RETENTION_DAYS,
  ): Promise<MotionPurgeRunSummary> {
    const personIds = await this.eligible(now, retentionDays);

    let purged = 0;
    let motionsDeleted = 0;
    let failed = 0;
    for (const personId of personIds) {
      try {
        const deleted = await this.purgePerson(personId, now, retentionDays);
        if (deleted > 0) {
          purged += 1;
          motionsDeleted += deleted;
        }
      } catch (error) {
        // The class of the failure and the person id, and nothing the failure
        // was holding: an exception message here can be quoting a row.
        failed += 1;
        this.logger.error(
          `Motion purge failed for person ${personId}: ${failureName(error)}`,
        );
      }
    }

    if (motionsDeleted > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(motionsDeleted)} motions for ${String(
          purged,
        )} of ${String(personIds.length)} eligible persons`,
      );
    }
    if (personIds.length === MAX_PERSONS_PER_RUN) {
      this.logger.log(
        `Motion purge stopped at its per-run bound of ${String(
          MAX_PERSONS_PER_RUN,
        )}; the rest are erased by the next run.`,
      );
    }

    return { considered: personIds.length, purged, motionsDeleted, failed };
  }

  /**
   * The people who submitted at least one closed motion whose retention has run
   * out.
   *
   * Grouped by the submitter rather than listing motions, because the unit of
   * work is a person: one transaction, one audit entry, one answer to "what of
   * mine was erased and when".
   *
   * A person under an open legal hold is excluded by the query itself rather than
   * filtered out of its answer, and that ordering is the whole reason for the
   * extra round trip. The per-run bound is applied by the database, so held people
   * removed afterwards would still have spent it: five hundred held people sorting
   * ahead of everybody else would fill every run for as long as their holds stood,
   * and the motions behind them would outlive their retention window with nothing
   * reporting a fault. The residency purge states the same rule inside its own
   * scan, for the same reason.
   *
   * The hold is checked again inside the transaction that deletes. That is the
   * check that counts.
   */
  async eligible(now: Date, retentionDays: number): Promise<string[]> {
    const cutoff = motionPurgeCutoff(now, retentionDays);
    const held = await this.heldPersonIds();

    const groups = await this.prisma.motion.groupBy({
      by: ["submittedByPersonId"],
      where: {
        // Both halves, and the first is not implied by the second: a null closing
        // date is not less than or equal to anything, but stating it makes the
        // rule readable as the rule it is - an open motion is out of scope
        // however old it is.
        closedAt: { not: null, lte: cutoff },
        // Spelled conditionally rather than as an empty `notIn`, so what the
        // query asks does not depend on how the client renders a list of none.
        ...(held.length > 0 ? { submittedByPersonId: { notIn: held } } : {}),
      },
      orderBy: [{ submittedByPersonId: "asc" }],
      take: MAX_PERSONS_PER_RUN,
    });

    return groups.map((group) => group.submittedByPersonId);
  }

  /**
   * Erases one person's expired motions, and answers how many went.
   *
   * The deletion and the entry that records it are one transaction. An audit log
   * claiming a purge that rolled back would be worse than no log: the entry is the
   * only evidence that data which no longer exists ever did, and it is written
   * into a table nobody can correct.
   */
  async purgePerson(
    personId: string,
    now: Date = new Date(),
    retentionDays: number = MOTION_RETENTION_DAYS,
  ): Promise<number> {
    const cutoff = motionPurgeCutoff(now, retentionDays);

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

      const { count } = await tx.motion.deleteMany({
        where: {
          submittedByPersonId: personId,
          closedAt: { not: null, lte: cutoff },
        },
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
          targetKind: "motion",
          /*
           * How many, and the window they fell out of. Not the titles and not the
           * dates any of them closed on - the retention rule on AuditLogService.
           * This entry names the person and outlives the rows it describes by
           * design, and the log is exempt from every purge, so a title copied in
           * here would be a permanent record of what somebody proposed, kept in
           * the entry that says it was erased.
           */
          context: { motions: count, retentionDaysAfterClosing: retentionDays },
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
   * before it chooses its shortlist rather than after. One row per held person at
   * most, and a hold is a dispute the board entered deliberately, so this is a
   * handful of ids in a cooperative that has any at all.
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
