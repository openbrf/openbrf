import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { activeBoardRecipientsWhere } from "../mail/board-recipients";
import { MailService } from "../mail/mail.service";
import { breachReminderMail } from "../mail/templates";
import { computeBreachDeadline, imyNotificationOwed } from "./breach-deadline";
import {
  BREACH_REMINDER_QUEUE,
  type BreachReminderJob,
} from "./breach-reminder.queue";

/**
 * Reminds the board a day before the 72 hours of GDPR art. 33(1) run out.
 *
 * A breach is recorded at the moment somebody notices it, which is rarely the
 * moment the board is ready to decide anything: the facts are still being
 * established, and the clock is already running. This is what stops that
 * becoming a missed deadline nobody meant to miss.
 *
 * One reminder, and only while the art. 33(1) act is still owed: the breach
 * has no decision, or the board decided IMY is to be notified and no
 * notification is recorded. Deciding to notify is not notifying, and the
 * reminder exists for exactly the board that meant to and has not yet. A board
 * that has notified, or found no notification owed, has done what the article
 * asks; a board that closed the breach has finished with it. Anything more
 * would be a product nagging about a record that is already complete.
 *
 * ## Why it no-ops rather than cancels
 *
 * The queue has no cancel. A corrected discovery date enqueues a second
 * reminder and leaves the first on the queue, so the handler checks that the
 * discovery it was scheduled against is still the row's before it sends. That
 * makes a stale job harmless, and it is a great deal less machinery than
 * teaching the queue to withdraw a job to save one message.
 */
@Injectable()
export class BreachReminderService implements OnModuleInit {
  private readonly logger = new Logger(BreachReminderService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the handler themselves, so a worker must not
      // race them with the real one.
      return;
    }
    await this.startReminderWorker();
  }

  /** Registers the worker. Public so an integration test can drive the job. */
  async startReminderWorker(): Promise<void> {
    await this.jobs.work<BreachReminderJob>(
      BREACH_REMINDER_QUEUE,
      async (data) => {
        await this.sendBreachReminder(data);
      },
    );
  }

  /**
   * Sends one reminder, and answers how many board members it reached.
   *
   * Zero is an ordinary answer and not a failure: the breach was decided with
   * nothing owed to IMY, or closed, or the reminder is a stale one from a corrected discovery date.
   */
  async sendBreachReminder(job: BreachReminderJob): Promise<number> {
    const breach = await this.prisma.personalDataBreach.findUnique({
      where: { id: job.breachId },
      select: {
        id: true,
        title: true,
        discoveredAt: true,
        decidedAt: true,
        closedAt: true,
        imyNotificationRequired: true,
        imyNotifiedAt: true,
      },
    });

    if (breach === null) {
      return 0;
    }
    const notificationOwed = imyNotificationOwed(breach);
    if (
      breach.closedAt !== null ||
      (breach.decidedAt !== null && !notificationOwed)
    ) {
      // The board has answered art. 33 and art. 34 with nothing left owed to
      // IMY, or finished with the breach entirely. Nothing left to remind
      // anybody about.
      return 0;
    }
    if (breach.discoveredAt.toISOString() !== job.discoveredAt) {
      // A superseded reminder: the discovery date was corrected and a new job
      // carries the new clock.
      return 0;
    }

    const board = await this.prisma.person.findMany({
      where: activeBoardRecipientsWhere(new Date()),
      select: {
        id: true,
        firstName: true,
        lastName: true,
        emailCipher: true,
        preferredLocale: true,
      },
    });

    let sent = 0;
    let addressed = 0;
    for (const member of board) {
      if (member.emailCipher === null) {
        continue;
      }
      addressed += 1;
      try {
        const to = await this.encryption.decrypt(
          "person.email",
          member.emailCipher,
        );
        await this.mail.send({
          to,
          locale: member.preferredLocale,
          template: breachReminderMail,
          props: {
            recipientName: `${member.firstName} ${member.lastName}`.trim(),
            breachTitle: breach.title,
            discoveredAt: breach.discoveredAt,
            notifyBy: computeBreachDeadline(breach.discoveredAt),
            decided: breach.decidedAt !== null,
          },
        });
        sent += 1;
      } catch (error) {
        /*
         * One board member's address failing must not cost the rest of them
         * the reminder. The class of the failure and the ids, and nothing the
         * failure was holding: an exception message here can be quoting an
         * address.
         */
        this.logger.error(
          `Breach reminder failed for person ${member.id} on breach ${breach.id}: ${failureName(error)}`,
        );
      }
    }

    if (sent === 0 && addressed > 0) {
      /*
       * Every address failed, which is the mail server rather than the board.
       * Thrown so the queue tries again (BREACH_REMINDER_RETRY): this is the
       * only warning the board gets before the 72-hour bound, and a job that
       * completed here would never be tried again. Nobody has been mailed yet,
       * so a retry cannot send anybody a second copy.
       */
      throw new Error(
        `Breach reminder for breach ${breach.id} reached none of the ${String(
          addressed,
        )} board members with an address.`,
      );
    }
    if (sent === 0) {
      /*
       * The reminder was owed and no board member has an address recorded.
       * The three no-ops above return before this point, so reaching it with
       * a count of zero is not ordinary - and the worker discards the count, so
       * without this line nothing records that the association's 72-hour
       * warning was not delivered. Trying again would not give anybody an
       * address.
       */
      this.logger.warn(
        `Breach reminder for breach ${breach.id} reached no board member.`,
      );
    }

    return sent;
  }
}
