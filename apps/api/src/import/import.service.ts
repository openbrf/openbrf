import { randomUUID } from "node:crypto";

import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { type ActorContext, auditActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import type {
  ImportPreviewStatus,
  ImportProposalOutcome,
} from "../generated/prisma/enums";
import { I18nService } from "../i18n/i18n.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { writeCsv } from "./csv";
import {
  finishImport,
  ImportApplyService,
  IMPORT_CHUNK_TRANSACTION_MS,
  readDecisions,
  stopImport,
} from "./import-apply.service";
import {
  type ImportField,
  type ImportMapping,
  suggestMapping,
} from "./import-columns";
import { ImportError } from "./import-errors";
import { maskedSample, readImportFile, SAMPLE_ROWS } from "./import-file";
import {
  ImportProposalService,
  proposalEnded,
} from "./import-proposal.service";
import { lockImportApply } from "./import-lock";
import { readImportRevision } from "./import-revision";
import {
  findUnpreviewed,
  type ImportDecisions,
  type ImportRole,
  readPreviewedCandidates,
  readPreviewedTargets,
} from "./import-plan";
import { assertMappingApplies } from "./import-planner.service";
import {
  IMPORT_PREVIEW_SELECT,
  ImportPreviewService,
  type ImportPreviewRun,
} from "./import-preview.service";
import {
  IMPORT_RUN_SELECT,
  type ImportRunView,
  RUNNING_IMPORT_STATUSES,
  toRunView,
} from "./import-run";
import {
  contentDigestOf,
  type ImportSourceView,
  saveSourceMapping,
  savedMapping,
  sourceKeyOf,
} from "./import-source";

/**
 * Importing a member list.
 *
 * Four steps, deliberately: upload, map the columns, look at what would happen,
 * apply. The third one is the reason for the other three. An import writes into
 * the statutory member register, which the database will not let anyone update
 * or delete, so the board has to be able to see every row that would be created
 * and every match that would be made before any of it happens.
 *
 * The uploaded rows are held between the steps rather than re-uploaded, because
 * a preview taken from a different copy of the file than the apply is a preview
 * that can be wrong. They are held encrypted: a cooperative's member list is
 * the densest personal data this instance ever handles.
 *
 * The upload and the mapping answer inside the request. The preview and the
 * apply do not: matching a member list against a register that holds identity
 * numbers is an Argon2id hash per row, and writing the register is that and
 * more, so both are background jobs (ADR 0002) that this service records and
 * queues. The screen polls them. What the board previewed is recorded on the
 * session, and the apply runs that - so what is written is what was looked at.
 * The request that starts it neither decrypts a row nor computes an index: the
 * board's decisions are planned by the preview, which the screen asks for again
 * with them.
 */

/** How long an upload stays usable before it has to be made again. */
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * How long the mapping and the applied digest of a source are kept after an
 * import last used them: long enough for a board that imports the manager's
 * list once a year, and misses a year, to find them again.
 */
const SOURCE_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** How often expired uploads and unused sources are deleted. */
const PURGE_CRON = "23 3 * * *";

/** Queue the scheduled purge of expired uploads and unused sources runs on. */
export const IMPORT_PURGE_QUEUE = "import-session-purge";

/**
 * How long abandoning an import may take. Longer than a chunk's transaction,
 * because a chunk in flight holds the session row the abandon has to update.
 */
const ABANDON_TIMEOUT_MS = IMPORT_CHUNK_TRANSACTION_MS + 10_000;

export interface ImportSessionView {
  sessionId: string;
  fileName: string;
  format: "CSV" | "XLSX";
  columns: string[];
  rowCount: number;
  /** The first rows, so a column can be recognised by what is in it. */
  sample: string[][];
  /** The guess from the column titles. */
  suggestedMapping: (ImportField | null)[];
  /**
   * The mapping the last import from a file with these column titles was
   * started with, offered in place of the guess. Null the first time.
   */
  savedMapping: ImportSourceView | null;
  expiresAt: string;
}

/**
 * The answer to an upload of the rows the register was last imported from,
 * for a file with the same column titles. Nothing is stored for it: there is
 * nothing to review, and the board uploads it again with `reviewUnchanged` to
 * review it all the same.
 */
export interface ImportUnchangedView {
  unchanged: true;
  fileName: string;
  appliedAt: string;
}

export type ImportUploadView =
  ({ unchanged: false } & ImportSessionView) | ImportUnchangedView;

export interface ImportMappingInput {
  mapping: ImportMapping;
  defaultRole: ImportRole | null;
  defaultMovedInOn: string | null;
}

export interface ImportPreviewInput extends ImportMappingInput {
  /** What the board has decided so far, for the rows after those to see. */
  decisions: ImportDecisions;
}

@Injectable()
export class ImportService implements OnModuleInit {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly i18n: I18nService,
    private readonly jobs: JobQueueService,
    private readonly previews: ImportPreviewService,
    private readonly applies: ImportApplyService,
    private readonly audit: AuditLogService,
    private readonly proposals: ImportProposalService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the purge themselves, so a worker does not run
      // against the sessions a test is in the middle of using.
      return;
    }
    await this.startPurgeWorker();
  }

  /** Registers the purge. Public so an integration test can drive the job. */
  async startPurgeWorker(): Promise<void> {
    await this.jobs.work(IMPORT_PURGE_QUEUE, async () => {
      // Each runs whether or not the other failed, so an error in one does not
      // keep the other's rows for another day. The job still fails with it.
      const outcomes = await Promise.allSettled([
        this.purgeExpiredSessions(),
        this.purgeUnusedSources(),
        this.proposals.purge(),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          throw outcome.reason;
        }
      }
    });
    await this.jobs.schedule(IMPORT_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Deletes uploads that can no longer be used.
   *
   * Refusing an expired session is not enough on its own: the row still holds
   * the uploaded member list, encrypted but complete, personal identity numbers
   * included. An upload nobody can act on any more is data kept for no purpose,
   * so it goes rather than sitting there until someone notices.
   *
   * An apply that is still running is left alone however old its upload is.
   * Deleting the rows underneath a job would stop the import halfway through a
   * register that cannot be corrected by editing.
   *
   * An import proposal is not an upload, and its record outlives its expiry:
   * `ImportProposalService.purge` ends and deletes those.
   */
  async purgeExpiredSessions(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.importSession.deleteMany({
      where: {
        proposedByPluginId: null,
        expiresAt: { lt: now },
        status: { notIn: [...RUNNING_IMPORT_STATUSES] },
      },
    });
    if (count > 0) {
      this.logger.log(`Purged ${String(count)} expired import sessions`);
    }
    return count;
  }

  /**
   * Deletes the sources no import has used for two years.
   *
   * A source is used when an import from it starts, which saves its mapping,
   * and when one finishes, which records the file. Losing one costs a board
   * that comes back to it the mapping, offered as a guess instead, and the
   * answer that a file is unchanged, which becomes a review.
   */
  async purgeUnusedSources(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - SOURCE_RETENTION_MS);
    const { count } = await this.prisma.importSource.deleteMany({
      where: {
        mappingSavedAt: { lt: cutoff },
        OR: [{ appliedAt: null }, { appliedAt: { lt: cutoff } }],
      },
    });
    if (count > 0) {
      this.logger.log(`Purged ${String(count)} unused import sources`);
    }
    return count;
  }

  /**
   * Parses an uploaded file and holds it for the mapping step.
   *
   * A file holding exactly the rows last applied from its source is answered as
   * unchanged and not held, unless the board asks to review it anyway: the
   * register may have been edited since, and the board is the one who knows.
   */
  async upload(input: {
    fileName: string;
    /** The file, base64 encoded. */
    content: string;
    actorPersonId: string;
    /** Review the file even if it is the one last applied. */
    reviewUnchanged?: boolean;
  }): Promise<ImportUploadView> {
    const { format, rows, header, data, sourceRows } = await readImportFile(
      Buffer.from(input.content, "base64"),
      input.fileName,
    );

    const sourceKey = await sourceKeyOf(this.encryption, header);
    const contentDigest = await contentDigestOf(this.encryption, rows);
    const source = await this.prisma.importSource.findUnique({
      where: { key: sourceKey },
      select: {
        mapping: true,
        defaultRole: true,
        defaultMovedInOn: true,
        mappingSavedAt: true,
        appliedDigest: true,
        appliedAt: true,
      },
    });
    if (
      input.reviewUnchanged !== true &&
      source !== null &&
      source.appliedAt !== null &&
      source.appliedDigest === contentDigest
    ) {
      this.logger.log(
        `Import upload of ${String(data.length)} rows from ${format}: unchanged since the last import`,
      );
      return {
        unchanged: true,
        fileName: input.fileName,
        appliedAt: source.appliedAt.toISOString(),
      };
    }

    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
    const encrypted = await this.encryption.encrypt(
      "importSession.rows",
      JSON.stringify(data),
    );

    const session = await this.prisma.importSession.create({
      data: {
        fileName: input.fileName,
        format,
        columns: header,
        rowsCipher: encrypted.cipher,
        rowCount: data.length,
        sourceRows,
        sourceKey,
        contentDigest,
        createdById: input.actorPersonId,
        expiresAt,
      },
      select: { id: true },
    });

    this.logger.log(
      `Import session ${session.id}: ${String(data.length)} rows from ${format}`,
    );

    const suggestedMapping = suggestMapping(header);
    const saved = savedMapping(source, header.length);
    return {
      unchanged: false,
      sessionId: session.id,
      fileName: input.fileName,
      format,
      columns: header,
      rowCount: data.length,
      sample: maskedSample(
        data.slice(0, SAMPLE_ROWS),
        suggestedMapping,
        saved?.mapping ?? [],
      ),
      suggestedMapping,
      savedMapping: saved,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Asks for the preview of a mapping: what it would do, without doing any of
   * it.
   *
   * The mapping is checked here, because a mapping problem is the board's to
   * fix on the screen it is on. Then it is recorded with the defaults, and the
   * job that plans it is queued in the same transaction. Asking again replaces
   * the preview: the token of the one before is withdrawn at once, so a screen
   * holding it cannot apply a mapping that is no longer the session's, and the
   * job planning it stops at its next progress report.
   *
   * The job records what it showed - the plan, which rows it could not resolve
   * to one person, and a digest of where it wrote every row - and issues
   * the token when it finishes. The apply reads that back rather than being
   * told again, so the import that runs is the one the board looked at.
   *
   * The decisions the board has made so far are recorded for the job to plan
   * with, because a person chosen for a row, or created by it, is one the rows
   * after it can match or contradict. The rows that need a decision are then
   * the ones that need it given those decisions.
   */
  async preview(
    sessionId: string,
    input: ImportPreviewInput,
  ): Promise<ImportPreviewRun> {
    const session = await this.loadForPreview(sessionId);
    assertMappingApplies({
      mapping: input.mapping,
      columnCount: session.columns.length,
      defaultRole: input.defaultRole,
      defaultMovedInOn: input.defaultMovedInOn,
    });

    // Before the transaction, as for the apply: creating a queue is the queue
    // backend's own work on its own connection.
    await this.previews.ensureQueues();

    const previewId = randomUUID();
    const recorded = await this.prisma.$transaction(async (tx) => {
      // Conditional on the status, so a preview cannot be recorded on a session
      // an apply has claimed in the meantime.
      const { count } = await tx.importSession.updateMany({
        where: { id: sessionId, status: "MAPPING", proposalOutcome: null },
        data: {
          mapping: input.mapping.map((field) => field ?? ""),
          defaultRole: input.defaultRole,
          defaultMovedInOn: input.defaultMovedInOn,
          previewId,
          previewStatus: "PLANNING",
          previewRowsDone: 0,
          previewFailureReason: null,
          previewWatchedAt: new Date(),
          previewCipher: null,
          previewToken: null,
          previewedAt: null,
          ambiguousRows: Prisma.DbNull,
          previewedTargets: Prisma.DbNull,
          previewedRevision: null,
          // Planned with by the job. The apply records its own when it claims
          // the session.
          decisions:
            Object.keys(input.decisions).length === 0
              ? Prisma.DbNull
              : (input.decisions as Prisma.InputJsonValue),
        },
      });
      if (count === 0) {
        return false;
      }
      await this.previews.enqueueInTransaction(tx, sessionId, previewId);
      return true;
    });
    if (!recorded) {
      // Started, or a proposal that ended, since it was read.
      await this.loadForPreview(sessionId);
      throw new ImportError(
        "That import has already been started.",
        "session-already-applied",
      );
    }

    this.logger.log(`Import session ${sessionId}: preview queued`);
    return {
      sessionId,
      previewId,
      status: "PLANNING",
      rowsDone: 0,
      rowsTotal: session.rowCount,
      failureReason: null,
      preview: null,
    };
  }

  /**
   * How far the preview has got, and the preview once it is ready.
   *
   * Asked for by the id the request answered with. A preview replaced since -
   * another tab, another board member - is refused as replaced rather than
   * answered with the other one's, so the screen goes back to its mapping
   * instead of showing a plan for a mapping it does not hold.
   *
   * Asking is also what keeps the job going: a preview nobody asks about is
   * one nobody will see, and the job stops planning it.
   */
  async previewRun(
    sessionId: string,
    previewId: string,
  ): Promise<ImportPreviewRun> {
    const session = requireMapping(
      await this.prisma.importSession.findUnique({
        where: { id: sessionId },
        select: {
          ...IMPORT_PREVIEW_SELECT,
          status: true,
          expiresAt: true,
          proposalOutcome: true,
        },
      }),
    );
    if (session.previewId !== previewId || session.previewStatus === null) {
      throw previewReplaced();
    }
    if (session.previewStatus === "PLANNING") {
      await this.prisma.importSession.updateMany({
        where: { id: sessionId, previewId, previewStatus: "PLANNING" },
        data: { previewWatchedAt: new Date() },
      });
    }
    return this.previews.view(sessionId, session);
  }

  /**
   * Stops a preview the screen has stopped waiting for: the board picked
   * another file, or left the page.
   *
   * Without this the job would go on planning it until it noticed nobody was
   * asking, and one worker plans every preview on the instance, so everybody
   * else's would wait behind it. Answered the same whatever the preview's state:
   * one already finished, replaced or stopped has nothing left to stop.
   */
  async cancelPreview(sessionId: string, previewId: string): Promise<void> {
    await this.previews.cancel(sessionId, previewId);
  }

  /**
   * Starts the apply.
   *
   * Every ambiguous row needs a decision, and the rows that need one are the
   * ones the preview found: applying with one unanswered would mean the import
   * quietly decided something the preview said it could not. What those
   * decisions write can make further rows need one, so they have to be the
   * decisions the preview was planned with (`checkDecisions`).
   *
   * Then the session is claimed and the job is queued, and that claim is the
   * whole concurrency guard. Two applies of one session overlap easily - a
   * double-clicked button is enough - and two jobs would each create the person,
   * the residency and the statutory ENTRY row. member_register_entry refuses
   * UPDATE and DELETE, so a member listed twice could only be answered with a
   * further correction entry. The conditional update takes the row lock, so the
   * second request finds nothing to claim and nothing is queued for it.
   *
   * One import runs at a time across the whole instance, not just one per
   * session. Two files applied side by side would each plan against a register
   * the other is in the middle of writing, so a person listed in both is created
   * twice with an ENTRY row each - the same uncorrectable duplicate, reached
   * from two sessions instead of one. The screen hides the upload while an
   * import runs, but a tab opened earlier, a second board member or a direct
   * call does not see that, so the refusal is made here, under the import
   * lock. A running session normally ends as APPLIED, or as FAILED on a
   * refusal or through the dead letter once its retries run out. Until then
   * every other apply is refused: for as long as a hung attempt takes to time
   * out and be retried, and for a session whose job was lost, until the next
   * start re-queues it - or until an administrator abandons it (`abandon`).
   *
   * And an import that wrote to the register after this one was previewed makes
   * the preview out of date. The counts it showed may no longer hold, and a row
   * it matched to one person can match two now - which the job would find on
   * its first chunk and stop on, leaving a FAILED session that has to be
   * uploaded again. Refused instead, before anything is claimed: the session
   * stays in MAPPING, and previewing it again shows the board what the apply
   * would do now and asks again about every row that needs a decision.
   */
  async apply(
    sessionId: string,
    input: { decisions: ImportDecisions; previewToken: string },
  ): Promise<ImportRunView> {
    const session = await this.loadForApply(sessionId);
    if (session.previewStatus === null) {
      throw new ImportError(
        "That import has not been previewed.",
        "preview-required",
      );
    }
    // The decisions below are checked against the rows this preview found, so
    // they have to be the decisions made on this preview. A screen holding an
    // older one is told, rather than having its answers applied to a mapping
    // somebody else chose since. A preview still being planned, or one that
    // stopped, has issued no token at all - and the token this request carries
    // came from a preview that was ready, so another has been asked for since
    // and "replaced" is what happened. It is also the answer that sends the
    // screen back to its mapping.
    if (
      session.previewToken === null ||
      session.previewToken !== input.previewToken
    ) {
      throw previewReplaced();
    }
    // Every chunk compares its rows with where the preview wrote them, and a
    // preview taken before that was recorded has nothing to compare with.
    if (readPreviewedTargets(session.previewedTargets) === null) {
      throw new ImportError(
        "That import was previewed before previews recorded where each row goes. Preview it again.",
        "preview-outdated",
      );
    }

    // Asked once before the decisions as well as under the lock. Decisions
    // refused as not previewed send the board to a preview, which would be of
    // a register another import is halfway through writing, instead of telling
    // it to wait. The lock below is still what decides.
    await refuseWhileAnotherRuns(this.prisma, sessionId);

    this.checkDecisions(session, input.decisions);

    // Before the transaction: creating a queue is the queue backend's own work
    // on its own connection and has no business inside this one.
    await this.applies.ensureQueues();

    // A refusal is thrown from inside the transaction, which rolls back and
    // rethrows it. None of the refusals has written anything by then.
    await this.prisma.$transaction(async (tx) => {
      await lockImportApply(tx);
      await refuseWhileAnotherRuns(tx, sessionId);

      // The preview read before the lock may have been replaced since, by
      // another tab, and its revision is the one that tab recorded. That is
      // the replaced preview's own refusal, not an outdated one: previewing
      // again from here would overwrite the newer preview. So the token is
      // asked first.
      const recorded = await tx.importSession.findUnique({
        where: { id: sessionId },
        select: { previewToken: true },
      });
      if (recorded !== null && recorded.previewToken !== input.previewToken) {
        throw previewReplaced();
      }

      // Under the lock and with nothing else running, so no chunk can move the
      // count between this read and the claim. The count is the one the
      // preview job read before it read the register.
      //
      // Only a chunk that wrote moves the count. An import that stopped before
      // writing, or whose rows were all skipped or in error, left the register
      // as this preview saw it, and a second preview would show the same.
      if (session.previewedRevision !== (await readImportRevision(tx))) {
        throw new ImportError(
          "Another import changed the register after this one was previewed. Preview it again.",
          "preview-outdated",
        );
      }

      // On the token as well, so a preview asked for between the read above
      // and this claim cannot have its mapping run with these decisions.
      const claim = await tx.importSession.updateMany({
        where: {
          id: sessionId,
          status: "MAPPING",
          proposalOutcome: null,
          previewStatus: "READY",
          previewToken: input.previewToken,
        },
        data: {
          status: "QUEUED",
          decidedAt: new Date(),
          decisions: input.decisions as Prisma.InputJsonValue,
          // The apply plans again from the rows; the stored preview has
          // been looked at and is not kept past the point it was for.
          previewCipher: null,
        },
      });
      if (claim.count === 0) {
        const current = await tx.importSession.findUnique({
          where: { id: sessionId },
          select: { status: true, proposalOutcome: true },
        });
        if (current !== null && current.proposalOutcome !== null) {
          // A proposal the plugin replaced or took back, or the board
          // rejected, while this board member was deciding on it.
          throw proposalEnded(current.proposalOutcome);
        }
        if (current?.status === "MAPPING") {
          // Not "preview-outdated": nothing this board member chose changed
          // the plan. Somebody else's preview replaced the one checked here,
          // and answering with a preview of this tab's own would replace
          // theirs in turn.
          throw previewReplaced();
        }
        throw new ImportError(
          "That import has already been started.",
          "session-already-applied",
        );
      }
      // The mapping the board started the import with is the one the next
      // file from the same source is offered.
      await saveSourceMapping(tx, sessionId);
      // The job is written by this transaction too, so the claim and the
      // work it claims commit together. A session left claimed with no job
      // behind it is an import that never runs and never says so.
      await this.applies.enqueueInTransaction(tx, sessionId);
    });

    this.logger.log(`Import session ${sessionId}: apply queued`);
    return this.run(sessionId);
  }

  /**
   * Ends an import that is queued or applying, without waiting for the queue.
   *
   * One import runs at a time, so a session whose job was lost, or whose
   * attempt hangs, refuses every other import until the queue gives up on it:
   * up to the next restart for the first, and the expiry times the retries for
   * the second. This is the way out an administrator takes meanwhile. The
   * session is recorded as FAILED, as the dead letter would record it but with
   * `apply-abandoned` rather than `apply-interrupted`, so the screen can say who
   * stopped it. The next apply is accepted.
   *
   * It stops the import; it undoes nothing. What the chunks before it wrote is
   * in a register that cannot be edited, and the counts on the session say how
   * much that was.
   *
   * After this returns, the abandoned session writes nothing more. Every write
   * the job makes is conditional on the session still being APPLYING, and a
   * chunk takes the session row before it writes. So the update below either
   * waits for a chunk that holds the row and lands after it, or lands first and
   * the chunk then finds nothing to claim. A job that wakes later for this
   * session - a retry, a redelivery, the re-queue at the next start - reads it
   * as FAILED and ends without having done anything.
   *
   * An import that has written every row is not abandoned, because it is not
   * running: there is nothing left to stop. The last chunk marks its import
   * applied in the commit that writes its rows, so an abandon that waited for
   * that chunk is refused. A session an earlier instance left applying with
   * every row written is marked applied here, which is all its job had left
   * to do, and the abandon is refused all the same.
   *
   * The audit entry is written in the same transaction as the change of status,
   * so neither exists without the other.
   */
  async abandon(
    sessionId: string,
    actor: ActorContext,
  ): Promise<ImportRunView> {
    const session = await this.prisma.$transaction(
      async (tx) => {
        const abandoned = await stopImport(tx, sessionId, "apply-abandoned");

        // Read after the update, under its row lock, so the cursor is the one
        // the import finally stopped at rather than one a chunk was about to
        // move.
        const after = await tx.importSession.findUnique({
          where: { id: sessionId },
          select: { ...IMPORT_RUN_SELECT, createdById: true },
        });
        if (after === null) {
          throw new ImportError("No such import.", "session-not-found");
        }
        if (!abandoned) {
          // Returned rather than thrown, because throwing would roll back
          // marking a complete import applied.
          if (await finishImport(tx, sessionId)) {
            this.logger.log(
              `Import session ${sessionId}: every row was written, marked applied`,
            );
          }
          return null;
        }

        await this.audit.record(
          {
            action: "IMPORT_ABANDONED",
            ...auditActor(actor),
            targetKind: "importSession",
            targetId: sessionId,
            // Enough to answer for the abandon once the session is purged:
            // how far the import got, whether its job had ever started it, and
            // who uploaded it.
            context: {
              rowsDone: after.rowsDone,
              rowsTotal: after.rowCount,
              startedAt: after.startedAt?.toISOString() ?? null,
              createdById: after.createdById,
            },
          },
          tx,
        );
        return after;
      },
      // Longer than the budget a chunk's own transaction has, so an abandon
      // that arrives while a chunk holds the session row waits for it to commit
      // or roll back instead of failing first. The same for getting a
      // connection: with a pool of one, the chunk holds the only one.
      { timeout: ABANDON_TIMEOUT_MS, maxWait: ABANDON_TIMEOUT_MS },
    );
    if (session === null) {
      throw new ImportError(
        "That import is not running.",
        "session-not-running",
      );
    }

    this.logger.warn(
      `Import session ${sessionId}: abandoned by an administrator`,
    );
    return toRunView(session);
  }

  /** How far the apply has got, read from the session itself. */
  async run(sessionId: string): Promise<ImportRunView> {
    const session = await this.prisma.importSession.findUnique({
      where: { id: sessionId },
      select: IMPORT_RUN_SELECT,
    });
    if (session === null) {
      throw new ImportError("No such import.", "session-not-found");
    }
    return toRunView(session);
  }

  /**
   * The import worth showing on the screen, if there is one.
   *
   * What a board member coming back to the screen needs is the import that was
   * started, whether it is still running or finished while the tab was closed.
   * An import that is still running comes first, however old its upload: it
   * is the one that locks out every other, and the screen that was just
   * refused with `another-import-running` has to show it rather than a newer
   * session that finished or failed. The purge leaves it alone, so one whose
   * job was lost stays on the screen where an administrator can abandon it.
   * Otherwise the most recent session that has left the mapping step is that
   * import, and it stays answerable for as long as the upload does - after
   * which the purge removes it and the screen offers a fresh upload again.
   */
  async activeRun(): Promise<ImportRunView | null> {
    const session =
      (await this.prisma.importSession.findFirst({
        where: { status: { in: [...RUNNING_IMPORT_STATUSES] } },
        orderBy: { createdAt: "desc" },
        select: IMPORT_RUN_SELECT,
      })) ??
      (await this.prisma.importSession.findFirst({
        where: {
          status: { not: "MAPPING" },
          expiresAt: { gt: new Date() },
          // A proposal waits fourteen days rather than one, and its record
          // is kept after that. The import a board member started from one
          // is shown for as long as an upload's would be after it ended.
          OR: [
            { proposedByPluginId: null },
            {
              finishedAt: {
                gt: new Date(Date.now() - SESSION_LIFETIME_MS),
              },
            },
          ],
        },
        orderBy: { createdAt: "desc" },
        select: IMPORT_RUN_SELECT,
      }));
    return session === null ? null : toRunView(session);
  }

  /**
   * The downloadable template.
   *
   * Column titles in the recipient's own language, because the board reading it
   * is Swedish by default and a template they have to translate before filling
   * in is a template nobody uses. The mapping step recognises both languages'
   * titles regardless of which one produced the file.
   */
  template(locale: string | null | undefined): string {
    const t = this.i18n.translatorFor(locale);
    const headers = TEMPLATE_COLUMNS.map((column) =>
      t(`import.template.column.${column}`),
    );
    const example = TEMPLATE_COLUMNS.map((column) => TEMPLATE_EXAMPLE[column]);

    return writeCsv([headers, example]);
  }

  private async loadForPreview(sessionId: string): Promise<{
    columns: string[];
    rowCount: number;
  }> {
    // The rows are not read here either: planning them is the job's work.
    const session = await this.prisma.importSession.findUnique({
      where: { id: sessionId },
      select: {
        columns: true,
        rowCount: true,
        status: true,
        expiresAt: true,
        proposalOutcome: true,
      },
    });
    return requireMapping(session);
  }

  /**
   * Refuses the import unless the board's decisions are the ones its preview
   * was planned with, and answer every row that preview asked about.
   *
   * A decision writes things the preview it answered could not know: the
   * person chosen for a row gets the row's email address and apartment, and a
   * new person gets its identity number too. A later row can contradict what
   * that wrote, or follow it instead of the person it matched, and the chunk
   * that meets it would stop the import with the chunks before it already
   * committed to a register that cannot be corrected by editing. So the file is
   * planned with the decisions before anything is claimed - by the preview job,
   * which the screen asks for again with them, and not in this request. Planned
   * here, a file whose identity numbers the register can match costs an
   * Argon2id hash a row, which is minutes for a long one, and a request held
   * open that long is closed by whatever sits in front of the API.
   *
   * What is left to check here is what the preview recorded: the rows it asked
   * about and the persons it offered for each. The register revision, checked
   * under the lock by the caller, covers what other imports wrote since. What
   * the rest of the register's writers changed is the job's to find: every
   * chunk compares its rows with where the preview wrote them, before it
   * writes.
   */
  private checkDecisions(
    session: { ambiguousRows: Prisma.JsonValue; decisions: Prisma.JsonValue },
    decisions: ImportDecisions,
  ): void {
    const unpreviewed = findUnpreviewed(
      readPreviewedCandidates(session.ambiguousRows),
      readDecisions(session.decisions),
      decisions,
    );
    if (unpreviewed === "decision-not-needed") {
      throw new ImportError(
        "A decision answers a row the preview did not ask about.",
        "preview-outdated",
      );
    }
    if (unpreviewed === "decision-not-a-candidate") {
      throw new ImportError(
        "A decision names a person that row did not match.",
        unpreviewed,
      );
    }
    if (unpreviewed === "decisions-not-previewed") {
      throw new ImportError(
        "The preview was not planned with these decisions. Preview the " +
          "import again with them.",
        unpreviewed,
      );
    }
    if (unpreviewed === "ambiguous-rows-undecided") {
      throw new ImportError(
        "Some rows match more than one person, or contradict the person " +
          "they match, and have no decision.",
        unpreviewed,
      );
    }
  }

  private async loadForApply(sessionId: string): Promise<{
    previewStatus: ImportPreviewStatus | null;
    previewToken: string | null;
    previewedRevision: number | null;
    ambiguousRows: Prisma.JsonValue;
    previewedTargets: Prisma.JsonValue;
    decisions: Prisma.JsonValue;
  }> {
    // Not the uploaded rows: the apply plans nothing, and the job reads them.
    const session = await this.prisma.importSession.findUnique({
      where: { id: sessionId },
      select: {
        previewStatus: true,
        previewToken: true,
        previewedRevision: true,
        ambiguousRows: true,
        previewedTargets: true,
        decisions: true,
        status: true,
        expiresAt: true,
        proposalOutcome: true,
      },
    });
    return requireMapping(session);
  }
}

function requireMapping<
  T extends {
    status: string;
    expiresAt: Date;
    proposalOutcome: ImportProposalOutcome | null;
  } | null,
>(session: T): NonNullable<T> {
  if (session === null) {
    throw new ImportError("No such import.", "session-not-found");
  }
  if (session.proposalOutcome !== null) {
    throw proposalEnded(session.proposalOutcome);
  }
  if (session.status !== "MAPPING") {
    throw new ImportError(
      "That import has already been started.",
      "session-already-applied",
    );
  }
  if (session.expiresAt.getTime() < Date.now()) {
    throw new ImportError("That upload has expired.", "session-expired");
  }
  return session;
}

function previewReplaced(): ImportError {
  return new ImportError(
    "The upload was previewed again since. Preview it once more and decide again.",
    "preview-replaced",
  );
}

function anotherImportRunning(): ImportError {
  return new ImportError(
    "Another import is running. Apply this one when it has finished.",
    "another-import-running",
  );
}

/**
 * Refuses while another session is queued or applying.
 *
 * Asked under the import lock to decide, and once before it to answer early.
 */
async function refuseWhileAnotherRuns(
  client: Pick<Prisma.TransactionClient, "importSession">,
  sessionId: string,
): Promise<void> {
  const running = await client.importSession.findFirst({
    where: {
      id: { not: sessionId },
      status: { in: [...RUNNING_IMPORT_STATUSES] },
    },
    select: { id: true },
  });
  if (running !== null) {
    throw anotherImportRunning();
  }
}

/** Columns of the downloadable template, in the order they are written. */
const TEMPLATE_COLUMNS = [
  "addressLabel",
  "apartmentNumber",
  "firstName",
  "lastName",
  "role",
  "email",
  "phone",
  "personalIdentityNumber",
  "postalStreet",
  "postalCode",
  "postalCity",
  "movedInOn",
  "movedOutOn",
] as const satisfies readonly ImportField[];

/**
 * One filled-in row.
 *
 * Deliberately not a real-looking person: the example goes into a file a board
 * fills in and sends around, and a plausible personal identity number in it
 * would eventually be treated as one.
 */
const TEMPLATE_EXAMPLE: Record<(typeof TEMPLATE_COLUMNS)[number], string> = {
  addressLabel: "Storgatan 12",
  apartmentNumber: "1101",
  firstName: "Anna",
  lastName: "Exempel",
  role: "medlem",
  email: "anna@exempel.se",
  phone: "070-123 45 67",
  personalIdentityNumber: "",
  postalStreet: "Storgatan 12",
  postalCode: "111 22",
  postalCity: "Stockholm",
  movedInOn: "2020-03-01",
  movedOutOn: "",
};
