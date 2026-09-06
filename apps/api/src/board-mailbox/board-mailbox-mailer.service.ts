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
import { boardMailboxReplyMail } from "../mail/templates";
import { REPLY_DELIVERY_FAILURES } from "./board-mailbox-delivery";
import { loadBoardMailboxSettings } from "./board-mailbox-settings";

/**
 * Sending one reply from the board's shared mailbox, as a background job.
 *
 * The transaction that accepted the reply has already written it onto the thread
 * with its delivery pending, so this worker's single rule is the one the news
 * mailing and the meeting notice live by: it claims the row before it sends it.
 * The claim is a conditional update from PENDING, so a job retried after the
 * process was killed sends only what it never reached, two workers on one reply
 * block on the same row and only one commits, and a reply is sent at most once
 * however many times the job runs.
 *
 * That choice is at-most-once rather than at-least-once, deliberately and for a
 * stronger reason here than on a mailing. A duplicated news item is a member
 * reading an announcement twice; a duplicated answer to a letter is the
 * association appearing to say the same thing twice to somebody who asked it
 * once, which reads as a mistake in the answer rather than in the software.
 *
 * ## Where the reply comes from, and where an answer to it goes
 *
 * The envelope sender stays the instance's configured SMTP identity, because
 * that is the identity the mail server will accept: a relay asked to send as an
 * address it does not hold rejects the message, and a board would then find that
 * its answers went nowhere for a reason no screen could explain. What carries
 * the conversation back is Reply-To, set to the board's own published address -
 * so a correspondent pressing reply writes to the shared mailbox and their
 * answer is collected into the same thread, which is the whole point.
 *
 * The threading headers do the rest. In-Reply-To and References name the letter
 * being answered, so the reply lands inside the conversation in the
 * correspondent's own client rather than as a new message beside it.
 *
 * ## The language
 *
 * The association's own default, and not a recipient's preference, because there
 * is no recipient record to hold one: the correspondent is an address the
 * envelope asserted and is deliberately never resolved to a person. Every other
 * message this instance sends goes to somebody it holds a locale for, which is
 * what makes this the one exception rather than a gap.
 *
 * No address is ever in a job payload. The payload is one message id, and this
 * worker decrypts the address as it reaches the row - so a queue table somebody
 * reads holds nobody's mail address at all.
 */

/** Queue the sending runs on. */
export const BOARD_MAILBOX_REPLY_QUEUE = "board-mailbox-reply";

/**
 * Where a reply lands once its retries are spent. The handler marks it as given
 * up on, so the thread reports an answer that never went out rather than one
 * still on its way.
 */
export const BOARD_MAILBOX_REPLY_ABANDONED_QUEUE =
  "board-mailbox-reply-abandoned";

const REPLY_JOB_OPTIONS = {
  // These retries are for the failures a second attempt can change - a database
  // that went away, a worker that was killed. A mail server refusing the address
  // is not one of them: that is recorded on the row and the board is shown it.
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
  expireInSeconds: 5 * 60,
  deadLetter: BOARD_MAILBOX_REPLY_ABANDONED_QUEUE,
} satisfies JobSendOptions;

/** Payload of the sending job. One id, and deliberately nothing else. */
interface ReplyJob {
  messageId: string;
  [key: string]: unknown;
}

