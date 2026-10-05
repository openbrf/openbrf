import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  type JobSendOptions,
  JobQueueService,
} from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { activeBoardRecipientsWhere } from "../mail/board-recipients";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import { contactSubmissionMail } from "../mail/templates";
import { ContactError } from "./contact.error";

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

/**
 * Where either job lands once its retries are spent. Nothing is lost there -
 * the message is in the inbox whatever happens to the mail about it - but a
 * board that was never told has to be findable in the log.
 */
export const CONTACT_ABANDONED_QUEUE = "contact-submission-abandoned";

/**
 * Retries spread over about half an hour, because what a second attempt can
 * change here is a mail server that greylisted the first one or was briefly
 * away, and three attempts in the same second change neither.
 */
const NOTICE_JOB_OPTIONS = {
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
  deadLetter: CONTACT_ABANDONED_QUEUE,
} satisfies JobSendOptions;

/**
 * How many messages in an hour the board is mailed about, whoever sent them.
 *
 * The form's own limit is per client address, and every stored message mails
 * every board member, so many senders together could otherwise spend the
 * association's mail account - the account its sign-in links and invitations
 * go out through. Past this, a message is stored and shown in the inbox as
 * always, and only the mail about it is left out. A board that has had this
 * many notices in an hour has reason to look at the inbox already.
 */
export const NOTIFIED_SUBMISSIONS_PER_HOUR = 10;

const HOUR_MS = 60 * 60 * 1000;

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

/** One page of the inbox, and what is behind it. */
export interface ContactInboxPage {
  submissions: ContactSubmissionView[];
  /** Every unhandled message, on this page or not. */
  unhandled: number;
  /** Every message the inbox holds. */
  total: number;
  /** Where the next page starts, or null when this is the last one. */
  nextCursor: string | null;
}

