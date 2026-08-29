import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import { contactSubmissionMail } from "../mail/templates";

/**
 * Messages the public writes to the board through the website's contact form.
 *
 * The ordering is the whole design and it is stated once here: the submission
 * is STORED, and only then is the board's notification enqueued. A housing
 * cooperative's SMTP settings are entered by a volunteer and are as likely to
 * be wrong as right, so a form that mailed first and stored afterwards - or
 * that stored nothing and only mailed - would lose a neighbour's message to a
 * misconfiguration nobody noticed. The inbox in settings is the record; the
 * email is a notification about it, and it says so.
 *
 * The fan-out is two queues rather than one loop, which is the one place this
 * deliberately departs from the board reminder in `move.service.ts`. That one
 * enumerates the board inside a single job and swallows each recipient's
 * failure, because a rejection would fail the whole job and the retry would
 * start at the first board member again - so everyone before the failure would
 * be told twice and everyone after it never. Splitting the work makes the
 * question go away: the first job reads who the board is and enqueues one job
 * per member, and each of those sends exactly one message and may fail and be
 * retried on its own without touching anybody else's.
 */

/** Reads the board and enqueues one delivery per member. Payload: submission. */
export const CONTACT_FANOUT_QUEUE = "contact-submission-fanout";

/** Sends one board member one message. Payload: submission and person. */
export const CONTACT_NOTICE_QUEUE = "contact-submission-notice";

export interface ContactFanoutJob {
  submissionId: string;
  [key: string]: unknown;
}

export interface ContactNoticeJob {
  submissionId: string;
  personId: string;
  [key: string]: unknown;
}

export interface SubmitContactMessageInput {
  /** What the sender called themselves, when they gave a name. */
  name?: string;
  email: string;
  message: string;
}

/** One message, as the board reads it in settings. */
export interface ContactSubmissionView {
  id: string;
  name: string | null;
  /** Decrypted for the board, because answering it is the point of the form. */
  email: string;
  message: string;
  handled: boolean;
  handledAt: string | null;
  createdAt: string;
}

/**
 * How many messages the inbox hands over at once.
 *
 * A bound rather than paging: the queue this drains is a board's correspondence
 * with the street, and a cooperative that has more than this waiting has a
 * problem no second page would solve.
 */
const INBOX_LIMIT = 200;

