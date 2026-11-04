import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { IssueStatusMeaning } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
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
import { issueReporterLinkMail } from "../mail/templates";
import { lockLegalHoldRegistry } from "../retention/legal-hold-lock";
import {
  type ReporterIssueMessageView,
  toReporterView,
} from "./issue-conversation.service";
import { requireHandledIssue } from "./issue-handlers";
import { lockIssue, lockIssueForHandling } from "./issue-lock";
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
import { IssueError } from "./issue.error";

/**
 * How long the transaction that sends a link mail may run: the mail driver's
 * connection, greeting and socket timeouts (10 s, 10 s, 20 s) with room over.
 */
const MAIL_TRANSACTION_MS = 60_000;

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
   * Whether an open issue has all the messages a link takes: the page then
   * offers no field and says so, rather than saying the issue is closed.
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
   * would open nothing, or whose address is a person's who restricted
   * processing (GDPR art. 18). Nor to an address that has had its three link
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
          type: { select: { name: true } },
          reporterLink: {
            select: { id: true, mailedAt: true, revokedAt: true },
          },
        },
      });
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
      if (await this.isRestricted(tx, issue.reporterEmailIndex)) {
        await this.releaseEarlier(tx, existing);
        return null;
      }

      /*
       * The address's budget, counted under a lock on the address, so two
       * reports from one address delivered at once count each other. The
       * blind index rather than the address, so the key names nobody.
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
     * the send can take, which the transaction's time limit allows for.
     *
     * The issue's lock too, after the registry's and for the same reason: a
     * close, a withdrawal or the purge of the address between the two
     * transactions is seen below, and one that comes later waits for the
     * stamp. Nothing takes the issue's lock and then the registry's, so the
     * two cannot wait on each other the other way round.
     */
    const mailed = await this.prisma.$transaction(
      async (tx) => {
        await lockLegalHoldRegistry(tx);
        await lockIssue(tx, issueId);
        if (await this.isRestricted(tx, issued.emailIndex)) {
          await this.releaseUnsent(tx, issued);
          return false;
        }
        const still = await tx.issue.findUnique({
          where: { id: issueId },
          select: {
            closedAt: true,
            reporterEmailIndex: true,
            reporterLink: { select: { revokedAt: true } },
          },
        });
        if (
          still === null ||
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
   * when a retry finds it will not mail it either: the issue closed, its
   * address restricted or that address's budget spent. The caller holds the
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

    const outcome = await this.prisma.$transaction(async (tx) => {
      const first = await liveReporterLinkByDigest(tx, digest);
      if (first === null) {
        return { kind: "not-found" as const };
      }
      await lockIssue(tx, first.issueId);
      const link = await liveReporterLinkByDigest(tx, digest);
      if (link === null) {
        return { kind: "not-found" as const };
      }

      const issue = await tx.issue.findUniqueOrThrow({
        where: { id: link.issueId },
        select: { status: { select: { meaning: true } } },
      });
      if (issue.status.meaning === "DONE") {
        return { kind: "closed" as const };
      }

      const [counts] = await tx.$queryRaw<
        { lastHour: bigint; total: bigint }[]
      >`
        SELECT
          count(*) FILTER (WHERE "createdAt" > now() - interval '1 hour') AS "lastHour",
          count(*) AS "total"
        FROM "issue_message"
        WHERE "issueId" = ${link.issueId} AND "side" = 'REPORTER'`;
      // The total first: it never drops, so it is the answer that stays true.
      if (Number(counts?.total ?? 0) >= REPORTER_LINK_MESSAGES_PER_ISSUE) {
        return { kind: "full" as const };
      }
      if (Number(counts?.lastHour ?? 0) >= REPORTER_LINK_MESSAGES_PER_HOUR) {
        return { kind: "limited" as const };
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
      return { kind: "sent" as const, issueId: link.issueId };
    });

    if (outcome.kind === "sent") {
      this.logger.log(
        `Issue ${outcome.issueId} has a message through its reporter's link`,
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
      await lockIssueForHandling(tx, issueId);
      const issue = await requireHandledIssue(tx, issueId, handlerPersonId, {
        reporterLink: {
          select: { id: true, mailedAt: true, revokedAt: true },
        },
      });
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
    const reporterMessages = issue.messages.filter(
      (message) => message.side === "REPORTER",
    ).length;
    const messageLimitReached =
      issue.status.meaning !== "DONE" &&
      reporterMessages >= REPORTER_LINK_MESSAGES_PER_ISSUE;
    return {
      typeName: issue.type.name,
      meaning: issue.status.meaning,
      createdAt: issue.createdAt,
      acceptsMessages: issue.status.meaning !== "DONE" && !messageLimitReached,
      messageLimitReached,
      messages: issue.messages.map(toReporterView),
    };
  }

  /**
   * Whether the address is that of a person who restricted processing (GDPR
   * art. 18): the association may store their data and must not mail them.
   */
  private async isRestricted(
    tx: Prisma.TransactionClient,
    emailIndex: string,
  ): Promise<boolean> {
    const restricted = await tx.person.findMany({
      where: {
        processingRestrictedAt: { not: null },
        emailCipher: { not: null },
      },
      select: { emailCipher: true },
    });
    for (const person of restricted) {
      if (person.emailCipher === null) {
        continue;
      }
      const address = await this.encryption.decrypt(
        "person.email",
        person.emailCipher,
      );
      if (
        (await this.encryption.computeIndex("issue.reporterEmail", address)) ===
        emailIndex
      ) {
        return true;
      }
    }
    return false;
  }
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
