import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockLegalHold } from "../retention/legal-hold-lock";
import {
  KEY_ORDER_RETENTION_DAYS,
  keyOrderPurgeCutoff,
} from "./key-order-retention";

/** Queue the nightly key order purge runs on. */
export const KEY_ORDER_PURGE_QUEUE = "key-order-purge";

/**
 * When it runs.
 *
 * In the small hours, on a minute of its own: the sublet purge takes 03:17, the
 * import session purge 03:23, the motion purge 03:29, the service data purge
 * 03:41 and the booking purge 03:53, and jobs waking together on one small
 * connection pool is a contention nobody gains anything from.
 */
const PURGE_CRON = "11 3 * * *";

/**
 * The most people one run erases the orders of.
 *
 * A cooperative is 20 to 200 households, so this is never reached in ordinary
 * running. It exists for the first run on an instance that has been taking
 * orders for years, or the day the retention window is shortened. Nothing is
 * lost by stopping - eligibility is computed from the data rather than marked on
 * it, so the next night's run finds the rest.
 */
const MAX_PERSONS_PER_RUN = 500;

export interface KeyOrderPurgeRunSummary {
  /** People the eligibility scan found erasable orders for. */
  considered: number;
  /** People whose orders were erased. */
  purged: number;
  /** Orders deleted across all of them. */
  ordersDeleted: number;
  /**
   * People whose purge threw. The run carries on past them: one row the database
   * refuses must not stop every later person for good.
   */
  failed: number;
}

/**
 * The key order purge (gallring av nyckelbestallningar).
 *
 * An order is service-tier personal data - which resident asked for a key to
 * which apartment, what for, and what the board did about it - and the purpose
 * it is held for ends a while after the order is closed. So it is erased on a
 * date derived from `closedAt` and not on the residency purge's clock; the
 * arithmetic and the reasoning are in `key-order-retention.ts`.
 *
 * ## What it erases, and what stays
 *
 * The order row, whole. There is nothing on it to blank down to: strip the
 * resident and what is left is an anonymous request for a key nobody can act on.
 * Handed over, declined and withdrawn orders go the same way.
 *
 * What stays is the audit entry that recorded the handover, which is deliberate.
 * KEY_ORDER_HANDED_OVER names the person, the kind and the quantity, and the log
 * is append-only and exempt from every purge - so once the order itself is gone
 * the association can still answer that somebody was given a key to the building
 * on a day. That is the one fact about a key order worth keeping past the row,
 * and it is kept in the one table that cannot be rewritten.
 *
 * An open order is not touched at all. The scan requires a closing date, so an
 * order still with the board is out of scope however old it is.
 *
 * ## Legal hold
 *
 * A hold standing against the person who ordered stops it, the way it stops the
 * residency, booking, motion and sublet purges. The ground under GDPR art. 17.3
 * is about the person's data rather than about one table.
 *
 * The hold is checked twice: once in the scan, and again inside the transaction
 * that deletes, under the advisory lock in `retention/legal-hold-lock.ts`. The
 * second one is the one that counts, because a hold placed while the run was in
 * flight has to win, and the board member who clicked that button is entitled to
 * assume it did.
 *
 * The scan's check is not a duplicate of it. Held people are excluded by the
 * query rather than dropped from its answer, so they cannot spend a run's bound
 * without anything being erased - see {@link KeyOrderPurgeService.eligible}.
 *
 * ## How it runs
 *
 * One person per transaction, like every other purge here and for the same
 * reasons. A crash halfway through leaves what it finished finished and the rest
 * for tomorrow, because eligibility is computed from `closedAt` and the window
 * rather than from a flag somebody has to keep in step.
 *
 * The entry is SERVICE_DATA_PURGED with a targetKind of "keyOrder", rather than
 * an action of its own. It is the same act the log already has a word for, and
 * one entry per person is what lets a later access report say which of that
 * person's data went and when.
 */
