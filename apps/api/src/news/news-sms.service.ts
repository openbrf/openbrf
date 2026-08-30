import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { normalizePhone } from "../crypto/personal-data";
import { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import {
  type JobSendOptions,
  JobQueueService,
  type TransactionalSql,
} from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { SmsNotConfiguredError } from "../sms/sms.driver";
import { SmsService } from "../sms/sms.service";
import { DELIVERY_FAILURES } from "./news-delivery";
import { composeNewsSms } from "./news-sms-message";

/**
 * Texting a published news item to the members, as a background job.
 *
 * The sibling of the news mailer, and deliberately the same shape rather than a
 * shape of its own: the publish transaction has written one ledger row per
 * recipient with the triple (news, person, channel) unique, and this service
 * claims each of its rows with a conditional update from PENDING BEFORE it
 * hands anything to a provider. Everything that makes a second email
 * impossible makes a second text message impossible, by the same mechanism.
 *
 * It is a second worker on a second queue rather than a channel argument to the
 * first, and that is what keeps the email guarantee where it was. The two jobs
 * retry independently, so an SMS gateway that is down cannot cost the mailing
 * its attempts, and a run that is given up on marks only its own channel's rows
 * as interrupted. Neither worker can claim the other's rows: the channel is in
 * every query either of them makes.
 *
 * No number is ever in a job payload. The payload is one news id, and the
 * worker decrypts each recipient's number as it reaches their row - so the
 * queue table holds no member's phone number at all, and the number exists in
 * this process only between the decrypt and the send.
 *
 * A member with no number is not in the ledger at all: the snapshot at publish
 * takes the members the association can text, so being unreachable this way is
 * an absence rather than a failure. What is recorded here is the narrower case
 * of a number that went away between the publish and the send.
 */

/** Queue the SMS mailing runs on. */
export const NEWS_SMS_QUEUE = "news-sms";

/**
 * Where an SMS mailing lands once its retries are spent. The handler marks
 * whatever is left of this channel's ledger as interrupted, so a mailing that
 * never finished is reported as stopped rather than left looking like one still
 * on its way.
 */
export const NEWS_SMS_ABANDONED_QUEUE = "news-sms-abandoned";

const SMS_JOB_OPTIONS = {
  // A failed attempt resumes from the ledger rather than starting again, so a
  // retry costs only the rows nobody claimed. These retries are for the
  // failures a second attempt can change - a gateway that was restarting, a
  // worker that was killed. A gateway refusing one number is not one of them:
  // that is recorded on the row and the job carries on.
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
  expireInSeconds: 15 * 60,
  deadLetter: NEWS_SMS_ABANDONED_QUEUE,
} satisfies JobSendOptions;

/** Payload of the SMS mailing job. One id, and deliberately nothing else. */
interface NewsSmsJob {
  newsId: string;
  [key: string]: unknown;
}

@Injectable()
export class NewsSmsService implements OnModuleInit {
  private readonly logger = new Logger(NewsSmsService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly i18n: I18nService,
    private readonly sms: SmsService,
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
    await this.jobs.work<NewsSmsJob>(NEWS_SMS_QUEUE, async (data) => {
      await this.runMailing(data.newsId);
    });
    await this.jobs.work<NewsSmsJob>(NEWS_SMS_ABANDONED_QUEUE, async (data) => {
      await this.recordAbandoned(data.newsId);
    });
  }

  /**
   * Creates the queues the SMS mailing uses.
   *
   * Awaited before the publish transaction opens, because creating a queue is
   * the queue backend's own work on its own connection.
   */
  async ensureQueues(): Promise<void> {
    await this.jobs.ensureQueue(NEWS_SMS_QUEUE);
    await this.jobs.ensureQueue(NEWS_SMS_ABANDONED_QUEUE);
  }

  /**
   * Puts the SMS mailing on the queue, inside the transaction that claimed it.
   *
   * The claim, the ledger and the job commit together or not at all.
   */
  async enqueueInTransaction(
    tx: TransactionalSql,
    newsId: string,
  ): Promise<void> {
    await this.jobs.sendInTransaction<NewsSmsJob>(
      tx,
      NEWS_SMS_QUEUE,
      { newsId },
      SMS_JOB_OPTIONS,
    );
  }

  /**
   * Works through one SMS mailing's ledger.
   *
   * Returns what it did, for the log and for the integration tests that drive
   * the job directly. A recipient's own failure never throws: it is written on
   * their row and the mailing carries on to the next person, because one
   * unreachable number must not abandon the members after it.
   */
  async runMailing(newsId: string): Promise<{ sent: number; failed: number }> {
    const news = await this.prisma.news.findUnique({
      where: { id: newsId },
      select: {
        slug: true,
        title: true,
        published: true,
        smsQueuedAt: true,
      },
    });

    if (news === null || !news.published || news.smsQueuedAt === null) {
      // The item was taken down or removed between the publish and this run.
      // Nothing to do, and nothing wrong: the ledger keeps its record of who
      // the board had addressed.
      this.logger.warn(
        `News SMS mailing skipped: ${newsId} is not a published, texted item.`,
      );
      return { sent: 0, failed: 0 };
    }

    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { name: true },
    });
    const articleUrl = new URL(
      `/nyheter/${news.slug}`,
      this.env.APP_URL,
    ).toString();

    /*
     * This channel's rows and no others.
     *
     * The ledger holds one row per recipient per channel, so the filter is what
     * keeps the two workers off each other's rows: without it this worker would
     * claim an email row, mark it sent, and that member's email would never go
     * out - claimed by a worker that cannot send one.
     */
    const pending = await this.prisma.newsDelivery.findMany({
      where: { newsId, channel: "SMS", status: "PENDING" },
      select: { id: true, personId: true },
      orderBy: { queuedAt: "asc" },
    });

    let sent = 0;
    let failed = 0;

    for (const delivery of pending) {
      const outcome = await this.deliver(delivery, {
        association: association?.name ?? "Open BRF",
        title: news.title,
        articleUrl,
      });
      if (outcome === "sent") {
        sent += 1;
      } else if (outcome === "failed") {
        failed += 1;
      }
    }

    this.logger.log(
      `News SMS mailing ${newsId}: ${String(sent)} sent, ${String(failed)} failed`,
    );
    return { sent, failed };
  }

  /**
   * Marks whatever is left of an SMS mailing as interrupted.
   *
   * Reached through the dead-letter queue when the retries are spent. This
   * channel's rows alone: an SMS gateway that never answered says nothing about
   * the email half of the same publication, which has its own job, its own
   * retries and its own dead letter.
   */
  async recordAbandoned(newsId: string): Promise<void> {
    const { count } = await this.prisma.newsDelivery.updateMany({
      where: { newsId, channel: "SMS", status: "PENDING" },
      data: {
        status: "FAILED",
        failureReason: DELIVERY_FAILURES.interrupted,
      },
    });

    this.logger.error(
      `News SMS mailing ${newsId} was given up on with ${String(count)} recipients unreached.`,
    );
  }

  /**
   * One recipient: claim the row, then text it.
   *
   * The claim is the conditional update, and everything this file promises
   * rests on it running before the message is handed to a provider. A row this
   * call does not claim was claimed by somebody else, and is left alone.
   */
  private async deliver(
    delivery: { id: string; personId: string },
    message: { association: string; title: string; articleUrl: string },
  ): Promise<"sent" | "failed" | "skipped"> {
    const claimed = await this.prisma.newsDelivery.updateMany({
      where: { id: delivery.id, channel: "SMS", status: "PENDING" },
      data: { status: "SENT", sentAt: new Date() },
    });
    if (claimed.count === 0) {
      return "skipped";
    }

    const person = await this.prisma.person.findUnique({
      where: { id: delivery.personId },
      select: { phoneCipher: true, preferredLocale: true },
    });

    if (person == null) {
      // Deletion-tolerant by design: a ledger row names a person by id and
      // holds no reference that could veto their erasure, so a recipient who is
      // gone by the time this runs is recorded as unreachable.
      await this.fail(delivery.id, DELIVERY_FAILURES.recipientGone);
      return "failed";
    }

    if (person.phoneCipher === null) {
      await this.fail(delivery.id, DELIVERY_FAILURES.noPhoneNumber);
      return "failed";
    }

    try {
      const number = normalizePhone(
        await this.encryption.decrypt("person.phone", person.phoneCipher),
      );

      if (number === "") {
        // Stored, but not a number anything could dial. Recorded as no number
        // rather than as a refusal: nothing was offered to a provider.
        await this.fail(delivery.id, DELIVERY_FAILURES.noPhoneNumber);
        return "failed";
      }

      await this.sms.send({
        to: number,
        body: composeNewsSms({
          // The recipient's own language, not the board's. Which language a
          // person is written to in is theirs to decide.
          t: this.i18n.translatorFor(person.preferredLocale),
          association: message.association,
          title: message.title,
          articleUrl: message.articleUrl,
        }),
      });
      return "sent";
    } catch (error) {
      await this.fail(
        delivery.id,
        error instanceof SmsNotConfiguredError
          ? DELIVERY_FAILURES.smsNotConfigured
          : DELIVERY_FAILURES.refused,
      );
      // Named by delivery and by the class of the failure, never by number and
      // never by the gateway's own words: this decrypts a number and hands it
      // to a provider, and a rejection quotes it back.
      this.logger.error(
        `News SMS delivery ${delivery.id} failed: ${failureName(error)}`,
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
