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
import { computeBreachDeadline } from "./breach-deadline";
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
 * One reminder, and only while the breach has no decision. A board that has
 * decided has done what the article asks; a board that closed the breach has
 * finished with it. Anything more would be a product nagging about a record
 * that is already complete.
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
   * Zero is an ordinary answer and not a failure: the breach was decided, or
   * closed, or the reminder is a stale one from a corrected discovery date.
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
      },
    });

    if (breach === null) {
      return 0;
    }
    if (breach.decidedAt !== null || breach.closedAt !== null) {
      // The board has answered art. 33 and art. 34, or finished with the
      // breach entirely. Nothing left to remind anybody about.
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
    for (const member of board) {
      if (member.emailCipher === null) {
        continue;
      }
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

    if (sent === 0) {
      /*
       * The reminder was owed and reached nobody: either no board member has an
       * address recorded, or every address failed. The three no-ops above
       * return before this point, so reaching it with a count of zero is the
       * one case that is not ordinary - and the worker discards the count, so
       * without this line nothing records that the association's 72-hour
       * warning was not delivered.
       */
      this.logger.warn(
        `Breach reminder for breach ${breach.id} reached no board member.`,
      );
    }

    return sent;
  }
}
