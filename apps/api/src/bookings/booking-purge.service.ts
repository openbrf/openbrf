import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import {
  BOOKING_RETENTION_DAYS,
  bookingPurgeCutoff,
} from "./booking-retention";

/** Queue the nightly booking purge runs on. */
export const BOOKING_PURGE_QUEUE = "booking-purge";

/**
 * When it runs.
 *
 * In the small hours, on a minute of its own: the import session purge takes
 * 03:23 and the service data purge 03:41, and three jobs waking together on one
 * small connection pool is a contention nobody gains anything from.
 */
const PURGE_CRON = "53 3 * * *";

/**
 * The most people one run erases the bookings of.
 *
 * A cooperative is 20 to 200 households and a night's worth of expiries is a
 * handful, so this is never reached in ordinary running. It exists for the
 * first run on an instance that has been booking for years, or the day the
 * retention window is shortened: without a bound that run would erase every
 * booking ever made in one transaction-per-person loop. Nothing is lost by
 * stopping - eligibility is computed from the data rather than marked on it, so
 * the next night's run finds the rest.
 */
const MAX_PERSONS_PER_RUN = 500;

export interface BookingPurgeRunSummary {
  /** People the eligibility scan found erasable bookings for. */
  considered: number;
  /** People whose bookings were erased. */
  purged: number;
  /** Bookings deleted across all of them. */
  bookingsDeleted: number;
  /**
   * People whose purge threw. The run carries on past them: one row the
   * database refuses must not stop every later person for good.
   */
  failed: number;
}

/**
 * The booking purge (gallring av bokningar).
 *
 * A booking is service-tier personal data - which person, in which apartment,
 * held which hour - and the purpose it is held for ends when the booked period
 * does. So it is erased on a date derived from `endsAt`, a year later, and not
 * on the residency purge's clock: somebody who still lives here has no more use
 * for last March's laundry hour than somebody who has left, and the residency
 * purge would never reach it at all while they stayed. The arithmetic and the
 * reasoning are in `booking-retention.ts`.
 *
 * ## What it erases
 *
 * The booking row, whole. There is nothing on it to blank down to: strip the
 * person and the apartment and what is left is a row saying the sauna was
 * booked from two until three, which is of no use to anybody and is still an
 * entry in a history somebody has to keep. Cancelled and released bookings go
 * the same way as booked ones - a cancellation is a record of a booking that
 * was made, and its purpose ran out on the same day.
 *
 * The resources themselves are never touched. A bookable resource holds no
 * personal data at all; it is the association's account of what it offers.
 *
 * ## Legal hold
 *
 * A hold standing against the person who made the booking stops it, the way it
 * stops the residency purge. The ground under GDPR art. 17.3 is about the
 * person's data rather than about one table, so a dispute that keeps somebody's
 * contact details keeps the bookings that may be what the dispute is about -
 * the guest apartment let out over a weekend the association and a household
 * disagree about is exactly the record a hold exists to preserve.
 *
 * The hold is checked twice: once in the scan, and again inside the transaction
 * that deletes. The second one is the one that counts, because a hold placed
 * while the run was in flight has to win, and the board member who clicked that
 * button is entitled to assume it did.
 *
 * ## How it runs
 *
 * One person per transaction, like the residency purge and for the same
 * reasons. A crash halfway through leaves what it finished finished and the
 * rest for tomorrow, because eligibility is computed from `endsAt` and the
 * window rather than from a flag somebody has to keep in step; and a person
 * with nothing left to erase is not selected, so nobody collects an entry a
 * night for ever in a table that cannot be tidied.
 *
 * The entry is SERVICE_DATA_PURGED with a targetKind of "booking", rather than
 * an action of its own. It is the same act the log already has a word for -
 * service-tier data past its retention date was erased - and one entry per
 * person is what lets a later access report say which of that person's data
 * went and when. The count says how much; the bookings themselves are gone,
 * which is the point.
 */
