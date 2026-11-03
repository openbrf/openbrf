import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  addLocalDays,
  compareLocalDays,
  formatDateColumn,
  formatLocalDay,
  instantAt,
  type LocalDay,
  localDayOf,
  localDayOfColumn,
  parseLocalDay,
} from "@openbrf/shared";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  type JobSendOptions,
  JobQueueService,
} from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import {
  type IssueHandlerNoticeEvent,
  issueHandlerNoticeMail,
  issueReporterNoticeMail,
} from "../mail/templates";
import { issueHandledBy, issueRecipientsWhere } from "./issue-handlers";
import { lockIssue } from "./issue-lock";

/**
 * The mail about issues (decisions 10, 12 and 21 of the issue module plan):
 * who is told what, and when.
 *
 * - **Filed.** A new issue is mailed to its assignee when its type assigned it,
 *   and to its type's handlers when it landed unassigned.
 * - **Akut.** An issue filed as Akut, or raised to it, is mailed to every
 *   handler of the issue, whoever is assigned (decision 12).
 * - **Assigned.** A handler giving an issue to somebody mails that person.
 * - **Overdue.** The assignee is reminded once when the issue's target date has
 *   passed and it is not closed (decision 10).
 * - **Reopened.** A closed issue opened again is mailed to its assignee, or to
 *   its handlers when it has none (decision 8).
 * - **Issue message.** A reporter's message is mailed to the assignee, or to
 *   the handlers when there is none; a handler's to a reporter who has an
 *   account. Nobody's words go with it (GLOSSARY.md, _svar_).
 *
 * The person whose act it was is never told of it. Every handler read is
 * `issueRecipientsWhere`, the handler rule of `issueHandlersWhere` with an
 * address and no restriction under GDPR art. 18, for the issue's own scope, so
 * a board-only issue never reaches the property manager by mail either.
 *
 * ## No free text
 *
 * A mail carries the issue number, the type's name, the priority and a link,
 * and nothing anybody wrote (decision 21): see the templates. Nothing written
 * goes on the queue either. A job holds identifiers, the event and a date.
 *
 * ## Stored, then told
 *
 * Every mail is a job written by the transaction of the act it tells of, so it
 * commits with the act or not at all and no worker reads the issue before the
 * act is there to read, as the contact form does. One job per person, retried
 * on its own: a mail server refusing one address costs nobody else their mail.
 * Each delivery reads the issue again and sends nothing once what it tells of
 * is no longer so - the issue closed, handed on, lowered from Akut, or the
 * person no longer handling it - so a job that waited on a retry never tells a
 * handler something that stopped being true. A delivery run twice repeats one
 * person's mail and nobody else's.
 *
 * ## The overdue reminder
 *
 * The queue has no cancel, so a reminder no-ops rather than being withdrawn, as
 * the breach reminder does. Setting a target date queues a job for the morning
 * after it, carrying the date; a job whose date is no longer the issue's finds
 * itself stale and sends nothing. A job that is owed claims the reminder under
 * the issue's lock by writing the date to `overdueRemindedFor` and queues the
 * delivery in the same transaction, so a second job for the same date - the
 * date moved away and back, or the issue reopened - finds it claimed. Once for
 * each target date: moving the date gives the new one a reminder of its own.
 */

/** Sends one person one mail about one issue. */
export const ISSUE_NOTICE_QUEUE = "issue-notice";

/** Decides, on the morning after a target date, whether a reminder is owed. */
export const ISSUE_OVERDUE_QUEUE = "issue-overdue-reminder";

/**
 * Where a delivery lands once its retries are spent. Nothing is lost: the issue
 * is in the queue whatever happens to the mail about it.
 */
export const ISSUE_NOTICE_ABANDONED_QUEUE = "issue-notice-abandoned";

/** The contact form's retry policy: a mail server that greylisted or was away. */
const NOTICE_JOB_OPTIONS = {
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
  deadLetter: ISSUE_NOTICE_ABANDONED_QUEUE,
} satisfies JobSendOptions;

