import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { IssueStatusMeaning } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { NORMALIZATION_VERSION } from "../crypto/personal-data";
import { databaseNow } from "../database/database-clock";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  type JobSendOptions,
  JobQueueService,
} from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { MailNotConfiguredError, MailService } from "../mail/mail.service";
import { issueReporterLinkMail } from "../mail/templates";
import { lockErasureEligibility } from "../retention/erasure-lock";
import { lockLegalHoldRegistry } from "../retention/legal-hold-lock";
import {
  type ReporterIssueMessageView,
  toReporterView,
} from "./issue-conversation.service";
import { requireHandledIssueForWrite } from "./issue-handlers";
import {
  holdIssueTypeRingFence,
  lockIssue,
  lockIssueForHandling,
  MAIL_TRANSACTION_MS,
  mailHandoffDeadline,
} from "./issue-lock";
import { IssueMailer } from "./issue-mailer.service";
import {
  extendReporterLink,
  type LiveReporterLink,
  liveReporterLinkByDigest,
} from "./issue-reporter-link";
import {
  hasReporterLinkTokenForm,
  mintReporterLinkToken,
  reporterLinkDigest,
} from "./issue-reporter-link-token";
import { reopenIssueByReply, replyModeOf } from "./issue-reopening";
import { IssueError } from "./issue.error";

/** The queue a public report's link mail waits on. */
export const REPORTER_LINK_QUEUE = "issue-reporter-link";

/** Where a link mail goes once its retries are spent. */
export const REPORTER_LINK_ABANDONED_QUEUE = "issue-reporter-link-abandoned";

const LINK_JOB_OPTIONS = {
  retryLimit: 5,
  retryDelay: 60,
  retryBackoff: true,
  deadLetter: REPORTER_LINK_ABANDONED_QUEUE,
} satisfies JobSendOptions;

/**
 * Link mails one address may be sent in 24 hours, whatever the issues.
 *
 * Anybody can type somebody else's address into the website's form, so the
 * form must not become a way to fill a stranger's inbox. Counted in the
 * database, under a lock on the address, so neither a restart nor two
 * instances of the worker reset it. Three, because a person who reports three
 * faults in a day is rare and one who reports more is told nothing worse than
 * that the board has their reports.
 */
export const REPORTER_LINK_MAILS_PER_ADDRESS_PER_DAY = 3;

/**
 * Messages a link may write in an hour.
 *
 * Counted per link and in the database, against the issue the link opens, so a
 * link that leaked and is used from many addresses shares one budget, which the
 * per-address limit on the route could never give. Ten is more than a person
 * answering the board writes in an hour.
 */
export const REPORTER_LINK_MESSAGES_PER_HOUR = 10;

/**
 * Messages a link may write in all. A conversation about one fault, not a
 * channel: past this the reporter is told the board has enough to go on.
 */
export const REPORTER_LINK_MESSAGES_PER_ISSUE = 100;

export interface ReporterLinkJob {
  issueId: string;
  /**
   * The language the reporter read the form in, or null for the
   * association's. A language code, never anything the reporter wrote.
   */
  locale?: string | null;
  [key: string]: unknown;
}

/**
 * The page a reporter's link shows, and nothing more (ADR 0055).
 *
 * Built field by field from what is allowed, never by passing an issue on: the
 * type, where it stands as a meaning, and the conversation the reporter is part
 * of, each handler's message signed by a role. No assignee, no handler's name,
 * no note, no file, no priority, no waiting reason (one names a contractor), no
 * description, location or name: the reporter wrote those, and the page has no
 * need to show them back to whoever holds the link.
 */
export interface ReporterLinkPageView {
  typeName: string;
  meaning: IssueStatusMeaning;
  createdAt: Date;
  /** Whether the page offers a field to write in. */
  acceptsMessages: boolean;
  /**
   * Whether the issue is closed and a message now reopens it (within the
   * reopening window, ADR 0054): the page says so beside the field.
   */
  reopensOnMessage: boolean;
  /**
   * Whether an issue that takes messages has all the messages a link takes:
   * the page then offers no field and says so, rather than saying the issue is
   * closed.
   */
  messageLimitReached: boolean;
  messages: ReporterIssueMessageView[];
}