@Injectable()
export class BookingPurgeService implements OnModuleInit {
  private readonly logger = new Logger(BookingPurgeService.name);

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
    await this.jobs.work(BOOKING_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(BOOKING_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every booking past its purge date, person by person.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting a year.
   * @param retentionDays How long a finished booking is kept.
   */
  async run(
    now: Date = new Date(),
    retentionDays: number = BOOKING_RETENTION_DAYS,
  ): Promise<BookingPurgeRunSummary> {
    const personIds = await this.eligible(now, retentionDays);

    let purged = 0;
    let bookingsDeleted = 0;
    let failed = 0;
    for (const personId of personIds) {
      try {
        const deleted = await this.purgePerson(personId, now, retentionDays);
        if (deleted > 0) {
          purged += 1;
          bookingsDeleted += deleted;
        }
      } catch (error) {
        // The class of the failure and the person id, and nothing the failure
        // was holding: an exception message here can be quoting a row.
        failed += 1;
        this.logger.error(
          `Booking purge failed for person ${personId}: ${failureName(error)}`,
        );
      }
    }

    if (bookingsDeleted > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(bookingsDeleted)} bookings for ${String(
          purged,
        )} of ${String(personIds.length)} eligible persons`,
      );
    }
    if (personIds.length === MAX_PERSONS_PER_RUN) {
      this.logger.log(
        `Booking purge stopped at its per-run bound of ${String(
          MAX_PERSONS_PER_RUN,
        )}; the rest are erased by the next run.`,
      );
    }

    return {
      considered: personIds.length,
      purged,
      bookingsDeleted,
      failed,
    };
  }

  /**
   * The people who hold at least one booking whose retention has run out.
   *
   * Grouped by the booker rather than listing bookings, because the unit of
   * work is a person: one transaction, one audit entry, one answer to "what of
   * mine was erased and when".
   *
   * A person under an open legal hold is left out here and refused again in the
   * transaction. `bookedByPersonId` is a plain column and not a relation, so
   * the hold is looked up separately rather than filtered through a join - the
   * same trade the audit log makes, and the reason a purge can reach this table
   * at all.
   */
  async eligible(now: Date, retentionDays: number): Promise<string[]> {
    const cutoff = bookingPurgeCutoff(now, retentionDays);

    const groups = await this.prisma.booking.groupBy({
      by: ["bookedByPersonId"],
      where: { endsAt: { lte: cutoff } },
      orderBy: [{ bookedByPersonId: "asc" }],
      take: MAX_PERSONS_PER_RUN,
    });
    const personIds = groups.map((group) => group.bookedByPersonId);
    if (personIds.length === 0) {
      return [];
    }

    const held = await this.heldPersonIds(personIds);
    return personIds.filter((personId) => !held.has(personId));
  }

  /**
   * Erases one person's expired bookings, and answers how many went.
   *
   * The deletion and the entry that records it are one transaction. An audit
   * log claiming a purge that rolled back would be worse than no log: the entry
   * is the only evidence that data which no longer exists ever did, and it is
   * written into a table nobody can correct.
   */
  async purgePerson(
    personId: string,
    now: Date = new Date(),
    retentionDays: number = BOOKING_RETENTION_DAYS,
  ): Promise<number> {
    const cutoff = bookingPurgeCutoff(now, retentionDays);

    return this.prisma.$transaction(async (tx) => {
      const held = await tx.legalHold.findFirst({
        where: { personId, releasedAt: null },
        select: { id: true },
      });
      if (held !== null) {
        /*
         * Re-checked here rather than trusted from the scan. A hold placed
         * between the scan and this transaction has to win: the board member
         * who placed it is entitled to assume it took effect, and this is the
         * moment where that is either true or a promise nobody kept.
         */
        return 0;
      }

      const expiring = await tx.booking.findMany({
        where: { bookedByPersonId: personId, endsAt: { lte: cutoff } },
        orderBy: [{ endsAt: "desc" }],
        select: { id: true, endsAt: true },
      });
      if (expiring.length === 0) {
        // The scan filters these out, so reaching here means the last of them
        // went while this ran. An entry for an erasure that erased nothing
        // would be a false record in a table that cannot be corrected.
        return 0;
      }

      const { count } = await tx.booking.deleteMany({
        where: { id: { in: expiring.map((booking) => booking.id) } },
      });

      await this.audit.record(
        {
          action: "SERVICE_DATA_PURGED",
          // No actor: nobody clicked this. The job ran because a date arrived,
          // which is what the retention window promised would happen.
          actorPersonId: null,
          targetPersonId: personId,
          targetKind: "booking",
          /*
           * How many and how far back, never which resource or when it was
           * booked - the retention rule on AuditLogService. This entry outlives
           * the rows it describes by design, so anything copied in here would
           * be the one copy the purge did not reach.
           */
          context: {
            bookings: count,
            retentionDaysAfterBooking: retentionDays,
            latestEndedAt: expiring[0]?.endsAt.toISOString() ?? null,
          },
        },
        tx,
      );

      return count;
    });
  }

  /** Which of these people have a legal hold standing against them. */
  private async heldPersonIds(
    personIds: readonly string[],
  ): Promise<Set<string>> {
    const holds = await this.prisma.legalHold.findMany({
      where: { personId: { in: [...personIds] }, releasedAt: null },
      select: { personId: true },
    });
    return new Set(holds.map((hold) => hold.personId));
  }
}
