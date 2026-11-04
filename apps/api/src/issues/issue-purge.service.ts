import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockIssue } from "./issue-lock";
import { lockLegalHoldRegistry } from "../retention/legal-hold-lock";
import { withheldAddressIndexes } from "../retention/withheld-addresses";
import {
  isPersonWithheld,
  withheldPersonIds,
} from "../retention/withheld-persons";
import {
  detachErasedReporter,
  ISSUE_RETENTION_DAYS,
  issuePurgeCutoff,
  WORK_ORDER_BODY_RETENTION_DAYS,
  WORK_ORDER_TEXT_STANDING,
} from "./issue-retention";

/** Queue the nightly public-form issue purge runs on. */
export const ISSUE_PURGE_QUEUE = "issue-purge";

/**
 * When it runs.
 *
 * In the small hours, in the band every purge in this product wakes in. The
 * purges are spread across its minutes because jobs waking together on one small
 * connection pool is a contention nobody gains anything from.
 */
const PURGE_CRON = "19 3 * * *";

/**
 * The most reports one run detaches.
 *
 * A cooperative fields a handful of public-form reports a month, so this is
 * never reached in ordinary running. It exists for the first run on an instance
 * that has had a public form open for years, or the day the window is
 * shortened: without a bound that run would rewrite every report ever filed in
 * one transaction-per-issue loop. Nothing is lost by stopping - eligibility is
 * computed from the closing date rather than marked on the row, so the next
 * night's run finds the rest.
 */
const MAX_ISSUES_PER_RUN = 500;

export interface IssuePurgeRunSummary {
  /** Reports the eligibility scan found past their window. */
  considered: number;
  /** Reports whose reporter details were detached. */
  purged: number;
  /**
   * Reports whose purge threw. The run carries on past them: one row the
   * database refuses must not stop every later report for good.
   */
  failed: number;
  /** The same three counts for the issues whose work-order text was erased. */
  workOrderTexts: { considered: number; purged: number; failed: number };
}

