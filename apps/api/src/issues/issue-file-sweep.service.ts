import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { MediaService, type RemovableFile } from "../media/media.service";
import { lockLegalHold } from "../retention/legal-hold-lock";
import {
  isPersonWithheld,
  withheldPersonIds,
} from "../retention/withheld-persons";

/** Queue the nightly sweep of the issues module's unattached files runs on. */
export const ISSUE_FILE_SWEEP_QUEUE = "issue-file-sweep";

/**
 * When it runs: in the band every purge wakes in, on a minute of its own.
 */
const SWEEP_CRON = "37 3 * * *";

/**
 * How long a file may wait for the row that puts it on an issue or a work
 * order.
 *
 * Every upload in the issues module stores the file first and writes the row
 * that puts it on an issue or a work order straight after, in the same request:
 * a reporter's photograph (`IssueService.attachPhoto`) and a handler's file
 * (`IssueConversationService.attach`) do, and so will a contractor's
 * photograph sent through a work order's link. The bytes cannot go into the
 * database's transaction, so the two are separate steps, and a process that
 * stops between them leaves a file on nothing. The wait between the steps is
 * the length of one request, seconds and never more than a few minutes; a day
 * is far past it.
 *
 * The age is a margin, not the guard. What keeps the sweep from deleting a file
 * whose row is being written is the lock it takes on the file's row before it
 * looks: see {@link IssueFileSweepService.keepsFile}.
 */
export const UNATTACHED_ISSUE_FILE_HOURS = 24;

/**
 * The most files one run removes.
 *
 * Never reached in ordinary running, where a stopped upload is rare. It bounds
 * the first run after something went wrong many times over. Nothing is lost by
 * stopping: what is swept is selected by the data, so the next run finds the
 * rest. Only removals count against it. A file whose removal fails is passed
 * over, not counted, so files that fail every night cannot use up the bound and
 * keep the files behind them stored.
 */
const MAX_FILES_PER_RUN = 500;

/**
 * How many removals in a row may fail before the run stops.
 *
 * Failures in a row are what storage that is down looks like: without a stop,
 * a run over a large backlog would try every candidate, each in a transaction
 * of its own with a call to storage and a line in the log, and hold the queue's
 * worker for as long as that takes. A file that fails on its own every night
 * does not stop the run, because the removal after it resets the count, so only
 * this many such files one after the other at the front of the scan could keep
 * the files behind them stored.
 */
const MAX_FAILURES_IN_A_ROW = 20;

/** How many candidates one read of the scan selects. */
const SCAN_PAGE_SIZE = 100;

/** The bounds of one run. Only a test passes others than the defaults. */
export interface IssueFileSweepLimits {
  /** The most files the run removes. */
  maxRemovals: number;
  /** How many removals in a row may fail before the run stops. */
  maxFailuresInARow: number;
  /** How many candidates one read of the scan selects. */
  pageSize: number;
}

const DEFAULT_LIMITS: IssueFileSweepLimits = {
  maxRemovals: MAX_FILES_PER_RUN,
  maxFailuresInARow: MAX_FAILURES_IN_A_ROW,
  pageSize: SCAN_PAGE_SIZE,
};

/** The capability every file the issues module stores is held under. */
const ISSUE_FILE_CAPABILITY = "issues:handle";

/**
 * Every relation through which something holds a media file, each asked to be
 * empty: a file that matches is on nothing at all.
 *
 * Not only the issues module's rows. A file the issues module stored and
 * something else came to hold is not unattached, and asking every relation
 * keeps the sweep from deciding which of them count.
 *
 * The type is what keeps the list whole. Its keys have to be every relation
 * the generated client gives `MediaFile` (`MediaFileInclude`), less the file's
 * own `apartment`, the count and `workOrderExposures`, so a relation added to
 * the schema fails the compiler here until it is listed. A relation left off
 * would make every file held only through it look unattached, and the sweep
 * would delete it.
 *
 * `workOrderExposures` holds nothing: it counts the photographs a contractor's
 * link has shown, for the access report, and lets go of the file when the file
 * goes (`SetNull`). Asked to be empty, it would keep a file that lost every
 * other row forever.
 */
export const MEDIA_FILE_ON_NOTHING = {
  associationLogo: { none: {} },
  associationLogoDark: { none: {} },
  issuePhotos: { none: {} },
  issueAttachment: null,
  workOrderPhotos: { none: {} },
  workOrderFile: null,
  document: null,
  apartmentDocument: null,
  boardMailboxAttachments: { none: {} },
  postImage: null,
} satisfies Record<
  Exclude<
    keyof Prisma.MediaFileInclude,
    "_count" | "apartment" | "workOrderExposures"
  >,
  unknown
> &
  Prisma.MediaFileWhereInput;

