import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockLegalHold } from "../retention/legal-hold-lock";
import { SUBLET_RETENTION_DAYS, subletPurgeCutoffs } from "./sublet-retention";

/** Queue the nightly sublet purge runs on. */
export const SUBLET_PURGE_QUEUE = "sublet-purge";

/**
 * When it runs.
 *
 * In the small hours, on a minute of its own: the import session purge takes
 * 03:23, the motion purge 03:29, the service data purge 03:41 and the booking
 * purge 03:53, and jobs waking together on one small connection pool is a
 * contention nobody gains anything from.
 */
const PURGE_CRON = "17 3 * * *";

/**
 * The most people one run erases the applications of.
 *
 * A cooperative is 20 to 200 households and a subletting application is a rare
 * event, so this is never reached in ordinary running. It exists for the first
 * run on an instance that has been taking applications for years, or the day the
 * retention window is shortened. Nothing is lost by stopping - eligibility is
 * computed from the data rather than marked on it, so the next night's run finds
 * the rest.
 */
const MAX_PERSONS_PER_RUN = 500;

export interface SubletPurgeRunSummary {
  /** People the eligibility scan found erasable applications for. */
  considered: number;
  /** People whose applications were erased. */
  purged: number;
  /** Applications deleted across all of them. */
  applicationsDeleted: number;
  /**
   * People whose purge threw. The run carries on past them: one row the database
   * refuses must not stop every later person for good.
   */
  failed: number;
}

/**
 * The sublet application purge (gallring av andrahandsansokningar).
 *
 * An application is service-tier personal data - which member wanted to let
 * their flat, to whom is deliberately not recorded, for how long and why, in
 * their own words - and the purpose it is held for ends a while after the
 * letting the consent was about is over. So it is erased on a date derived from
 * `closedAt` and `periodTo` together, and not on the residency purge's clock;
 * the arithmetic and the reasoning are in `sublet-retention.ts`.
 *
 * ## What it erases
 *
 * The application row, whole. There is nothing on it to blank down to: strip the
 * member and what is left is an anonymous request nobody can act on, still held
 * in a table somebody has to keep. Consented, refused and withdrawn applications
 * go the same way - a withdrawal is a record of a request that was made, and its
 * purpose ran out on the same clock. A recorded rent tribunal permission goes
 * with the refusal it stands against, because on its own it would be a date
 * against nothing.
 *
 * An open application is not touched at all. The scan requires a closing date,
 * so a request still with the board is out of scope however old it is: the
 * association is processing it, so the purpose it is held for has not ended, and
 * a queue nobody has worked is something for the board to see rather than for a
 * job to erase.
 *
 * ## Legal hold
 *
 * A hold standing against the member who applied stops it, the way it stops the
 * residency, booking and motion purges. The ground under GDPR art. 17.3 is about
 * the person's data rather than about one table, so a dispute that keeps
 * somebody's contact details keeps the applications that may be what the dispute
 * is about - whether the board ever consented to a letting is exactly the record
 * a hold exists to preserve, and letting without consent is a forfeiture ground
 * under BRL 7 kap. 18 § 2.
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
 * without anything being erased - see {@link SubletPurgeService.eligible}.
 *
 * ## How it runs
 *
 * One person per transaction, like the residency, booking and motion purges and
 * for the same reasons. A crash halfway through leaves what it finished finished
 * and the rest for tomorrow, because eligibility is computed from the two
 * anchoring columns and the window rather than from a flag somebody has to keep
 * in step.
 *
 * The entry is SERVICE_DATA_PURGED with a targetKind of "subletApplication",
 * rather than an action of its own. It is the same act the log already has a
 * word for - service tier data past its retention date was erased - and one
 * entry per person is what lets a later access report say which of that person's
 * data went and when.
 */