/** The overdue job reads and writes the database only; a few quick retries. */
const OVERDUE_JOB_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
} satisfies JobSendOptions;

/**
 * The minute of the association's day the overdue reminder goes out, the
 * morning after the target date: in working hours rather than at midnight,
 * which is the first minute the issue is overdue.
 */
const OVERDUE_REMINDER_MINUTE = 7 * 60;

/**
 * How many issues from the website's form in an hour the handlers are mailed
 * about, whoever filed them.
 *
 * The form's own limit is per client address, and an unassigned report mails
 * every handler of its type, so many senders together could otherwise spend
 * the association's mail account - the one its sign-in links go out through.
 * Past this, a report is filed and shown in the queue as always, and only the
 * mail about it is left out. The contact form's bound, for the same reason.
 */
export const NOTIFIED_PUBLIC_REPORTS_PER_HOUR = 10;

const HOUR_MS = 60 * 60 * 1000;

/** What a delivery tells of: a handler's event, or a reporter's new message. */
export type IssueNoticeEvent = IssueHandlerNoticeEvent | "reporterMessage";

export interface IssueNoticeJob {
  issueId: string;
  personId: string;
  event: IssueNoticeEvent;
  /** The target date an `overdue` delivery is for, as `YYYY-MM-DD`. */
  targetDate?: string;
  [key: string]: unknown;
}

export interface IssueOverdueJob {
  issueId: string;
  /**
   * The target date the job was queued for, as `YYYY-MM-DD`. Carried so the job
   * can tell its own date from a stale one: a moved date queues a new job and
   * leaves this one, which then finds the issue's date is not its own.
   */
  targetDate: string;
  [key: string]: unknown;
}

/** Who wrote an issue message, for the mail that says there is a new one. */
export type IssueMessageAuthor =
  { kind: "reporter" } | { kind: "handler"; personId: string };

/** What every decision here reads of an issue. */
const ISSUE_SELECT = {
  id: true,
  number: true,
  priority: true,
  targetDate: true,
  overdueRemindedFor: true,
  assigneePersonId: true,
  reporterPersonId: true,
  enteredByPersonId: true,
  enteredByHandler: true,
  boardOnly: true,
  status: { select: { meaning: true } },
  type: { select: { name: true, handledBy: true } },
} as const;

type NoticeIssue = Prisma.IssueGetPayload<{ select: typeof ISSUE_SELECT }>;

type Db = Prisma.TransactionClient | PrismaService;

