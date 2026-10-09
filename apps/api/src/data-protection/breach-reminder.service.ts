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
import type { Prisma } from "../generated/prisma/client";
import { lockBreach } from "./breach-lock";
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
    await this.jobs.ensureQueue(BREACH_REMINDER_QUEUE);
    // The metadata says whether a failed run is the last one, which is the
    // run that has to say the reminder was given up on.
    const options = { includeMetadata: true } as const;
    await this.jobs.instance.work<BreachReminderJob, void, typeof options>(
      BREACH_REMINDER_QUEUE,
      options,
      async (batch) => {
        for (const job of batch) {
          try {
            await this.sendBreachReminder(job.data);
          } catch (cause) {
            if (job.retryCount >= job.retryLimit) {
              /*
               * Once, on the run no retry follows. Each failed member is
               * logged as it fails; this is the line that says the board's
               * only warning before the bound was not delivered to everyone.
               */
              this.logger.error(
                `Gave up on the breach reminder for breach ${job.data.breachId} after ${String(
                  job.retryCount + 1,
                )} attempts: ${failureName(cause)}`,
              );
            }
            throw cause;
          }
        }
      },
    );
  }

  /**
   * Sends one reminder, and answers how many board members it newly reached.
   *
   * Zero is an ordinary answer and not a failure: the breach was decided with
   * nothing owed to IMY, or closed, or the reminder is a stale one from a
   * corrected discovery date, or everybody was reached by an earlier run.
   *
   * ## One member at a time, under the breach's lock
   *
   * Each member is a transaction of its own: the lock is taken, what is owed
   * and who has been reached is read again, the mail is sent, and the member is
   * recorded as reached. So two jobs for one discovery - a time corrected from
   * A to B and back to A queues two - cannot both mail one member, a run that
   * failed for some members is retried for those and no others, and a board
   * that answers while the loop runs stops the rest of the reminders. The
   * receipts are kept per discovery instant, so A, then B, then A again finds
   * A's members already reached. A lock held across a send is held for one
   * send, which the drivers bound at twenty seconds.
   */
  async sendBreachReminder(job: BreachReminderJob): Promise<number> {
    const breach = await this.prisma.personalDataBreach.findUnique({
      where: { id: job.breachId },
      select: REMINDER_SELECT,
    });

    if (breach === null || !reminderOwed(breach, job)) {
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
    let failed = 0;
    let addressed = 0;
    for (const member of board) {
      if (member.emailCipher === null) {
        continue;
      }
      addressed += 1;
      try {
        const reached = await this.prisma.$transaction(
          async (tx) => {
            await lockBreach(tx, job.breachId);
            const held = await tx.personalDataBreach.findUnique({
              where: { id: job.breachId },
              select: REMINDER_SELECT,
            });
            if (held === null || !reminderOwed(held, job)) {
              return false;
            }
            const receipts = receiptsOf(held.reminderReceipts);
            const discovery = held.discoveredAt.toISOString();
            const already = receipts[discovery] ?? [];
            if (already.includes(member.id)) {
              return false;
            }

            const to = await this.encryption.decrypt(
              "person.email",
              member.emailCipher ?? "",
            );
            await this.mail.send({
              to,
              locale: member.preferredLocale,
              template: breachReminderMail,
              props: {
                recipientName: `${member.firstName} ${member.lastName}`.trim(),
                breachTitle: held.title,
                discoveredAt: held.discoveredAt,
                notifyBy: computeBreachDeadline(held.discoveredAt),
                decided: held.decidedAt !== null,
              },
            });
            await tx.personalDataBreach.update({
              where: { id: job.breachId },
              data: {
                // The other discoveries' receipts stay: A, B and back to A.
                reminderReceipts: {
                  ...receipts,
                  [discovery]: [...already, member.id],
                },
              },
            });
            return true;
          },
          { timeout: REMINDER_TRANSACTION_TIMEOUT_MS },
        );
        if (reached) {
          sent += 1;
        }
      } catch (error) {
        failed += 1;
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

    if (failed > 0) {
      /*
       * The mail server rather than the board, for some of them or for all.
       * Thrown so the queue tries again (BREACH_REMINDER_RETRY): this is the
       * only warning the board gets before the 72-hour bound, and a job that
       * completed here would never be tried again. A retry mails the members
       * not recorded as reached and nobody else, so the ones this run reached
       * are not sent a second copy.
       */
      throw new Error(
        `Breach reminder for breach ${breach.id} did not reach ${String(
          failed,
        )} of the ${String(addressed)} board members with an address.`,
      );
    }
    if (addressed === 0) {
      /*
       * The reminder was owed and no board member has an address recorded.
       * Trying again would not give anybody an address, and the worker discards
       * the count, so without this line nothing records that the association's
       * 72-hour warning was not delivered.
       */
      this.logger.warn(
        `Breach reminder for breach ${breach.id} reached no board member.`,
      );
    }

    return sent;
  }
}

/** What the reminder reads of a breach, outside the lock and under it. */
const REMINDER_SELECT = {
  id: true,
  title: true,
  discoveredAt: true,
  decidedAt: true,
  closedAt: true,
  imyNotificationRequired: true,
  imyNotifiedAt: true,
  reminderReceipts: true,
} as const;

/**
 * The receipts as the column holds them: the person ids reached, per discovery
 * instant. Anything else in the column is read as no receipts rather than
 * trusted, so a malformed value costs one repeated reminder and not the run.
 */
function receiptsOf(value: Prisma.JsonValue): Record<string, string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const receipts: Record<string, string[]> = {};
  for (const [discovery, ids] of Object.entries(value)) {
    if (Array.isArray(ids)) {
      receipts[discovery] = ids.filter((id) => typeof id === "string");
    }
  }
  return receipts;
}

/**
 * One send waits on the mail server for at most twenty seconds (the drivers'
 * own bound), and the lock is held for that long; the default five seconds of
 * an interactive transaction would roll back a send that had succeeded.
 */
const REMINDER_TRANSACTION_TIMEOUT_MS = 45_000;

/**
 * Whether this reminder is still owed.
 *
 * Only while the art. 33(1) act is still owed, and only for the discovery the
 * job was scheduled against: a corrected discovery date queues a new job and
 * leaves the old one, which finds its payload stale and sends nothing.
 */
function reminderOwed(
  breach: Pick<
    Prisma.PersonalDataBreachGetPayload<{ select: typeof REMINDER_SELECT }>,
    | "decidedAt"
    | "closedAt"
    | "discoveredAt"
    | "imyNotificationRequired"
    | "imyNotifiedAt"
  >,
  job: BreachReminderJob,
): boolean {
  if (breach.discoveredAt.toISOString() !== job.discoveredAt) {
    return false;
  }
  if (breach.closedAt !== null) {
    return false;
  }
  // The board has answered art. 33 and art. 34 with nothing left owed to IMY.
  return breach.decidedAt === null || imyNotificationOwed(breach);
}
