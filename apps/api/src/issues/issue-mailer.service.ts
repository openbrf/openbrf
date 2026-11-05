import { randomUUID } from "node:crypto";

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
import {
  holdIssueTypeRingFence,
  lockFilingBudget,
  lockIssue,
  lockMessageBudget,
  MAIL_TRANSACTION_MS,
  mailHandoffDeadline,
} from "./issue-lock";

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
 *   the handlers when there is none, while the reporter's hourly budget for
 *   messages lasts; a handler's to a reporter who has an account. Nobody's
 *   words go with it (GLOSSARY.md, _svar_).
 * - **Contractor.** The contractor of a work order answered it, wrote a note
 *   or added a photograph through its link: mailed to the assignee, or to the
 *   handlers when there is none, every answer, and a note or a photograph
 *   once an hour at most (ADR 0055).
 *
 * The person whose act it was is never told of it. Every handler read is
 * `issueRecipientsWhere`, the handler rule of `issueHandlersWhere` with an
 * address and no restriction under GDPR art. 18, for the issue's own scope, so
 * a board-only issue never reaches the property manager by mail either.
 *
 * ## Not a ring-fenced issue
 *
 * Nothing about an issue of a ring-fenced type is mailed, to a handler or to
 * its reporter (decision 32): the board reads it on its own screen and the
 * reporter on theirs, and the mail provider is never told that one was made.
 * Every decision here reads the issue through `readIssue`, which does not find
 * one, so none is queued and one queued before the ring-fence sends nothing.
 *
 * ## No free text
 *
 * A mail carries the issue number, the type's name and a link, and a mail to a
 * handler the priority as well. It carries nothing anybody wrote
 * (decision 21): see the templates. Nothing written goes on the queue either.
 * A job holds identifiers, the event and a date.
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
 * handler something that stopped being true. That includes who it goes to: a
 * notice to the handlers of an unassigned issue is dropped once somebody is
 * assigned, and a notice to the assignee once somebody else is. A delivery run
 * twice repeats one person's mail and nobody else's.
 *
 * An issue handed to a person, away and back, or reopened twice, before the
 * first notice is delivered would pass that check twice. The notices of an
 * assignment and of a reopening are therefore throttled to one per person and
 * issue in each slot of {@link REPEATED_NOTICE_SECONDS}: the queue creates no
 * second job for the same event in the same slot. A slot is a clock hour, as
 * the queue cuts time, and not a window that opens with the first notice: a
 * repeat just after the hour turns is a notice of its own. The slot belongs to
 * a notice that was sent or is still to be: one the delivery skipped, because
 * what it told of had stopped being so, or that was given up on, gives it
 * back, so a later assignment or reopening of the same person is told of.
 *
 * One job holds a slot, and only that job may send while it does. A delivery
 * that finds nothing to send decides under the issue's lock, which every act
 * that queues such a notice holds until it commits. An act that came between
 * its look and the lock found the slot taken and queued nothing, so when the
 * notice is owed again the job keeps its slot and looks once more; when it is
 * not, the job gives the slot back and sends nothing, and an act after that
 * queues a job of its own. Each job carries its own id, and gives back its own
 * slot by it, never another job's of the same person and event.
 *
 * ## The overdue reminder
 *
 * The queue has no cancel, so a reminder no-ops rather than being withdrawn, as
 * the breach reminder does. Setting a target date queues a job for the morning
 * after it, carrying the date; a job whose date is no longer the issue's finds
 * itself stale and sends nothing. A job that is owed claims the reminder under
 * the issue's lock by adding the date to `overdueRemindedFor`, the list of
 * dates reminded, and queues the delivery in the same transaction, so a second
 * job for the same date - the date moved away and back, or the issue reopened -
 * finds it claimed, however many other dates were reminded in between. Once for
 * each target date: moving the date gives the new one a reminder of its own.
 *
 * A claim is kept only while its mail may still go out. A delivery that sends
 * nothing, because the assignee changed, the mail settings are missing or the
 * person is out of reach, and a delivery given up on after its retries, give
 * the date back, under the same lock. When the issue has meanwhile been handed
 * to somebody else, the reminder is queued again for them.
 *
 * A job that finds the issue without an assignee this channel reaches claims
 * nothing, so the reminder is still owed. Nothing queues the job again on its
 * own, so assigning the issue does: see {@link IssueMailer.assignedInTransaction}.
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
 * How many reports from the website's form in an hour the handlers are mailed
 * about, whoever filed them: this many ordinary ones, and this many Akut ones
 * besides. The count is of reports filed in the hour, not of mails queued: a
 * report whose type had no handler to mail spends it all the same.
 *
 * The form's own limit is per client address, and an unassigned report mails
 * every handler of its type, so many senders together could otherwise spend
 * the association's mail account - the one its sign-in links go out through.
 * Past this, a report is filed and shown in the queue as always, and only the
 * mail about it is left out. The contact form's bound, for the same reason.
 *
 * Akut is counted apart (decision 12), so a run of ordinary reports never
 * keeps the handlers from hearing of an urgent one. Only Akut reports spend
 * the Akut budget, and by the time they have, the handlers have had that many
 * Akut mails in the hour.
 */
