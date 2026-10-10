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
import type { SentMail } from "../mail/mail-driver";
import type { RenderedMail } from "../mail/mail-template";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import {
  boardMailboxReplyMail,
  type BoardMailboxReplyMailProps,
} from "../mail/templates";
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
 * The envelope sender stays the instance's configured sender, because that is
 * the identity the mail server will accept: a relay asked to send as an address
 * it does not hold rejects the message, and a board would then find that its
 * answers went nowhere for a reason no screen could explain. On an instance
 * whose mail is set where it runs, that sender is on a domain the host may share
 * between associations, under the association's name (ADR 0024). What carries
 * the conversation back is Reply-To, set to the board's own published address -
 * so a correspondent pressing reply writes to the shared mailbox and their
 * answer is collected into the same thread, which is the whole point.
 *
 * The threading headers do the rest. In-Reply-To and References name the letter
 * being answered, so the reply lands inside the conversation in the
 * correspondent's own client rather than as a new message beside it. And the
 * identifier the answer was delivered with is what the thread keeps: a mail
 * service that writes its own Message-ID reports it, and it replaces the one
 * minted here, because it is the one the correspondent's reply will name.
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
     *
     * What the claim writes is the time, and not the outcome. SENT says a mail
     * server accepted the reply, which nothing here knows yet: writing it now
     * would mean that a process stopping between this line and the handover
     * leaves the thread stating that an answer went to a correspondent who never
     * received one, with nothing left able to correct it - the dead-letter
     * handler only touches a reply still pending, and a retried job finds the
     * row claimed. Claimed and still pending is what is true in that window,
     * and it is the state the dead-letter handler resolves.
     */
    const claimed = await this.prisma.boardMailboxMessage.updateMany({
      where: { id: messageId, deliveryStatus: "PENDING", sentAt: null },
      data: { sentAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.refuseUnsettledClaim(messageId);
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

    let sent: SentMail;
    try {
      const to = await this.encryption.decrypt(
        "boardMailboxThread.correspondentEmail",
        message.thread.correspondentEmailCipher,
      );

      sent = await this.mail.send({
        to,
        ...(await this.replyMail(message, settings.address)),
        replyTo: settings.address,
        messageId: message.messageId,
        inReplyTo: message.inReplyTo,
      });
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

    /*
     * The handover happened, and this is the record of it.
     *
     * Outside the block above on purpose: a write that fails here cannot unsend
     * the reply, and turning it into a delivery failure would put the one thing
     * on the thread that is certainly untrue. The row stays claimed and pending,
     * and the job fails: a job that completed would leave the reply on its way
     * for good, and a failed one ends in the dead letter, whose handler records
     * that the delivery is unconfirmed.
     *
     * The identifier the answer was delivered with goes onto the row here, over
     * the one minted when it was written, where the two differ. A mail service
     * that owns the Message-ID refuses the minted one and writes its own, and
     * that is the identifier a copy of the answer comes back with and the one
     * the correspondent's reply names in In-Reply-To - so it is what the
     * collector has to find on this row to recognise the one and thread the
     * other. Here rather than earlier, because nothing knows it before the
     * handover.
     */
    const delivered = sent.messageId;
    if (delivered === null) {
      this.logger.warn(
        `Board mailbox reply ${messageId} was sent without a delivered message identifier; a reply to it may not join its thread.`,
      );
    }
    try {
      await this.prisma.boardMailboxMessage.update({
        where: { id: messageId },
        data:
          delivered !== null && delivered !== message.messageId
            ? { deliveryStatus: "SENT", messageId: delivered }
            : { deliveryStatus: "SENT" },
      });
    } catch (error) {
      // The delivered identifier is named, because nothing else holds it: a
      // row left with the minted one never threads the correspondent's reply,
      // and this line is what it can be repaired from. It is not personal data.
      this.logger.error(
        `Board mailbox reply ${messageId} was sent but not recorded as sent` +
          (delivered === null ? "" : ` (delivered as <${delivered}>)`) +
          `: ${failureName(error)}`,
      );
      throw error;
    }
    return "sent";
  }

  /**
   * A reply as this instance renders it, or null when the row is not a reply.
   *
   * For the collector, which recognises a copy of the board's own answer by
   * what it says: see `ownAnswerId` there. Rendered by the same code that
   * sends it, so the two cannot drift apart.
   *
   * @param boardAddress The address the board publishes, which the reply
   *   states in its closing line.
   */
  async renderReply(
    answerId: string,
    boardAddress: string,
  ): Promise<RenderedMail | null> {
    const message = await this.prisma.boardMailboxMessage.findFirst({
      where: { id: answerId, direction: "OUTBOUND" },
      select: {
        body: true,
        thread: { select: { subject: true, correspondentNameCipher: true } },
      },
    });
    if (message === null) {
      return null;
    }
    return this.mail.renderMail(await this.replyMail(message, boardAddress));
  }

  /** The template a reply is sent with, and what fills it in. */
  private async replyMail(
    message: {
      body: string;
      thread: { subject: string; correspondentNameCipher: string | null };
    },
    boardAddress: string,
  ): Promise<{
    locale: null;
    template: typeof boardMailboxReplyMail;
    props: BoardMailboxReplyMailProps;
  }> {
    return {
      // The association's default. See the note at the top of this file: there
      // is no recipient record here to hold a preference.
      locale: null,
      template: boardMailboxReplyMail,
      props: {
        recipientName:
          message.thread.correspondentNameCipher === null
            ? null
            : await this.encryption.decrypt(
                "boardMailboxThread.correspondentName",
                message.thread.correspondentNameCipher,
              ),
        subject: message.thread.subject,
        body: message.body,
        boardAddress,
      },
    };
  }

  /**
   * Fails the job when the reply it could not claim is claimed and unsettled.
   *
   * A reply is claimed by one attempt, and a retry of the same job finds the
   * claim. Where the row has since been settled, as sent or failed, there is
   * nothing left to do. Where it is still pending, the attempt that claimed it
   * stopped before recording an outcome - the process was restarted during
   * the handover, or the job expired under it - or is still running. Either
   * way the job must not complete: a completed job is never looked at again,
   * and the reply would read as on its way for good. Failing it leaves the
   * queue to retry, and when the retries are spent, to hand the reply to the
   * dead-letter handler, which settles it. An attempt still running settles
   * the row first, and the handler then leaves it alone.
   */
  private async refuseUnsettledClaim(messageId: string): Promise<void> {
    const row = await this.prisma.boardMailboxMessage.findUnique({
      where: { id: messageId },
      select: { deliveryStatus: true, sentAt: true },
    });
    if (row?.deliveryStatus === "PENDING" && row.sentAt !== null) {
      throw new Error(
        `Board mailbox reply ${messageId} is claimed by an attempt that has not recorded its outcome.`,
      );
    }
  }

  /**
   * Marks a reply as given up on.
   *
   * Reached through the dead-letter queue when the retries are spent, so the
   * board reads an answer that stopped rather than one still on its way.
   *
   * Only a reply still pending is touched, which is what a reply is until a mail
   * server has accepted it. One already recorded as sent or failed has its own
   * answer and this handler does not overwrite it - the meeting notice's rule,
   * unchanged.
   *
   * What it is recorded as depends on whether an attempt had claimed it. One
   * nobody claimed never reached a mail server, and it did not go out. One
   * that was claimed may have: the attempt stopped somewhere between the claim
   * and the record of its outcome, and nothing says where. Both conditions are
   * in the statements rather than read first, so a claim committed while this
   * runs is seen by the second of them.
   */
  async recordAbandoned(messageId: string): Promise<void> {
    const neverClaimed = await this.prisma.boardMailboxMessage.updateMany({
      where: { id: messageId, deliveryStatus: "PENDING", sentAt: null },
      data: {
        deliveryStatus: "FAILED",
        deliveryFailure: REPLY_DELIVERY_FAILURES.interrupted,
      },
    });
    const claimed = await this.prisma.boardMailboxMessage.updateMany({
      where: {
        id: messageId,
        deliveryStatus: "PENDING",
        sentAt: { not: null },
      },
      data: {
        deliveryStatus: "FAILED",
        deliveryFailure: REPLY_DELIVERY_FAILURES.unconfirmed,
        sentAt: null,
      },
    });

    this.logger.error(
      `Board mailbox reply ${messageId} was given up on (${String(neverClaimed.count)} unclaimed, ${String(claimed.count)} claimed row).`,
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