/**
 * A file the issues module stored that is on nothing and older than
 * {@link UNATTACHED_ISSUE_FILE_HOURS}.
 *
 * The issues module's files are told apart by what the media layer records of
 * them: INTERNAL under `issues:handle`, which every upload in the module states
 * and no other module does.
 */
export function unattachedIssueFiles(
  uploadedBefore: Date,
): Prisma.MediaFileWhereInput {
  return {
    visibility: "INTERNAL",
    requiredCapability: ISSUE_FILE_CAPABILITY,
    createdAt: { lt: uploadedBefore },
    ...MEDIA_FILE_ON_NOTHING,
  };
}

export interface IssueFileSweepRunSummary {
  /**
   * Files the run tried to remove: those the scan found on nothing and past
   * their age, up to where the run stopped. It counts the files the check under
   * the row lock then kept ({@link IssueFileSweepService.keepsFile}), which are
   * neither removed nor failed.
   */
  tried: number;
  /** Files removed, with their bytes. */
  removed: number;
  /**
   * Files whose removal threw. The run carries on past them to the files
   * behind them, and the next run selects them again.
   */
  failed: number;
  /**
   * Whether the run stopped because
   * {@link IssueFileSweepLimits.maxFailuresInARow} removals in a row failed,
   * rather than at its bound or the end of the candidates.
   */
  stoppedOnFailures: boolean;
}

/**
 * Removes the files an upload in the issues module stored and then never put
 * on anything.
 *
 * An upload stores the file through the media layer and then, in a
 * transaction of its own, writes the row that puts it on an issue or a work
 * order. A refused row removes the file again, but a process that stops
 * between the two steps - a deployment, a crash, a lost database connection -
 * leaves the file stored and on nothing. Its address went to nobody: the request
 * that stored it failed before answering with it. But it is somebody's photograph of
 * their home, or a handler's file about a case, and nothing else would ever
 * find it: the clock on an issue's free text and the issue erasure job reach
 * files through the issue, and this one is on none. Nor does the board-only
 * rule reach it: the media route asks that rule of a file on an issue
 * (`issue-file-access.ts`), and leaves a file on none to its capability alone.
 *
 * ## How it runs
 *
 * Nightly, one file per transaction, through `MediaService.remove` with
 * `bytesFirst`: the row, its MEDIA_DELETED entry and the removal of the bytes
 * from storage stand or fall together, so a storage failure leaves the row for
 * the next run to find rather than bytes with nothing left to name them. No
 * actor, because nobody pressed anything, and no file name in the entry, for
 * the reason every upload in the module gives: the name is free text, and the
 * log is append-only.
 *
 * The same query finds a file that lost its row some other way and whose
 * removal then failed, which is unattached as much as a stopped upload's is.
 *
 * ## What it keeps
 *
 * - **A file anything holds**, through any relation, not only the issues
 *   module's ({@link MEDIA_FILE_ON_NOTHING}).
 * - **A file younger than {@link UNATTACHED_ISSUE_FILE_HOURS}.**
 * - **A file whose uploader is under a legal hold or a restriction of
 *   processing.** The file is their data like anything they wrote, and either
 *   one forbids erasing it (`retention/withheld-persons.ts`), whether or not it
 *   ever went on an issue. A contractor's photograph has no uploader in the
 *   register, and nobody a hold could stand over.
 *
 * Each is asked in the scan and again in the transaction that deletes the
 * row, under the file's row lock and the uploader's legal hold key
 * ({@link keepsFile}).
 */