/** How many messages the inbox hands over at once. */
export const INBOX_PAGE_SIZE = 50;

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
    // Both queues give up into this one, and both payloads name the message.
    await this.jobs.work<ContactFanoutJob | ContactNoticeJob>(
      CONTACT_ABANDONED_QUEUE,
      (data) => {
        // The identifiers only, as everywhere else in this file.
        this.logger.error(
          `Gave up telling the board about contact submission ${data.submissionId}; it is in the inbox.`,
        );
      },
    );
  }

  /**
   * Creates the queues these jobs use, the dead letter among them.
   *
   * Before any transaction: creating a queue is the queue backend's own work
   * on its own connection and has no business inside somebody else's.
   */
  private async ensureQueues(): Promise<void> {
    await this.jobs.ensureQueue(CONTACT_ABANDONED_QUEUE);
    await this.jobs.ensureQueue(CONTACT_FANOUT_QUEUE);
    await this.jobs.ensureQueue(CONTACT_NOTICE_QUEUE);
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

    await this.ensureQueues();

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
        NOTICE_JOB_OPTIONS,
      );

      return row;
    });

    // The identifier only. What somebody wrote to their board has no business
    // in a log line, and neither has the address they wrote from.
    this.logger.log(`Stored contact submission ${submission.id}`);
    return submission;
  }

  /**
   * The board's inbox, unhandled first and oldest first within each half, a
   * page at a time.
   *
   * Paged rather than cut off, and counted, so a burst of messages cannot hide
   * the ones behind it: the board is told how many are waiting and can read on
   * past any number of them. The cursor is the last row's own sort key rather
   * than its identifier, so a row removed since the last page loses nothing.
   *
   * A row handled or reopened since then does move, because whether it is
   * handled is part of the order: one marked handled comes round again further
   * on, and one reopened lands before the cursor and is not shown until the
   * inbox is read from the start. The screen drops a row it already shows, and
   * the counts above the list are always current.
   */
  async list(cursor?: string): Promise<ContactInboxPage> {
    const after = cursor === undefined ? null : readInboxCursor(cursor);

    const [rows, unhandled, total] = await Promise.all([
      this.prisma.contactSubmission.findMany({
        where: after === null ? {} : afterCursor(after),
        orderBy: [{ handled: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: INBOX_PAGE_SIZE + 1,
      }),
      this.prisma.contactSubmission.count({ where: { handled: false } }),
      this.prisma.contactSubmission.count(),
    ]);

    const page = rows.slice(0, INBOX_PAGE_SIZE);
    const last = page.at(-1);
    return {
      submissions: await Promise.all(page.map((row) => this.viewOf(row))),
      unhandled,
      total,
      nextCursor:
        rows.length > INBOX_PAGE_SIZE && last !== undefined
          ? inboxCursor(last)
          : null,
    };
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
    /*
     * Conditional on the row, so a message that is gone is a refusal this board
     * can be told about rather than the database's own failure - including one
     * removed between this call's read and its write.
     *
     * Reachable without anybody doing anything wrong: the inbox in front of the
     * board was read a moment ago, and these rows are service tier - removable
     * by another board member in the meantime. IssueService.setStatus answers
     * the same situation the same way.
     */
    const { count } = await this.prisma.contactSubmission.updateMany({
      where: { id: input.id },
      data: {
        handled: input.handled,
        handledAt: input.handled ? new Date() : null,
        handledByPersonId: input.handled ? input.byPersonId : null,
      },
    });
    const updated =
      count === 0
        ? null
        : await this.prisma.contactSubmission.findUnique({
            where: { id: input.id },
          });
    if (updated === null) {
      throw new ContactError("No such message.", "not-found");
    }

    return this.viewOf(updated);
  }

  /**
   * Removes a message from the inbox, for good.
   *
   * The board's own act, and the only bounded retention these rows have today.
   * A message is somebody's name, address and free text about their own
   * situation, and most of them come from people the association holds no
   * record of at all - so the person-keyed purge that erases a former
   * resident's service data cannot reach them, and there is no move-out date to
   * count a retention period from. Until the retention policy grows a period
   * for correspondence, the board deleting what it has answered is what keeps
   * this table from being an unbounded store of strangers' personal data.
   *
   * Service tier, so deleting is allowed: no append-only trigger, nothing
   * statutory, and nothing downstream refers to these rows.
   */
  async remove(id: string): Promise<void> {
    if ((await this.removeMany([id])) === 0) {
      throw new ContactError("No such message.", "not-found");
    }
  }

  /**
   * Removes several messages at once, and answers how many were there.
   *
   * What a board clearing a burst of junk out of the inbox needs, rather than
   * one confirmation per row. A message already gone is not an error here: the
   * board asked for it not to be in the inbox, and it is not.
   */
  async removeMany(ids: readonly string[]): Promise<number> {
    const { count } = await this.prisma.contactSubmission.deleteMany({
      where: { id: { in: [...ids] } },
    });
    // How many and nothing else. What was written to the board has no business
    // in a log line, on the way in or on the way out.
    this.logger.log(`Removed ${String(count)} contact submissions`);
    return count;
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
      select: { id: true, createdAt: true },
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

    /*
     * Counted from the stored messages rather than from mail sent, so a retry
     * of this job reaches the same answer as the first attempt did.
     */
    const earlier = await this.prisma.contactSubmission.count({
      where: {
        createdAt: {
          gte: new Date(submission.createdAt.getTime() - HOUR_MS),
          lt: submission.createdAt,
        },
      },
    });
    if (earlier >= NOTIFIED_SUBMISSIONS_PER_HOUR) {
      this.logger.warn(
        `Contact submission ${submissionId} is stored but the board was not mailed: ${String(NOTIFIED_SUBMISSIONS_PER_HOUR)} messages in an hour have been.`,
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

    /*
     * One transaction for the whole fan-out, so it cannot half-happen.
     *
     * Enqueuing one job at a time left a window: a failure partway through the
     * loop is retried from the top, and every board member already enqueued
     * would be told twice. Writing all of them with one commit removes that
     * window - either the board is queued or none of it is.
     *
     * What remains is the queue's own at-least-once delivery, which every
     * worker in this codebase lives under: a job whose completion is not
     * recorded runs again. That is bounded here to a duplicate notification
     * about a message the board can already read in the inbox, and closing it
     * would need a delivery record per recipient, which is a heavier thing
     * than the failure it would prevent.
     */
    await this.ensureQueues();
    await this.prisma.$transaction(async (tx) => {
      for (const personId of board) {
        await this.jobs.sendInTransaction<ContactNoticeJob>(
          tx,
          CONTACT_NOTICE_QUEUE,
          { submissionId, personId },
          NOTICE_JOB_OPTIONS,
        );
      }
    });

    this.logger.log(
      `Contact submission ${submissionId} queued for ${String(board.length)} board members`,
    );
    return board.length;
  }

  /**
   * Sends one board member one message.
   *
   * A failure is rethrown so the queue retries this delivery and no other. That
   * is the difference from the reminder loop in the moves module, where a
   * rejection fails the whole job and the retry starts at the first board
   * member again: one recipient per job keeps a retry to the recipient it
   * failed for, rather than replaying it over everybody before them.
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

    const member = await this.prisma.person.findFirst({
      where: { id: personId, ...activeBoardRecipientsWhere(new Date()) },
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

  private async viewOf(row: {
    id: string;
    name: string | null;
    emailCipher: string;
    message: string;
    handled: boolean;
    handledAt: Date | null;
    createdAt: Date;
  }): Promise<ContactSubmissionView> {
    return {
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
    };
  }

  /** Everyone holding a board seat today, with an address to reach them at. */
  private async activeBoardMemberIds(): Promise<string[]> {
    const board = await this.prisma.person.findMany({
      where: activeBoardRecipientsWhere(new Date()),
      select: { id: true },
      orderBy: { id: "asc" },
    });
    return board.map((member) => member.id);
  }
}

/** Where one page of the inbox ended: the last row's sort key. */
interface InboxCursor {
  handled: boolean;
  createdAt: Date;
  id: string;
}

/**
 * The cursor for the page ending at this row. Every part is something the
 * board was just shown, so it travels legibly rather than encoded.
 */
function inboxCursor(row: InboxCursor): string {
  return [
    row.handled ? "handled" : "open",
    row.createdAt.toISOString(),
    row.id,
  ].join("|");
}

/**
 * The cursor a reader handed back, refused as a place in the inbox that is not
 * there when this service did not write it - rather than read as the first
 * page, which would hand a board reading on the messages already in front of
 * it.
 */
function readInboxCursor(value: string): InboxCursor {
  const [state, instant = "", id = "", ...rest] = value.split("|");
  const createdAt = new Date(instant);
  if (
    rest.length > 0 ||
    (state !== "open" && state !== "handled") ||
    id === "" ||
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== instant
  ) {
    throw new ContactError(
      "There is no such place in the inbox. Read it again from the start.",
      "not-found",
    );
  }
  return { handled: state === "handled", createdAt, id };
}

/** Every row the inbox order puts after the cursor. */
function afterCursor(after: InboxCursor) {
  const laterInItsHalf = {
    handled: after.handled,
    OR: [
      { createdAt: { gt: after.createdAt } },
      { createdAt: after.createdAt, id: { gt: after.id } },
    ],
  };
  return after.handled
    ? laterInItsHalf
    : { OR: [laterInItsHalf, { handled: true }] };
}