@Injectable()
export class IssueMailer implements OnModuleInit {
  private readonly logger = new Logger(IssueMailer.name);

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
    await this.ensureQueues();
    await this.jobs.work<IssueNoticeJob>(ISSUE_NOTICE_QUEUE, async (data) => {
      await this.deliver(data);
    });
    await this.jobs.work<IssueOverdueJob>(ISSUE_OVERDUE_QUEUE, async (data) => {
      await this.remindOverdue(data);
    });
    await this.jobs.work<IssueNoticeJob>(
      ISSUE_NOTICE_ABANDONED_QUEUE,
      (data) => {
        // Identifiers only, as everywhere else in this module.
        this.logger.error(
          `Gave up mailing ${data.personId} about issue ${data.issueId} (${data.event}); it is in the queue.`,
        );
      },
    );
  }

  /**
   * Creates the queues, the dead letter among them.
   *
   * Before the transaction of an act that mails: creating a queue happens on
   * the queue backend's own connection and has no place inside it.
   */
  async ensureQueues(): Promise<void> {
    await this.jobs.ensureQueue(ISSUE_NOTICE_ABANDONED_QUEUE);
    await this.jobs.ensureQueue(ISSUE_NOTICE_QUEUE);
    await this.jobs.ensureQueue(ISSUE_OVERDUE_QUEUE);
  }

  /**
   * Queues the mail about a newly filed issue, in the transaction that files
   * it (decision 12).
   *
   * Akut goes to every handler of the issue. Otherwise the assignee, when the
   * type assigned one, or every handler of the issue when it landed
   * unassigned. The assignee is told it is theirs either way. The handler who
   * opened the issue is told nothing.
   *
   * A report from the website's form is mailed about only while fewer than
   * {@link NOTIFIED_PUBLIC_REPORTS_PER_HOUR} came in the hour before it.
   *
   * Answers how many were queued.
   */
  async filedInTransaction(
    tx: Prisma.TransactionClient,
    issueId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const issue = await this.readIssue(tx, issueId);
    if (issue === null) {
      return 0;
    }
    // The handler who opened it, if one did; nobody is told of their own act.
    const except = issue.enteredByPersonId;

    if (
      isFromPublicForm(issue) &&
      (await this.publicFormFlooded(tx, issue, now))
    ) {
      this.logger.warn(
        `Issue ${issueId} is in the queue but nobody was mailed: ${String(NOTIFIED_PUBLIC_REPORTS_PER_HOUR)} reports from the website's form in an hour have been.`,
      );
      return 0;
    }

    const assignee = issue.assigneePersonId;
    const everyHandler =
      issue.priority === "URGENT" || assignee === null
        ? await this.recipients(tx, issue, now)
        : [];
    const deliveries = new Map<string, IssueHandlerNoticeEvent>();
    for (const personId of everyHandler) {
      deliveries.set(
        personId,
        issue.priority === "URGENT" ? "urgent" : "filed",
      );
    }
    if (
      assignee !== null &&
      (await this.isRecipient(tx, assignee, issue, now))
    ) {
      deliveries.set(assignee, "assigned");
    }
    return this.queue(tx, issueId, deliveries, except);
  }

  /**
   * Queues the mail to a new assignee, in the transaction that assigns them.
   * Nothing when the actor assigned the issue to themselves.
   */
  async assignedInTransaction(
    tx: Prisma.TransactionClient,
    issueId: string,
    assigneePersonId: string,
    actorPersonId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const issue = await this.readIssue(tx, issueId);
    if (
      issue === null ||
      !(await this.isRecipient(tx, assigneePersonId, issue, now))
    ) {
      return 0;
    }
    return this.queue(
      tx,
      issueId,
      new Map([[assigneePersonId, "assigned"]]),
      actorPersonId,
    );
  }

  /**
   * Queues the Akut mail to every handler of the issue but the actor, in the
   * transaction that raises its priority to Akut (decision 12).
   */
  async raisedToUrgentInTransaction(
    tx: Prisma.TransactionClient,
    issueId: string,
    actorPersonId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const issue = await this.readIssue(tx, issueId);
    if (issue === null || issue.status.meaning === "DONE") {
      return 0;
    }
    const handlers = await this.recipients(tx, issue, now);
    return this.queue(
      tx,
      issueId,
      new Map(handlers.map((personId) => [personId, "urgent"])),
      actorPersonId,
    );
  }

  /**
   * Queues the reopening alert, in the transaction that moves a closed issue
   * out of done: to its assignee, or to every handler of the issue when it has
   * none, and never to the person who reopened it. The overdue reminder is
   * queued again too, for an issue whose target date is set: a job that came
   * while the issue was closed found nothing owed.
   *
   * `actorPersonId` is null for a reopening nobody chose, such as a reporter's
   * reply.
   */
  async reopenedInTransaction(
    tx: Prisma.TransactionClient,
    issueId: string,
    actorPersonId: string | null,
    now: Date = new Date(),
  ): Promise<number> {
    const issue = await this.readIssue(tx, issueId);
    if (issue === null) {
      return 0;
    }
    if (issue.targetDate !== null) {
      await this.scheduleOverdue(
        tx,
        issueId,
        localDayOfColumn(issue.targetDate),
        now,
      );
    }
    return this.queue(
      tx,
      issueId,
      await this.assigneeOrHandlers(tx, issue, "reopened", now),
      actorPersonId,
    );
  }

  /**
   * Queues the overdue reminder for a target date just set, in the transaction
   * that sets it. Nothing for a date removed: the job queued for the old date
   * finds it gone and sends nothing.
   */
  async targetDateSetInTransaction(
    tx: Prisma.TransactionClient,
    issueId: string,
    targetDate: LocalDay | null,
    now: Date = new Date(),
  ): Promise<void> {
    if (targetDate !== null) {
      await this.scheduleOverdue(tx, issueId, targetDate, now);
    }
  }

  /**
   * Queues the mail that says an issue has a new issue message, in the
   * transaction that stores the message. Never the message itself.
   *
   * A reporter's goes to the assignee, or to every handler of the issue when it
   * has none. A handler's goes to the reporter when the reporter has an
   * account; a reporter from the website's form has the private link instead
   * (ADR 0055). An internal note is not an issue message and is mailed to
   * nobody.
   */
  async messageInTransaction(
    tx: Prisma.TransactionClient,
    issueId: string,
    author: IssueMessageAuthor,
    now: Date = new Date(),
  ): Promise<number> {
    const issue = await this.readIssue(tx, issueId);
    if (issue === null) {
      return 0;
    }
    if (author.kind === "reporter") {
      return this.queue(
        tx,
        issueId,
        await this.assigneeOrHandlers(tx, issue, "message", now),
        issue.reporterPersonId,
      );
    }
    const reporter = issue.reporterPersonId;
    if (reporter === null || !(await this.reachableReporter(tx, reporter))) {
      return 0;
    }
    return this.queue(
      tx,
      issueId,
      new Map([[reporter, "reporterMessage"]]),
      author.personId,
    );
  }

  /**
   * Decides whether the overdue reminder this job was queued for is owed, and
   * if it is, claims it and queues its mail to the assignee.
   *
   * Owed while the issue is not closed, its target date is still the job's and
   * has passed on the association's calendar, nobody has been reminded of that
   * date, and it has an assignee this channel reaches. Answers whether a mail
   * was queued.
   */
  async remindOverdue(
    job: IssueOverdueJob,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (parseLocalDay(job.targetDate) === null) {
      return false;
    }
    await this.ensureQueues();
    const queued = await this.prisma.$transaction(async (tx) => {
      // The claim is a read followed by a write: two jobs for one date would
      // otherwise both find it unclaimed.
      await lockIssue(tx, job.issueId);
      const issue = await this.readIssue(tx, job.issueId);
      if (issue === null || !overdueFor(issue, job.targetDate, now)) {
        return false;
      }
      if (formatDateColumn(issue.overdueRemindedFor) === job.targetDate) {
        return false;
      }
      const assignee = issue.assigneePersonId;
      if (
        assignee === null ||
        !(await this.isRecipient(tx, assignee, issue, now))
      ) {
        return false;
      }
      await tx.issue.update({
        where: { id: job.issueId },
        data: { overdueRemindedFor: issue.targetDate },
      });
      await this.jobs.sendInTransaction<IssueNoticeJob>(
        tx,
        ISSUE_NOTICE_QUEUE,
        {
          issueId: job.issueId,
          personId: assignee,
          event: "overdue",
          targetDate: job.targetDate,
        },
        NOTICE_JOB_OPTIONS,
      );
      return true;
    });
    if (queued) {
      this.logger.log(`Issue ${job.issueId} overdue reminder queued`);
    }
    return queued;
  }

  /**
   * Sends one person one mail about one issue, or answers false when there is
   * nothing to send: the issue is gone, what the mail tells of is no longer so,
   * the person is no longer somebody it goes to, or the instance has no mail
   * settings.
   *
   * Any other failure is rethrown, so the queue retries this delivery and no
   * other.
   */
  async deliver(job: IssueNoticeJob, now: Date = new Date()): Promise<boolean> {
    const issue = await this.readIssue(this.prisma, job.issueId);
    if (issue === null || !stillSo(issue, job, now)) {
      return false;
    }

    const recipient = await this.prisma.person.findFirst({
      where:
        job.event === "reporterMessage"
          ? {
              id: job.personId,
              emailCipher: { not: null },
              processingRestrictedAt: null,
            }
          : {
              AND: [
                { id: job.personId },
                issueRecipientsWhere(issueHandledBy(issue), now),
              ],
            },
      select: {
        firstName: true,
        lastName: true,
        emailCipher: true,
        preferredLocale: true,
      },
    });
    const cipher = recipient?.emailCipher;
    if (recipient === null || cipher == null) {
      this.logger.log(
        `Mail about issue ${job.issueId} (${job.event}) skipped: ${job.personId} is no longer somebody it goes to.`,
      );
      return false;
    }

    const to = await this.encryption.decrypt("person.email", cipher);
    const recipientName = `${recipient.firstName} ${recipient.lastName}`.trim();
    try {
      if (job.event === "reporterMessage") {
        await this.mail.send({
          to,
          locale: recipient.preferredLocale,
          template: issueReporterNoticeMail,
          props: {
            recipientName,
            number: issue.number,
            typeName: issue.type.name,
          },
        });
      } else {
        await this.mail.send({
          to,
          locale: recipient.preferredLocale,
          template: issueHandlerNoticeMail,
          props: {
            recipientName,
            event: job.event,
            number: issue.number,
            typeName: issue.type.name,
            priority: issue.priority,
            targetDate: job.event === "overdue" ? issue.targetDate : null,
          },
        });
      }
    } catch (error) {
      if (error instanceof MailNotConfiguredError) {
        this.logger.warn(
          `Issue ${job.issueId} is in the queue but was not mailed: this instance has no mail settings.`,
        );
        return false;
      }
      // By the class of the failure: a rejection quotes the address back.
      this.logger.error(
        `Mail about issue ${job.issueId} (${job.event}) failed for ${job.personId}: ${failureName(error)}`,
      );
      throw error;
    }
    return true;
  }

  /** The issue as every decision here reads it, or null when it is gone. */
  private readIssue(db: Db, issueId: string): Promise<NoticeIssue | null> {
    return db.issue.findUnique({
      where: { id: issueId },
      select: ISSUE_SELECT,
    });
  }

  /** The handlers of the issue this channel reaches, by identifier. */
  private async recipients(
    db: Db,
    issue: NoticeIssue,
    now: Date,
  ): Promise<string[]> {
    const people = await db.person.findMany({
      where: issueRecipientsWhere(issueHandledBy(issue), now),
      select: { id: true },
      orderBy: { id: "asc" },
    });
    return people.map((person) => person.id);
  }

  /** Whether a mail about this issue may go to this person as a handler. */
  private async isRecipient(
    db: Db,
    personId: string,
    issue: NoticeIssue,
    now: Date,
  ): Promise<boolean> {
    const person = await db.person.findFirst({
      where: {
        AND: [
          { id: personId },
          issueRecipientsWhere(issueHandledBy(issue), now),
        ],
      },
      select: { id: true },
    });
    return person !== null;
  }

  /** Whether a reporter with an account may be mailed. */
  private async reachableReporter(db: Db, personId: string): Promise<boolean> {
    const person = await db.person.findFirst({
      where: {
        id: personId,
        emailCipher: { not: null },
        processingRestrictedAt: null,
      },
      select: { id: true },
    });
    return person !== null;
  }

  /** The assignee when the issue has one, or every handler of it when not. */
  private async assigneeOrHandlers(
    db: Db,
    issue: NoticeIssue,
    event: IssueHandlerNoticeEvent,
    now: Date,
  ): Promise<Map<string, IssueHandlerNoticeEvent>> {
    const assignee = issue.assigneePersonId;
    if (assignee !== null) {
      return (await this.isRecipient(db, assignee, issue, now))
        ? new Map([[assignee, event]])
        : new Map();
    }
    const handlers = await this.recipients(db, issue, now);
    return new Map(handlers.map((personId) => [personId, event]));
  }

  /**
   * Whether the website's form has filed so many reports in the hour before
   * this one that it is mailed about no more.
   *
   * Counted in the filing's own transaction, so two reports filed at the same
   * moment may each miss the other and both be mailed about: a bound on how
   * much the form spends, not an exact count.
   */
  private async publicFormFlooded(
    tx: Prisma.TransactionClient,
    issue: NoticeIssue,
    now: Date,
  ): Promise<boolean> {
    const earlier = await tx.issue.count({
      where: {
        id: { not: issue.id },
        reporterPersonId: null,
        enteredByHandler: false,
        createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
      },
    });
    return earlier >= NOTIFIED_PUBLIC_REPORTS_PER_HOUR;
  }

  /** Queues one delivery per person, leaving out the person who acted. */
  private async queue(
    tx: Prisma.TransactionClient,
    issueId: string,
    deliveries: ReadonlyMap<string, IssueNoticeEvent>,
    except: string | null,
  ): Promise<number> {
    let queued = 0;
    for (const [personId, event] of deliveries) {
      if (personId === except) {
        continue;
      }
      await this.jobs.sendInTransaction<IssueNoticeJob>(
        tx,
        ISSUE_NOTICE_QUEUE,
        { issueId, personId, event },
        NOTICE_JOB_OPTIONS,
      );
      queued += 1;
    }
    return queued;
  }

  /**
   * Queues the job that decides, the morning after the target date, whether
   * the reminder is owed. A date already past runs it at once.
   */
  private async scheduleOverdue(
    tx: Prisma.TransactionClient,
    issueId: string,
    targetDate: LocalDay,
    now: Date,
  ): Promise<void> {
    const morning =
      instantAt(addLocalDays(targetDate, 1), OVERDUE_REMINDER_MINUTE) ??
      // Seven in the morning always exists; the fallback is for the type.
      instantAt(addLocalDays(targetDate, 1), 0) ??
      now;
    await this.jobs.sendAtInTransaction<IssueOverdueJob>(
      tx,
      ISSUE_OVERDUE_QUEUE,
      { issueId, targetDate: formatLocalDay(targetDate) },
      morning.getTime() > now.getTime() ? morning : now,
      OVERDUE_JOB_OPTIONS,
    );
  }
}

