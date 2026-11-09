import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockLegalHoldRegistry } from "../retention/legal-hold-lock";
import { withheldAddressIndexes } from "../retention/withheld-addresses";
import {
  isAnyPersonWithheld,
  isPersonWithheld,
  withheldPersonIds,
} from "../retention/withheld-persons";
import {
  ISSUE_FREE_TEXT_STANDING,
  issueTextClockYears,
  issueTextRetentionDays,
  issueTextRetentionYears,
} from "./issue-free-text";
import {
  CONCERNS_NO_WITHHELD_PERSON,
  concernedPersonIdsOf,
  concernsUnlockedPerson,
  lockPersonHolds,
} from "./issue-concerned-persons";
import { IssueFreeTextService } from "./issue-free-text.service";
import { lockIssue } from "./issue-lock";
import { issuePurgeCutoff } from "./issue-retention";

/** Queue the nightly purge of issues' free text runs on. */
export const ISSUE_TEXT_PURGE_QUEUE = "issue-text-purge";

/**
 * When it runs: in the band every purge wakes in, on a minute of its own, and
 * before the person purge at `53 3`, which detaches a reporter only from an
 * issue whose free text is gone and so finds tonight's issues finished.
 */
const PURGE_CRON = "21 3 * * *";

/**
 * The most issues one run removes, and how many it reads at a time.
 *
 * Never reached in ordinary running. It exists for the first night on an
 * instance with years of closed issues behind it, or the day the board
 * shortens the clock. Nothing is lost by stopping: what stands is selected by
 * the data, so the next run finds the rest.
 *
 * The bound counts removals and not issues read. An issue whose removal fails
 * keeps its text and is selected again the next night, so a bound on what is
 * read would let five hundred failing old issues keep every newer one past its
 * clock for as long as they failed. The run reads on past them, a page after
 * the last one it saw, up to {@link MAX_ATTEMPTS_PER_RUN}.
 */
const MAX_ISSUES_PER_RUN = 500;

/**
 * The most issues one run tries, removed or not.
 *
 * Twice the removals, so a run gets past as many failing or kept issues as it
 * removes. Without it a backlog that fails throughout - storage that refuses
 * every removal - would be read to its end in one run, past the time the job
 * queue gives a job before it hands the same night's run out again.
 */
const MAX_ATTEMPTS_PER_RUN = 2 * MAX_ISSUES_PER_RUN;

/** Where a page of the scan left off: the last issue's closing and id. */
interface IssueCursor {
  closedAt: Date;
  id: string;
}

export interface IssueTextPurgeRunSummary {
  /** Issues the scan found past their clock with free text standing. */
  considered: number;
  /** Issues whose free-text layer is now gone. */
  purged: number;
  /** Issues whose removal threw. The run carries on past them. */
  failed: number;
}

/**
 * The clock on an issue's free text (ADR 0057, decision 33).
 *
 * Once an issue has been closed - in the `DONE` meaning, whatever the board
 * named its status - for as many years as the board set, from one to ten and
 * two by default, or for one year when its type is ring-fenced, whatever the
 * board set (`RING_FENCED_ISSUE_TEXT_RETENTION_YEARS`), its free-text layer is
 * removed: the description, the
 * free-text location, every issue message and internal note, and every
 * photograph and handler's file, from storage and not only from the issue. The
 * building record stays. `issue-free-text.ts` says which is which, and
 * `IssueFreeTextService` removes it.
 *
 * ## What stops the clock
 *
 * - **Reopening.** The clock runs from `closedAt`, which the service writes
 *   under the issue lock on a move into `DONE` and clears on a move out of it.
 * - **A legal hold on the issue** (`legalHoldAt`), which a damage case and an
 *   inspection finding place, and a handler may.
 * - **A legal hold or a restriction on its reporter**: a signed-in reporter by
 *   their person, a public-form reporter by the address on the report, as the
 *   website form's own purge reads it (`issue-purge.service.ts`).
 * - **A legal hold or a restriction on a person it concerns**
 *   (`IssueConcernedPerson`, ADR 0057), read by their person as a signed-in
 *   reporter is: the text is what the case holds about them as much as about
 *   the reporter, and the record that it concerns them goes with it.
 *
 * Each is checked in the scan and again inside the transaction that removes,
 * under the issue lock and the hold's: a hold placed or an issue reopened while
 * the run is in flight has to win.
 *
 * ## Not an erasure domain
 *
 * The clock is keyed to the issue and reads no request. What a granted erasure
 * request reaches in the issues module is `IssueErasureService`'s, on the date
 * the board granted, and it registers in `ERASURE_DOMAINS`.
 */