/** What became of a message written through a link. */
export type ReporterLinkReplyOutcome =
  | "sent"
  /** The issue is closed and takes no more messages. */
  | "closed"
  /** The link has written as much as it may this hour; later it may again. */
  | "limited"
  /** The link has written as much as it ever may: no later try helps. */
  | "full"
  /** The token opens nothing: the same answer for every reason. */
  | "not-found";

/**
 * The private link of a reporter without an account (decision 20 of the issue
 * module plan, ADR 0055): issuing and mailing it, the page it opens, a message
 * written through it, and a handler withdrawing it.
 *
 * A link reaches one issue, and only its conversation. Everything here that a
 * link holder can reach takes the token and resolves it itself, in the
 * transaction that reads or writes, so there is no grant to keep and no way to
 * name an issue beside the token. Nothing takes a principal, so no path
 * through this service confuses a link with an account.
 *
 * Three rules hold here and each has a test that fails without it:
 *
 * - **The token is never stored, logged or queued.** It is minted by the
 *   worker that mails it, at the moment it mails it, and only its digest is
 *   written. The job carries the issue's identifier.
 * - **A read writes nothing.** Opening the page reads; it stamps no "seen", no
 *   "last used", no audit entry. Mail scanners and link previews open every
 *   link in a message, and must not be able to do anything by it.
 * - **The form cannot mail a stranger at will.** One link mail per issue,
 *   not sent again (save the one failure `deliver` names), and at most three
 *   a day to one address, counted in the database. There is no way to ask for
 *   the link again.
 */