/**
 * A report from the website's form: no account behind it, and no handler
 * entered it.
 */
function isFromPublicForm(issue: NoticeIssue): boolean {
  return issue.reporterPersonId === null && !issue.enteredByHandler;
}

/**
 * Whether the issue is open, its target date is this one, and that day has
 * passed on the association's calendar.
 */
function overdueFor(
  issue: NoticeIssue,
  targetDate: string,
  now: Date,
): boolean {
  if (issue.status.meaning === "DONE" || issue.targetDate === null) {
    return false;
  }
  if (formatDateColumn(issue.targetDate) !== targetDate) {
    return false;
  }
  return (
    compareLocalDays(localDayOfColumn(issue.targetDate), localDayOf(now)) < 0
  );
}

/**
 * Whether what a delivery tells of is still so when it is sent. A mail that
 * waited on a retry must not tell a handler of an issue given to somebody
 * else, lowered from Akut or closed since.
 */
function stillSo(issue: NoticeIssue, job: IssueNoticeJob, now: Date): boolean {
  switch (job.event) {
    case "reporterMessage":
      return issue.reporterPersonId === job.personId;
    case "message":
      return true;
    case "assigned":
      return (
        issue.status.meaning !== "DONE" &&
        issue.assigneePersonId === job.personId
      );
    case "urgent":
      return issue.status.meaning !== "DONE" && issue.priority === "URGENT";
    case "overdue":
      return (
        issue.assigneePersonId === job.personId &&
        job.targetDate !== undefined &&
        overdueFor(issue, job.targetDate, now)
      );
    case "filed":
    case "reopened":
      return issue.status.meaning !== "DONE";
  }
}
