import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockLegalHold } from "../retention/legal-hold-lock";
import {
  EVENT_SIGNUP_RETENTION_DAYS,
  eventSignupPurgeCutoff,
} from "./event-signup-retention";
import { SIGNUP_TARGET_KIND } from "./event-signup.service";

/** Queue the nightly sign-up purge runs on. */
export const EVENT_SIGNUP_PURGE_QUEUE = "event-signup-purge";

/**
 * When it runs.
 *
 * In the small hours, on a minute of its own: the import session purge takes
 * 03:23, the service data purge 03:41 and the booking purge 03:53, and jobs
 * waking together on one small connection pool is a contention nobody gains
 * anything from. Ahead of the others rather than after them, so that adding one
 * more purge later has the whole second half of the hour free.
 */
const PURGE_CRON = "11 3 * * *";

/**
 * The most people one run erases the sign-ups of.
 *
 * A cooperative is 20 to 200 households and a night's worth of expiries is a
 * handful, so this is never reached in ordinary running. It exists for the first
 * run on an instance that has been keeping a calendar for years, or the day the
 * retention window is shortened: without a bound that run would erase every
 * sign-up ever made in one transaction-per-person loop. Nothing is lost by
 * stopping - eligibility is computed from the data rather than marked on it, so
 * the next night's run finds the rest.
 */
const MAX_PERSONS_PER_RUN = 500;

export interface EventSignupPurgeRunSummary {
  /** People the eligibility scan found erasable sign-ups for. */
  considered: number;
  /** People whose sign-ups were erased. */
  purged: number;
  /** Sign-ups deleted across all of them. */
  signupsDeleted: number;
  /**
   * People whose purge threw. The run carries on past them: one row the database
   * refuses must not stop every later person for good.
   */
  failed: number;
}

/**
 * The event sign-up purge (gallring av anmalningar).
 *
 * A sign-up is service-tier personal data - which person put their name down for
 * which of the association's dates - and the purpose it is held for ends when
 * that date does. So it is erased on a clock derived from the occurrence's
 * `endsAt`, a year later, and not on the residency purge's: somebody who still
 * lives here has no more use for last April's cleaning day than somebody who has
 * left, and the residency purge would never reach it at all while they stayed.
 * The arithmetic and the reasoning are in `event-signup-retention.ts`.
 *
 * ## What it erases
 *
 * The sign-up row, whole, withdrawn ones included. There is nothing on it to
 * blank down to: strip the person and what is left is a row saying somebody
 * signed up for the cleaning day, which is of no use to anybody and is still an
 * entry in a history somebody has to keep. A withdrawal goes the same way as a
 * standing sign-up - it is a record that somebody had put their name down, and
 * its purpose ran out on the same day.
 *
 * The series and its dates are never touched. Neither holds personal data: they
 * are the association's own account of what it arranged, which is why they carry
 * no purge date at all.
 *
 * ## Legal hold
 *
 * A hold standing against the person who signed up stops it, the way it stops the
 * residency purge and the booking purge. The ground under GDPR art. 17.3 is about
 * the person's data rather than about one table, so a dispute that keeps
 * somebody's contact details keeps the sign-ups that may be what the dispute is
 * about - who was expected at the cleaning day the association and a household
 * disagree about is exactly the record a hold exists to preserve.
 *
 * The hold is checked twice: once in the scan, and again inside the transaction
 * that deletes. The second one is the one that counts, because a hold placed
 * while the run was in flight has to win, and the board member who clicked that
 * button is entitled to assume it did. That second check is taken under the
 * advisory lock in `retention/legal-hold-lock.ts`, which is what makes it a
 * decision rather than a race: a placement takes the same key, so it either lands
 * before the check and stops the run or waits for it and takes effect from the
 * moment it commits.
 *
 * The scan's check is not a duplicate of it. Held people are excluded by the
 * query rather than dropped from its answer, so they cannot spend a run's bound
 * without anything being erased - see {@link EventSignupPurgeService.eligible}.
 *
 * ## How it runs
 *
 * One person per transaction, like the booking purge and for the same reasons. A
 * crash halfway through leaves what it finished finished and the rest for
 * tomorrow, because eligibility is computed from the occurrence's end and the
 * window rather than from a flag somebody has to keep in step; and a person with
 * nothing left to erase is not selected, so nobody collects an entry a night for
 * ever in a table that cannot be tidied.
 *
 * The entry is SERVICE_DATA_PURGED with a targetKind of "eventSignup", rather
 * than an action of its own. It is the same act the log already has a word for -
 * service-tier data past its retention date was erased - and one entry per person
 * is what lets a later access report say which of that person's data went and
 * when. The count says how much; the sign-ups themselves are gone, which is the
 * point.
 */
