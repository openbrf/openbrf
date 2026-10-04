import { createHash, randomUUID } from "node:crypto";

import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { ImportPreviewStatus } from "../generated/prisma/enums";
import {
  type JobSendOptions,
  JobQueueService,
  type TransactionalSql,
} from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { type ImportField, readMapping } from "./import-columns";
import { ImportError, type ImportErrorReason } from "./import-errors";
import { readDecisions } from "./import-apply.service";
import type { ImportOutcome, ImportPlan, PlannedRow } from "./import-plan";
import { ImportPlannerService } from "./import-planner.service";

/**
 * Planning the preview, as a background job.
 *
 * A preview matches every row against the register, and a row carrying a
 * personal identity number is matched by its blind index: an Argon2id hash
 * that costs tens of milliseconds by design. Against a register that holds
 * identity numbers, the largest file the upload accepts is minutes of that, so
 * the preview runs the way the apply does (ADR 0002). The request records the
 * mapping and queues the job; the screen polls the preview by its id; the job
 * stores the plan, encrypted, and issues the token the apply has to carry.
 *
 * A preview is asked for again whenever the mapping changes, so most jobs are
 * overtaken rather than finished. Each one therefore checks, every
 * {@link PREVIEW_PROGRESS_ROWS} rows, that it is still the preview the session
 * wants and that a screen is still watching it, and lets go of the worker when
 * it is not. One worker plans previews one at a time, and a job nobody can look
 * at must not hold up the next one somebody can.
 */

/** Queue the preview runs on. */
export const IMPORT_PREVIEW_QUEUE = "import-preview";

/**
 * Where a preview lands once its retries are spent. The handler records the
 * interruption, so the screen polling it is told rather than left waiting.
 */
export const IMPORT_PREVIEW_ABANDONED_QUEUE = "import-preview-abandoned";

/**
 * Rows planned between two progress reports.
 *
 * Each report is one conditional update, and it is also where the job learns
 * that it has been replaced or abandoned. Fifty rows carrying identity numbers
 * is a little over two seconds of Argon2id, which keeps the progress bar
 * moving and bounds what a replaced job goes on spending.
 */
export const PREVIEW_PROGRESS_ROWS = 50;

/**
 * How long a preview may go without a screen asking about it before the job
 * stops planning it.
 *
 * The screen asks every second and a half. Two minutes leaves room for a tab in
 * the background, whose timers a browser slows to as little as once a minute.
 */
export const PREVIEW_UNWATCHED_MS = 2 * 60 * 1000;

/** How long the queue waits before deciding a worker is gone. */
const PREVIEW_EXPIRE_SECONDS = 30 * 60;

const PREVIEW_JOB_OPTIONS = {
  // A retry plans from the start, so retries are few: they are for a database
  // that went away or a worker that was killed. A refusal never reaches them.
  retryLimit: 2,
  retryDelay: 5,
  retryBackoff: true,
  expireInSeconds: PREVIEW_EXPIRE_SECONDS,
  deadLetter: IMPORT_PREVIEW_ABANDONED_QUEUE,
} satisfies JobSendOptions;

/** Payload of the preview job. */
interface ImportPreviewJob {
  sessionId: string;
  previewId: string;
  [key: string]: unknown;
}

/**
 * A previewed row.
 *
 * The personal identity number is reported as present or absent and never sent.
 * A preview is not a register view, and DESIGN.md keeps identity numbers out of
 * every screen that is not one.
 */
export interface ImportPreviewRow extends Omit<
  PlannedRow,
  "person" | "problems" | "movedInStated"
> {
  person: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    hasPersonalIdentityNumber: boolean;
    postalStreet: string | null;
    postalCode: string | null;
    postalCity: string | null;
  };
  problems: { field: ImportField | null; reason: string }[];
}

export interface ImportPreview {
  sessionId: string;
  /** Sent back with the apply, which runs only the preview it names. */
  previewToken: string;
  summary: Record<ImportOutcome, number>;
  rows: ImportPreviewRow[];
}

/** A preview as the screen polls it. */
export interface ImportPreviewRun {
  sessionId: string;
  /** Names this preview. The screen polls with it. */
  previewId: string;
  status: ImportPreviewStatus;
  /** Rows planned against rows total: the file's data rows, header excluded. */
  rowsDone: number;
  rowsTotal: number;
  /** The import's own reason code when the preview stopped, else null. */
  failureReason: ImportErrorReason | null;
  /** The preview itself, once it is ready. */
  preview: ImportPreview | null;
}