/**
 * The public-form issue purge (gallring av anmalningar fran webbformularet).
 *
 * Every other issue is keyed to a person, and the residency purge detaches the
 * reporter link when that person's retention window runs out. An issue reported
 * from the public form is keyed to nobody: it carries the reporter's name and
 * email as ciphers and no personId at all, so no person-keyed purge will ever
 * find it. Without a clock of its own it would be the one place in the product
 * where contact details are kept for ever, which is exactly what a retention
 * policy exists to prevent.
 *
 * ## What it detaches, and what it keeps
 *
 * The three reporter columns and nothing else, the address index excepted on a
 * report a work order's text still stands on (see Work-order text, below). The
 * issue stays, and so does its free text until the issue's own clock removes it
 * (`issue-text-purge.service.ts`, ADR 0057): the description, the conversation
 * and the photographs are the association's record of a problem with its
 * building for as many years as the board set. This is the same detachment the
 * residency purge performs, reached from the other end, and on a shorter clock:
 * a stranger's address is not kept for as long as the words about the damp
 * patch.
 *
 * What is left is still personal data, and the word for it is a detachment
 * rather than anything stronger: the description is free text somebody wrote
 * and may name a neighbour, so Recital 26 has nothing to say about a row that
 * still identifies somebody.
 *
 * ## The clock
 *
 * A year after the issue was closed, not after it was reported. The purpose the
 * contact details are held for is being able to come back to the person about
 * the problem, and that purpose lasts as long as the problem does - a leak
 * reported in March and still being argued with a contractor in December is a
 * live matter, and erasing the reporter's address halfway through would end the
 * association's ability to answer them. An open issue has no purge date at all,
 * and a reopened one loses the date it had. The arithmetic and the reasoning
 * are in `issue-retention.ts`.
 *
 * ## Legal hold and restriction
 *
 * A report from the public form is keyed to nobody, but the address on it can
 * still be a person's: somebody in the register who wrote in without signing
 * in, or somebody who wrote in first and was entered later. A legal hold or a
 * restriction of processing standing against that person stops the purge of
 * their reports, as it stops the board mailbox purge of their letters - the
 * ground is about the person's data rather than about one table, and art.
 * 18(2) lets the association keep storing the data and little else, so
 * erasing it is the one act a restricted person asked it not to perform.
 *
 * The match is made from the register's side, the way the board mailbox makes
 * it: each withheld person's own address is re-indexed under this table's field
 * and compared (`retention/withheld-addresses.ts`). Nothing here resolves a
 * reporter to a person for any other purpose.
 *
 * The check is made twice: once in the scan, and again inside the transaction
 * that detaches, under the legal hold registry key in
 * `retention/legal-hold-lock.ts`. The second one is the one that counts. This
 * job cannot name the person it might be racing, so it takes the registry key,
 * which a hold placement and a restriction grant both take as well as the
 * person's own - a hold or a restriction committed while the run is in flight
 * has to win. An issue that does have a reporter is left to the residency
 * purge, which takes the person's own key - reaching one row from both ends
 * would be two jobs racing over it.
 *
 * ## How it runs
 *
 * One issue per transaction, like the residency, motion and booking purges and
 * for the same reasons. A crash halfway through leaves what it finished
 * finished and the rest for tomorrow, because eligibility is computed from
 * `closedAt` and the window rather than from a flag somebody has to keep in
 * step; and an issue with nothing left to detach is not selected, so no row
 * collects an entry a night for ever in a table that cannot be tidied.
 *
 * The entry is SERVICE_DATA_PURGED with a targetKind of "issue" and the issue's
 * own id, rather than the targetPersonId every other purge in the band writes.
 * There is no person to name - that is the whole point of this job - so the
 * record it names is the issue, which survives the purge and stays readable for
 * as long as the entry does.
 *
 * ## Work-order text
 *
 * The same run erases the text of the work orders sent about any closed issue,
 * whoever reported it, once `WORK_ORDER_BODY_RETENTION_DAYS`, ten years, have
 * passed since it was closed (see `issue-retention.ts`). Unlike the description, that text
 * is not the association's record of its building but a copy of a mail it sent
 * a firm, in a handler's words that may name the reporter or a neighbour; the
 * row stays with whom it went to and when, which is the record of the
 * disclosure. A legal hold or a restriction against the issue's reporter keeps
 * the text, as it keeps the reporter's details, read again under the registry
 * key inside the transaction that erases it.
 *
 * On a public-form report the reporter is reached only through the address
 * index, so that index has to outlive the contact details for as long as a
 * work order's text stands: a hold or a restriction placed in year three on
 * the person who wrote in would otherwise match nothing, and the text would go
 * at year ten regardless (ADR 0057: no case whose text stands may lose its
 * selector). The year's purge therefore detaches the name and the address and
 * keeps the index while any work order on the report still has its text, and
 * the transaction that erases the last text clears it. The index is a keyed
 * hash of the address, which tells nobody anything without the address and
 * the key, and only the hold and restriction match ever reads it. A separate
 * person-to-case record, which ADR 0057 also allows, would be a second store
 * of the same thing.
 *
 * A report keyed to a person keeps its selector the same way: the person purge
 * leaves `reporterPersonId` on an issue a work order's text stands on
 * (`retention/purge.service.ts`), and detaches it on a later run once the text
 * is gone. A person whose erasure request was carried out is not selected
 * again, so for them the transaction that erases the last text clears it.
 */
