import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { FINANCIAL_YEAR_START_MONTHS } from "../retention/financial-year";
import { lockLegalHold } from "../retention/legal-hold-lock";
import { FEE_RETENTION_YEARS, feePurgeCutoff } from "./fee-retention";
import { FEE_TARGET_KIND } from "./fee.service";

/** Queue the nightly fee purge runs on. */
export const FEE_PURGE_QUEUE = "fee-purge";

/**
 * When it runs.
 *
 * In the small hours, in the band every purge in this product wakes in, so that
 * a night's erasures happen while nobody is using the instance. The minutes are
 * spread across the band because jobs waking together on one small connection
 * pool is a contention nobody gains anything from.
 */
const PURGE_CRON = "35 3 * * *";

/**
 * The most apartments one run erases the fees of.
 *
 * A cooperative is 20 to 200 households and a night's worth of expiries is a
 * handful, so this is never reached in ordinary running. It exists for the
 * first run on an instance that has been keeping fees for years, or the day the
 * retention window is shortened: without a bound that run would erase every fee
 * ever recorded in one transaction-per-apartment loop. Nothing is lost by
 * stopping - eligibility is computed from the data rather than marked on it, so
 * the next night's run finds the rest.
 */
const MAX_APARTMENTS_PER_RUN = 500;

/**
 * The rates, notices and runs whose retention has run out, as filters.
 *
 * Judged on each row's own `financialYearStartMonth` - the month the
 * association's financial year began in when the rate was recorded or the run
 * issued - and never on the association's current setting. Bokforingslagen
 * 7 kap. 2 § counts from the end of the calendar year the row's own books
 * closed, and a later change to the setting does not change the year those books
 * closed; reading the current setting would move an erasure date already stated
 * on a data subject access report, and could move it a year earlier.
 *
 * A notice is judged by its run, which carries the month and the period the
 * notice was issued for. One branch per possible month rather than a read of the
 * months the tables hold, so each scan and each delete stays one statement.
 */
function fallenOut(
  now: Date,
  retentionYears: number,
): {
  rates: {
    OR: {
      financialYearStartMonth: number;
      appliesUntil: { not: null; lt: Date };
    }[];
  };
  notices: {
    notification: {
      OR: { financialYearStartMonth: number; periodTo: { lt: Date } }[];
    };
  };
  runs: { OR: { financialYearStartMonth: number; periodTo: { lt: Date } }[] };
} {
  const cutoffs = FINANCIAL_YEAR_START_MONTHS.map((startMonth) => ({
    startMonth,
    cutoff: feePurgeCutoff(now, startMonth, retentionYears),
  }));
  const byPeriod = cutoffs.map(({ startMonth, cutoff }) => ({
    financialYearStartMonth: startMonth,
    periodTo: { lt: cutoff },
  }));

  return {
    rates: {
      OR: cutoffs.map(({ startMonth, cutoff }) => ({
        financialYearStartMonth: startMonth,
        // A rate still in force has no ended day and is never erasable. Spelled
        // as "not null and before the cutoff" rather than left to the
        // comparison, so the rule is visible in the query.
        appliesUntil: { not: null, lt: cutoff },
      })),
    },
    notices: { notification: { OR: byPeriod } },
    runs: { OR: byPeriod },
  };
}

export interface FeePurgeRunSummary {
  /** Apartments the eligibility scan found erasable rows for. */
  considered: number;
  /** Apartments whose rows were erased. */
  purged: number;
  /** Fee rates deleted across all of them. */
  feesDeleted: number;
  /** Notices deleted across all of them. */
  noticesDeleted: number;
  /** Notification runs left with nothing, and so erased. */
  notificationsDeleted: number;
  /**
   * Apartments whose purge threw. The run carries on past them: one row the
   * database refuses must not stop every later apartment for good.
   */
  failed: number;
}