/** The columns a preview run is built from. */
export const IMPORT_PREVIEW_SELECT = {
  rowCount: true,
  previewId: true,
  previewStatus: true,
  previewRowsDone: true,
  previewFailureReason: true,
  previewCipher: true,
  previewToken: true,
} as const;

type ImportPreviewRunRow = Prisma.ImportSessionGetPayload<{
  select: typeof IMPORT_PREVIEW_SELECT;
}>;

/** What is stored of a finished preview. The token is a column of its own. */
interface StoredPreview {
  summary: Record<ImportOutcome, number>;
  rows: ImportPreviewRow[];
}

/** Thrown by a progress report when the job has nothing left to do. */
class PreviewReleased extends Error {
  constructor() {
    super("The preview was replaced or left unwatched.");
    this.name = "PreviewReleased";
  }
}

@Injectable()
export class ImportPreviewService implements OnModuleInit {
  private readonly logger = new Logger(ImportPreviewService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly planner: ImportPlannerService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests start the worker themselves, as they do the apply's.
      return;
    }
    await this.startPreviewWorker();
    await this.resumeInterruptedPreviews();
  }

  /** Registers the workers. Public so an integration test can drive the job. */
  async startPreviewWorker(): Promise<void> {
    await this.jobs.work<ImportPreviewJob>(
      IMPORT_PREVIEW_QUEUE,
      async (data) => {
        await this.runPreview(data.sessionId, data.previewId);
      },
    );
    await this.jobs.work<ImportPreviewJob>(
      IMPORT_PREVIEW_ABANDONED_QUEUE,
      async (data) => {
        await this.release(
          data.sessionId,
          data.previewId,
          "preview-interrupted",
        );
      },
    );
  }

  /**
   * Creates the queues the preview uses. Awaited before a transaction that
   * enqueues, because creating a queue is the queue backend's own work on its
   * own connection.
   */
  async ensureQueues(): Promise<void> {
    await this.jobs.ensureQueue(IMPORT_PREVIEW_QUEUE);
    await this.jobs.ensureQueue(IMPORT_PREVIEW_ABANDONED_QUEUE);
  }

  /**
   * Puts the preview on the queue, inside the transaction that recorded it, so
   * a preview the session says is being planned always has a job behind it.
   */
  async enqueueInTransaction(
    tx: TransactionalSql,
    sessionId: string,
    previewId: string,
  ): Promise<void> {
    await this.jobs.sendInTransaction<ImportPreviewJob>(
      tx,
      IMPORT_PREVIEW_QUEUE,
      { sessionId, previewId },
      PREVIEW_JOB_OPTIONS,
    );
  }

  /**
   * Re-queues every preview that was being planned when the process stopped.
   *
   * A preview is planned from the start every time, so this is all resuming
   * takes. One nobody has asked about for {@link PREVIEW_UNWATCHED_MS} - the
   * process was down longer than that - is recorded as interrupted instead:
   * its screen has stopped waiting, and the job would only decrypt the file and
   * hash rows to find that out.
   */
  async resumeInterruptedPreviews(): Promise<number> {
    const unfinished = await this.prisma.importSession.findMany({
      where: {
        status: "MAPPING",
        previewStatus: "PLANNING",
        expiresAt: { gt: new Date() },
      },
      select: { id: true, previewId: true, previewWatchedAt: true },
    });

    let queued = 0;
    for (const session of unfinished) {
      if (session.previewId === null) {
        continue;
      }
      if (!watched(session.previewWatchedAt)) {
        await this.release(
          session.id,
          session.previewId,
          "preview-interrupted",
        );
        continue;
      }
      await this.jobs.send<ImportPreviewJob>(
        IMPORT_PREVIEW_QUEUE,
        { sessionId: session.id, previewId: session.previewId },
        PREVIEW_JOB_OPTIONS,
      );
      queued++;
    }
    if (queued > 0) {
      this.logger.log(`Re-queued ${String(queued)} unfinished import previews`);
    }
    return queued;
  }

  /**
   * Stops a preview the screen no longer waits for.
   *
   * Recorded through the same guard as every other end of a preview, so it
   * touches only a preview still being planned, and the job planning it lets go
   * of the worker at its next progress report rather than when the preview is
   * next found unwatched.
   */
  async cancel(sessionId: string, previewId: string): Promise<void> {
    await this.release(sessionId, previewId, "preview-cancelled");
  }

  /**
   * Plans the preview and records it. Public so a test can drive it.
   *
   * Failures are answered as the apply answers them: an `ImportError` is a
   * refusal no retry can change, so it is recorded and the job finishes;
   * anything else is thrown on for the queue to retry.
   */
  async runPreview(sessionId: string, previewId: string): Promise<void> {
    const session = await this.prisma.importSession.findUnique({
      where: { id: sessionId },
      select: {
        columns: true,
        rowsCipher: true,
        mapping: true,
        defaultRole: true,
        defaultMovedInOn: true,
        decisions: true,
        status: true,
        previewId: true,
        previewStatus: true,
        previewWatchedAt: true,
      },
    });
    if (
      session === null ||
      session.status !== "MAPPING" ||
      session.previewId !== previewId ||
      session.previewStatus !== "PLANNING"
    ) {
      // Purged, started, cancelled or previewed again since: nobody wants this
      // one.
      return;
    }
    if (!watched(session.previewWatchedAt)) {
      // A job that waited out an outage or a long queue: its screen has gone,
      // so the file is not decrypted for it.
      await this.release(sessionId, previewId, "preview-interrupted");
      return;
    }

    try {
      const plan = await this.planner.plan({
        rows: await this.planner.decryptRows(session.rowsCipher),
        columnCount: session.columns.length,
        mapping: readMapping(session.mapping),
        defaultRole: session.defaultRole,
        defaultMovedInOn: session.defaultMovedInOn,
        decisions: readDecisions(session.decisions),
        // A preview matches; it writes nothing. An identity number is
        // therefore only worth its Argon2id hash when the register holds one
        // to match it against.
        indexEveryIdentityNumber: false,
        // This job's alone, and gone when it ends.
        indexes: new Map(),
        onRowPrepared: async (rowsPrepared) => {
          if (rowsPrepared % PREVIEW_PROGRESS_ROWS === 0) {
            await this.reportProgress(sessionId, previewId, rowsPrepared);
          }
        },
      });
      await this.record(sessionId, previewId, plan);
    } catch (error) {
      if (error instanceof PreviewReleased) {
        this.logger.log(
          `Import session ${sessionId}: preview ${previewId} let go`,
        );
        return;
      }
      if (error instanceof ImportError) {
        await this.release(sessionId, previewId, error.reason);
        return;
      }
      // Named by its class, not by what it carried: the values are a member
      // list.
      this.logger.error(
        `Import session ${sessionId}: preview failed with ${failureName(error)}`,
      );
      throw error;
    }
  }

  /** The preview as the screen reads it, decrypted once it is ready. */
  async view(
    sessionId: string,
    session: ImportPreviewRunRow,
  ): Promise<ImportPreviewRun> {
    const status = session.previewStatus ?? "FAILED";
    let preview: ImportPreview | null = null;
    if (
      status === "READY" &&
      session.previewCipher !== null &&
      session.previewToken !== null
    ) {
      const stored = JSON.parse(
        await this.encryption.decrypt(
          "importSession.preview",
          session.previewCipher,
        ),
      ) as StoredPreview;
      preview = {
        sessionId,
        previewToken: session.previewToken,
        summary: stored.summary,
        rows: stored.rows,
      };
    }

    return {
      sessionId,
      previewId: session.previewId ?? "",
      status,
      rowsDone: session.previewRowsDone,
      rowsTotal: session.rowCount,
      // Written only from an ImportErrorReason, by release().
      failureReason: session.previewFailureReason as ImportErrorReason | null,
      preview,
    };
  }

  /**
   * Records how far the job has got, and finds out whether to go on.
   *
   * One conditional update does both. It matches only while this is still the
   * session's preview and a screen has asked about it recently; when it
   * matches nothing, the preview has been replaced or cancelled, the import
   * started, or the screen has gone, and the job stops where it is.
   */
  private async reportProgress(
    sessionId: string,
    previewId: string,
    rowsDone: number,
  ): Promise<void> {
    const { count } = await this.prisma.importSession.updateMany({
      where: {
        ...current(sessionId, previewId),
        previewWatchedAt: { gte: new Date(Date.now() - PREVIEW_UNWATCHED_MS) },
      },
      data: { previewRowsDone: rowsDone },
    });
    if (count === 0) {
      // A replaced or cancelled preview is left alone by this; one left
      // unwatched is marked stopped, so a screen that does come back is told
      // rather than waiting.
      await this.release(sessionId, previewId, "preview-interrupted");
      throw new PreviewReleased();
    }
  }

  /** Stores the finished preview and issues the token the apply carries. */
  private async record(
    sessionId: string,
    previewId: string,
    plan: ImportPlan,
  ): Promise<void> {
    // The rows the board will have to decide, read back by the apply: a row
    // needing a decision cannot be slipped past by applying a mapping nobody
    // previewed.
    const ambiguousRows: Record<string, string[]> = {};
    for (const row of plan.rows) {
      if (row.outcome === "ambiguous") {
        ambiguousRows[String(row.rowNumber)] = row.candidates.map(
          (candidate) => candidate.personId,
        );
      }
    }

    const stored: StoredPreview = {
      summary: plan.summary,
      rows: plan.rows.map(toPreviewRow),
    };
    const encrypted = await this.encryption.encrypt(
      "importSession.preview",
      JSON.stringify(stored),
    );

    const { count } = await this.prisma.importSession.updateMany({
      where: current(sessionId, previewId),
      data: {
        previewStatus: "READY",
        previewToken: randomUUID(),
        previewCipher: encrypted.cipher,
        previewRowsDone: plan.rows.length,
        ambiguousRows: ambiguousRows as Prisma.InputJsonValue,
        previewDigest: planDigest(plan),
        previewedAt: new Date(),
      },
    });
    if (count > 0) {
      this.logger.log(`Import session ${sessionId}: preview ready`);
    }
  }

  /** Records that the preview stopped, if it is still the session's preview. */
  private async release(
    sessionId: string,
    previewId: string,
    reason: ImportErrorReason,
  ): Promise<void> {
    const { count } = await this.prisma.importSession.updateMany({
      where: current(sessionId, previewId),
      data: { previewStatus: "FAILED", previewFailureReason: reason },
    });
    if (count > 0) {
      this.logger.warn(
        `Import session ${sessionId}: preview stopped: ${reason}`,
      );
    }
  }
}