@Injectable()
export class IssueFileSweepService implements OnModuleInit {
  private readonly logger = new Logger(IssueFileSweepService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the sweep themselves.
      return;
    }
    await this.startSweepWorker();
  }

  /** Registers the sweep. Public so an integration test can drive the job. */
  async startSweepWorker(): Promise<void> {
    await this.jobs.work(ISSUE_FILE_SWEEP_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(ISSUE_FILE_SWEEP_QUEUE, SWEEP_CRON, {});
  }

  /**
   * Removes the issues module's files that are on nothing and past their age.
   *
   * The scan reads the candidates oldest first, a page at a time, each page
   * starting after the last file of the one before. A file the run could not
   * remove is therefore passed over rather than read again, and the run goes
   * on to the files behind it until it has removed
   * {@link IssueFileSweepLimits.maxRemovals} or found no more.
   *
   * It stops sooner when {@link IssueFileSweepLimits.maxFailuresInARow}
   * removals in a row fail, as they do when storage is down, and leaves the
   * rest to the next night rather than holding the queue's worker for a try at
   * every candidate. A file the check under the lock keeps neither adds to the
   * failures in a row nor clears them: only a removal shows that storage works.
   *
   * A file whose removal fails is logged as a warning, every night it fails.
   * The run's stop on failures in a row is logged as an error, being what an
   * outage of storage looks like.
   *
   * @param now The moment to judge the age at, passed in so a test can drive
   *   it instead of waiting a day.
   * @param limits The run's bounds, passed in so a test can reach them with a
   *   handful of files.
   */
  async run(
    now: Date = new Date(),
    limits: IssueFileSweepLimits = DEFAULT_LIMITS,
  ): Promise<IssueFileSweepRunSummary> {
    const uploadedBefore = new Date(
      now.getTime() - UNATTACHED_ISSUE_FILE_HOURS * 60 * 60 * 1000,
    );
    const withheld = await withheldPersonIds(this.prisma);
    // Excluded by the query, so withheld uploads cannot spend the run's bound.
    // Spelled out for the file with no uploader, which a bare `notIn` would
    // leave out: SQL answers NULL NOT IN (...) with neither true nor false.
    const notWithheld: Prisma.MediaFileWhereInput =
      withheld.length > 0
        ? {
            OR: [
              { uploadedByPersonId: null },
              { uploadedByPersonId: { notIn: withheld } },
            ],
          }
        : {};

    let tried = 0;
    let removed = 0;
    let failed = 0;
    let failedInARow = 0;
    let stoppedOnFailures = false;
    let after: { createdAt: Date; id: string } | null = null;
    scan: while (removed < limits.maxRemovals) {
      const page: { createdAt: Date; id: string }[] =
        await this.prisma.mediaFile.findMany({
          where: {
            AND: [
              unattachedIssueFiles(uploadedBefore),
              notWithheld,
              after === null
                ? {}
                : {
                    OR: [
                      { createdAt: { gt: after.createdAt } },
                      { createdAt: after.createdAt, id: { gt: after.id } },
                    ],
                  },
            ],
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limits.pageSize,
          select: { id: true, createdAt: true },
        });

      for (const { id } of page) {
        if (removed >= limits.maxRemovals) {
          break scan;
        }
        tried += 1;
        try {
          if (
            await this.media.remove(id, null, "SYSTEM", {
              recordFileName: false,
              bytesFirst: true,
              keep: (tx, file) => this.keepsFile(tx, file, uploadedBefore),
            })
          ) {
            removed += 1;
            failedInARow = 0;
          }
        } catch (error) {
          // The id and the class of the failure: an id is opaque, and a file
          // name would be somebody's own words.
          failed += 1;
          failedInARow += 1;
          this.logger.warn(
            `Issue file sweep left the file ${id}: ${failureName(error)}`,
          );
          if (failedInARow >= limits.maxFailuresInARow) {
            stoppedOnFailures = true;
            break scan;
          }
        }
      }

      const last = page.at(-1);
      if (last === undefined || page.length < limits.pageSize) {
        break;
      }
      after = last;
    }

    if (stoppedOnFailures) {
      this.logger.error(
        `Issue file sweep stopped after ${String(failedInARow)} removals in a row failed; removed ${String(removed)}, failed ${String(failed)} of ${String(tried)} files tried`,
      );
    } else if (removed > 0 || failed > 0) {
      this.logger.log(
        `Issue file sweep removed ${String(removed)}, failed ${String(failed)} of ${String(tried)} files tried that were on nothing`,
      );
    }
    return { tried, removed, failed, stoppedOnFailures };
  }

  /**
   * Whether a file the scan selected has to stay after all, asked on the
   * transaction that would delete its row.
   *
   * The uploader's legal hold key first, then the file's row, the order every
   * purge takes them in. A hold placed or a restriction granted between the
   * scan and this transaction takes the same key before it writes
   * (`legal-hold-lock.ts`), so what is read below settles the question until
   * the commit.
   *
   * The row lock is what keeps an upload that is still writing its row safe,
   * whatever its age. The row that puts a file on an issue or a work order
   * refers to the file's row, and the database locks the file's row while it
   * checks the reference. So a write that got there first has its row
   * committed by the time this lock is granted, and the read below sees it and
   * keeps the file; a write that comes after waits for the deletion, then
   * finds no file to refer to and fails, and its upload is refused. Without
   * the lock the read could miss a row not yet committed, and the deletion
   * would then wait for it and take it with the file, from an issue its
   * uploader had been told now carried it.
   *
   * Then everything the scan assumed, read again in one query.
   */
  private async keepsFile(
    tx: Prisma.TransactionClient,
    file: RemovableFile,
    uploadedBefore: Date,
  ): Promise<boolean> {
    if (file.uploadedByPersonId !== null) {
      await lockLegalHold(tx, file.uploadedByPersonId);
    }
    await tx.$queryRaw`SELECT "id" FROM "media_file" WHERE "id" = ${file.id} FOR UPDATE`;
    const unattached = await tx.mediaFile.count({
      where: { id: file.id, ...unattachedIssueFiles(uploadedBefore) },
    });
    if (unattached === 0) {
      return true;
    }
    return (
      file.uploadedByPersonId !== null &&
      (await isPersonWithheld(tx, file.uploadedByPersonId))
    );
  }
}
