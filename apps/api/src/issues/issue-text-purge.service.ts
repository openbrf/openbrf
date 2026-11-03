import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import {
  lockLegalHold,
  lockLegalHoldRegistry,
} from "../retention/legal-hold-lock";
import { withheldAddressIndexes } from "../retention/withheld-addresses";
import {
  isPersonWithheld,
  withheldPersonIds,
} from "../retention/withheld-persons";
import {
  ISSUE_FREE_TEXT_STANDING,
  issueTextRetentionDays,
  issueTextRetentionYears,
} from "./issue-free-text";
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
 * the last one it saw, until a page comes back empty.
 */
const MAX_ISSUES_PER_RUN = 500;

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
 * two by default, its free-text layer is removed: the description, the
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
   */
  async run(
    now: Date = new Date(),
    years?: number,
  ): Promise<IssueTextPurgeRunSummary> {
    const clock = years ?? (await issueTextRetentionYears(this.prisma));

    let considered = 0;
    let purged = 0;
    let failed = 0;
    let after: IssueCursor | undefined;
    while (purged < MAX_ISSUES_PER_RUN) {
      const page = await this.eligiblePage(now, clock, after);
      if (page.length === 0) {
        break;
      }
      considered += page.length;
      for (const { id } of page) {
        try {
          if ((await this.purgeIssue(id, now, clock)) === "removed") {
            purged += 1;
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
    if (purged >= MAX_ISSUES_PER_RUN) {
      this.logger.log(
        `Issue text purge stopped at its per-run bound of ${String(
          MAX_ISSUES_PER_RUN,
        )}; the rest are reached by the next run.`,
      );
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
   */
  async eligiblePage(
    now: Date,
    years: number,
    after?: IssueCursor,
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
      take: MAX_ISSUES_PER_RUN,
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
    return this.freeText.remove(issueId, now, {
      targetPersonId: null,
      context: { retentionYearsAfterClosing: years },
      stillDue: async (tx) => {
        const reporter = await tx.issue.findUnique({
          where: { id: issueId },
          select: { reporterPersonId: true, reporterEmailIndex: true },
        });
        if (reporter === null) {
          return false;
        }
        // The hold's locks, then the issue's: the order the person purge takes
        // them in, so neither waits on the other the other way round.
        if (reporter.reporterPersonId !== null) {
          await lockLegalHold(tx, reporter.reporterPersonId);
        }
        if (reporter.reporterEmailIndex !== null) {
          await lockLegalHoldRegistry(tx);
        }
        await lockIssue(tx, issueId);

        const due = await tx.issue.findFirst({
          where: { id: issueId, ...pastClock(now, years) },
          select: { reporterPersonId: true, reporterEmailIndex: true },
        });
        if (due === null) {
          return false;
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
 */
function pastClock(now: Date, years: number): Prisma.IssueWhereInput {
  return {
    status: { meaning: "DONE" },
    closedAt: {
      not: null,
      lte: issuePurgeCutoff(now, issueTextRetentionDays(years)),
    },
    legalHoldAt: null,
  };
}