@Injectable()
export class IssueTextPurgeService implements OnModuleInit {
  private readonly logger = new Logger(IssueTextPurgeService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly freeText: IssueFreeTextService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the purge with a clock of their own.
      return;
    }
    await this.startPurgeWorker();
  }

  /** Registers the purge. Public so an integration test can drive the job. */
  async startPurgeWorker(): Promise<void> {
    await this.jobs.work(ISSUE_TEXT_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(ISSUE_TEXT_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Removes the free-text layer of every closed issue past the board's clock.
   *
   * @param now The moment to judge the clock at, passed in so a test can drive
   *   it forward instead of waiting years.
   * @param years The clock, in whole years; the board's setting by default.
   * @param pageSize How many issues the scan reads at a time, passed in so a
   *   test can make it read past a page without seeding five hundred issues.
   */
  async run(
    now: Date = new Date(),
    years?: number,
    pageSize: number = MAX_ISSUES_PER_RUN,
  ): Promise<IssueTextPurgeRunSummary> {
    const clock = years ?? (await issueTextRetentionYears(this.prisma));

    let considered = 0;
    let purged = 0;
    let failed = 0;
    // Issues whose text went while a file attached in flight still stands:
    // they stay due, so the next run selects them again, as it does a failed
    // removal.
    let unfinished = 0;
    let after: IssueCursor | undefined;
    const bounded = (): boolean =>
      purged >= MAX_ISSUES_PER_RUN || considered >= MAX_ATTEMPTS_PER_RUN;
    while (!bounded()) {
      const page = await this.eligiblePage(now, clock, after, pageSize);
      if (page.length === 0) {
        break;
      }
      for (const { id } of page) {
        // The bound holds inside a page too: a page read with room left is not
        // carried through once the run has taken its share.
        if (bounded()) {
          break;
        }
        considered += 1;
        try {
          const outcome = await this.purgeIssue(id, now, clock);
          if (outcome === "removed") {
            purged += 1;
          } else if (outcome === "unfinished") {
            unfinished += 1;
          }
        } catch (error) {
          // The class of the failure and the issue id, and nothing the failure
          // was holding: a message here can be quoting the text being removed.
          failed += 1;
          this.logger.error(
            `Issue text purge failed for issue ${id}: ${failureName(error)}`,
          );
        }
      }
      const last = page.at(-1);
      if (last === undefined) {
        break;
      }
      after = { closedAt: last.closedAt, id: last.id };
    }

    if (purged > 0 || failed > 0) {
      this.logger.log(
        `Removed the free text of ${String(purged)} of ${String(
          considered,
        )} issues past their clock`,
      );
    }
    if (bounded()) {
      // A failed removal leaves the issue first in line, so a run that failed
      // its way to the bound has not reached the issues behind it, and the
      // next run will not either until the failures stop. Said as an error so
      // that whoever runs the instance sees free text standing past its clock.
      if (purged < MAX_ISSUES_PER_RUN) {
        this.logger.error(
          `Issue text purge stopped at its bound of ${String(
            MAX_ATTEMPTS_PER_RUN,
          )} attempts, ${String(
            failed + unfinished,
          )} of which did not finish (${String(failed)} failed removals, ${String(
            unfinished,
          )} issues with a file still standing; the rest were removed or kept); ${
            failed + unfinished > 0
              ? "issues behind the ones that did not succeed wait until those do."
              : "the issues behind them are reached by the next run."
          }`,
        );
      } else {
        this.logger.log(
          `Issue text purge stopped at its per-run bound of ${String(
            MAX_ISSUES_PER_RUN,
          )} removals; the rest are reached by the next run.`,
        );
      }
    }

    return { considered, purged, failed };
  }

  /**
   * One page of the issues past the clock with free text standing and nothing
   * holding it, oldest closing first, after the one the cursor names.
   *
   * A withheld reporter is excluded by the query rather than dropped from its
   * answer, for the reason the website form's purge gives: the bound is
   * applied by the database, and held issues sorting first would otherwise
   * fill every run for as long as the hold stood.
   *
   * @param take The most issues the page holds.
   */
  async eligiblePage(
    now: Date,
    years: number,
    after?: IssueCursor,
    take: number = MAX_ISSUES_PER_RUN,
  ): Promise<{ id: string; closedAt: Date }[]> {
    const withheldPersons = await withheldPersonIds(this.prisma);
    const withheldAddresses = [
      ...(await this.withheldAddresses(this.prisma)).keys(),
    ];

    const issues = await this.prisma.issue.findMany({
      where: {
        ...pastClock(now, years),
        AND: [
          ISSUE_FREE_TEXT_STANDING,
          // Keyset paging on the order below, so a page after one whose
          // removals failed is not the same page again.
          ...(after === undefined
            ? []
            : [
                {
                  OR: [
                    { closedAt: { gt: after.closedAt } },
                    { closedAt: after.closedAt, id: { gt: after.id } },
                  ],
                },
              ]),
          // Spelled with the null branch beside each list, because `NOT IN`
          // answers null rather than true for a null column.
          ...(withheldPersons.length > 0
            ? [
                {
                  OR: [
                    { reporterPersonId: null },
                    { reporterPersonId: { notIn: withheldPersons } },
                  ],
                },
              ]
            : []),
          CONCERNS_NO_WITHHELD_PERSON,
          ...(withheldAddresses.length > 0
            ? [
                {
                  OR: [
                    { reporterEmailIndex: null },
                    { reporterEmailIndex: { notIn: withheldAddresses } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ closedAt: "asc" }, { id: "asc" }],
      take,
      select: { id: true, closedAt: true },
    });
    return issues.flatMap((issue) =>
      issue.closedAt === null
        ? []
        : [{ id: issue.id, closedAt: issue.closedAt }],
    );
  }

  /** The first page of {@link eligiblePage}, as identifiers. */
  async eligible(now: Date, years: number): Promise<string[]> {
    return (await this.eligiblePage(now, years)).map((issue) => issue.id);
  }

  /** Removes one issue's free-text layer, if it is still due. */
  async purgeIssue(
    issueId: string,
    now: Date,
    years: number,
  ): Promise<"removed" | "kept" | "unfinished"> {
    /*
     * The clock the entry names. Filled in by `stillDue` from the issue's type
     * as it is read under the issue's lock, which is before the entry is
     * written in the same transaction, so the entry names the clock the removal
     * was judged by rather than the one the scan saw.
     */
    const context: Record<string, number | boolean> = {
      retentionYearsAfterClosing: years,
    };
    return this.freeText.remove(issueId, now, {
      targetPersonId: null,
      context,
      stillDue: async (tx) => {
        const reporter = await tx.issue.findUnique({
          where: { id: issueId },
          select: { reporterPersonId: true, reporterEmailIndex: true },
        });
        if (reporter === null) {
          return false;
        }
        // The holds' locks, then the issue's: the order the person purge takes
        // them in, so neither waits on the other the other way round. The
        // reporter's key among those of the people the issue concerns.
        const concerned = await concernedPersonIdsOf(tx, issueId);
        await lockPersonHolds(tx, [reporter.reporterPersonId, ...concerned]);
        if (reporter.reporterEmailIndex !== null) {
          await lockLegalHoldRegistry(tx);
        }
        await lockIssue(tx, issueId);
        // Somebody recorded since the read above is kept for the next run,
        // rather than having their hold read without their key.
        if (await concernsUnlockedPerson(tx, issueId, concerned)) {
          return false;
        }
        if (await isAnyPersonWithheld(tx, concerned)) {
          return false;
        }

        const due = await tx.issue.findFirst({
          where: { id: issueId, ...pastClock(now, years) },
          select: {
            reporterPersonId: true,
            reporterEmailIndex: true,
            type: { select: { ringFenced: true } },
          },
        });
        if (due === null) {
          return false;
        }
        if (due.type.ringFenced) {
          context.retentionYearsAfterClosing = issueTextClockYears(years, true);
          context.ringFenced = true;
        }
        if (
          due.reporterPersonId !== null &&
          (await isPersonWithheld(tx, due.reporterPersonId))
        ) {
          return false;
        }
        return !(
          due.reporterEmailIndex !== null &&
          (await this.withheldAddresses(tx)).has(due.reporterEmailIndex)
        );
      },
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

/**
 * Closed, past the clock, and under no hold of its own.
 *
 * The `DONE` meaning, never a label: a status the board added under done
 * closes an issue for the clock as Klar does.
 *
 * Two clocks, by the issue's type as it stands now: the board's for an
 * ordinary type, and for a ring-fenced one the shorter of that and
 * `RING_FENCED_ISSUE_TEXT_RETENTION_YEARS`, which the board does not set
 * (decision 32). Read off the type on every run rather than fixed at closing,
 * so a type the board ring-fences brings its closed issues onto the shorter
 * clock from the next night.
 */
function pastClock(now: Date, years: number): Prisma.IssueWhereInput {
  const closedBy = (clockYears: number) => ({
    not: null,
    lte: issuePurgeCutoff(now, issueTextRetentionDays(clockYears)),
  });
  return {
    status: { meaning: "DONE" },
    legalHoldAt: null,
    OR: [
      {
        type: { ringFenced: false },
        closedAt: closedBy(issueTextClockYears(years, false)),
      },
      {
        type: { ringFenced: true },
        closedAt: closedBy(issueTextClockYears(years, true)),
      },
    ],
  };
}