export const NOTIFIED_PUBLIC_REPORTS_PER_HOUR = 10;

/**
 * How many of their own reports in an hour one signed-in reporter has the
 * handlers mailed about: this many ordinary ones, and this many Akut ones
 * besides, as for the website's form. Counted as filed, as for the form.
 *
 * Counted for each reporter, so one resident filing report after report
 * spends their own budget and nobody else's. Past it the report is filed and
 * shown in the queue as always. A handler opening an issue spends nothing:
 * the budget is for what reporters send, not for the handlers' own work.
 */
export const NOTIFIED_REPORTS_PER_REPORTER_PER_HOUR = 5;

/**
 * How many of their own issue messages in an hour one reporter has the
 * handlers mailed about, across all of their issues.
 *
 * A message is mailed to the assignee or to every handler of the issue, and a
 * reporter may write as often as they like, so without a bound one resident
 * could have the handlers mailed hundreds of times an hour and spend the
 * association's mail account - the one its sign-in links go out through.
 * Counted for each reporter, so one resident spends their own budget and
 * nobody else's. Past it the message is stored and shown in the conversation
 * as always, and only the mail about it is left out. A handler's message to
 * the reporter spends nothing: the budget is for what reporters send.
 */
export const NOTIFIED_MESSAGES_PER_REPORTER_PER_HOUR = 10;

const HOUR_MS = 60 * 60 * 1000;

/** The length of the clock-hour slot within which one person is told of one assignment or reopening once. */
export const REPEATED_NOTICE_SECONDS = 60 * 60;

/**
 * How many times a delivery that found its notice owed again under the
 * issue's lock looks once more, before it leaves the decision to its retry.
 * Each look after the first needs the issue to have changed again since the
 * lock was let go.
 */
const REPEATED_LOOKS = 2;

/**
 * The throttle key of an assignment or reopening notice, or null for a notice
 * that is not throttled.
 */
function throttleKeyOf(
  job: Pick<IssueNoticeJob, "issueId" | "personId" | "event" | "contractor">,
): string | null {
  if (job.event === "contractor" && job.contractor === "answer") {
    // The answer that ends a link is never one a note in the same hour may
    // stand in for, and a link takes two answers at most.
    return null;
  }
  return job.event === "assigned" ||
    job.event === "reopened" ||
    job.event === "contractor"
    ? `${job.event}:${job.issueId}:${job.personId}`
    : null;
}

/**
 * What a contractor did through a work order's link, as far as the notice
 * about it is throttled: an answer (accept, decline, done) is told of every
 * time; a note or a photograph (`activity`) once an hour.
 */
export type ContractorNoticeKind = "answer" | "activity";

/** What a delivery tells of: a handler's event, or a reporter's new message. */
export type IssueNoticeEvent = IssueHandlerNoticeEvent | "reporterMessage";