@Injectable()
export class IssuePurgeService implements OnModuleInit {
  private readonly logger = new Logger(IssuePurgeService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the purge with a clock of their own, so a
      // worker must not race them with the real one.
      return;
    }
    await this.startPurgeWorker();
  }

  /** Registers the purge. Public so an integration test can drive the job. */
  async startPurgeWorker(): Promise<void> {
    await this.jobs.work(ISSUE_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(ISSUE_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Detaches the reporter from every closed public-form report past its window.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting a year.
   * @param retentionDays How long a closed report keeps its reporter details.
   */
  async run(
    now: Date = new Date(),
    retentionDays: number = ISSUE_RETENTION_DAYS,
    workOrderRetentionDays: number = WORK_ORDER_BODY_RETENTION_DAYS,
  ): Promise<IssuePurgeRunSummary> {
    const issueIds = await this.eligible(now, retentionDays);

    let purged = 0;
    let failed = 0;
    for (const issueId of issueIds) {
      try {
        if (await this.purgeIssue(issueId, now, retentionDays)) {
          purged += 1;
        }
      } catch (error) {
        /*
         * The class of the failure and the issue id, and nothing the failure was
         * holding: an exception message here can be quoting a row, and what it
         * would be quoting is the contact details this job exists to remove.
         */
        failed += 1;
        this.logger.error(
          `Issue purge failed for issue ${issueId}: ${failureName(error)}`,
        );
      }
    }

    if (purged > 0 || failed > 0) {
      this.logger.log(
        `Detached the reporter details of ${String(purged)} of ${String(
          issueIds.length,
        )} eligible public-form reports`,
      );
    }
    if (issueIds.length === MAX_ISSUES_PER_RUN) {
      this.logger.log(
        `Issue purge stopped at its per-run bound of ${String(
          MAX_ISSUES_PER_RUN,
        )}; the rest are detached by the next run.`,
      );
    }

    return {
      considered: issueIds.length,
      purged,
      failed,
      workOrderTexts: await this.runWorkOrderTexts(now, workOrderRetentionDays),
    };
  }

  /** Erases the text of the work orders on every closed issue past its window. */
  private async runWorkOrderTexts(
    now: Date,
    retentionDays: number,
  ): Promise<IssuePurgeRunSummary["workOrderTexts"]> {
    const issueIds = await this.eligibleWorkOrderTexts(now, retentionDays);

    let purged = 0;
    let failed = 0;
    for (const issueId of issueIds) {
      try {
        if (await this.purgeWorkOrderTexts(issueId, now, retentionDays)) {
          purged += 1;
        }
      } catch (error) {
        // The issue id and the class of the failure, never what it was
        // holding: see `run`.
        failed += 1;
        this.logger.error(
          `Work-order text purge failed for issue ${issueId}: ${failureName(error)}`,
        );
      }
    }

    if (purged > 0 || failed > 0) {
      this.logger.log(
        `Erased the work-order text of ${String(purged)} of ${String(
          issueIds.length,
        )} eligible closed issues`,
      );
    }
    if (issueIds.length === MAX_ISSUES_PER_RUN) {
      this.logger.log(
        `Work-order text purge stopped at its per-run bound of ${String(
          MAX_ISSUES_PER_RUN,
        )}; the rest are erased by the next run.`,
      );
    }

    return { considered: issueIds.length, purged, failed };
  }

  /**
   * The closed issues with a work order whose text is still kept past its
   * window, by the oldest closing first.
   *
   * An issue under a legal hold of its own (`legalHoldAt`, ADR 0057), or whose
   * reporter is withheld - a person under a legal hold or a restriction, or a
   * public-form address that is theirs - is excluded by the query rather than
   * dropped from its answer, for the reason `eligible` gives about its bound.
   */
  async eligibleWorkOrderTexts(
    now: Date,
    retentionDays: number,
  ): Promise<string[]> {
    const cutoff = issuePurgeCutoff(now, retentionDays);
    const persons = await withheldPersonIds(this.prisma);
    const addresses = [...(await this.withheldAddresses(this.prisma)).keys()];

    const issues = await this.prisma.issue.findMany({
      where: {
        status: { meaning: "DONE" },
        closedAt: { not: null, lte: cutoff },
        legalHoldAt: null,
        ...WORK_ORDER_TEXT_STANDING,
        AND: [
          // Conditional, with the null branch beside it, for the reason
          // `eligible` gives: `NOT IN` answers null for a null column.
          ...(persons.length > 0
            ? [
                {
                  OR: [
                    { reporterPersonId: { notIn: persons } },
                    { reporterPersonId: null },
                  ],
                },
              ]
            : []),
          ...(addresses.length > 0
            ? [
                {
                  OR: [
                    { reporterEmailIndex: { notIn: addresses } },
                    { reporterEmailIndex: null },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ closedAt: "asc" }, { id: "asc" }],
      take: MAX_ISSUES_PER_RUN,
      select: { id: true },
    });

    return issues.map((issue) => issue.id);
  }

  /**
   * Erases the text of one closed issue's work orders, and answers whether any
   * went. The recipient, the date and the delivery record stay.
   *
   * The closing and the issue's own legal hold are read again under the issue
   * lock, which a reopen and a hold placed on the issue take too
   * (`lockIssueForHandling`), so an issue reopened or held since the scan
   * keeps its texts; and the reporter's hold or restriction is read again
   * under the legal hold registry key, which a hold placement and a
   * restriction grant take too, so one committed while the run is in flight
   * wins. The entry records how many texts went and the window, never a word
   * of them.
   */
  async purgeWorkOrderTexts(
    issueId: string,
    now: Date = new Date(),
    retentionDays: number = WORK_ORDER_BODY_RETENTION_DAYS,
  ): Promise<boolean> {
    const cutoff = issuePurgeCutoff(now, retentionDays);

    return this.prisma.$transaction(async (tx) => {
      await lockLegalHoldRegistry(tx);
      // The issue's own lock, which a reopen takes before it clears
      // `closedAt` and a handler takes before placing a legal hold on the
      // issue (`issue-lock.ts`): the closing and the hold read below then hold
      // until the texts are erased.
      await lockIssue(tx, issueId);
      const issue = await tx.issue.findFirst({
        where: {
          id: issueId,
          status: { meaning: "DONE" },
          closedAt: { not: null, lte: cutoff },
          legalHoldAt: null,
        },
        select: { reporterPersonId: true, reporterEmailIndex: true },
      });
      if (issue === null) {
        return false;
      }
      if (
        issue.reporterPersonId !== null &&
        (await isPersonWithheld(tx, issue.reporterPersonId))
      ) {
        return false;
      }
      if (
        issue.reporterEmailIndex !== null &&
        (await this.withheldAddresses(tx)).has(issue.reporterEmailIndex)
      ) {
        return false;
      }

      const { count } = await tx.workOrder.updateMany({
        where: { issueId, body: { not: null } },
        data: { body: null },
      });
      if (count === 0) {
        return false;
      }

      /*
       * The address index a public-form report kept past its contact details
       * for these texts' sake (see `purgeIssue`) goes with the last of them.
       * Only once the name and the address themselves are gone: while they
       * stand the index is theirs, and `purgeIssue` clears all three together.
       */
      const { count: addressIndexCleared } = await tx.issue.updateMany({
        where: {
          id: issueId,
          reporterPersonId: null,
          reporterNameCipher: null,
          reporterEmailCipher: null,
          reporterEmailIndex: { not: null },
        },
        data: { reporterEmailIndex: null },
      });

      /*
       * The reporter column the person purge kept for these texts' sake goes
       * with them once that person's erasure request has been carried out: no
       * job selects the person after that, so nothing else would clear it. Not
       * while the issue's free text still stands, which keeps the column for
       * its own sake, and whose removal clears it instead. A reporter whose
       * own window ran out is detached by the person purge on its next run,
       * which selects them again now that no text stands. The issue's lock,
       * which that purge takes on every issue it detaches, orders the two.
       */
      const reporterDetached = await detachErasedReporter(
        tx,
        issueId,
        issue.reporterPersonId,
      );

      await this.audit.record(
        {
          action: "SERVICE_DATA_PURGED",
          channel: "SYSTEM",
          actorPersonId: null,
          targetPersonId: null,
          targetKind: "issue",
          targetId: issueId,
          context: {
            workOrderTexts: count,
            retentionDaysAfterClosing: retentionDays,
            ...(addressIndexCleared > 0 ? { addressIndexCleared: true } : {}),
            ...(reporterDetached ? { reporterDetached: true } : {}),
          },
        },
        tx,
      );

      return true;
    });
  }

  /**
   * The public-form reports whose retention has run out.
   *
   * `reporterPersonId: null` is what makes a report this job's rather than the
   * residency purge's, and it is the first clause for that reason: an issue
   * keyed to a person is erased on that person's clock, and reaching one row
   * from both ends would be two jobs racing over it.
   *
   * A report with all three columns already null is not selected. It has
   * nothing left to detach, and selecting it would spend the run's bound and
   * write an entry a night for ever in a table nobody can tidy. Nor, for the
   * same reason, is one left with only the address index while a work order's
   * text stands: that index is kept on purpose (see the class comment).
   *
   * Nor is a report whose address is a withheld person's, and it is excluded by
   * the query rather than dropped from its answer: the bound is applied by the
   * database, so withheld reports removed afterwards would still have spent it,
   * and enough of them sorting first would fill every run for as long as the
   * hold or the restriction stood.
   */
  async eligible(now: Date, retentionDays: number): Promise<string[]> {
    const cutoff = issuePurgeCutoff(now, retentionDays);
    const withheld = [...(await this.withheldAddresses(this.prisma)).keys()];

    const issues = await this.prisma.issue.findMany({
      where: {
        reporterPersonId: null,
        // The DONE meaning, whatever the board named the status: a status it
        // added under DONE closes an issue as the default one does (ADR 0057).
        status: { meaning: "DONE" },
        closedAt: { not: null, lte: cutoff },
        AND: [
          {
            OR: [
              { reporterNameCipher: { not: null } },
              { reporterEmailCipher: { not: null } },
              // An index alone only once no work order's text stands: until
              // then it is kept, and `purgeWorkOrderTexts` clears it.
              {
                reporterEmailIndex: { not: null },
                NOT: WORK_ORDER_TEXT_STANDING,
              },
            ],
          },
          /*
           * Spelled conditionally rather than as an empty `notIn`, and with the
           * null branch beside it because `NOT IN` answers null rather than true
           * for a null column: a report that left a name and no address would
           * otherwise be invisible to this query for as long as any hold or
           * restriction stood anywhere in the association.
           */
          ...(withheld.length > 0
            ? [
                {
                  OR: [
                    { reporterEmailIndex: { notIn: withheld } },
                    { reporterEmailIndex: null },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ closedAt: "asc" }],
      take: MAX_ISSUES_PER_RUN,
      select: { id: true },
    });

    return issues.map((issue) => issue.id);
  }

  /**
   * Detaches one report's reporter, and answers whether anything went.
   *
   * The update and the entry that records it are one transaction. An audit log
   * claiming a purge that rolled back would be worse than no log: the entry is
   * the only evidence that data which no longer exists ever did, and it is
   * written into a table nobody can correct.
   *
   * The eligibility is stated again in the update's own `where`, rather than
   * trusted from the scan. A report reopened between the scan and this
   * transaction is a live matter again, and whoever reopened it is entitled to
   * assume the association can still answer the person who wrote in.
   *
   * And the hold and the restriction are read again, under the legal hold
   * registry key, before anything is detached. See the class comment.
   */
  async purgeIssue(
    issueId: string,
    now: Date = new Date(),
    retentionDays: number = ISSUE_RETENTION_DAYS,
  ): Promise<boolean> {
    const cutoff = issuePurgeCutoff(now, retentionDays);

    return this.prisma.$transaction(async (tx) => {
      const issue = await tx.issue.findUnique({
        where: { id: issueId },
        select: { reporterEmailIndex: true },
      });
      if (issue === null) {
        return false;
      }
      // A report that left no address matches nobody, whatever holds stand, so
      // there is nothing to order against a placement. The address is written
      // when the report is filed and never again, so it cannot appear between
      // this read and the update. It can go, if `purgeWorkOrderTexts` clears an
      // index this job kept, but only once the name and the address are gone,
      // and the update below then finds nothing to detach.
      let keepsAddressIndex = false;
      if (issue.reporterEmailIndex !== null) {
        // Before anything is read about holds, and taken whether or not this
        // report turns out to be withheld: in the ordinary case the address is
        // nobody's, and there is then no person's key to take.
        await lockLegalHoldRegistry(tx);
        if ((await this.withheldAddresses(tx)).has(issue.reporterEmailIndex)) {
          return false;
        }
        // The issue's own lock, which sending a work order takes
        // (`work-order.service.ts`), so the texts counted here are all there
        // are until this transaction ends. Taken after the registry key, in
        // the order `purgeWorkOrderTexts` takes them.
        await lockIssue(tx, issueId);
        keepsAddressIndex =
          (await tx.workOrder.count({
            where: { issueId, body: { not: null } },
          })) > 0;
      }

      const { count } = await tx.issue.updateMany({
        where: {
          id: issueId,
          reporterPersonId: null,
          status: { meaning: "DONE" },
          closedAt: { not: null, lte: cutoff },
          // Something left to detach, so a report kept only by its index
          // writes no entry for detaching nothing.
          OR: [
            { reporterNameCipher: { not: null } },
            { reporterEmailCipher: { not: null } },
            ...(keepsAddressIndex
              ? []
              : [{ reporterEmailIndex: { not: null } }]),
          ],
        },
        data: {
          reporterNameCipher: null,
          reporterEmailCipher: null,
          ...(keepsAddressIndex ? {} : { reporterEmailIndex: null }),
        },
      });
      if (count === 0) {
        return false;
      }

      await this.audit.record(
        {
          action: "SERVICE_DATA_PURGED",
          channel: "SYSTEM",
          // No actor: nobody clicked this. The job ran because a date arrived,
          // which is what the retention window promised would happen.
          actorPersonId: null,
          // No subject either, which is what distinguishes this job from every
          // other purge in the band: the report is keyed to nobody in the
          // register, and the id it detaches is not a person's.
          targetPersonId: null,
          targetKind: "issue",
          targetId: issueId,
          /*
           * The window it fell out of, and nothing the report said. Not the
           * description, not the location, and above all not the name or the
           * address being detached - the retention rule on AuditLogService.
           * This entry outlives the columns it describes by design, and the log
           * is exempt from every purge, so a contact detail copied in here
           * would be a permanent copy of exactly what the entry says was
           * removed.
           */
          context: {
            retentionDaysAfterClosing: retentionDays,
            ...(keepsAddressIndex ? { addressIndexKept: true } : {}),
          },
        },
        tx,
      );

      return true;
    });
  }

  private withheldAddresses(
    client: Prisma.TransactionClient,
  ): Promise<Map<string, string>> {
    return withheldAddressIndexes(
      client,
      this.encryption,
      "issue.reporterEmail",
    );
  }
}
