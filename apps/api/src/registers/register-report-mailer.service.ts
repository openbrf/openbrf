import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { MailService } from "../mail/mail.service";
import { registerReportObligationMail } from "../mail/templates";

/** Payload of the board's reporting-obligation notice. */
export interface RegisterReportNoticeJob {
  obligationId: string;
  [key: string]: unknown;
}

/** Queue the board's reporting-obligation notice runs on. */
export const REGISTER_REPORT_NOTICE_QUEUE = "register-report-notice";

/**
 * Telling the board that a reporting window has opened.
 *
 * A deadline entered in the ledger nobody is told about is a deadline nobody
 * meets. Lag (2026:484) 3 kap. gives two weeks and 3 kap. 10 § lets Lantmateriet
 * order a late report in under penalty of a fine, so the message goes out when
 * the window opens rather than being left for whoever next opens the queue.
 *
 * ## Queued, and not sent on the request path
 *
 * Every board fan-out in this application is queued, and the reason is the
 * request rather than the mail. A board has as many seats as it has, each send
 * is a separate SMTP conversation, and MailService bounds a stage of one
 * conversation rather than the sum of them - so a mail server that is merely
 * unreachable would hold an already-committed register write open for as long as
 * every seat takes to time out. What the caller does then is retry, and a
 * termination carries no uniqueness constraint: the retry writes a second
 * statutory row that the database will not let anybody delete. Taking the sends
 * off the request path is what removes that, not a shorter timeout.
 *
 * The job is enqueued AFTER the register transaction has committed and inside a
 * try/catch, which is the opposite of the move-out reminder's ordering and for
 * the opposite reason. That reminder cannot be reconstructed - the EXIT row
 * refuses a second move-out, so a lost reminder has no path back - so it is
 * enqueued by the transaction that decides to send it. This notice is
 * reconstructable: the queue screen lists every duty whether or not anybody was
 * written to. So a job queue that is down must not be able to fail a statutory
 * register write, and the notice is the half worth losing.
 *
 * The payload is one identifier. The handler reads the dates and the apartment
 * back from the ledger rather than trusting a payload, for the reason the
 * move-out reminder gives about its own figures: a message stating a deadline
 * that no longer matches the row would be worse than no message.
 *
 * ## A failed send never leaves the handler
 *
 * The loop catches per board member, so one unreachable address does not abandon
 * the seats after it: a rejection that escaped would leave the board members
 * before the failure notified and the ones after it not, with nothing saying
 * which.
 *
 * ## The address is decrypted per send and never held
 *
 * A recipient is resolved from their person row each time a message goes out and
 * the plaintext address lives in one local for the length of the call. It is
 * never a field on this service and never in a log line: only the person id and
 * the obligation id are, which is the convention `logging/failure.ts` sets out.
 * A mail server refusing a recipient quotes the envelope back, and that envelope
 * holds an address decrypted a few lines earlier.
 *
 * ## The locale is the recipient's own
 *
 * Read off each board member's row rather than taken from whoever recorded the
 * register event. A board with a Swedish chair and an English-reading treasurer
 * gets one message each in their own language, and the message names the
 * register event through a locale key rather than as a rendered word so the
 * whole sentence follows the recipient.
 */
@Injectable()
export class RegisterReportMailerService implements OnModuleInit {
  private readonly logger = new Logger(RegisterReportMailerService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the handler themselves, so a job under test is
      // not raced by a worker that came up with the module.
      return;
    }
    await this.startNoticeWorker();
  }

  /** Registers the worker. Public so an integration test can drive the job. */
  async startNoticeWorker(): Promise<void> {
    await this.jobs.work<RegisterReportNoticeJob>(
      REGISTER_REPORT_NOTICE_QUEUE,
      async (data) => {
        await this.notifyBoard(data.obligationId);
      },
    );
  }

  /**
   * Puts one notice on the queue.
   *
   * Called after the register transaction has committed, by a caller that
   * swallows a failure here. Nothing in this method reaches a mail server.
   */
  async enqueueNotice(obligationId: string): Promise<void> {
    await this.jobs.send<RegisterReportNoticeJob>(
      REGISTER_REPORT_NOTICE_QUEUE,
      { obligationId },
    );
  }

  /**
   * Tells the board that one duty exists.
   *
   * @returns How many board members the message reached.
   */
  async notifyBoard(
    obligationId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const obligation = await this.prisma.registerReportObligation.findUnique({
      where: { id: obligationId },
      select: {
        id: true,
        kind: true,
        triggeredOn: true,
        dueOn: true,
        apartment: {
          select: {
            number: true,
            address: { select: { street: true, number: true } },
          },
        },
      },
    });
    if (obligation === null) {
      // The ledger refuses DELETE, so this is a job for a row that never
      // existed - a payload from an older build, or a queue drained against
      // another database. Nothing to say, and nothing to retry.
      this.logger.warn(
        `No reporting obligation ${obligationId} to notify the board about`,
      );
      return 0;
    }

    const board = await this.prisma.person.findMany({
      where: {
        // A seat with an end date in the future is still held, which is how
        // every other reader of this table decides.
        boardPositions: {
          some: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
        },
        emailCipher: { not: null },
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        emailCipher: true,
        preferredLocale: true,
      },
    });

    const designation = `${obligation.apartment.address.street} ${obligation.apartment.address.number} ${obligation.apartment.number}`;

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
          template: registerReportObligationMail,
          props: {
            recipientName: `${member.firstName} ${member.lastName}`.trim(),
            kind: obligation.kind,
            designation,
            triggeredOn: obligation.triggeredOn,
            dueOn: obligation.dueOn,
          },
        });
        sent += 1;
      } catch (error) {
        // Named by person id, obligation id and the class of the failure, never
        // by address and never by the failure's own payload: this loop decrypts
        // an address and hands it to a mail server, which quotes it back.
        this.logger.error(
          `Reporting obligation notice failed for board member ${member.id} ` +
            `on obligation ${obligation.id}: ` +
            failureName(error),
        );
      }
    }

    this.logger.log(
      `Reporting obligation ${obligation.id} notified to ${String(sent)} board members`,
    );
    return sent;
  }
}
