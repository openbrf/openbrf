import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import {
  ANSWERED_RETENTION_DAYS,
  answeredPurgeCutoff,
  RECEIVED_RETENTION_DAYS,
  receivedPurgeCutoff,
} from "./broker-update-request-retention";

/** Queue the nightly update request purge runs on. */
export const BROKER_UPDATE_REQUEST_PURGE_QUEUE = "broker-update-request-purge";

/**
 * When it runs.
 *
 * In the small hours, in the band every purge in this product wakes in, on a
 * minute of its own. It reads no erasure request: a broker is nobody the
 * register holds, so there is no person's request for it to come before.
 */
const PURGE_CRON = "7 3 * * *";

export interface BrokerUpdateRequestPurgeRunSummary {
  /** Requests deleted on this run, by either clock. */
  deleted: number;
}

/**
 * The update request purge (gallring av uppdateringsförfrågningar).
 *
 * Deletes what `broker-update-request-retention.ts` says has been kept long
 * enough: a request thirty days after the board answered it, and any request
 * ninety days after it arrived. The whole row goes - there is nothing on it to
 * keep once the broker's details are gone.
 *
 * No legal hold reaches these rows. A hold stands against a person the
 * association holds data about, and a broker who filled in a public form is
 * not one: nothing here is keyed to a person, so there is no person to hold.
 *
 * One statement and one SERVICE_DATA_PURGED entry for the run, in one
 * transaction, carrying the count and the windows, and no entry when nothing
 * went. The entry names no request: each one's RECEIVED entry is what names
 * it, and the count is what says they were deleted on this night.
 */
@Injectable()
export class BrokerUpdateRequestPurgeService implements OnModuleInit {
  private readonly logger = new Logger(BrokerUpdateRequestPurgeService.name);

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
    await this.jobs.work(BROKER_UPDATE_REQUEST_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(BROKER_UPDATE_REQUEST_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Deletes every request past its retention.
   *
   * @param now The moment to judge retention at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting three months.
   */
  async run(
    now: Date = new Date(),
  ): Promise<BrokerUpdateRequestPurgeRunSummary> {
    const deleted = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.brokerUpdateRequest.deleteMany({
        where: {
          OR: [
            { answeredAt: { lte: answeredPurgeCutoff(now) } },
            { createdAt: { lte: receivedPurgeCutoff(now) } },
          ],
        },
      });

      if (count > 0) {
        await this.audit.record(
          {
            action: "SERVICE_DATA_PURGED",
            channel: "SYSTEM",
            // No actor: nobody clicked this. The job ran because a date
            // arrived, which is what the retention window promised.
            actorPersonId: null,
            targetKind: "brokerUpdateRequest",
            context: {
              brokerUpdateRequests: count,
              retentionDaysAfterAnswer: ANSWERED_RETENTION_DAYS,
              retentionDaysAfterReceipt: RECEIVED_RETENTION_DAYS,
            },
          },
          tx,
        );
      }

      return count;
    });

    if (deleted > 0) {
      // A count, like every other line a purge writes.
      this.logger.log(
        `Purged ${String(deleted)} broker update requests past their retention`,
      );
    }
    return { deleted };
  }
}
