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
import { meetingNoticeMail } from "../mail/templates";
import { NOTICE_DELIVERY_FAILURES } from "./meeting-notice-delivery";

/**
 * Sending one notice (kallelse) to the members, as a background job.
 *
 * The transaction that issued the notice has already written down whom it
 * summons: one ledger row per member, with the triple (notice, person, channel)
 * unique. This service works through those rows, and the single rule it lives by
 * is that it claims a row before it mails it.
 *
 * The claim is a conditional update from PENDING, so a job retried after the
 * process was killed mails only the rows it never reached; two workers on one
 * notice block on the same row and only one commits the claim; and a row is
 * claimed exactly once in its life, so no member is summoned twice however many
 * times the job runs. The news mailing's own shape, and the reasoning is set out
 * at length in `news/news-mailer.service.ts`.
 *
 * The claim is taken BEFORE the message is handed to the mail server, which
 * chooses at-most-once over at-least-once. A process killed between the claim
 * and the send loses that copy, and the ledger then says the member was reached
 * when they were not - which is why the board's screen reads the ledger and the
 * association's own record of the summons is the notice, not this worker.
 *
 * A member's own failure never throws. It is written on their row as a code and
 * the sending carries on, because one unreachable address must not leave the
 * members after it uncalled - and because the meeting has been summoned either
 * way. The notice is not rolled back by a mail server: EFL 6 kap. 25 § is about
 * a notice whose content or timing was wrong, and a refused envelope is neither.
 *
 * No address is ever in a job payload. The payload is one notice id, and this
 * worker decrypts each member's address as it reaches their row - so a queue
 * table somebody reads holds no member's email at all.
 */

/** Queue the sending runs on. */
export const MEETING_NOTICE_QUEUE = "meeting-notice";

/**
 * Where the sending lands once its retries are spent. The handler marks whatever
 * is left of the ledger as interrupted, so a notice that never finished going
 * out is reported as stopped rather than left looking like one still on its way.
 */
export const MEETING_NOTICE_ABANDONED_QUEUE = "meeting-notice-abandoned";

const NOTICE_JOB_OPTIONS = {
  // A failed attempt resumes from the ledger rather than starting again, so a
  // retry costs only the rows nobody claimed. These retries are for the failures
  // a second attempt can change - a database that went away, a worker that was
  // killed. A mail server refusing one address is not one of them: that is
  // recorded on the row and the sending carries on.
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
  expireInSeconds: 15 * 60,
  deadLetter: MEETING_NOTICE_ABANDONED_QUEUE,
} satisfies JobSendOptions;

/** Payload of the sending job. One id, and deliberately nothing else. */
interface MeetingNoticeJob {
  noticeId: string;
  [key: string]: unknown;
}