@Injectable()
export class BoardMailboxMailerService implements OnModuleInit {
  private readonly logger = new Logger(BoardMailboxMailerService.name);

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
      // not raced by one that came up with the module.
      return;
    }
    await this.startWorker();
  }

  /** Registers the workers. Public so an integration test can drive the job. */
  async startWorker(): Promise<void> {
    await this.jobs.work<ReplyJob>(BOARD_MAILBOX_REPLY_QUEUE, async (data) => {
      await this.sendReply(data.messageId);
    });
    await this.jobs.work<ReplyJob>(
      BOARD_MAILBOX_REPLY_ABANDONED_QUEUE,
      async (data) => {
        await this.recordAbandoned(data.messageId);
      },
    );
  }

  /**
   * Creates the queues the sending uses.
   *
   * Awaited before the transaction that accepts the reply opens, because creating
   * a queue is the queue backend's own work on its own connection.
   */
  async ensureQueues(): Promise<void> {
    await this.jobs.ensureQueue(BOARD_MAILBOX_REPLY_QUEUE);
    await this.jobs.ensureQueue(BOARD_MAILBOX_REPLY_ABANDONED_QUEUE);
  }

  /**
   * Puts the sending on the queue, inside the transaction that wrote the reply,
   * so the reply, the thread's new state and the job commit together or not at
   * all.
   */
  async enqueueInTransaction(
    tx: TransactionalSql,
    messageId: string,
  ): Promise<void> {
    await this.jobs.sendInTransaction<ReplyJob>(
      tx,
      BOARD_MAILBOX_REPLY_QUEUE,
      { messageId },
      REPLY_JOB_OPTIONS,
    );
  }

  /**
   * Sends one reply.
   *
   * Returns what it did, for the log and for the tests that drive the job
   * directly.
   */
  async sendReply(messageId: string): Promise<"sent" | "failed" | "skipped"> {
    const message = await this.prisma.boardMailboxMessage.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        body: true,
        messageId: true,
        inReplyTo: true,
        thread: {
          select: {
            subject: true,
            correspondentEmailCipher: true,
            correspondentNameCipher: true,
          },
        },
      },
    });

    if (message === null) {
      // The thread was erased between the board pressing send and this run: the
      // purge cascades to the messages, and there is nothing left to send or to
      // record it on.
      this.logger.warn(
        `Board mailbox reply ${messageId} was gone before it was sent.`,
      );
      return "skipped";
    }

    /*
     * The claim, and everything this file promises rests on it running before
     * anything is handed to a mail server. A row this call does not claim was
     * claimed by another worker and is left alone.
     */
    const claimed = await this.prisma.boardMailboxMessage.updateMany({
      where: { id: messageId, deliveryStatus: "PENDING" },
      data: { deliveryStatus: "SENT", sentAt: new Date() },
    });
    if (claimed.count === 0) {
      return "skipped";
    }

    const settings = await loadBoardMailboxSettings(
      this.prisma,
      this.encryption,
    );
    if (settings === null) {
      // The mailbox was unconfigured between the board pressing send and this
      // run. Recorded rather than sent from an address a correspondent could not
      // answer.
      await this.fail(messageId, REPLY_DELIVERY_FAILURES.mailNotConfigured);
      return "failed";
    }

    try {
      const to = await this.encryption.decrypt(
        "boardMailboxThread.correspondentEmail",
        message.thread.correspondentEmailCipher,
      );
      const name =
        message.thread.correspondentNameCipher === null
          ? null
          : await this.encryption.decrypt(
              "boardMailboxThread.correspondentName",
              message.thread.correspondentNameCipher,
            );

      await this.mail.send({
        to,
        // The association's default. See the note at the top of this file: there
        // is no recipient record here to hold a preference.
        locale: null,
        template: boardMailboxReplyMail,
        props: {
          recipientName: name,
          subject: message.thread.subject,
          body: message.body,
          boardAddress: settings.address,
        },
        replyTo: settings.address,
        messageId: message.messageId,
        inReplyTo: message.inReplyTo,
      });
      return "sent";
    } catch (error) {
      await this.fail(
        messageId,
        error instanceof MailNotConfiguredError
          ? REPLY_DELIVERY_FAILURES.mailNotConfigured
          : REPLY_DELIVERY_FAILURES.refused,
      );
      // Named by the reply and by the class of the failure, never by address and
      // never in the mail server's own words: this decrypts an address and hands
      // it to a mail server, and a rejection quotes it back.
      this.logger.error(
        `Board mailbox reply ${messageId} failed: ${failureName(error)}`,
      );
      return "failed";
    }
  }

  /**
   * Marks a reply as given up on.
   *
   * Reached through the dead-letter queue when the retries are spent, so the
   * board reads an answer that stopped rather than one still on its way.
   *
   * Only a reply still pending is touched. One already claimed was handed to a
   * mail server, and what happened to it after that is the ledger's own record
   * rather than this handler's to overwrite - the meeting notice's rule,
   * unchanged.
   */
  async recordAbandoned(messageId: string): Promise<void> {
    const { count } = await this.prisma.boardMailboxMessage.updateMany({
      where: { id: messageId, deliveryStatus: "PENDING" },
      data: {
        deliveryStatus: "FAILED",
        deliveryFailure: REPLY_DELIVERY_FAILURES.interrupted,
        sentAt: null,
      },
    });

    this.logger.error(
      `Board mailbox reply ${messageId} was given up on (${String(count)} row).`,
    );
  }

  private async fail(messageId: string, failure: string): Promise<void> {
    await this.prisma.boardMailboxMessage.update({
      where: { id: messageId },
      data: {
        deliveryStatus: "FAILED",
        deliveryFailure: failure,
        sentAt: null,
      },
    });
  }
}