@Injectable()
export class IssueReporterLinkService implements OnModuleInit {
  private readonly logger = new Logger(IssueReporterLinkService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly jobs: JobQueueService,
    private readonly audit: AuditLogService,
    private readonly mailer: IssueMailer,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the jobs themselves.
      return;
    }
    await this.startWorkers();
  }

  async startWorkers(): Promise<void> {
    await this.jobs.work<ReporterLinkJob>(REPORTER_LINK_QUEUE, async (data) => {
      await this.deliver(data.issueId, data.locale ?? null);
    });
    await this.jobs.work<ReporterLinkJob>(
      REPORTER_LINK_ABANDONED_QUEUE,
      async (data) => {
        await this.abandon(data.issueId);
      },
    );
  }

  /**
   * A link mail whose retries are spent. The link was never mailed and nobody
   * holds it, so it is deleted and its slot in the address's daily budget goes
   * back. A link that was mailed in the meantime is left alone.
   */
  async abandon(issueId: string): Promise<void> {
    // The identifier only: never the address, and there is no token.
    this.logger.error(
      `Gave up mailing the private link of issue ${issueId}; its reporter has none.`,
    );
    await this.prisma.issueReporterLink.deleteMany({
      where: { issueId, mailedAt: null },
    });
  }

  /** The queues, created before a transaction puts a job on one. */
  async ensureQueues(): Promise<void> {
    await this.jobs.ensureQueue(REPORTER_LINK_ABANDONED_QUEUE);
    await this.jobs.ensureQueue(REPORTER_LINK_QUEUE);
  }

  /**
   * Queues the link mail for a report just filed from the website's form, in
   * the transaction that files it, so a report that rolls back mails nobody.
   * The caller ensures the queues first (`ensureQueues`).
   */
  async queueInTransaction(
    tx: Prisma.TransactionClient,
    issueId: string,
    locale: string | null,
  ): Promise<void> {
    await this.jobs.sendInTransaction<ReporterLinkJob>(
      tx,
      REPORTER_LINK_QUEUE,
      { issueId, locale },
      LINK_JOB_OPTIONS,
    );
  }

  /**
   * Issues the link of one report and mails it, once.
   *
   * The token is minted here, in the transaction that stores its digest, and
   * leaves this method only in the mail. A delivery that fails before the mail
   * server takes the message is tried again with a token of its own, replacing
   * the digest: nobody holds the first one. Once the mail server has it,
   * `mailedAt` is stamped with the audit entry, and the link is never mailed
   * again.
   *
   * Not at most once in every failure. If the mail server takes the message
   * and the call or the stamp then fails, the job tries again, mints a new
   * token and mails it, and the first mail's link opens nothing: only the
   * digest is kept, so the first token cannot be sent again. The reporter
   * then holds two mails, of which the later one works.
   *
   * The restriction is read twice: before a token is minted, to leave a
   * restricted address alone, and again under the legal-hold registry lock
   * that the send and the stamp run under, so a restriction granted in
   * between is seen. A restriction granted while the mail server takes the
   * message waits for it. Whether the issue is still open, its address still
   * there and its link not withdrawn is read again in the same place, under
   * the issue's lock.
   *
   * A link whose mail is refused (a restriction, a close, no mail settings,
   * or, on a retry, an address whose three a day are spent) or abandoned
   * after its retries is deleted, so it no longer counts toward its address's
   * three a day; one still being retried counts. A retry that refuses before
   * it mints a token deletes the unmailed link the earlier attempt left too.
   *
   * Answers whether a mail went. Nothing is mailed, and no link issued, for a
   * report that no longer has an address, that already has its link, that a
   * handler withdrew the link of, that closed long enough ago that a link
   * would open nothing, whose type the board has since ring-fenced (decision
   * 32), or whose address is a person's who restricted processing (GDPR art.
   * 18). Nor to an address that has had its three link
   * mails today: that report is in the queue like any other, and the board
   * answers its reporter by other means if it must.
   */
  async deliver(
    issueId: string,
    locale: string | null = null,
  ): Promise<boolean> {
    const issued = await this.prisma.$transaction(async (tx) => {
      await lockIssue(tx, issueId);
      const issue = await tx.issue.findUnique({
        where: { id: issueId },
        select: {
          reporterPersonId: true,
          reporterEmailCipher: true,
          reporterEmailIndex: true,
          closedAt: true,
          type: { select: { name: true, ringFenced: true } },
          reporterLink: {
            select: { id: true, mailedAt: true, revokedAt: true },
          },
        },
      });
      if (issue !== null && issue.type.ringFenced) {
        // Nothing about a ring-fenced issue is mailed (decision 32). The
        // website's form offers no ring-fenced type, so this is a report filed
        // before the board ring-fenced its type: read under the issue's lock
        // and not mailed. A link an earlier attempt issued and did not mail
        // gives its slot back, as on a close.
        await this.releaseEarlier(tx, issue.reporterLink);
        return null;
      }
      if (
        issue === null ||
        issue.reporterPersonId !== null ||
        issue.reporterEmailCipher === null ||
        issue.reporterEmailIndex === null
      ) {
        return null;
      }
      const existing = issue.reporterLink;
      if (
        existing !== null &&
        (existing.mailedAt !== null || existing.revokedAt !== null)
      ) {
        return null;
      }
      if (issue.closedAt !== null) {
        // Closed before the mail went: a link would open the page for a few
        // days at most, and the reporter learns nothing a mail should carry.
        await this.releaseEarlier(tx, existing);
        return null;
      }
      if (
        await this.isRestricted(tx, {
          emailCipher: issue.reporterEmailCipher,
          emailIndex: issue.reporterEmailIndex,
        })
      ) {
        await this.releaseEarlier(tx, existing);
        return null;
      }

      /*
       * The address's budget, counted under a lock on the address, so two
       * reports from one address delivered at once count each other. The
       * blind index rather than the address, so the key names nobody.
       *
       * Links issued, not mails sent: a link is mailed after this transaction
       * commits, so a count of `mailedAt` would miss one whose mail is on its
       * way, and two deliveries to one address could each find a slot free. A
       * link that will not be mailed is deleted and gives its slot back
       * (`releaseUnsent`, `releaseEarlier`, `abandon`), so what counts is
       * mailed or still being tried (ADR 0055).
       */
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`issue-reporter-link-address:${issue.reporterEmailIndex}`}))`;
      const sentToday = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count"
        FROM "issue_reporter_link" l
        JOIN "issue" i ON i."id" = l."issueId"
        WHERE i."reporterEmailIndex" = ${issue.reporterEmailIndex}
          AND l."issueId" <> ${issueId}
          AND l."issuedAt" > now() - interval '24 hours'`;
      if (
        Number(sentToday[0]?.count ?? 0) >=
        REPORTER_LINK_MAILS_PER_ADDRESS_PER_DAY
      ) {
        this.logger.log(
          `Issue ${issueId} gets no private link: its address has had as many today as it may.`,
        );
        await this.releaseEarlier(tx, existing);
        return null;
      }

      const token = mintReporterLinkToken();
      const tokenDigest = reporterLinkDigest(token);
      /*
       * Every instant that decides what the link opens is the database's:
       * `LIVE` reads the database's clock, so the lifetime is set from it too. A new link
       * is created already expired and then extended by the one statement
       * `extendReporterLink` is, in this transaction, so no reader sees it so.
       */
      const link =
        existing === null
          ? await tx.issueReporterLink.create({
              data: { issueId, tokenDigest, expiresAt: new Date(0) },
              select: { id: true },
            })
          : await tx.issueReporterLink.update({
              where: { id: existing.id },
              data: { tokenDigest },
              select: { id: true },
            });
      if (existing !== null) {
        await tx.$executeRaw`
          UPDATE "issue_reporter_link" SET "issuedAt" = now()
          WHERE "id" = ${link.id}`;
      }
      // A retried mail is a mailing too: the year runs from this one, not
      // from the attempt that failed.
      await extendReporterLink(tx, link.id);

      return {
        linkId: link.id,
        token,
        tokenDigest,
        typeName: issue.type.name,
        emailCipher: issue.reporterEmailCipher,
        emailIndex: issue.reporterEmailIndex,
      };
    });

    if (issued === null) {
      return false;
    }

    /*
     * The send and the stamp under the registry lock, which a restriction's
     * grant takes too: a restriction is granted before the check below or
     * waits until the mail server has taken the message, and a check made in
     * the transaction above would leave a gap in which the mail still goes to
     * an address that was restricted meanwhile. The lock is held as long as
     * the send can take: the send is ended at its deadline, before the
     * transaction's time limit can end the transaction (`MAIL_HANDOFF_MS`).
     *
     * The type's ring-fence, held shared, and the issue's own lock too, after
     * the registry's and for the same reason: a close, a withdrawal, the purge
     * of the address or the board's ring-fence of the type between the two
     * transactions is seen below, and one that comes later waits for the
     * stamp. Not the type's lock, which a filing and every handler's write
     * take: they must not wait for a mail server (`lockIssueTypeRingFence`).
     * The ring-fence before the issue, and nothing takes the issue's lock and
     * then the ring-fence or the registry, so the locks cannot wait on each
     * other the other way round. The type is read first, unlocked: nothing
     * moves an issue to another type.
     *
     * The send is ended before the transaction's limit can end the
     * transaction and let these locks go with the mail still on its way
     * (`MAIL_HANDOFF_MS`): one deadline, started before the transaction is
     * asked for, so the waits for a connection and for every lock spend it
     * too, and checked again once the address is decrypted.
     */
    const deadline = mailHandoffDeadline();
    const mailed = await this.prisma.$transaction(
      async (tx) => {
        await lockLegalHoldRegistry(tx);
        const typed = await tx.issue.findUnique({
          where: { id: issueId },
          select: { typeId: true },
        });
        if (typed !== null) {
          await holdIssueTypeRingFence(tx, typed.typeId);
        }
        await lockIssue(tx, issueId);
        if (await this.isRestricted(tx, issued)) {
          await this.releaseUnsent(tx, issued);
          return false;
        }
        const still = await tx.issue.findUnique({
          where: { id: issueId },
          select: {
            closedAt: true,
            reporterEmailIndex: true,
            reporterLink: { select: { revokedAt: true } },
            type: { select: { ringFenced: true } },
          },
        });
        if (
          still === null ||
          still.type.ringFenced ||
          still.closedAt !== null ||
          still.reporterEmailIndex !== issued.emailIndex ||
          still.reporterLink === null ||
          still.reporterLink.revokedAt !== null
        ) {
          await this.releaseUnsent(tx, issued);
          return false;
        }

        try {
          await this.mail.send({
            to: await this.encryption.decrypt(
              "issue.reporterEmail",
              issued.emailCipher,
            ),
            // The language they read the form in, or the association's own: a
            // reporter without an account has no profile to name one.
            locale,
            template: issueReporterLinkMail,
            signal: deadline,
            props: {
              typeName: issued.typeName,
              linkUrl: reporterLinkUrl(this.env.APP_URL, issued.token),
            },
          });
        } catch (error) {
          if (error instanceof MailNotConfiguredError) {
            this.logger.warn(
              `Issue ${issueId} is filed but its private link was not mailed: this instance has no SMTP settings.`,
            );
            await this.releaseUnsent(tx, issued);
            return false;
          }
          // The class of the failure only: a rejection can quote the address
          // back, and the message carried the token.
          this.logger.error(
            `The private link of issue ${issueId} could not be mailed: ${failureName(error)}`,
          );
          throw error;
        }

        // Only the digest this delivery minted: a later delivery that
        // replaced it owns the stamp.
        const { count } = await tx.issueReporterLink.updateMany({
          where: {
            id: issued.linkId,
            tokenDigest: issued.tokenDigest,
            mailedAt: null,
          },
          data: { mailedAt: new Date() },
        });
        if (count === 0) {
          return true;
        }
        await this.audit.record(
          {
            action: "ISSUE_REPORTER_LINK_ISSUED",
            channel: "SYSTEM",
            // Nobody clicked anything: a report arrived with an address.
            actorPersonId: null,
            targetKind: "issue",
            targetId: issueId,
            // The link, never the token, its digest or the address.
            context: { linkId: issued.linkId },
          },
          tx,
        );
        return true;
      },
      { timeout: MAIL_TRANSACTION_MS, maxWait: 20_000 },
    );
    if (!mailed) {
      return false;
    }

    this.logger.log(`Mailed the private link of issue ${issueId}`);
    return true;
  }

  /**
   * Gives back the slot of a link that was issued and will not be mailed: a
   * restriction, a close or an instance without mail settings stopped the send.
   * A link whose send is still being tried keeps its slot, and a mailed link
   * is never touched. Only the digest this delivery minted, so a later
   * delivery's link is left alone.
   */
  private async releaseUnsent(
    tx: Prisma.TransactionClient,
    issued: { linkId: string; tokenDigest: string },
  ): Promise<void> {
    await tx.issueReporterLink.deleteMany({
      where: {
        id: issued.linkId,
        tokenDigest: issued.tokenDigest,
        mailedAt: null,
      },
    });
  }

  /**
   * Gives back the slot of a link an earlier attempt issued and did not mail,
   * when a retry finds it will not mail it either: the issue closed, its type
   * ring-fenced, its address restricted or that address's budget spent. The caller holds the
   * issue's lock, which the stamp is written under too, and has read the link
   * as neither mailed nor withdrawn.
   */
  private async releaseEarlier(
    tx: Prisma.TransactionClient,
    existing: { id: string } | null,
  ): Promise<void> {
    if (existing === null) {
      return;
    }
    await tx.issueReporterLink.deleteMany({
      where: { id: existing.id, mailedAt: null, revokedAt: null },
    });
  }

  /**
   * The page a token opens, or null for every token that opens nothing.
   *
   * Reads, and writes nothing at all. The token's form is checked before the
   * database is asked; a value that cannot be a token is answered as one that
   * is unknown. The link and the issue are read from one snapshot, so a
   * revocation either happened before this read or after it, never between
   * its two halves.
   */
  async open(token: string): Promise<ReporterLinkPageView | null> {
    if (!hasReporterLinkTokenForm(token)) {
      return null;
    }
    const digest = reporterLinkDigest(token);
    return this.prisma.$transaction(
      async (tx) => {
        const link = await liveReporterLinkByDigest(tx, digest);
        if (link === null) {
          return null;
        }
        return this.pageOf(tx, link);
      },
      { isolationLevel: "RepeatableRead" },
    );
  }

  /**
   * A message the reporter writes through their link.
   *
   * The caller has read the body against the form's rules. Under the issue's
   * lock, which a status move and a revocation take too, the token is
   * resolved again, so a link withdrawn or an issue closed while the message
   * was being written is answered as it is now. The link's budget is counted
   * in the same transaction. The message has no author: there is no person
   * behind a link, and its audit entry is on the link's own channel, naming the
   * link.
   */
  async reply(token: string, body: string): Promise<ReporterLinkReplyOutcome> {
    if (!hasReporterLinkTokenForm(token)) {
      return "not-found";
    }
    const digest = reporterLinkDigest(token);

    // Before the transaction: a queue is made on the backend's own connection.
    await this.mailer.ensureQueues();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const first = await liveReporterLinkByDigest(tx, digest);
      if (first === null) {
        return { kind: "not-found" as const };
      }
      // The locks a status move takes: a reply that reopens the issue and a
      // handler's move must not both decide what its closing date is.
      await lockIssueForHandling(tx, first.issueId);
      const link = await liveReporterLinkByDigest(tx, digest);
      if (link === null) {
        return { kind: "not-found" as const };
      }

      const issue = await tx.issue.findUniqueOrThrow({
        where: { id: link.issueId },
        select: {
          id: true,
          typeId: true,
          closedAt: true,
          mergedIntoIssueId: true,
          status: { select: { id: true, meaning: true } },
        },
      });
      // The database's clock, as the link's own liveness is judged on: an API
      // clock ahead of it must not refuse a reply to a link that still opens.
      const mode = replyModeOf(issue, await databaseNow(tx));
      if (mode === "NEW_REPORT") {
        return { kind: "closed" as const };
      }

      const counts = await reporterMessageCounts(tx, link.issueId);
      // The total first: it never drops, so it is the answer that stays true.
      if (counts.total >= REPORTER_LINK_MESSAGES_PER_ISSUE) {
        return { kind: "full" as const };
      }
      if (counts.lastHour >= REPORTER_LINK_MESSAGES_PER_HOUR) {
        return { kind: "limited" as const };
      }

      const reopens = mode === "REOPENS";
      if (reopens) {
        // Within the reopening window the reply reopens the issue, as a
        // signed-in reporter's does (ADR 0054), and alerts its assignee.
        await reopenIssueByReply(
          { audit: this.audit, mailer: this.mailer },
          tx,
          issue,
          { channel: "LINK", linkId: link.linkId },
        );
      }
      const message = await tx.issueMessage.create({
        data: {
          issueId: link.issueId,
          side: "REPORTER",
          authorPersonId: null,
          body,
        },
        select: { id: true },
      });
      await extendReporterLink(tx, link.linkId);
      await this.audit.record(
        {
          action: "ISSUE_MESSAGE_SENT",
          channel: "LINK",
          // No person: whoever holds the link wrote it.
          actorPersonId: null,
          targetKind: "issue",
          targetId: link.issueId,
          // Which message and which link, never what it says or the token.
          context: { messageId: message.id, linkId: link.linkId },
        },
        tx,
      );
      return { kind: "sent" as const, issueId: link.issueId, reopens };
    });

    if (outcome.kind === "sent") {
      this.logger.log(
        outcome.reopens
          ? `Issue ${outcome.issueId} was reopened by a message through its reporter's link`
          : `Issue ${outcome.issueId} has a message through its reporter's link`,
      );
    }
    return outcome.kind;
  }

  /**
   * A handler withdraws the reporter's link. Mails nobody.
   *
   * Under the locks a handling write takes, and after asking whether the
   * handler handles the issue, so an issue the board took to itself is
   * answered to anybody else as one that does not exist. Withdrawing a link
   * that is already withdrawn is not a second act; one that was never mailed
   * is `no-reporter-link`.
   */
  async revoke(handlerPersonId: string, issueId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // The writer's erasure lock first, as a note takes it.
      await lockErasureEligibility(tx, handlerPersonId);
      await lockIssueForHandling(tx, issueId);
      const issue = await requireHandledIssueForWrite(
        tx,
        issueId,
        handlerPersonId,
        {
          reporterLink: {
            select: { id: true, mailedAt: true, revokedAt: true },
          },
        },
        new Date(),
      );
      const link = issue.reporterLink;
      if (link === null || link.mailedAt === null) {
        throw new IssueError(
          "This issue's reporter has no private link.",
          "no-reporter-link",
        );
      }
      if (link.revokedAt !== null) {
        return;
      }
      await tx.issueReporterLink.update({
        where: { id: link.id },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        {
          action: "ISSUE_REPORTER_LINK_REVOKED",
          channel: "WEB",
          actorPersonId: handlerPersonId,
          targetKind: "issue",
          targetId: issueId,
          context: { linkId: link.id },
        },
        tx,
      );
    });
    this.logger.log(`The private link of issue ${issueId} was withdrawn`);
  }

  private async pageOf(
    tx: Prisma.TransactionClient,
    link: LiveReporterLink,
  ): Promise<ReporterLinkPageView> {
    const issue = await tx.issue.findUniqueOrThrow({
      where: { id: link.issueId },
      select: {
        createdAt: true,
        closedAt: true,
        mergedIntoIssueId: true,
        type: { select: { name: true } },
        status: { select: { meaning: true } },
        messages: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            side: true,
            authorPersonId: true,
            signature: true,
            body: true,
            redactedAt: true,
            createdAt: true,
          },
        },
      },
    });
    const counts = await reporterMessageCounts(tx, link.issueId);
    // Judged on the database's clock, as the link is (see `databaseNow`).
    const mode = replyModeOf(issue, await databaseNow(tx));
    // A closed issue takes a message only while one still reopens it.
    const takesMessages = mode !== "NEW_REPORT";
    const messageLimitReached =
      takesMessages && counts.total >= REPORTER_LINK_MESSAGES_PER_ISSUE;
    // The notice promises a reopening, which the hourly limit would refuse.
    const hourlyLimitReached =
      counts.lastHour >= REPORTER_LINK_MESSAGES_PER_HOUR;
    const reopensOnMessage = mode === "REOPENS";
    return {
      typeName: issue.type.name,
      meaning: issue.status.meaning,
      createdAt: issue.createdAt,
      acceptsMessages: takesMessages && !messageLimitReached,
      reopensOnMessage:
        reopensOnMessage && !messageLimitReached && !hourlyLimitReached,
      messageLimitReached,
      messages: issue.messages.map(toReporterView),
    };
  }

  /**
   * Whether the address is that of a person who restricted processing (GDPR
   * art. 18): the association may store their data and must not mail them.
   *
   * Asked under the issue's lock on every delivery, so it reads the people at
   * this one address rather than every restricted person. The two blind
   * indexes are not comparable (`field-encryption.service.ts`), so the
   * reporter's address is decrypted and indexed as a person's address, and the
   * register is asked for that index. A person whose indexes predate the
   * current normalisation rules (`blindIndexVersion`) may hold an index that
   * no longer matches their address until `PersonReindexService` rewrites it,
   * so a restricted one is read too. Every candidate's address is indexed
   * under the reporter's field and compared, as a 32-bit index can collide.
   */
  private async isRestricted(
    tx: Prisma.TransactionClient,
    reporter: { emailCipher: string; emailIndex: string },
  ): Promise<boolean> {
    const address = await this.encryption.decrypt(
      "issue.reporterEmail",
      reporter.emailCipher,
    );
    const personIndex = await this.encryption.computeIndex(
      "person.email",
      address,
    );
    const restricted = await tx.person.findMany({
      where: {
        processingRestrictedAt: { not: null },
        emailCipher: { not: null },
        OR: [
          ...(personIndex === null ? [] : [{ emailIndex: personIndex }]),
          { blindIndexVersion: { lt: NORMALIZATION_VERSION } },
        ],
      },
      select: { emailCipher: true },
    });
    for (const person of restricted) {
      if (person.emailCipher === null) {
        continue;
      }
      const candidate = await this.encryption.decrypt(
        "person.email",
        person.emailCipher,
      );
      if (
        (await this.encryption.computeIndex(
          "issue.reporterEmail",
          candidate,
        )) === reporter.emailIndex
      ) {
        return true;
      }
    }
    return false;
  }
}

/**
 * The messages a link's reporter has written on an issue: all of them, and
 * those of the last hour on the database's clock. Read by the reply, which
 * refuses past either limit, and by the page, which promises nothing the reply
 * would refuse.
 */
async function reporterMessageCounts(
  tx: Prisma.TransactionClient,
  issueId: string,
): Promise<{ lastHour: number; total: number }> {
  const [counts] = await tx.$queryRaw<{ lastHour: bigint; total: bigint }[]>`
    SELECT
      count(*) FILTER (WHERE "createdAt" > clock_timestamp() - interval '1 hour') AS "lastHour",
      count(*) AS "total"
    FROM "issue_message"
    WHERE "issueId" = ${issueId} AND "side" = 'REPORTER'`;
  return {
    lastHour: Number(counts?.lastHour ?? 0),
    total: Number(counts?.total ?? 0),
  };
}

/** The address of the page a token opens: the instance's own, token in the path. */
export function reporterLinkUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}${REPORTER_LINK_PATH}/${token}`;
}

/**
 * Where the page lives, on the website's origin: one static segment the board
 * cannot claim for a page (`pages.service.ts`), then the token, and nothing
 * else in the address.
 */
export const REPORTER_LINK_PATH = "/arende";
