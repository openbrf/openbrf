import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import {
  issueErasureGrounds,
  issuesErasedOnRequest,
} from "../retention/erasure-domains";
import { lockErasureEligibility } from "../retention/erasure-lock";
import { lockLegalHold } from "../retention/legal-hold-lock";
import {
  erasureRequestedPersonIds,
  isErasureInForce,
} from "../retention/withheld-persons";
import { IssueFreeTextService } from "./issue-free-text.service";
import { lockIssue } from "./issue-lock";

/** Queue the nightly issue erasure job runs on. */
export const ISSUE_ERASURE_QUEUE = "issue-erasure";

/**
 * When it runs: before the person purge at `53 3`, which
 * `erasure-request-order.spec.ts` holds it to. The person purge closes the
 * request and detaches the reporter, and a job running after it would find
 * neither the open request nor the issues it is about.
 */
const ERASURE_CRON = "25 3 * * *";

export interface IssueErasureRunSummary {
  /** Issues the scan found owed to a granted request. */
  considered: number;
  /** Issues whose free-text layer is now gone. */
  purged: number;
  /** Issues whose removal threw. The run carries on past them. */
  failed: number;
}

/**
 * Carries out a granted erasure request in the issues module (ADR 0057).
 *
 * The clock removes an issue's free text years after it closes, and that is
 * no evidence that an erasure the board granted was carried out: the person
 * purge marks the request executed and closes it, and once it is closed no job
 * finds it. So for each person a granted request names, this job removes the
 * free-text layer of every issue they reported that is closed and under no
 * legal hold of its own, on the date the board granted rather than on the
 * issue's clock - the description, the location, the conversation, the
 * internal notes and every photograph and file, from storage. The building
 * record stays.
 *
 * An issue they reported that is still open, or under a hold of its own, is
 * kept, and counted as kept: the request stays open with that reason until the
 * issue closes or the hold is released. `ERASURE_DOMAINS` says both, and the
 * closing job counts both before it writes `executedAt`.
 *
 * What a request erases is `issuesErasedOnRequest`, the one where-input the
 * scan and the closing job's count read; the removal's re-check reads its
 * grounds without the test that some text stands, because the removal takes
 * the files first and the last of them may be gone by the time it asks.
 */
@Injectable()
export class IssueErasureService implements OnModuleInit {
  private readonly logger = new Logger(IssueErasureService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly freeText: IssueFreeTextService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the job with a clock of their own.
      return;
    }
    await this.startErasureWorker();
  }

  /** Registers the job. Public so an integration test can drive it. */
  async startErasureWorker(): Promise<void> {
    await this.jobs.work(ISSUE_ERASURE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(ISSUE_ERASURE_QUEUE, ERASURE_CRON, {});
  }

  /**
   * Removes the free text of every issue a granted erasure request reaches.
   *
   * @param now The moment to judge at, passed in so a test can drive it.
   */
  async run(now: Date = new Date()): Promise<IssueErasureRunSummary> {
    const owed = await this.eligible(now);

    let purged = 0;
    let failed = 0;
    for (const { id, reporterPersonId } of owed) {
      try {
        if ((await this.eraseIssue(id, reporterPersonId, now)) === "removed") {
          purged += 1;
        }
      } catch (error) {
        // The class of the failure and the issue id, and nothing the failure
        // was holding. The request stays open, because the closing job counts
        // this issue as owed.
        failed += 1;
        this.logger.error(
          `Issue erasure failed for issue ${id}: ${failureName(error)}`,
        );
      }
    }

    if (purged > 0 || failed > 0) {
      this.logger.log(
        `Removed the free text of ${String(purged)} of ${String(
          owed.length,
        )} issues owed to a granted erasure request`,
      );
    }

    return { considered: owed.length, purged, failed };
  }

  /**
   * The issues a granted erasure request reaches.
   *
   * Every one, with no per-run bound: the people a request names are taken
   * ahead of any bound in every job of this kind (`remainingRunBound` gives
   * the reason), and the people a request names are all this job takes. The
   * closing job's count keeps a request open for an issue a failed run left.
   */
  async eligible(
    now: Date,
  ): Promise<{ id: string; reporterPersonId: string }[]> {
    const requested = await erasureRequestedPersonIds(this.prisma, now);
    if (requested.length === 0) {
      return [];
    }
    const issues = await this.prisma.issue.findMany({
      where: issuesErasedOnRequest({ in: requested }),
      orderBy: [{ reporterPersonId: "asc" }, { id: "asc" }],
      select: { id: true, reporterPersonId: true },
    });
    return issues.flatMap((issue) =>
      issue.reporterPersonId === null
        ? []
        : [{ id: issue.id, reporterPersonId: issue.reporterPersonId }],
    );
  }

  /** Removes one issue's free-text layer, if the request is still in force. */
  async eraseIssue(
    issueId: string,
    personId: string,
    now: Date,
  ): Promise<"removed" | "kept" | "unfinished"> {
    return this.freeText.remove(issueId, now, {
      targetPersonId: personId,
      context: { onRequest: true },
      stillDue: async (tx) => {
        // The hold, then what decides whether an erasure may run, then the
        // issue: the order the person purge takes them in.
        await lockLegalHold(tx, personId);
        await lockErasureEligibility(tx, personId);
        await lockIssue(tx, issueId);
        if (!(await isErasureInForce(tx, personId, now))) {
          return false;
        }
        const due = await tx.issue.findFirst({
          where: { id: issueId, ...issueErasureGrounds(personId) },
          select: { id: true },
        });
        return due !== null;
      },
    });
  }
}