@Injectable()
export class EventSignupPurgeService implements OnModuleInit {
  private readonly logger = new Logger(EventSignupPurgeService.name);

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
    await this.jobs.work(EVENT_SIGNUP_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(EVENT_SIGNUP_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every sign-up past its purge date, person by person.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting a year.
   * @param retentionDays How long a sign-up is kept after the date it was for.
   */
  async run(
    now: Date = new Date(),
    retentionDays: number = EVENT_SIGNUP_RETENTION_DAYS,
  ): Promise<EventSignupPurgeRunSummary> {
    const personIds = await this.eligible(now, retentionDays);

    let purged = 0;
    let signupsDeleted = 0;
    let failed = 0;
    for (const personId of personIds) {
      try {
        const deleted = await this.purgePerson(personId, now, retentionDays);
        if (deleted > 0) {
          purged += 1;
          signupsDeleted += deleted;
        }
      } catch (error) {
        // The class of the failure and the person id, and nothing the failure
        // was holding: an exception message here can be quoting a row.
        failed += 1;
        this.logger.error(
          `Event sign-up purge failed for person ${personId}: ${failureName(
            error,
          )}`,
        );
      }
    }

    if (signupsDeleted > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(signupsDeleted)} event sign-ups for ${String(
          purged,
        )} of ${String(personIds.length)} eligible persons`,
      );
    }
    if (personIds.length === MAX_PERSONS_PER_RUN) {
      this.logger.log(
        `Event sign-up purge stopped at its per-run bound of ${String(
          MAX_PERSONS_PER_RUN,
        )}; the rest are erased by the next run.`,
      );
    }

    return {
      considered: personIds.length,
      purged,
      signupsDeleted,
      failed,
    };
  }

  /**
   * The people who hold at least one sign-up whose retention has run out.
   *
   * Grouped by the person rather than listing sign-ups, because the unit of work
   * is a person: one transaction, one audit entry, one answer to "what of mine
   * was erased and when".
   *
   * A person under an open legal hold is excluded by the query itself rather than
   * filtered out of its answer, and that ordering is the whole reason for the
   * extra round trip. The per-run bound is applied by the database, so held
   * people removed afterwards would still have spent it: five hundred held people
   * sorting ahead of everybody else would fill every run for as long as their
   * holds stood, and the sign-ups behind them would outlive their retention
   * window with nothing reporting a fault. The booking purge and the residency
   * purge both state the same rule inside their own scans, for the same reason.
   *
   * `personId` is a plain column and not a relation, so the holds are read first
   * and passed in rather than joined - the same trade the audit log makes, and
   * the reason a purge can reach this table at all. The occurrence, by contrast,
   * IS a relation, so the window is asked of it directly: the end of the date is
   * what the clock runs from and copying it onto every sign-up would be a second
   * value to keep in step with an edit that moves the date.
   *
   * The hold is checked again inside the transaction that deletes. That is the
   * check that counts.
   */
  async eligible(now: Date, retentionDays: number): Promise<string[]> {
    const cutoff = eventSignupPurgeCutoff(now, retentionDays);
    const held = await this.heldPersonIds();

    const groups = await this.prisma.eventSignup.groupBy({
      by: ["personId"],
      where: {
        occurrence: { endsAt: { lte: cutoff } },
        // Spelled conditionally rather than as an empty `notIn`, so what the
        // query asks does not depend on how the client renders a list of none.
        ...(held.length > 0 ? { personId: { notIn: held } } : {}),
      },
      orderBy: [{ personId: "asc" }],
      take: MAX_PERSONS_PER_RUN,
    });

    return groups.map((group) => group.personId);
  }

  /**
   * Erases one person's expired sign-ups, and answers how many went.
   *
   * The deletion and the entry that records it are one transaction. An audit log
   * claiming a purge that rolled back would be worse than no log: the entry is
   * the only evidence that data which no longer exists ever did, and it is
   * written into a table nobody can correct.
   */
  async purgePerson(
    personId: string,
    now: Date = new Date(),
    retentionDays: number = EVENT_SIGNUP_RETENTION_DAYS,
  ): Promise<number> {
    const cutoff = eventSignupPurgeCutoff(now, retentionDays);

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

      const { count } = await tx.eventSignup.deleteMany({
        where: { personId, occurrence: { endsAt: { lte: cutoff } } },
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
          targetKind: SIGNUP_TARGET_KIND,
          /*
           * How many, and the window they fell out of. Not which series, and not
           * which dates - the retention rule on AuditLogService. This entry names
           * the person and outlives the rows it describes by design, and the log
           * is exempt from every purge, so a date copied in here would be a
           * precise record of which of the association's events somebody went to,
           * kept for good, in the entry that says it was erased.
           */
          context: {
            signups: count,
            retentionDaysAfterOccurrence: retentionDays,
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
