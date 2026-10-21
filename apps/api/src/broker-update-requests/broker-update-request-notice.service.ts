import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  type JobSendOptions,
  JobQueueService,
  type TransactionalSql,
} from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { activeBoardSeatWhere } from "../mail/board-recipients";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import { brokerUpdateRequestNoticeMail } from "../mail/templates";

/**
 * Telling the board that a broker has asked it to look at the facts.
 *
 * The contact form's two queues, for the same reason (`contact.service.ts`):
 * the first job reads who is to be told and queues one job per person, and
 * each of those sends one message and is retried on its own. The first job is
 * written by the transaction that stores the request, so it exists exactly
 * when the request does and runs only once that has committed.
 *
 * Told is whoever holds `site:manage`, the capability that reads the queue and
 * confirms the facts that answer it, with an address to reach them at. The
 * notice names the apartment and when, and links to the queue. It carries
 * nothing about the broker: see the template.
 *
 * ## Told once
 *
 * A fan-out claims the request's `notifiedAt` in the transaction that queues
 * the deliveries, and queues nothing when another fan-out has claimed it
 * first. So a fan-out job that is run again - its completion lost, or the
 * queue's own at-least-once delivery - finds the request already claimed and
 * tells nobody a second time. A duplicate request for the same apartment is
 * never stored (`broker-update-request.service.ts`), so it has no notice to
 * send either.
 *
 * What is left is a delivery job run twice, which repeats one person's notice
 * and nobody else's, as the contact form's does.
 */

/** Reads who is told and enqueues one delivery each. Payload: request. */
export const BROKER_UPDATE_REQUEST_FANOUT_QUEUE =
  "broker-update-request-fanout";

/** Sends one person one notice. Payload: request and person. */
export const BROKER_UPDATE_REQUEST_NOTICE_QUEUE =
  "broker-update-request-notice";

/**
 * Where either job lands once its retries are spent. Nothing is lost: the
 * request is in the queue on the settings screen whatever happens to the mail.
 */
export const BROKER_UPDATE_REQUEST_ABANDONED_QUEUE =
  "broker-update-request-abandoned";

/** The contact form's retry policy: a mail server that greylisted or was away. */
const NOTICE_JOB_OPTIONS = {
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
  deadLetter: BROKER_UPDATE_REQUEST_ABANDONED_QUEUE,
} satisfies JobSendOptions;

export interface BrokerUpdateRequestFanoutJob {
  requestId: string;
  [key: string]: unknown;
}

export interface BrokerUpdateRequestNoticeJob {
  requestId: string;
  personId: string;
  [key: string]: unknown;
}

/**
 * Who holds `site:manage` today, with an address to reach them at.
 *
 * The capability is the board seat's and the administrator's, and nobody
 * else's (`authorization/capabilities.ts`; `broker-update-request-notice.spec.ts`
 * holds the two in step). Read as a filter here, because a notice is sent to
 * people and a capability is computed for one principal at a time.
 */
export function siteManagerRecipientsWhere(now: Date): Prisma.PersonWhereInput {
  return {
    emailCipher: { not: null },
    OR: [
      { systemRoles: { some: { role: "ADMIN" } } },
      activeBoardSeatWhere(now),
    ],
  };
}