/**
 * What a plan does with every row, as one value to compare.
 *
 * The outcome, the person the row is written to and the key that reached
 * them, which decides whether its identity number is written, the earlier row
 * it follows, and the persons it could equally well be - sorted, because the
 * register lists them in no fixed order. Hashed, because a file can have
 * thousands of rows and the only question ever asked is whether two plans
 * agree.
 */
export function planDigest(plan: ImportPlan): string {
  const hash = createHash("sha256");
  for (const row of plan.rows) {
    hash.update(
      `${JSON.stringify([
        row.rowNumber,
        row.outcome,
        row.matchedPersonId,
        row.matchedBy,
        row.sameAsRowNumber,
        row.candidates.map((candidate) => candidate.personId).sort(),
      ])}\n`,
    );
  }
  return hash.digest("hex");
}

/** Whether a screen has asked about the preview recently enough to go on. */
function watched(watchedAt: Date | null): boolean {
  return (
    watchedAt !== null &&
    watchedAt.getTime() >= Date.now() - PREVIEW_UNWATCHED_MS
  );
}

/** The session, while this preview is still the one it is planning. */
function current(
  sessionId: string,
  previewId: string,
): Prisma.ImportSessionWhereInput {
  return {
    id: sessionId,
    status: "MAPPING",
    previewId,
    previewStatus: "PLANNING",
  };
}

function toPreviewRow(row: PlannedRow): ImportPreviewRow {
  const { person, movedInStated: _movedInStated, ...rest } = row;
  return {
    ...rest,
    person: {
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      phone: person.phone,
      hasPersonalIdentityNumber: person.personalIdentityNumber !== null,
      postalStreet: person.postalStreet,
      postalCode: person.postalCode,
      postalCity: person.postalCity,
    },
  };
}