@Injectable()
export class KeyOrderPurgeService implements OnModuleInit {
  private readonly logger = new Logger(KeyOrderPurgeService.name);

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
    await this.jobs.work(KEY_ORDER_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(KEY_ORDER_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every closed order past its purge date, person by person.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting a year.
   * @param retentionDays How long a closed order is kept.
   */
  async run(
    now: Date = new Date(),
    retentionDays: number = KEY_ORDER_RETENTION_DAYS,
  ): Promise<KeyOrderPurgeRunSummary> {
    const personIds = await this.eligible(now, retentionDays);

    let purged = 0;
    let ordersDeleted = 0;
    let failed = 0;
    for (const personId of personIds) {
      try {
        const deleted = await this.purgePerson(personId, now, retentionDays);
        if (deleted > 0) {
          purged += 1;
          ordersDeleted += deleted;
        }
      } catch (error) {
        // The class of the failure and the person id, and nothing the failure
        // was holding: an exception message here can be quoting a row. The id
        // stays because it is the only handle on an erasure that did not
        // happen, and a failed transaction wrote no audit entry to carry it -
        // ADR 0007.
        failed += 1;
        this.logger.error(
          `Key order purge failed for person ${personId}: ${failureName(error)}`,
        );
      }
    }

    if (ordersDeleted > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(ordersDeleted)} key orders for ${String(
          purged,
        )} of ${String(personIds.length)} eligible persons`,
      );
    }
    if (personIds.length === MAX_PERSONS_PER_RUN) {
      this.logger.log(
        `Key order purge stopped at its per-run bound of ${String(
          MAX_PERSONS_PER_RUN,
        )}; the rest are erased by the next run.`,
      );
    }

    return { considered: personIds.length, purged, ordersDeleted, failed };
  }

  /**
   * The people who placed at least one closed order whose retention has run out.
   *
   * Grouped by the orderer rather than listing orders, because the unit of work
   * is a person: one transaction, one audit entry, one answer to "what of mine
   * was erased and when".
   *
   * A person under an open legal hold is excluded by the query itself rather than
   * filtered out of its answer, and that ordering is the whole reason for the
   * extra round trip. The per-run bound is applied by the database, so held
   * people removed afterwards would still have spent it: five hundred held people
   * sorting ahead of everybody else would fill every run for as long as their
   * holds stood, and the orders behind them would outlive their retention window
   * with nothing reporting a fault.
   *
   * The hold is checked again inside the transaction that deletes. That is the
   * check that counts.
   */
  async eligible(now: Date, retentionDays: number): Promise<string[]> {
    const cutoff = keyOrderPurgeCutoff(now, retentionDays);
    const held = await this.heldPersonIds();

    const groups = await this.prisma.keyOrder.groupBy({
      by: ["orderedByPersonId"],
      where: {
        // Both halves, and the first is not implied by the second: a null closing
        // date is not less than or equal to anything, but stating it makes the
        // rule readable as the rule it is - an open order is out of scope however
        // old it is.
        closedAt: { not: null, lte: cutoff },
        // Spelled conditionally rather than as an empty `notIn`, so what the
        // query asks does not depend on how the client renders a list of none.
        ...(held.length > 0 ? { orderedByPersonId: { notIn: held } } : {}),
      },
      orderBy: [{ orderedByPersonId: "asc" }],
      take: MAX_PERSONS_PER_RUN,
    });

    return groups.map((group) => group.orderedByPersonId);
  }

  /**
   * Erases one person's expired orders, and answers how many went.
   *
   * The deletion and the entry that records it are one transaction. An audit log
   * claiming a purge that rolled back would be worse than no log: the entry is
   * the only evidence that data which no longer exists ever did, and it is
   * written into a table nobody can correct.
   */
  async purgePerson(
    personId: string,
    now: Date = new Date(),
    retentionDays: number = KEY_ORDER_RETENTION_DAYS,
  ): Promise<number> {
    const cutoff = keyOrderPurgeCutoff(now, retentionDays);

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

      const { count } = await tx.keyOrder.deleteMany({
        where: {
          orderedByPersonId: personId,
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
          targetKind: "keyOrder",
          /*
           * How many, and the window they fell out of. Not what any of them was
           * for - the retention rule on AuditLogService. This entry names the
           * person and outlives the rows it describes by design, and the log is
           * exempt from every purge, so a note copied in here would be a
           * permanent record kept in the entry that says it was erased.
           */
          context: {
            keyOrders: count,
            retentionDaysAfterClosing: retentionDays,
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