@Injectable()
export class SubletPurgeService implements OnModuleInit {
  private readonly logger = new Logger(SubletPurgeService.name);

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
    await this.jobs.work(SUBLET_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(SUBLET_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every closed application past its purge date, person by person.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting two years.
   * @param retentionDays How long a closed application is kept.
   */
  async run(
    now: Date = new Date(),
    retentionDays: number = SUBLET_RETENTION_DAYS,
  ): Promise<SubletPurgeRunSummary> {
    const personIds = await this.eligible(now, retentionDays);

    let purged = 0;
    let applicationsDeleted = 0;
    let failed = 0;
    for (const personId of personIds) {
      try {
        const deleted = await this.purgePerson(personId, now, retentionDays);
        if (deleted > 0) {
          purged += 1;
          applicationsDeleted += deleted;
        }
      } catch (error) {
        // The class of the failure and the person id, and nothing the failure
        // was holding: an exception message here can be quoting a row.
        failed += 1;
        this.logger.error(
          `Sublet purge failed for person ${personId}: ${failureName(error)}`,
        );
      }
    }

    if (applicationsDeleted > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(applicationsDeleted)} sublet applications for ${String(
          purged,
        )} of ${String(personIds.length)} eligible persons`,
      );
    }
    if (personIds.length === MAX_PERSONS_PER_RUN) {
      this.logger.log(
        `Sublet purge stopped at its per-run bound of ${String(
          MAX_PERSONS_PER_RUN,
        )}; the rest are erased by the next run.`,
      );
    }

    return {
      considered: personIds.length,
      purged,
      applicationsDeleted,
      failed,
    };
  }

  /**
   * The people who made at least one closed application whose retention has run
   * out.
   *
   * Grouped by the applicant rather than listing applications, because the unit
   * of work is a person: one transaction, one audit entry, one answer to "what
   * of mine was erased and when".
   *
   * A person under an open legal hold is excluded by the query itself rather than
   * filtered out of its answer, and that ordering is the whole reason for the
   * extra round trip. The per-run bound is applied by the database, so held
   * people removed afterwards would still have spent it: five hundred held people
   * sorting ahead of everybody else would fill every run for as long as their
   * holds stood, and the applications behind them would outlive their retention
   * window with nothing reporting a fault.
   *
   * The hold is checked again inside the transaction that deletes. That is the
   * check that counts.
   */
  async eligible(now: Date, retentionDays: number): Promise<string[]> {
    const held = await this.heldPersonIds();

    const groups = await this.prisma.subletApplication.groupBy({
      by: ["appliedByPersonId"],
      where: {
        ...erasable(now, retentionDays),
        // Spelled conditionally rather than as an empty `notIn`, so what the
        // query asks does not depend on how the client renders a list of none.
        ...(held.length > 0 ? { appliedByPersonId: { notIn: held } } : {}),
      },
      orderBy: [{ appliedByPersonId: "asc" }],
      take: MAX_PERSONS_PER_RUN,
    });

    return groups.map((group) => group.appliedByPersonId);
  }

  /**
   * Erases one person's expired applications, and answers how many went.
   *
   * The deletion and the entry that records it are one transaction. An audit log
   * claiming a purge that rolled back would be worse than no log: the entry is
   * the only evidence that data which no longer exists ever did, and it is
   * written into a table nobody can correct.
   */
  async purgePerson(
    personId: string,
    now: Date = new Date(),
    retentionDays: number = SUBLET_RETENTION_DAYS,
  ): Promise<number> {
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

      const { count } = await tx.subletApplication.deleteMany({
        where: { appliedByPersonId: personId, ...erasable(now, retentionDays) },
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
          targetKind: "subletApplication",
          /*
           * How many, and the window they fell out of. Not the periods and not
           * the reasons any of them gave - the retention rule on
           * AuditLogService. This entry names the person and outlives the rows it
           * describes by design, and the log is exempt from every purge, so a
           * reason copied in here would be a permanent record of why somebody
           * wanted to let their home, kept in the entry that says it was erased.
           */
          context: {
            subletApplications: count,
            retentionDaysAfterLastAnchor: retentionDays,
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

/**
 * The rows whose retention has run out, as one filter both queries share.
 *
 * Two comparisons joined by AND, which is exactly `max(closedAt, end of period)
 * + window <= now` - see `sublet-retention.ts` for why. Written once because the
 * scan and the delete have to select the same rows: a scan that found a person
 * whose applications the delete then did not match would record a purge that
 * erased nothing, and the opposite would erase what the report had not stated.
 *
 * `closedAt: { not: null, ... }` states the rule as the rule it is - an open
 * application is out of scope however old it is - rather than leaning on a null
 * never comparing less than or equal to anything.
 */
function erasable(
  now: Date,
  retentionDays: number,
): {
  closedAt: { not: null; lte: Date };
  periodTo: { lte: Date };
} {
  const cutoffs = subletPurgeCutoffs(now, retentionDays);
  return {
    closedAt: { not: null, lte: cutoffs.closedAtOrBefore },
    periodTo: { lte: cutoffs.periodEndedOnOrBefore },
  };
}