export interface IssueNoticeJob {
  issueId: string;
  personId: string;
  event: IssueNoticeEvent;
  /** The target date an `overdue` delivery is for, as `YYYY-MM-DD`. */
  targetDate?: string;
  /**
   * The queue's id of this job, for an assignment or reopening notice: chosen
   * when it is queued, so the delivery, and its dead letter once it is given up
   * on, give back the slot this job holds and no other job's.
   */
  jobId?: string;
  /**
   * The message a `message` or `reporterMessage` notice tells of. A delivery
   * that finds the message gone, as the free-text purge of a closed issue
   * leaves it, sends nothing: the link would open an empty conversation.
   */
  messageId?: string;
  /**
   * For a `contractor` notice, whether it tells of an answer, which is not
   * throttled, or of a note or photograph, which is. A job queued before the
   * field existed has none, and is throttled as it was.
   */
  contractor?: ContractorNoticeKind;
  [key: string]: unknown;
}

/**
 * What one look at a delivery came to: the mail was handed to the mail
 * service, nothing was owed any more, or the instance has no mail settings.
 */
type Delivery = "sent" | "notOwed" | "noMailSettings";

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

/**
 * Who wrote an issue message, and which stored message it is, for the mail
 * that says there is a new one. The message is required: its notice names it,
 * so a delivery that finds it erased by the free-text purge sends nothing.
 */
export type IssueMessageAuthor =
  | { kind: "reporter"; messageId: string }
  | { kind: "handler"; personId: string; messageId: string };

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
  typeId: true,
  status: { select: { meaning: true } },
  type: { select: { name: true, handledBy: true } },
} as const;

type NoticeIssue = Prisma.IssueGetPayload<{ select: typeof ISSUE_SELECT }>;

/** What a notice reads of the person it goes to. */
const RECIPIENT_SELECT = {
  firstName: true,
  lastName: true,
  emailCipher: true,
  preferredLocale: true,
} as const;