@Injectable()
export class ContactService implements OnModuleInit {
  private readonly logger = new Logger(ContactService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the jobs themselves, so a worker that came up
      // with the module does not race the assertions.
      return;
    }
    await this.startWorkers();
  }

  /** Registers both workers. Public so an integration test can drive them. */
  async startWorkers(): Promise<void> {
    await this.jobs.work<ContactFanoutJob>(
      CONTACT_FANOUT_QUEUE,
      async (data) => {
        await this.fanOutToBoard(data.submissionId);
      },
    );
    await this.jobs.work<ContactNoticeJob>(
      CONTACT_NOTICE_QUEUE,
      async (data) => {
        await this.notifyBoardMember(data.submissionId, data.personId);
      },
    );
  }

  /**
   * Stores a message and asks for the board to be told about it.
   *
   * The job is written by the same transaction as the row, so the two commit
   * together or neither does. Sending after the commit instead would have no
   * way back when the enqueue fails: the message would be stored with nobody
   * ever told, which is the failure this form cannot afford.
   *
   * An address the blind index cannot be computed from is stored anyway,
   * without an index. That is the opposite of what a sign-up request does, and
   * for a reason: a sign-up request's address has to be matched to a person
   * later, so an unusable one is a validation failure. A message to the board
   * only has to be readable by a person, and refusing to store it because the
   * address will not normalise would throw away what somebody wrote.
   */
  async submit(input: SubmitContactMessageInput): Promise<{ id: string }> {
    const email = await this.encryption.encrypt(
      "contactSubmission.email",
      input.email,
    );

    // Before the transaction: creating a queue is the queue backend's own work
    // on its own connection and has no business inside somebody else's.
    await this.jobs.ensureQueue(CONTACT_FANOUT_QUEUE);
    await this.jobs.ensureQueue(CONTACT_NOTICE_QUEUE);

    const submission = await this.prisma.$transaction(async (tx) => {
      const row = await tx.contactSubmission.create({
        data: {
          name: input.name ?? null,
          emailCipher: email.cipher,
          emailIndex: email.index,
          message: input.message,
        },
        select: { id: true },
      });

      await this.jobs.sendInTransaction<ContactFanoutJob>(
        tx,
        CONTACT_FANOUT_QUEUE,
        { submissionId: row.id },
      );

      return row;
    });

    // The identifier only. What somebody wrote to their board has no business
    // in a log line, and neither has the address they wrote from.
    this.logger.log(`Stored contact submission ${submission.id}`);
    return submission;
  }

  /** The board's inbox, unhandled first and oldest first within each half. */
  async list(): Promise<ContactSubmissionView[]> {
    const rows = await this.prisma.contactSubmission.findMany({
      orderBy: [{ handled: "asc" }, { createdAt: "asc" }],
      take: INBOX_LIMIT,
    });

    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        name: row.name,
        email: await this.encryption.decrypt(
          "contactSubmission.email",
          row.emailCipher,
        ),
        message: row.message,
        handled: row.handled,
        handledAt: row.handledAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    );
  }

  /**
   * Marks a message dealt with, or puts it back.
   *
   * Both directions, because a board member who ticks the wrong row has to be
   * able to untick it: this is a flag on the board's own inbox, not a record of
   * anything that happened.
   */
  async setHandled(input: {
    id: string;
    handled: boolean;
    byPersonId: string;
  }): Promise<ContactSubmissionView> {
    const updated = await this.prisma.contactSubmission.update({
      where: { id: input.id },
      data: {
        handled: input.handled,
        handledAt: input.handled ? new Date() : null,
        handledByPersonId: input.handled ? input.byPersonId : null,
      },
    });

    return {
      id: updated.id,
      name: updated.name,
      email: await this.encryption.decrypt(
        "contactSubmission.email",
        updated.emailCipher,
      ),
      message: updated.message,
      handled: updated.handled,
      handledAt: updated.handledAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  /**
   * Enqueues one delivery for every board member with an address.
   *
   * The board is read here rather than carried in the payload, so a member
   * elected between the message arriving and the job running is told, and one
   * who stood down is not.
   */
  async fanOutToBoard(submissionId: string): Promise<number> {
    const submission = await this.prisma.contactSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true },
    });
    if (submission === null) {
      // Nothing to tell anybody about. A submission can be gone by the time
      // this runs - service-tier data is purgeable - and that is not a failure
      // to retry.
      this.logger.warn(
        `Contact fan-out skipped: submission ${submissionId} is gone.`,
      );
      return 0;
    }

    const board = await this.activeBoardMemberIds();
    if (board.length === 0) {
      // Worth a line: the message is stored and the inbox has it, but nobody
      // will be told by email until the board register is filled in.
      this.logger.warn(
        `Contact submission ${submissionId} has no board member to notify.`,
      );
      return 0;
    }

    await this.jobs.ensureQueue(CONTACT_NOTICE_QUEUE);
    for (const personId of board) {
      await this.jobs.send<ContactNoticeJob>(CONTACT_NOTICE_QUEUE, {
        submissionId,
        personId,
      });
    }

    this.logger.log(
      `Contact submission ${submissionId} queued for ${String(board.length)} board members`,
    );
    return board.length;
  }

  /**
   * Sends one board member one message.
   *
   * A failure is rethrown so the queue retries this delivery and no other. That
   * is the difference from the reminder loop in the moves module: one recipient
   * per job means a retry cannot send anybody a second copy.
   *
   * An instance with no SMTP settings is the exception, and it is not a
   * failure to retry: the message is stored, the inbox shows it, and there is
   * nothing a further attempt could do differently until somebody fills the
   * settings in.
   */
  async notifyBoardMember(
    submissionId: string,
    personId: string,
  ): Promise<boolean> {
    const submission = await this.prisma.contactSubmission.findUnique({
      where: { id: submissionId },
      select: {
        name: true,
        emailCipher: true,
        message: true,
        createdAt: true,
      },
    });
    if (submission === null) {
      this.logger.warn(
        `Contact notice skipped: submission ${submissionId} is gone.`,
      );
      return false;
    }

    const now = new Date();
    const member = await this.prisma.person.findFirst({
      where: {
        id: personId,
        boardPositions: {
          some: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
        },
        emailCipher: { not: null },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        emailCipher: true,
        preferredLocale: true,
      },
    });
    const recipientCipher = member?.emailCipher;
    if (member === null || recipientCipher == null) {
      // They left the board, or lost their address, between the fan-out and
      // this delivery. Not a failure: there is nobody to send to.
      this.logger.log(
        `Contact notice for ${submissionId} skipped: ${personId} is not a board member with an address.`,
      );
      return false;
    }

    try {
      await this.mail.send({
        to: await this.encryption.decrypt("person.email", recipientCipher),
        locale: member.preferredLocale,
        template: contactSubmissionMail,
        props: {
          recipientName: `${member.firstName} ${member.lastName}`.trim(),
          senderName: submission.name,
          senderEmail: await this.encryption.decrypt(
            "contactSubmission.email",
            submission.emailCipher,
          ),
          message: submission.message,
          receivedAt: submission.createdAt,
        },
      });
    } catch (error) {
      if (error instanceof MailNotConfiguredError) {
        this.logger.warn(
          `Contact submission ${submissionId} is stored but was not mailed: this instance has no SMTP settings.`,
        );
        return false;
      }
      // Named by the class of the failure and never by its payload: this line
      // is written after an address was decrypted and handed to a mail server,
      // and a rejection quotes the address back.
      this.logger.error(
        `Contact notice for ${submissionId} failed for board member ${member.id}: ${failureName(error)}`,
      );
      throw error;
    }

    return true;
  }

  /** Everyone holding a board position that has not ended. */
  private async activeBoardMemberIds(): Promise<string[]> {
    const now = new Date();
    const board = await this.prisma.person.findMany({
      where: {
        boardPositions: {
          some: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
        },
        emailCipher: { not: null },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    return board.map((member) => member.id);
  }
}