@Injectable()
export class BrokerUpdateRequestNoticeService implements OnModuleInit {
  private readonly logger = new Logger(BrokerUpdateRequestNoticeService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the jobs themselves.
      return;
    }
    await this.startWorkers();
  }

  /** Registers the workers. Public so an integration test can drive them. */
  async startWorkers(): Promise<void> {
    await this.jobs.work<BrokerUpdateRequestFanoutJob>(
      BROKER_UPDATE_REQUEST_FANOUT_QUEUE,
      async (data) => {
        await this.fanOut(data.requestId);
      },
    );
    await this.jobs.work<BrokerUpdateRequestNoticeJob>(
      BROKER_UPDATE_REQUEST_NOTICE_QUEUE,
      async (data) => {
        await this.notify(data.requestId, data.personId);
      },
    );
    await this.jobs.work<
      BrokerUpdateRequestFanoutJob | BrokerUpdateRequestNoticeJob
    >(BROKER_UPDATE_REQUEST_ABANDONED_QUEUE, (data) => {
      // The identifier only, as everywhere else in this module.
      this.logger.error(
        `Gave up telling the board about broker update request ${data.requestId}; it is in the queue.`,
      );
    });
  }

  /**
   * Creates the queues, the dead letter among them.
   *
   * Before the transaction that stores a request: creating a queue happens on
   * the queue backend's own connection and has no place inside it.
   */
  async ensureQueues(): Promise<void> {
    await this.jobs.ensureQueue(BROKER_UPDATE_REQUEST_ABANDONED_QUEUE);
    await this.jobs.ensureQueue(BROKER_UPDATE_REQUEST_FANOUT_QUEUE);
    await this.jobs.ensureQueue(BROKER_UPDATE_REQUEST_NOTICE_QUEUE);
  }

  /**
   * Queues the fan-out for a request, in the transaction that stores it.
   *
   * So the job commits with the row or not at all, and no worker can pick it
   * up before the row is there to read.
   */
  async enqueueInTransaction(
    tx: TransactionalSql,
    requestId: string,
  ): Promise<void> {
    await this.jobs.sendInTransaction<BrokerUpdateRequestFanoutJob>(
      tx,
      BROKER_UPDATE_REQUEST_FANOUT_QUEUE,
      { requestId },
      NOTICE_JOB_OPTIONS,
    );
  }

  /**
   * Queues one notice for everybody who holds `site:manage`, once per request.
   *
   * Answers how many were queued. Nobody is queued for a request that is
   * gone - dismissed or purged - or already answered, because the board has
   * then looked at the facts, nor for one another fan-out has claimed.
   */
  async fanOut(requestId: string, now: Date = new Date()): Promise<number> {
    const request = await this.prisma.brokerUpdateRequest.findUnique({
      where: { id: requestId },
      select: { answeredAt: true, notifiedAt: true },
    });
    if (request === null || request.answeredAt !== null) {
      this.logger.log(
        `Broker update request fan-out skipped: ${requestId} is ${request === null ? "gone" : "answered"}.`,
      );
      return 0;
    }
    if (request.notifiedAt !== null) {
      return 0;
    }

    const recipients = await this.prisma.person.findMany({
      where: siteManagerRecipientsWhere(now),
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (recipients.length === 0) {
      this.logger.warn(
        `Broker update request ${requestId} has nobody with site:manage and an address to notify.`,
      );
      return 0;
    }

    await this.ensureQueues();
    const queued = await this.prisma.$transaction(async (tx) => {
      // The claim and the deliveries commit together: a second fan-out finds
      // the request claimed, and one that fails partway claims nothing.
      const { count } = await tx.brokerUpdateRequest.updateMany({
        where: { id: requestId, notifiedAt: null, answeredAt: null },
        data: { notifiedAt: now },
      });
      if (count === 0) {
        return 0;
      }
      for (const recipient of recipients) {
        await this.jobs.sendInTransaction<BrokerUpdateRequestNoticeJob>(
          tx,
          BROKER_UPDATE_REQUEST_NOTICE_QUEUE,
          { requestId, personId: recipient.id },
          NOTICE_JOB_OPTIONS,
        );
      }
      return recipients.length;
    });

    if (queued > 0) {
      this.logger.log(
        `Broker update request ${requestId} queued for ${String(queued)} people`,
      );
    }
    return queued;
  }

  /**
   * Sends one person one notice, or answers false when there is nothing to
   * send: the request is gone or answered, the person no longer holds
   * `site:manage` with an address, or the instance has no mail settings.
   *
   * Any other failure is rethrown, so the queue retries this delivery and no
   * other.
   */
  async notify(
    requestId: string,
    personId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const request = await this.prisma.brokerUpdateRequest.findUnique({
      where: { id: requestId },
      select: { apartmentReference: true, createdAt: true, answeredAt: true },
    });
    if (request === null || request.answeredAt !== null) {
      return false;
    }

    const recipient = await this.prisma.person.findFirst({
      where: { id: personId, ...siteManagerRecipientsWhere(now) },
      select: {
        firstName: true,
        lastName: true,
        emailCipher: true,
        preferredLocale: true,
      },
    });
    const recipientCipher = recipient?.emailCipher;
    if (recipient === null || recipientCipher == null) {
      this.logger.log(
        `Broker update request notice for ${requestId} skipped: ${personId} no longer holds site:manage with an address.`,
      );
      return false;
    }

    try {
      await this.mail.send({
        to: await this.encryption.decrypt("person.email", recipientCipher),
        locale: recipient.preferredLocale,
        template: brokerUpdateRequestNoticeMail,
        props: {
          recipientName: `${recipient.firstName} ${recipient.lastName}`.trim(),
          apartmentReference: request.apartmentReference,
          receivedAt: request.createdAt,
        },
      });
    } catch (error) {
      if (error instanceof MailNotConfiguredError) {
        this.logger.warn(
          `Broker update request ${requestId} is in the queue but was not mailed: this instance has no SMTP settings.`,
        );
        return false;
      }
      // By the class of the failure: a rejection quotes the address back.
      this.logger.error(
        `Broker update request notice for ${requestId} failed for ${personId}: ${failureName(error)}`,
      );
      throw error;
    }
    return true;
  }
}