type NoticeRecipient = Prisma.PersonGetPayload<{
  select: typeof RECIPIENT_SELECT;
}>;

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
      async (data) => {
        // Identifiers only, as everywhere else in this module.
        this.logger.error(
          `Gave up mailing ${data.personId} about issue ${data.issueId} (${data.event}); it is in the queue.`,
        );
        // The reminder for that date was never sent, so it is still owed.
        await this.releaseOverdueClaim(data);
        // Nor was the assignment or reopening, so the person is still to be
        // told of the next.
        await this.releaseNoticeSlot(data);
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
   * Akut goes to every handler of the issue, the assignee among them, who is
   * told it is urgent. Otherwise the assignee, when the type assigned one,
   * who is told it is theirs, or every handler of the issue when it landed
   * unassigned. Whoever filed it is told nothing: the handler who opened it,
   * or the reporter who reported it themselves, a handler among them.
   *
   * A report is mailed about only while its sender's budget for the hour
   * lasts: {@link NOTIFIED_PUBLIC_REPORTS_PER_HOUR} for the website's form,
   * {@link NOTIFIED_REPORTS_PER_REPORTER_PER_HOUR} for each signed-in
   * reporter, ordinary reports and Akut ones counted apart.
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
    // Nobody is told of their own act: the handler who entered it when one
    // did, and otherwise the reporter, who filed it themselves.
    const except = issue.enteredByPersonId ?? issue.reporterPersonId;

    const budget = filingBudget(issue);
    if (budget !== null && (await this.budgetSpent(tx, issue, budget, now))) {
      this.logger.warn(
        `Issue ${issueId} is in the queue but nobody was mailed: its sender's ${issue.priority === "URGENT" ? "Akut" : "ordinary"} reports for the hour have been.`,
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
    // An urgent issue tells its assignee that it is urgent: the assignee is
    // one of the handlers it goes to, and one mail says both what the priority
    // is and, in its facts, which issue. An assignee the first query left out
    // and who is a recipient by now gets the same notice as the others.
    if (
      assignee !== null &&
      !deliveries.has(assignee) &&
      (await this.isRecipient(tx, assignee, issue, now))
    ) {
      deliveries.set(
        assignee,
        issue.priority === "URGENT" ? "urgent" : "assigned",
      );
    }
    return this.queue(tx, issueId, deliveries, except);
  }

  /**
   * Queues the mail to a new assignee, in the transaction that assigns them.
   * Nothing when the actor assigned the issue to themselves.
   *
   * Also queues the overdue reminder again when the issue's target date has
   * already passed and nobody has been reminded of it: the job of that morning
   * found no assignee and claimed nothing, and nothing else would send it now.
   * A job for a date already reminded finds it claimed, so this never repeats
   * a reminder. Not for a handler assigning the issue to themselves, who has
   * just taken it knowing its date.
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
    const queued = await this.queue(
      tx,
      issueId,
      new Map([[assigneePersonId, "assigned"]]),
      actorPersonId,
    );
    if (
      assigneePersonId !== actorPersonId &&
      issue.targetDate !== null &&
      overdueFor(issue, formatDateColumn(issue.targetDate), now) &&
      !remindedFor(issue, formatDateColumn(issue.targetDate))
    ) {
      await this.scheduleOverdue(
        tx,
        issueId,
        localDayOfColumn(issue.targetDate),
        now,
      );
    }
    return queued;
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
   * has none, while the reporter's budget lasts: at most
   * {@link NOTIFIED_MESSAGES_PER_REPORTER_PER_HOUR} of their messages in an
   * hour are mailed about, whichever issues they are on. A handler's goes to
   * the reporter when the reporter has an account; a reporter from the
   * website's form has the private link instead (ADR 0055). An internal note
   * is not an issue message and is mailed to nobody.
   *
   * Called after the message is stored, in the same transaction, so the
   * budget counts it among the reporter's messages of the hour.
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
      const reporter = issue.reporterPersonId;
      // Only a reporter with an account writes on an issue, and they are its
      // reporter; with nobody to count the message against, nobody is mailed.
      if (reporter === null) {
        return 0;
      }
      if (await this.messageBudgetSpent(tx, reporter, now)) {
        this.logger.warn(
          `Issue ${issueId} has a message from its reporter but nobody was mailed: their messages for the hour have been.`,
        );
        return 0;
      }
      return this.queue(
        tx,
        issueId,
        await this.assigneeOrHandlers(tx, issue, "message", now),
        reporter,
        author.messageId === undefined ? {} : { messageId: author.messageId },
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
      author.messageId === undefined ? {} : { messageId: author.messageId },
    );
  }

  /**
   * Tells the issue's assignee, or its handlers when it has none, that the
   * contractor of one of its work orders did something through the work
   * order's link: answered it, wrote a note or added a photograph (ADR 0055,
   * control H7 of its threat review). In the transaction of the act. Answers
   * how many deliveries were queued.
   *
   * The mail says only that, with the issue's number and type, as every
   * handler's notice does (decision 21): never the answer's note or a word a
   * contractor wrote. A note or a photograph is throttled to one per person
   * and issue in each clock hour, as an assignment is, so a link used for many
   * notes in an hour mails each handler once. An answer is not: a decline or
   * done after a note in the same hour is the act the handler most needs to
   * hear of, and a link takes two answers at most. Nobody is left out as the
   * actor: a contractor is nobody here.
   */
  async contractorInTransaction(
    tx: Prisma.TransactionClient,
    issueId: string,
    kind: ContractorNoticeKind,
    now: Date = new Date(),
  ): Promise<number> {
    const issue = await this.readIssue(tx, issueId);
    if (issue === null) {
      return 0;
    }
    return this.queue(
      tx,
      issueId,
      await this.assigneeOrHandlers(tx, issue, "contractor", now),
      null,
      { contractor: kind },
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
      if (
        issue === null ||
        issue.targetDate === null ||
        !overdueFor(issue, job.targetDate, now)
      ) {
        return false;
      }
      if (remindedFor(issue, job.targetDate)) {
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
        // Added to the dates already reminded: a date reminded earlier stays
        // claimed.
        data: { overdueRemindedFor: { push: issue.targetDate } },
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
   *
   * An assignment or reopening notice that finds nothing to send settles its
   * slot under the issue's lock before it answers (see the module's comment):
   * it keeps the slot and looks again when the notice is owed by then, and
   * gives it back otherwise. One whose issue changes again after each of
   * those looks is thrown back to the queue still holding its slot, and its
   * retry decides afresh.
   */
  async deliver(job: IssueNoticeJob, now: Date = new Date()): Promise<boolean> {
    let delivery = await this.send(job, now);
    if (delivery === "sent") {
      return true;
    }
    // A reminder that goes nowhere gives the date it claimed back.
    await this.releaseOverdueClaim(job, now);
    for (let looks = 0; delivery === "notOwed"; looks += 1) {
      if (!(await this.keepNoticeSlotIfOwed(job, now))) {
        return false;
      }
      if (looks === REPEATED_LOOKS) {
        throw new Error(
          `Issue ${job.issueId} changed during each look at its ${job.event} notice for ${job.personId}; it is retried.`,
        );
      }
      delivery = await this.send(job, now);
      if (delivery === "sent") {
        return true;
      }
    }
    // Without mail settings nobody is mailed, whoever the slot is kept for.
    await this.releaseNoticeSlot(job);
    return false;
  }

  /**
   * Gives back the slot an assignment or reopening notice holds, because it
   * was not sent and will not be: the queue completes a job that sent nothing,
   * and its slot would keep the same person from being told for the rest of
   * the clock hour. For a delivery without mail settings, and for one given up on
   * after its retries.
   *
   * The slot of this job alone, by the id it carries: another job of the same
   * person and event, in a later slot, keeps its own. Answers whether a slot
   * was given back, which is never for any other notice.
   */
  async releaseNoticeSlot(job: IssueNoticeJob): Promise<boolean> {
    const jobId = job.jobId;
    if (throttleKeyOf(job) === null || jobId === undefined) {
      return false;
    }
    return this.prisma.$transaction(async (tx) => {
      await lockIssue(tx, job.issueId);
      return this.jobs.releaseSingleton(tx, ISSUE_NOTICE_QUEUE, jobId, [
        "active",
        "failed",
      ]);
    });
  }

  /**
   * Decides, under the issue's lock, what becomes of the slot of an
   * assignment or reopening notice whose delivery found nothing to send.
   *
   * Every act that queues such a notice holds the lock until it commits. One
   * that committed since the delivery looked found this job's slot taken and
   * queued nothing, and this reads what it did: when the notice is owed now,
   * the slot is kept and the answer is true, for the caller to look again.
   * Otherwise the slot is given back before the lock is, so an act that comes
   * after queues a job of its own, and the answer is false: this job sends
   * nothing. Either way the slot has one job that may send while it holds it.
   *
   * False, with nothing given back, for any other notice.
   */
  private async keepNoticeSlotIfOwed(
    job: IssueNoticeJob,
    now: Date,
  ): Promise<boolean> {
    const jobId = job.jobId;
    if (throttleKeyOf(job) === null || jobId === undefined) {
      return false;
    }
    return this.prisma.$transaction(async (tx) => {
      await lockIssue(tx, job.issueId);
      const issue = await this.readIssue(tx, job.issueId);
      if (
        issue !== null &&
        stillSo(issue, job, now) &&
        (await tx.person.findFirst({
          where: recipientWhereOf(issue, job, now),
          select: { id: true },
        })) !== null
      ) {
        return true;
      }
      await this.jobs.releaseSingleton(tx, ISSUE_NOTICE_QUEUE, jobId, [
        "active",
      ]);
      return false;
    });
  }

  /**
   * Gives back the target date an overdue notice claimed, under the issue's
   * lock, because the notice was never sent. Nothing for any other notice, or
   * for a date not claimed.
   *
   * When the issue is handed to somebody else and the date is still past, the
   * reminder is queued again, since nothing else would: the assignment found
   * the date claimed. Not for the same assignee, who a new job would find
   * unreachable all the same.
   */
  async releaseOverdueClaim(
    job: IssueNoticeJob,
    now: Date = new Date(),
  ): Promise<void> {
    const targetDate = job.targetDate;
    if (job.event !== "overdue" || targetDate === undefined) {
      return;
    }
    const day = parseLocalDay(targetDate);
    if (day === null) {
      return;
    }
    await this.ensureQueues();
    await this.prisma.$transaction(async (tx) => {
      await lockIssue(tx, job.issueId);
      const issue = await this.readIssue(tx, job.issueId);
      if (issue === null || !remindedFor(issue, targetDate)) {
        return;
      }
      await tx.issue.update({
        where: { id: job.issueId },
        data: {
          overdueRemindedFor: {
            set: issue.overdueRemindedFor.filter(
              (date) => formatDateColumn(date) !== targetDate,
            ),
          },
        },
      });
      if (
        issue.assigneePersonId !== null &&
        issue.assigneePersonId !== job.personId &&
        overdueFor(issue, targetDate, now)
      ) {
        await this.scheduleOverdue(tx, job.issueId, day, now);
      }
    });
  }

  /**
   * Whether the message a notice tells of still exists. A notice that names no
   * message stands. A message is erased with the free text of a closed issue.
   */
  private async messageStands(
    job: IssueNoticeJob,
    db: Db = this.prisma,
  ): Promise<boolean> {
    if (job.messageId === undefined) {
      return true;
    }
    const found = await db.issueMessage.findFirst({
      where: { id: job.messageId, issueId: job.issueId },
      select: { id: true },
    });
    return found !== null;
  }

  /**
   * One look at whether a notice is still owed, by the time it is asked:
   * reads the issue, asks whether the notice still holds and its message
   * stands, and finds the person it goes to. `null` when the notice is not
   * owed, with the person `null` when it is but nobody is left to receive it.
   */
  private async lookUp(
    job: IssueNoticeJob,
    at: Date,
    db: Db = this.prisma,
  ): Promise<{
    issue: NoticeIssue;
    recipient: NoticeRecipient | null;
  } | null> {
    const issue = await this.readIssue(db, job.issueId);
    if (
      issue === null ||
      !stillSo(issue, job, at) ||
      !(await this.messageStands(job, db))
    ) {
      return null;
    }
    const recipient = await db.person.findFirst({
      where: recipientWhereOf(issue, job, at),
      select: RECIPIENT_SELECT,
    });
    return { issue, recipient };
  }

  /** One look at a delivery: sends the mail when it is owed. */
  private async send(job: IssueNoticeJob, now: Date): Promise<Delivery> {
    const found = await this.lookUp(job, now);
    if (found === null) {
      return "notOwed";
    }
    const recipient = found.recipient;
    const cipher = recipient?.emailCipher;
    if (recipient === null || cipher == null) {
      this.logger.log(
        `Mail about issue ${job.issueId} (${job.event}) skipped: ${job.personId} is no longer somebody it goes to.`,
      );
      return "notOwed";
    }

    const to = await this.encryption.decrypt("person.email", cipher);
    // Decrypting took time, and a restriction, a board-only change or the end
    // of a board seat can have come since the read above: read the issue again
    // and ask again, by the time it is now, as close to the handoff as the code
    // can. A clock handed in that is ahead of the real one is kept.
    //
    // The ring-fence is held as it is from that read until the mail server has
    // taken the message: the board's change of it waits for the handoff, so a
    // type ring-fenced meanwhile is decided either before the mail, which is
    // then not sent, or after it. Shared, and under a key of its own, so that
    // mails do not wait for each other and a filing or a handler's write does
    // not wait for the mail server. A restriction, board-only change or ended
    // seat committed in the last stretch is not seen, and a mail with the
    // number and type (and the priority, to a handler) and no free text can
    // still go out; the issue's lock is not held, because it would stay held
    // across the mail service's rendering, sender lookup and network call.
    //
    // The send is ended before the transaction's limit can end the
    // transaction and let the ring-fence go with the mail still on its way
    // (`MAIL_HANDOFF_MS`): one deadline, started before the transaction is
    // asked for, so the waits for a connection and for the lock spend it too.
    const deadline = mailHandoffDeadline();
    const handoffAt = new Date(Math.max(now.getTime(), Date.now()));
    return this.prisma.$transaction(
      async (tx): Promise<Delivery> => {
        await holdIssueTypeRingFence(tx, found.issue.typeId);
        const again = await this.lookUp(job, handoffAt, tx);
        // Each way the notice can have stopped being owed since the first
        // look, one at a time, so a change to what `lookUp` answers cannot
        // turn one of them into a silent skip: no longer owed (`null`),
        // nobody left to receive it, or an address changed while it was
        // decrypted, which is not the one decrypted.
        if (again === null) {
          this.logger.log(
            `Mail about issue ${job.issueId} (${job.event}) skipped: it is no longer owed.`,
          );
          return "notOwed";
        }
        if (
          again.recipient === null ||
          again.recipient.emailCipher !== cipher
        ) {
          this.logger.log(
            `Mail about issue ${job.issueId} (${job.event}) skipped: ${job.personId} is no longer somebody it goes to.`,
          );
          return "notOwed";
        }
        const current = again.issue;
        const recipientName =
          `${recipient.firstName} ${recipient.lastName}`.trim();
        try {
          if (job.event === "reporterMessage") {
            await this.mail.send({
              to,
              locale: recipient.preferredLocale,
              template: issueReporterNoticeMail,
              signal: deadline,
              props: {
                recipientName,
                number: current.number,
                typeName: current.type.name,
              },
            });
          } else {
            await this.mail.send({
              to,
              locale: recipient.preferredLocale,
              template: issueHandlerNoticeMail,
              signal: deadline,
              props: {
                recipientName,
                event: job.event,
                number: current.number,
                typeName: current.type.name,
                priority: current.priority,
                targetDate: job.event === "overdue" ? current.targetDate : null,
              },
            });
          }
        } catch (error) {
          if (error instanceof MailNotConfiguredError) {
            this.logger.warn(
              `Issue ${job.issueId} is in the queue but was not mailed: this instance has no mail settings.`,
            );
            return "noMailSettings";
          }
          // By the class of the failure: a rejection quotes the address back.
          this.logger.error(
            `Mail about issue ${job.issueId} (${job.event}) failed for ${job.personId}: ${failureName(error)}`,
          );
          throw error;
        }
        return "sent";
      },
      { timeout: MAIL_TRANSACTION_MS, maxWait: 20_000 },
    );
  }

  /**
   * The issue as every decision here reads it, or null when it is gone or its
   * type is ring-fenced.
   *
   * The one read every queueing and every delivery makes, so a ring-fenced
   * issue is mailed about to nobody, and a notice queued before the board
   * ring-fenced its type finds nothing owed when it comes due.
   */
  private readIssue(db: Db, issueId: string): Promise<NoticeIssue | null> {
    return db.issue.findFirst({
      where: { id: issueId, type: { ringFenced: false } },
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
   * Whether this report's sender - the website's form, or one signed-in
   * reporter - has filed so many reports of its kind, ordinary or Akut, in the
   * hour before this one that it is mailed about no more.
   *
   * Every earlier report counts, whether or not a mail was queued for it: no
   * record is kept of which were mailed about, and a report to a type nobody
   * handles is still one more from the same sender.
   *
   * Counted under the sender's budget lock, which every report from that
   * sender takes before it counts and holds until it commits, so two reports
   * filed at the same moment each see the other and the bound is exact. The
   * count reads the priority the earlier reports have now: one a handler has
   * since raised to Akut counts as Akut.
   */
  private async budgetSpent(
    tx: Prisma.TransactionClient,
    issue: NoticeIssue,
    budget: FilingBudget,
    now: Date,
  ): Promise<boolean> {
    await lockFilingBudget(tx, budget.reporterPersonId);
    const earlier = await tx.issue.count({
      where: {
        id: { not: issue.id },
        reporterPersonId: budget.reporterPersonId,
        enteredByHandler: false,
        priority: issue.priority === "URGENT" ? "URGENT" : { not: "URGENT" },
        createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
      },
    });
    return earlier >= budget.perHour;
  }

  /**
   * Whether this reporter has written more issue messages in the past hour,
   * on any of their issues and the one just stored among them, than they are
   * mailed about.
   *
   * Counted under the reporter's message budget lock, which every message of
   * theirs takes after it is stored and holds until it commits, so two
   * messages written at the same moment, on one issue or on two, each see the
   * other and the bound is exact.
   */
  private async messageBudgetSpent(
    tx: Prisma.TransactionClient,
    reporterPersonId: string,
    now: Date,
  ): Promise<boolean> {
    await lockMessageBudget(tx, reporterPersonId);
    const written = await tx.issueMessage.count({
      where: {
        side: "REPORTER",
        authorPersonId: reporterPersonId,
        createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
      },
    });
    return written > NOTIFIED_MESSAGES_PER_REPORTER_PER_HOUR;
  }

  /** Queues one delivery per person, leaving out the person who acted. */
  private async queue(
    tx: Prisma.TransactionClient,
    issueId: string,
    deliveries: ReadonlyMap<string, IssueNoticeEvent>,
    except: string | null,
    about: Pick<IssueNoticeJob, "messageId" | "contractor"> = {},
  ): Promise<number> {
    let queued = 0;
    for (const [personId, event] of deliveries) {
      if (personId === except) {
        continue;
      }
      const key = throttleKeyOf({ issueId, personId, event, ...about });
      let id: string | null;
      if (key === null) {
        id = await this.jobs.sendInTransaction<IssueNoticeJob>(
          tx,
          ISSUE_NOTICE_QUEUE,
          { issueId, personId, event, ...about },
          NOTICE_JOB_OPTIONS,
        );
      } else {
        // The job is told its own id, to give back its own slot by.
        const jobId = randomUUID();
        id = await this.jobs.sendInTransaction<IssueNoticeJob>(
          tx,
          ISSUE_NOTICE_QUEUE,
          { issueId, personId, event, jobId, ...about },
          {
            ...NOTICE_JOB_OPTIONS,
            id: jobId,
            singletonKey: key,
            singletonSeconds: REPEATED_NOTICE_SECONDS,
          },
        );
      }
      // A send whose slot is taken answers null and queues nothing.
      if (id !== null) {
        queued += 1;
      }
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

/** Whose hourly mail budget a report spends, and how much of it there is. */
interface FilingBudget {
  /** The signed-in reporter, or null for the website's form. */
  reporterPersonId: string | null;
  perHour: number;
}

/**
 * The budget a newly filed issue spends: the website's form's when nobody
 * signed in reported it, the reporter's own when somebody did, and none when a
 * handler entered it.
 */
function filingBudget(issue: NoticeIssue): FilingBudget | null {
  if (issue.enteredByHandler) {
    return null;
  }
  return issue.reporterPersonId === null
    ? { reporterPersonId: null, perHour: NOTIFIED_PUBLIC_REPORTS_PER_HOUR }
    : {
        reporterPersonId: issue.reporterPersonId,
        perHour: NOTIFIED_REPORTS_PER_REPORTER_PER_HOUR,
      };
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

/** Whether the assignee has already been reminded of this target date. */
function remindedFor(issue: NoticeIssue, targetDate: string): boolean {
  return issue.overdueRemindedFor.some(
    (day) => formatDateColumn(day) === targetDate,
  );
}

/**
 * The person a delivery may still go to: the reporter with an address and no
 * restriction for a reporter's notice, and otherwise the handler of the issue
 * this channel reaches.
 */
function recipientWhereOf(
  issue: NoticeIssue,
  job: IssueNoticeJob,
  now: Date,
): Prisma.PersonWhereInput {
  return job.event === "reporterMessage"
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
      };
}

/**
 * Whether a notice for this person still goes to them by who the issue is
 * assigned to: to the assignee when it has one, and to its handlers when it has
 * none. The reading of handlers' access is the recipient query's.
 */
function routedTo(issue: NoticeIssue, personId: string): boolean {
  return issue.assigneePersonId === null || issue.assigneePersonId === personId;
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
      return routedTo(issue, job.personId);
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
      // Told to the handlers of an issue nobody is assigned; once somebody is,
      // "nobody is assigned" is untrue, and the assignee is told it is theirs.
      return issue.status.meaning !== "DONE" && issue.assigneePersonId === null;
    case "reopened":
      return issue.status.meaning !== "DONE" && routedTo(issue, job.personId);
    case "contractor":
      return routedTo(issue, job.personId);
  }
}
