import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  type JobSendOptions,
  JobQueueService,
  type TransactionalSql,
} from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import { newsMail } from "../mail/templates";
import { readPageContent, textBlocksOnly } from "../site/page-content";
import { teaserOf } from "../site/site-news.service";

/**
 * Mailing a published news item to the members, as a background job.
 *
 * The publish transaction has already written down who the mailing is for: one
 * ledger row per recipient, with the pair (news, person) unique. This service
 * works through that ledger, and the single rule it lives by is that it claims
 * a row before it mails it.
 *
 * The claim is a conditional update from PENDING, so:
 *
 * - a job retried after the process was killed mails only the rows it never
 *   reached, and nobody twice;
 * - two workers on one mailing - a retry overlapping a run - block on the same
 *   row, and only one of them commits the claim;
 * - a row is claimed exactly once in its life, so a member cannot receive the
 *   same announcement twice however many times this job runs.
 *
 * That is deliberately not the shape the board's move-out reminder has, whose
 * own comment records the cost of the alternative: it walks the board members
 * in a loop, and a failure part-way through means the retry starts at the first
 * of them again.
 *
 * The claim is taken BEFORE the message is handed to the mail server, which
 * chooses at-most-once over at-least-once. A process killed between the claim
 * and the send loses that one message; the announcement is on the association's
 * website regardless, and a member reading a notice twice is the failure this
 * whole design exists to prevent.
 *
 * No address is ever in a job payload. The payload is one news id, and the
 * worker decrypts each recipient's address as it reaches their row - so a
 * queue table that somebody reads holds no member's email at all.
 */

/** Queue the mailing runs on. */
export const NEWS_MAILING_QUEUE = "news-mailing";

/**
 * Where a mailing lands once its retries are spent. The handler marks whatever
 * is left of the ledger as interrupted, so a mailing that never finished is
 * reported as stopped rather than left looking like one still on its way.
 */
export const NEWS_MAILING_ABANDONED_QUEUE = "news-mailing-abandoned";

/** Reasons a delivery carries when it did not go out. Codes, never prose. */
export const DELIVERY_FAILURES = {
  /** This instance has no mail server. The item is published all the same. */
  mailNotConfigured: "mail-not-configured",
  /** The mail server refused the message. */
  refused: "send-failed",
  /** The person is no longer in the register, or has no address any more. */
  recipientGone: "recipient-gone",
  /** The mailing was given up on before it reached this row. */
  interrupted: "mailing-interrupted",
} as const;

const MAILING_JOB_OPTIONS = {
  // A failed attempt resumes from the ledger rather than starting again, so a
  // retry costs only the rows nobody claimed. These retries are for the
  // failures a second attempt can change - a database that went away, a worker
  // that was killed. A mail server refusing one address is not one of them:
  // that is recorded on the row and the job carries on.
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
  expireInSeconds: 15 * 60,
  deadLetter: NEWS_MAILING_ABANDONED_QUEUE,
} satisfies JobSendOptions;

/** Payload of the mailing job. One id, and deliberately nothing else. */
interface NewsMailingJob {
  newsId: string;
  [key: string]: unknown;
}

