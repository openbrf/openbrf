import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import {
  type JobSendOptions,
  JobQueueService,
  type TransactionalSql,
} from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { NewsWriteError, NewsWriteService } from "./news-write.service";

/** Queue a scheduled news item waits on until its instant. */
export const NEWS_SCHEDULED_PUBLISH_QUEUE = "news-scheduled-publish";

const SCHEDULED_JOB_OPTIONS = {
  /*
   * These retries are for a database that went away or a worker that was
   * killed. A refusal on the merits - a personal identity number somebody put
   * into the item on the news screen after it was scheduled - is not retried:
   * it is logged, and the item waits as a draft for the board.
   */
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 5 * 60,
} satisfies JobSendOptions;

/**
 * Payload of the scheduled publish: the item, who scheduled it, and whether
 * the board marked the post important, which is what sends the mailing.
 */
interface ScheduledPublishJob {
  newsId: string;
  personId: string;
  sendEmail: boolean;
  [key: string]: unknown;
}

/**
 * Publishes a news item at the instant the board chose for it: "Schemalägg
 * publicering" on a post written as Styrelsen.
 *
 * On the queue the rest of the product's date-triggered work runs on, as a job
 * due at that instant and written in the transaction that wrote the item, so
 * the item and the job that will publish it commit together or not at all.
 * Until the job runs the item is a draft: on no website, in nobody's mailbox,
 * and in nobody's feed but the board's, which sees it waiting.
 *
 * One written to Alla can be taken over on the news screen like any draft; one
 * written to Styrelsen or Administratörer is that audience's and on no news
 * screen (`news-audience.ts`). Publishing it by hand first, taking it
 * down again or removing it leaves the job nothing to do, which the job asks
 * under the item's row lock (`NewsWriteService.publishScheduled`).
 *
 * The board member who scheduled it must still speak for the board when the
 * job runs. If their seat has ended meanwhile the item stays a draft: a draft
 * to Styrelsen or Administratörer can be withdrawn by an eligible board member
 * through `BoardPostService.withdraw`, while a draft to Alla remains removable
 * from the news screen.
 */
@Injectable()
export class NewsScheduleService implements OnModuleInit {
  private readonly logger = new Logger(NewsScheduleService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly jobs: JobQueueService,
    private readonly news: NewsWriteService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests run the job themselves, so one under test is not
      // raced by a worker that came up with the module.
      return;
    }
    await this.startWorker();
  }

  /** Registers the worker. Public so an integration test can drive the job. */
  async startWorker(): Promise<void> {
    await this.jobs.work<ScheduledPublishJob>(
      NEWS_SCHEDULED_PUBLISH_QUEUE,
      async (data) => {
        await this.run(data);
      },
    );
  }

  /**
   * Creates the queue, before the transaction that schedules on it opens:
   * creating one is the queue backend's own work on its own connection.
   */
  async ensureQueue(): Promise<void> {
    await this.jobs.ensureQueue(NEWS_SCHEDULED_PUBLISH_QUEUE);
  }

  /** Puts the publish on the queue, due at `at`, inside the caller's transaction. */
  async scheduleInTransaction(
    tx: TransactionalSql,
    at: Date,
    job: { newsId: string; personId: string; sendEmail: boolean },
  ): Promise<void> {
    await this.jobs.sendAtInTransaction<ScheduledPublishJob>(
      tx,
      NEWS_SCHEDULED_PUBLISH_QUEUE,
      { ...job },
      at,
      SCHEDULED_JOB_OPTIONS,
    );
  }

  /** One scheduled publish. Public so an integration test can run it. */
  async run(job: {
    newsId: string;
    personId: string;
    sendEmail: boolean;
  }): Promise<void> {
    try {
      const published = await this.news.publishScheduled(job);
      if (published !== null) {
        this.logger.log(`Published the scheduled news item ${job.newsId}`);
      }
    } catch (cause) {
      if (cause instanceof NewsWriteError) {
        // The item, never its words: ADR 0007 keeps the identifier and the log
        // keeps no prose.
        this.logger.warn(
          `The scheduled news item ${job.newsId} was not published: ${cause.reason}`,
        );
        return;
      }
      this.logger.error(
        `The scheduled news item ${job.newsId} could not be published: ${failureName(cause)}`,
      );
      throw cause;
    }
  }
}