/**
 * The fee purge (gallring av avgifter och avier).
 *
 * A fee rate and the notices issued from it are service-tier personal data -
 * what one apartment pays, and an apartment leads back to whoever lives in it -
 * and the purpose they are held for ends when the accounting record they were
 * the basis for has outlived its own preservation period. So they are erased on
 * a clock derived from the financial year they fall in, seven calendar years
 * after the one that year ended in, and not on the residency purge's: somebody
 * who still lives here has no more use for a 2026 notice than somebody who has
 * left, and the residency purge would never reach it at all while they stayed.
 * The arithmetic and the reasoning are in `fee-retention.ts`.
 *
 * ## What it erases, and what it never reaches
 *
 * A fee rate that has ended, whole. A rate still in force is never erased at
 * any age: no preservation period has run out on a fact that is still true, and
 * erasing the rate an apartment is paying under would leave the board unable to
 * say what it is billing. That is the one way this purge differs from the
 * charge purge, whose rows are all about days that have passed.
 *
 * A notice, whole, with its run once nothing of the run is left. There is
 * nothing on either to blank down to: strip the apartment from a notice and
 * what is left is a sum the association billed nobody. The run is erased last
 * and only when empty, because a run with some notices still held is still the
 * record of when and for what period those were issued.
 *
 * ## Legal hold
 *
 * A hold standing against anybody who has ever held a residency in the
 * apartment stops it, the way it stops the charge purge for an apartment-keyed
 * charge. Ever, and not only now, because the rows are from a financial year
 * that has closed and the household that disputes them may have moved out
 * since. That errs towards keeping, which is the direction a hold is for.
 *
 * The hold is checked twice: once in the scan, and again inside the transaction
 * that deletes. The second one is the one that counts, because a hold placed
 * while the run was in flight has to win, and the board member who clicked that
 * button is entitled to assume it did. That second check is taken under the
 * advisory lock in `retention/legal-hold-lock.ts`, which is what makes it a
 * decision rather than a race.
 *
 * The scan's check is not a duplicate of it. Held apartments are excluded by
 * the query rather than dropped from its answer, so they cannot spend a run's
 * bound without anything being erased.
 *
 * ## How it runs
 *
 * One apartment per transaction, like the charge, booking and sign-up purges
 * and for the same reasons. A crash halfway through leaves what it finished
 * finished and the rest for tomorrow, because eligibility is computed from the
 * dates and the window rather than from a flag somebody has to keep in step.
 *
 * The entry is SERVICE_DATA_PURGED with a targetKind of "fee", rather than an
 * action of its own. It is the same act the log already has a word for -
 * service-tier data past its retention date was erased - and one entry per
 * apartment is what lets a later access report say which of that household's
 * data went and when. It names no subject, for the reason the recording entry
 * gives: which of an apartment's residents that would be is a question the log
 * must not answer by guessing.
 */