@Injectable()
export class NewsMailerService implements OnModuleInit {
  private readonly logger = new Logger(NewsMailerService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests start the worker themselves, so a job under test is
      // not raced by a worker that came up with the module.
      return;
    }
    await this.startWorker();
  }

  /** Registers the workers. Public so an integration test can drive the job. */
  async startWorker(): Promise<void> {
    await this.jobs.work<NewsMailingJob>(NEWS_MAILING_QUEUE, async (data) => {
      await this.runMailing(data.newsId);
    });
    await this.jobs.work<NewsMailingJob>(
      NEWS_MAILING_ABANDONED_QUEUE,
      async (data) => {
        await this.recordAbandoned(data.newsId);
      },
    );
  }

  /**
   * Creates the queues the mailing uses.
   *
   * Awaited before the publish transaction opens, because creating a queue is
   * the queue backend's own work on its own connection.
   */
  async ensureQueues(): Promise<void> {
    await this.jobs.ensureQueue(NEWS_MAILING_QUEUE);
    await this.jobs.ensureQueue(NEWS_MAILING_ABANDONED_QUEUE);
  }

  /**
   * Puts the mailing on the queue, inside the transaction that claimed it.
   *
   * The claim, the ledger and the job commit together or not at all.
   */
  async enqueueInTransaction(
    tx: TransactionalSql,
    newsId: string,
  ): Promise<void> {
    await this.jobs.sendInTransaction<NewsMailingJob>(
      tx,
      NEWS_MAILING_QUEUE,
      { newsId },
      MAILING_JOB_OPTIONS,
    );
  }

  /**
   * Works through one mailing's ledger.
   *
   * Returns what it did, for the log and for the integration tests that drive
   * the job directly. A recipient's own failure never throws: it is written on
   * their row and the mailing carries on to the next person, because one
   * unreachable address must not abandon the members after it.
   */
  async runMailing(newsId: string): Promise<{ sent: number; failed: number }> {
    const news = await this.prisma.news.findUnique({
      where: { id: newsId },
      select: {
        slug: true,
        title: true,
        content: true,
        published: true,
        emailQueuedAt: true,
      },
    });

    if (news === null || !news.published || news.emailQueuedAt === null) {
      // The item was taken down or removed between the publish and this run.
      // Nothing to do, and nothing wrong: the ledger keeps its record of who
      // the board had addressed.
      this.logger.warn(
        `News mailing skipped: ${newsId} is not a published, mailed item.`,
      );
      return { sent: 0, failed: 0 };
    }

    const teaser = teaserOf(textBlocksOnly(readPageContent(news.content)));
    const articleUrl = new URL(
      `/nyheter/${news.slug}`,
      this.env.APP_URL,
    ).toString();

    const pending = await this.prisma.newsDelivery.findMany({
      where: { newsId, status: "PENDING" },
      select: { id: true, personId: true },
      orderBy: { queuedAt: "asc" },
    });

    let sent = 0;
    let failed = 0;

    for (const delivery of pending) {
      const outcome = await this.deliver(delivery, {
        title: news.title,
        teaser,
        articleUrl,
      });
      if (outcome === "sent") {
        sent += 1;
      } else if (outcome === "failed") {
        failed += 1;
      }
    }

    this.logger.log(
      `News mailing ${newsId}: ${String(sent)} sent, ${String(failed)} failed`,
    );
    return { sent, failed };
  }

  /**
   * Marks whatever is left of a mailing as interrupted.
   *
   * Reached through the dead-letter queue when the retries are spent, so the
   * board's screen reports a mailing that stopped rather than one that is still
   * on its way. The rows already sent are untouched: what was delivered was
   * delivered.
   */
  async recordAbandoned(newsId: string): Promise<void> {
    const { count } = await this.prisma.newsDelivery.updateMany({
      where: { newsId, status: "PENDING" },
      data: {
        status: "FAILED",
        failureReason: DELIVERY_FAILURES.interrupted,
      },
    });

    this.logger.error(
      `News mailing ${newsId} was given up on with ${String(count)} recipients unreached.`,
    );
  }

  /**
   * One recipient: claim the row, then mail it.
   *
   * The claim is the conditional update, and everything this file promises
   * rests on it running before the message is handed to a mail server. A row
   * this call does not claim was claimed by somebody else, and is left alone.
   */
  private async deliver(
    delivery: { id: string; personId: string },
    message: { title: string; teaser: string; articleUrl: string },
  ): Promise<"sent" | "failed" | "skipped"> {
    const claimed = await this.prisma.newsDelivery.updateMany({
      where: { id: delivery.id, status: "PENDING" },
      data: { status: "SENT", sentAt: new Date() },
    });
    if (claimed.count === 0) {
      return "skipped";
    }

    const person = await this.prisma.person.findUnique({
      where: { id: delivery.personId },
      select: {
        firstName: true,
        lastName: true,
        emailCipher: true,
        preferredLocale: true,
      },
    });

    if (person == null || person.emailCipher === null) {
      // Deletion-tolerant by design: a ledger row names a person by id and
      // holds no reference that could veto their erasure, so a recipient who
      // is gone by the time this runs is recorded as unreachable.
      await this.fail(delivery.id, DELIVERY_FAILURES.recipientGone);
      return "failed";
    }

    try {
      const to = await this.encryption.decrypt(
        "person.email",
        person.emailCipher,
      );
      await this.mail.send({
        to,
        // The recipient's own language, not the board's. Which language a
        // person is written to in is theirs to decide.
        locale: person.preferredLocale,
        template: newsMail,
        props: {
          recipientName: `${person.firstName} ${person.lastName}`.trim(),
          title: message.title,
          teaser: message.teaser,
          articleUrl: message.articleUrl,
        },
      });
      return "sent";
    } catch (error) {
      await this.fail(
        delivery.id,
        error instanceof MailNotConfiguredError
          ? DELIVERY_FAILURES.mailNotConfigured
          : DELIVERY_FAILURES.refused,
      );
      // Named by delivery and by the class of the failure, never by address and
      // never by the mail server's own words: this decrypts an address and
      // hands it to a mail server, and a rejection quotes it back.
      this.logger.error(
        `News delivery ${delivery.id} failed: ${failureName(error)}`,
      );
      return "failed";
    }
  }

  private async fail(id: string, reason: string): Promise<void> {
    await this.prisma.newsDelivery.update({
      where: { id },
      data: { status: "FAILED", failureReason: reason, sentAt: null },
    });
  }
}