@Injectable()
export class MeetingNoticeMailerService implements OnModuleInit {
  private readonly logger = new Logger(MeetingNoticeMailerService.name);

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
    await this.jobs.work<MeetingNoticeJob>(
      MEETING_NOTICE_QUEUE,
      async (data) => {
        await this.runSending(data.noticeId);
      },
    );
    await this.jobs.work<MeetingNoticeJob>(
      MEETING_NOTICE_ABANDONED_QUEUE,
      async (data) => {
        await this.recordAbandoned(data.noticeId);
      },
    );
  }

  /**
   * Creates the queues the sending uses.
   *
   * Awaited before the transaction that issues the notice opens, because
   * creating a queue is the queue backend's own work on its own connection.
   */
  async ensureQueues(): Promise<void> {
    await this.jobs.ensureQueue(MEETING_NOTICE_QUEUE);
    await this.jobs.ensureQueue(MEETING_NOTICE_ABANDONED_QUEUE);
  }

  /**
   * Puts the sending on the queue, inside the transaction that issued the
   * notice, so the notice, the ledger and the job commit together or not at all.
   */
  async enqueueInTransaction(
    tx: TransactionalSql,
    noticeId: string,
  ): Promise<void> {
    await this.jobs.sendInTransaction<MeetingNoticeJob>(
      tx,
      MEETING_NOTICE_QUEUE,
      { noticeId },
      NOTICE_JOB_OPTIONS,
    );
  }

  /**
   * Works through one notice's ledger.
   *
   * Returns what it did, for the log and for the tests that drive the job
   * directly.
   */
  async runSending(
    noticeId: string,
  ): Promise<{ sent: number; failed: number }> {
    const notice = await this.prisma.meetingNotice.findUnique({
      where: { id: noticeId },
      select: {
        startsAt: true,
        place: true,
        digitalParticipation: true,
        meeting: {
          select: {
            kind: true,
            agendaItems: {
              orderBy: { position: "asc" },
              select: { title: true },
            },
          },
        },
      },
    });

    if (notice === null) {
      // Nothing to do and nothing wrong: the meeting the notice belonged to was
      // removed between the issue and this run, and the ledger went with it.
      this.logger.warn(`Notice sending skipped: ${noticeId} is not a notice.`);
      return { sent: 0, failed: 0 };
    }

    const pending = await this.prisma.meetingNoticeDelivery.findMany({
      where: { noticeId, channel: "EMAIL", status: "PENDING" },
      select: { id: true, personId: true },
      orderBy: { queuedAt: "asc" },
    });

    let sent = 0;
    let failed = 0;

    for (const delivery of pending) {
      const outcome = await this.deliver(delivery, {
        kind: notice.meeting.kind,
        startsAt: notice.startsAt,
        place: notice.place,
        digitalParticipation: notice.digitalParticipation,
        agenda: notice.meeting.agendaItems.map((item) => item.title),
      });
      if (outcome === "sent") {
        sent += 1;
      } else if (outcome === "failed") {
        failed += 1;
      }
    }

    this.logger.log(
      `Notice ${noticeId}: ${String(sent)} sent, ${String(failed)} failed`,
    );
    return { sent, failed };
  }

  /**
   * Marks whatever is left of a sending as interrupted.
   *
   * Reached through the dead-letter queue when the retries are spent, so the
   * board's screen reports a summons that stopped part-way rather than one still
   * on its way. The rows already sent are untouched: what was delivered was
   * delivered.
   */
  async recordAbandoned(noticeId: string): Promise<void> {
    const { count } = await this.prisma.meetingNoticeDelivery.updateMany({
      where: { noticeId, channel: "EMAIL", status: "PENDING" },
      data: {
        status: "FAILED",
        failureReason: NOTICE_DELIVERY_FAILURES.interrupted,
      },
    });

    this.logger.error(
      `Notice ${noticeId} was given up on with ${String(count)} members uncalled.`,
    );
  }

  /**
   * One member: claim the row, then mail it.
   *
   * The claim is the conditional update, and everything this file promises rests
   * on it running before the message is handed to a mail server. A row this call
   * does not claim was claimed by somebody else and is left alone.
   */
  private async deliver(
    delivery: { id: string; personId: string },
    notice: {
      kind: "ORDINARY" | "EXTRAORDINARY";
      startsAt: Date;
      place: string;
      digitalParticipation: string | null;
      agenda: readonly string[];
    },
  ): Promise<"sent" | "failed" | "skipped"> {
    const claimed = await this.prisma.meetingNoticeDelivery.updateMany({
      where: { id: delivery.id, channel: "EMAIL", status: "PENDING" },
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

    if (person == null) {
      // Deletion-tolerant by design: a ledger row names a person by id and holds
      // no reference that could veto their erasure.
      await this.fail(delivery.id, NOTICE_DELIVERY_FAILURES.recipientGone);
      return "failed";
    }
    if (person.emailCipher === null) {
      // Its own code. A member with no address is in this ledger deliberately -
      // see `meeting-notice-delivery.ts` - and the board has to be able to tell
      // them apart from a member who left.
      await this.fail(delivery.id, NOTICE_DELIVERY_FAILURES.noEmailAddress);
      return "failed";
    }

    try {
      const to = await this.encryption.decrypt(
        "person.email",
        person.emailCipher,
      );
      await this.mail.send({
        to,
        // The recipient's own language, not the board's. What the board wrote -
        // the place and the agenda - travels as written.
        locale: person.preferredLocale,
        template: meetingNoticeMail,
        props: {
          recipientName: `${person.firstName} ${person.lastName}`.trim(),
          kind: notice.kind,
          startsAt: notice.startsAt,
          place: notice.place,
          digitalParticipation: notice.digitalParticipation,
          agenda: notice.agenda,
        },
      });
      return "sent";
    } catch (error) {
      await this.fail(
        delivery.id,
        error instanceof MailNotConfiguredError
          ? NOTICE_DELIVERY_FAILURES.mailNotConfigured
          : NOTICE_DELIVERY_FAILURES.refused,
      );
      // Named by delivery and by the class of the failure, never by address and
      // never in the mail server's own words: this decrypts an address and hands
      // it to a mail server, and a rejection quotes it back.
      this.logger.error(
        `Notice delivery ${delivery.id} failed: ${failureName(error)}`,
      );
      return "failed";
    }
  }

  private async fail(id: string, reason: string): Promise<void> {
    await this.prisma.meetingNoticeDelivery.update({
      where: { id },
      data: { status: "FAILED", failureReason: reason, sentAt: null },
    });
  }
}