@Injectable()
export class FeePurgeService implements OnModuleInit {
  private readonly logger = new Logger(FeePurgeService.name);

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
    await this.jobs.work(FEE_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(FEE_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every fee and notice past its purge date, apartment by apartment,
   * then the runs nothing is left of.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting seven years.
   * @param retentionYears How many full calendar years after the one its
   *   financial year ended in a row is kept.
   */
  async run(
    now: Date = new Date(),
    retentionYears: number = FEE_RETENTION_YEARS,
  ): Promise<FeePurgeRunSummary> {
    const apartmentIds = await this.eligible(now, retentionYears);

    let purged = 0;
    let feesDeleted = 0;
    let noticesDeleted = 0;
    let failed = 0;
    for (const apartmentId of apartmentIds) {
      try {
        const deleted = await this.purgeApartment(
          apartmentId,
          now,
          retentionYears,
        );
        if (deleted.fees > 0 || deleted.notices > 0) {
          purged += 1;
          feesDeleted += deleted.fees;
          noticesDeleted += deleted.notices;
        }
      } catch (error) {
        // The class of the failure and the apartment, and nothing the failure
        // was holding: an exception message here can be quoting a row. The id
        // stays because it is the only handle on an erasure that did not
        // happen, and a failed transaction wrote no audit entry to carry it -
        // ADR 0007.
        failed += 1;
        this.logger.error(
          `Fee purge failed for apartment ${apartmentId}: ${failureName(error)}`,
        );
      }
    }

    const notificationsDeleted = await this.purgeEmptyRuns(now, retentionYears);

    if (feesDeleted > 0 || noticesDeleted > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(feesDeleted)} fees and ${String(
          noticesDeleted,
        )} notices for ${String(purged)} of ${String(
          apartmentIds.length,
        )} eligible apartments`,
      );
    }

    return {
      considered: apartmentIds.length,
      purged,
      feesDeleted,
      noticesDeleted,
      notificationsDeleted,
      failed,
    };
  }

  /**
   * The apartments holding at least one row whose retention has run out.
   *
   * Grouped by the apartment rather than listing rows, because the unit of work
   * is an apartment: one transaction, one audit entry, one answer to "what of
   * this household's was erased and when".
   *
   * A held apartment is excluded by the query itself rather than filtered out of
   * its answer, and that ordering is the whole reason for the extra round trips.
   * The per-run bound is applied by the database, so held apartments removed
   * afterwards would still have spent it, and the rows behind them would outlive
   * their retention window with nothing reporting a fault.
   */
  async eligible(now: Date, retentionYears: number): Promise<string[]> {
    const expired = fallenOut(now, retentionYears);
    const heldApartmentIds = await this.heldApartmentIds();
    const exclude =
      heldApartmentIds.length > 0 ? { notIn: heldApartmentIds } : {};

    const fees = await this.prisma.fee.groupBy({
      by: ["apartmentId"],
      where: { ...expired.rates, apartmentId: exclude },
      orderBy: [{ apartmentId: "asc" }],
      take: MAX_APARTMENTS_PER_RUN,
    });

    const notices = await this.prisma.feeNotice.groupBy({
      by: ["apartmentId"],
      where: { ...expired.notices, apartmentId: exclude },
      orderBy: [{ apartmentId: "asc" }],
      take: MAX_APARTMENTS_PER_RUN,
    });

    return [
      ...new Set([
        ...fees.map((group) => group.apartmentId),
        ...notices.map((group) => group.apartmentId),
      ]),
    ].sort();
  }

  /**
   * Erases one apartment's expired rows, and answers how many went.
   *
   * The deletion and the entry that records it are one transaction. An audit log
   * claiming a purge that rolled back would be worse than no log: the entry is
   * the only evidence that data which no longer exists ever did, and it is
   * written into a table nobody can correct.
   */
  async purgeApartment(
    apartmentId: string,
    now: Date = new Date(),
    retentionYears: number = FEE_RETENTION_YEARS,
  ): Promise<{ fees: number; notices: number }> {
    const expired = fallenOut(now, retentionYears);
    const holdOn = await this.residentsOf(apartmentId);

    return this.prisma.$transaction(async (tx) => {
      /*
       * Before the holds are read, so that reading them settles the question.
       * Everything below runs at READ COMMITTED, where a placement committing
       * between the read and the delete would leave this transaction erasing the
       * rows the hold was placed to preserve - and the board member would have
       * been told the person was held. `LegalHoldService.place` takes the same
       * key, which is what makes the two orderable at all.
       *
       * Taken in sorted order: two runs holding two of the same flat's residents
       * in opposite orders would deadlock, and there is nothing in this loop that
       * could recover from one.
       */
      for (const personId of [...holdOn].sort()) {
        await lockLegalHold(tx, personId);
      }

      if (holdOn.length > 0) {
        const held = await tx.legalHold.findFirst({
          where: { personId: { in: holdOn }, releasedAt: null },
          select: { id: true },
        });
        if (held !== null) {
          /*
           * Re-checked here rather than trusted from the scan. A hold placed
           * between the scan and this transaction has to win: the board member
           * who placed it is entitled to assume it took effect, and this is the
           * moment where that is either true or a promise nobody kept.
           */
          return { fees: 0, notices: 0 };
        }
      }

      const notices = await tx.feeNotice.deleteMany({
        where: { apartmentId, ...expired.notices },
      });
      const fees = await tx.fee.deleteMany({
        where: { apartmentId, ...expired.rates },
      });

      if (notices.count === 0 && fees.count === 0) {
        // The scan filters these out, so reaching here means the last of them
        // went while this ran. An entry for an erasure that erased nothing would
        // be a false record in a table that cannot be corrected.
        return { fees: 0, notices: 0 };
      }

      await this.audit.record(
        {
          action: "SERVICE_DATA_PURGED",
          channel: "SYSTEM",
          // No actor: nobody clicked this. The job ran because a date arrived,
          // which is what the retention window promised would happen.
          actorPersonId: null,
          // No subject: which of the apartment's residents that would be is a
          // question the log must not answer by guessing.
          targetPersonId: null,
          targetKind: FEE_TARGET_KIND,
          targetId: apartmentId,
          /*
           * How many, and the window they fell out of. Not which rows, not what
           * they were for and not what they came to - the retention rule on
           * AuditLogService. This entry outlives the rows it describes by
           * design, and the log is exempt from every purge, so a sum copied in
           * here would be a precise, permanent record of what one household
           * paid, inside the entry that says it was erased.
           */
          context: {
            fees: fees.count,
            notices: notices.count,
            apartmentId,
            // Not the financial year: each rate and each run carries its own,
            // and one apartment's rows can span a change to the setting.
            retentionYearsAfterFinancialYear: retentionYears,
          },
        },
        tx,
      );

      return { fees: fees.count, notices: notices.count };
    });
  }

  /**
   * Erases the runs nothing is left of.
   *
   * After the apartments, and never before: a run with notices still held is
   * still the record of when and for what period those were issued, and the
   * cascade on `fee_notice` would take them with it. So a run goes only once its
   * own period has fallen out of the window and it carries no notices at all,
   * which is exactly the state a legal hold cannot be standing in.
   *
   * No audit entry of its own. What was erased is the household's data, which
   * the per-apartment entries above name; the run left behind is a period and a
   * date with nothing personal on it, and an entry for removing an empty row
   * would say nothing an access report could use.
   */
  private async purgeEmptyRuns(
    now: Date,
    retentionYears: number,
  ): Promise<number> {
    const { count } = await this.prisma.feeNotification.deleteMany({
      where: { ...fallenOut(now, retentionYears).runs, notices: { none: {} } },
    });
    return count;
  }

  /**
   * Every apartment a legal hold currently reaches.
   *
   * A hold is placed against a person, and a fee names only an apartment, so the
   * hold is read through the flat: a hold against anybody who has ever held a
   * residency there keeps that apartment's rows.
   */
  private async heldApartmentIds(): Promise<string[]> {
    const holds = await this.prisma.legalHold.findMany({
      where: { releasedAt: null },
      select: { personId: true },
      distinct: ["personId"],
    });
    if (holds.length === 0) {
      return [];
    }

    const residencies = await this.prisma.residency.findMany({
      where: { personId: { in: holds.map((hold) => hold.personId) } },
      select: { apartmentId: true },
      distinct: ["apartmentId"],
    });
    return residencies.map((residency) => residency.apartmentId);
  }

  /** Everybody who has ever held a residency on one apartment. */
  private async residentsOf(apartmentId: string): Promise<string[]> {
    const residencies = await this.prisma.residency.findMany({
      where: { apartmentId },
      select: { personId: true },
      distinct: ["personId"],
    });
    return residencies.map((residency) => residency.personId);
  }
}
