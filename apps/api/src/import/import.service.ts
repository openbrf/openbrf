import { createHash } from "node:crypto";

import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { type ActorContext, auditActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { I18nService } from "../i18n/i18n.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { decodeCsv, parseCsv, writeCsv } from "./csv";
import {
  finishImport,
  ImportApplyService,
  IMPORT_CHUNK_TRANSACTION_MS,
  stopImport,
} from "./import-apply.service";
import {
  type ImportField,
  type ImportMapping,
  readMapping,
  suggestMapping,
} from "./import-columns";
import { ImportError } from "./import-errors";
import { lockImportApply } from "./import-lock";
import {
  findUndecided,
  type ImportDecisions,
  type ImportOutcome,
  type ImportPlan,
  type ImportRole,
  type PlannedRow,
} from "./import-plan";
import { ImportPlannerService } from "./import-planner.service";
import {
  IMPORT_RUN_SELECT,
  type ImportRunView,
  RUNNING_IMPORT_STATUSES,
  toRunView,
} from "./import-run";
import { MAX_IMPORT_ROWS, parseWorkbook } from "./workbook";

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
 * The first three steps answer inside the request. The fourth does not: writing
 * the register is minutes of Argon2id on a real member list, so it is a chunked
 * background job (ADR 0002) and this service only claims the session and queues
 * it. What the board previewed is recorded on the session, and the apply runs
 * that - so what is written is what was looked at. The request that starts it
 * plans the file once more when the board has made any decision, which costs
 * what a preview costs, and otherwise neither decrypts a row nor computes an
 * index.
 */

/** The largest upload accepted, decoded. A member list is far below this. */
export const MAX_UPLOAD_BYTES = 512 * 1024;

/** How long an upload stays usable before it has to be made again. */
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** How often expired uploads are deleted. */
const PURGE_CRON = "23 3 * * *";

/** Queue the scheduled purge of expired uploads runs on. */
export const IMPORT_PURGE_QUEUE = "import-session-purge";

/** Rows shown on the mapping screen so a column can be recognised by content. */
const SAMPLE_ROWS = 5;

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
  suggestedMapping: (ImportField | null)[];
  expiresAt: string;
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
  "person" | "problems"
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
  summary: Record<ImportOutcome, number>;
  rows: ImportPreviewRow[];
}

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
    private readonly planner: ImportPlannerService,
    private readonly applies: ImportApplyService,
    private readonly audit: AuditLogService,
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
      await this.purgeExpiredSessions();
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
   */
  async purgeExpiredSessions(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.importSession.deleteMany({
      where: {
        expiresAt: { lt: now },
        status: { notIn: [...RUNNING_IMPORT_STATUSES] },
      },
    });
    if (count > 0) {
      this.logger.log(`Purged ${String(count)} expired import sessions`);
    }
    return count;
  }

  /** Parses an uploaded file and holds it for the mapping step. */
  async upload(input: {
    fileName: string;
    /** The file, base64 encoded. */
    content: string;
    actorPersonId: string;
  }): Promise<ImportSessionView> {
    const bytes = Buffer.from(input.content, "base64");
    if (bytes.byteLength === 0) {
      throw new ImportError("The uploaded file is empty.", "file-empty");
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new ImportError("That file is too large.", "file-too-large");
    }

    const format = detectFormat(bytes, input.fileName);
    const rows = await this.parse(bytes, format);

    const header = rows[0];
    if (header === undefined || rows.length < 2) {
      throw new ImportError(
        "The file has no rows below its column titles.",
        "file-empty",
      );
    }
    const data = rows.slice(1);
    if (data.length > MAX_IMPORT_ROWS) {
      throw new ImportError("That file has too many rows.", "too-many-rows");
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
        createdById: input.actorPersonId,
        expiresAt,
      },
      select: { id: true },
    });

    this.logger.log(
      `Import session ${session.id}: ${String(data.length)} rows from ${format}`,
    );

    return {
      sessionId: session.id,
      fileName: input.fileName,
      format,
      columns: header,
      rowCount: data.length,
      sample: data.slice(0, SAMPLE_ROWS),
      suggestedMapping: suggestMapping(header),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Works out what the mapping would do, without doing any of it.
   *
   * It also records what it showed: the mapping, the defaults, which rows it
   * could not resolve to one person, and a digest of what it planned for every
   * row. The apply reads that back rather than being told again, so the import
   * that runs is the one the board looked at and a row needing a decision
   * cannot be slipped past by applying a mapping nobody previewed.
   *
   * The decisions the board has made so far are planned with, because a
   * person chosen for a row, or created by it, is one the rows after it can
   * match or contradict. The rows that need a decision are then the ones that
   * need it given those decisions.
   */
  async preview(
    sessionId: string,
    input: ImportPreviewInput,
  ): Promise<ImportPreview> {
    const session = await this.loadForPreview(sessionId);

    const plan = await this.planner.plan({
      rows: await this.planner.decryptRows(session.rowsCipher),
      columnCount: session.columns.length,
      mapping: input.mapping,
      defaultRole: input.defaultRole,
      defaultMovedInOn: input.defaultMovedInOn,
      decisions: input.decisions,
      // A preview matches; it writes nothing. An identity number is therefore
      // only worth its 43.8 ms when the register holds one to match it against.
      indexEveryIdentityNumber: false,
      indexes: new Map(),
    });

    const ambiguousRows: Record<string, string[]> = {};
    for (const row of plan.rows) {
      if (row.outcome === "ambiguous") {
        ambiguousRows[String(row.rowNumber)] = row.candidates.map(
          (candidate) => candidate.personId,
        );
      }
    }

    await this.prisma.importSession.updateMany({
      where: { id: sessionId, status: "MAPPING" },
      data: {
        mapping: input.mapping.map((field) => field ?? ""),
        defaultRole: input.defaultRole,
        defaultMovedInOn: input.defaultMovedInOn,
        ambiguousRows: ambiguousRows as Prisma.InputJsonValue,
        previewDigest: planDigest(plan),
        previewedAt: new Date(),
      },
    });

    return {
      sessionId,
      summary: plan.summary,
      rows: plan.rows.map(toPreviewRow),
    };
  }

  /**
   * Starts the apply.
   *
   * Every ambiguous row needs a decision, and the rows that need one are the
   * ones the preview found: applying with one unanswered would mean the import
   * quietly decided something the preview said it could not. What those
   * decisions write can make further rows need one, which is checked too.
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
   * call does not see that, so the refusal is made here. A running session
   * normally ends as APPLIED, or as FAILED on a refusal or through the dead
   * letter once its retries run out. Until then every other apply is refused:
   * for as long as a hung attempt takes to time out and be retried, and for a
   * session whose job was lost, until the next start re-queues it - or until
   * an administrator abandons it (`abandon`).
   */
  async apply(
    sessionId: string,
    input: { decisions: ImportDecisions },
  ): Promise<ImportRunView> {
    const session = await this.loadForApply(sessionId);
    if (session.previewedAt === null) {
      throw new ImportError(
        "That import has not been previewed.",
        "preview-required",
      );
    }

    // Asked once before the plan as well as under the lock. Planned against a
    // register another import is halfway through writing, the decisions could
    // look outdated, and the board would be sent back to a preview of that
    // half-written register instead of being told to wait. The lock below is
    // still what decides.
    await refuseWhileAnotherRuns(this.prisma, sessionId);

    await this.checkDecidedPlan(sessionId, session, input.decisions);

    // Before the transaction: creating a queue is the queue backend's own work
    // on its own connection and has no business inside this one.
    await this.applies.ensureQueues();

    // A refusal is thrown from inside the transaction, which rolls back and
    // rethrows it. None of the refusals has written anything by then.
    await this.prisma.$transaction(async (tx) => {
      await lockImportApply(tx);
      await refuseWhileAnotherRuns(tx, sessionId);

      const claim = await tx.importSession.updateMany({
        // The preview this apply was checked against. One taken meanwhile
        // may have recorded another mapping, and its rows are not the ones
        // these decisions answer.
        where: {
          id: sessionId,
          status: "MAPPING",
          previewedAt: session.previewedAt,
        },
        data: {
          status: "QUEUED",
          decisions: input.decisions as Prisma.InputJsonValue,
        },
      });
      if (claim.count === 0) {
        const current = await tx.importSession.findUnique({
          where: { id: sessionId },
          select: { status: true },
        });
        if (current?.status === "MAPPING") {
          // Not "preview-outdated": nothing this board member chose changed
          // the plan. Somebody else's preview replaced the one checked here,
          // and answering with a preview of this tab's own would replace theirs
          // in turn.
          throw new ImportError(
            "The import was previewed again while it was being started.",
            "preview-replaced",
          );
        }
        throw new ImportError(
          "That import has already been started.",
          "session-already-applied",
        );
      }
      // The job is written by this transaction too, so the claim and the work
      // it claims commit together. A session left claimed with no job behind it
      // is an import that never runs and never says so.
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
   * The most recent session that has left the mapping step is that import, and
   * it stays answerable for as long as the upload does - after which the purge
   * removes it and the screen offers a fresh upload again.
   *
   * A running import comes first, however old its upload. The purge leaves it
   * alone and it refuses every other apply until it ends, so one whose job was
   * lost has to stay on the screen where an administrator can abandon it.
   */
  async activeRun(): Promise<ImportRunView | null> {
    const session =
      (await this.prisma.importSession.findFirst({
        where: { status: { in: [...RUNNING_IMPORT_STATUSES] } },
        orderBy: { createdAt: "desc" },
        select: IMPORT_RUN_SELECT,
      })) ??
      (await this.prisma.importSession.findFirst({
        where: { status: { not: "MAPPING" }, expiresAt: { gt: new Date() } },
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

  private async parse(
    bytes: Buffer,
    format: "CSV" | "XLSX",
  ): Promise<string[][]> {
    try {
      if (format === "CSV") {
        return parseCsv(decodeCsv(bytes)).rows;
      }
      return await parseWorkbook(bytes);
    } catch {
      throw new ImportError(
        "That file could not be read as a spreadsheet.",
        "file-unreadable",
      );
    }
  }

  private async loadForPreview(sessionId: string): Promise<{
    columns: string[];
    rowsCipher: string;
  }> {
    const session = await this.prisma.importSession.findUnique({
      where: { id: sessionId },
      select: {
        columns: true,
        rowsCipher: true,
        status: true,
        expiresAt: true,
      },
    });
    return requireMapping(session);
  }

  /**
   * Plans the whole file again with the board's decisions, and refuses the
   * import if that plan is not the one the board looked at.
   *
   * A decision writes things the preview it answered could not know: the
   * person chosen for a row gets the row's email address and apartment, and a
   * new person gets its identity number too. A later row can contradict what
   * that wrote, and the chunk that meets it would stop the import with the
   * chunks before it already committed to a register that cannot be corrected
   * by editing. Found here, the import is refused before anything is written,
   * and the screen previews again with the decisions so the board sees why.
   *
   * The same goes for a row the preview showed as needing a decision that no
   * longer does, or that now matches other people: its decision would be
   * dropped, or name somebody the row no longer offers, without anyone seeing
   * that. A decision for a row that needs none is refused for the same reason.
   * And for any other row the decisions write differently from the
   * preview - a row shown as an update of the person an earlier decision chose
   * becomes a new person when that decision is changed to a skip - which is
   * why every row is compared, through the preview's digest.
   *
   * The preview may itself have been planned with decisions, so even a skip
   * can change what the rows after it match: skipping a row the preview had
   * written to a person takes that write away again. Only an apply with no
   * decisions at all plans exactly what was previewed, and is not planned
   * again: it is refused if the preview asked about any row, and otherwise
   * neither decrypts a row nor computes an index. With decisions it costs what
   * a preview costs, and indexes an identity number only when the register
   * holds one to match it against.
   */
  private async checkDecidedPlan(
    sessionId: string,
    session: {
      columns: string[];
      mapping: string[];
      defaultRole: ImportRole | null;
      defaultMovedInOn: string | null;
      ambiguousRows: Prisma.JsonValue;
      previewDigest: string | null;
    },
    decisions: ImportDecisions,
  ): Promise<void> {
    const previewed = readAmbiguousRows(session.ambiguousRows);
    if (Object.keys(decisions).length === 0) {
      if (Object.keys(previewed).length > 0) {
        throw new ImportError(
          "Some rows match more than one person, or contradict the person " +
            "they match, and have no decision.",
          "ambiguous-rows-undecided",
        );
      }
      return;
    }

    const plan = await this.planner.plan({
      rows: await this.loadRows(sessionId),
      columnCount: session.columns.length,
      mapping: readMapping(session.mapping),
      defaultRole: session.defaultRole,
      defaultMovedInOn: session.defaultMovedInOn,
      decisions,
      indexEveryIdentityNumber: false,
      indexes: new Map(),
    });

    if (
      plan.rows.some((row) => {
        const candidates = previewed[String(row.rowNumber)];
        return (
          candidates !== undefined &&
          (row.outcome !== "ambiguous" ||
            !samePeople(
              candidates,
              row.candidates.map((candidate) => candidate.personId),
            ))
        );
      })
    ) {
      throw new ImportError(
        "Given these decisions, a row the preview showed as needing a " +
          "decision no longer does, or matches other people.",
        "preview-outdated",
      );
    }

    // A decision is an answer to a row that asks for one, and to nothing else.
    // One kept for a row that needs none would be carried into the job, where
    // a register that changed between chunks could make that row need it, and
    // the worker would then write what nobody was shown.
    const decidable = new Set(
      plan.rows
        .filter((row) => row.outcome === "ambiguous")
        .map((row) => String(row.rowNumber)),
    );
    if (Object.keys(decisions).some((rowNumber) => !decidable.has(rowNumber))) {
      throw new ImportError(
        "Given these decisions, a decision answers a row that does not need one.",
        "preview-outdated",
      );
    }

    const undecided = findUndecided(plan, decisions);
    if (undecided === "ambiguous-rows-undecided") {
      throw new ImportError(
        "Given these decisions, more rows match more than one person or " +
          "contradict the person they match, and have no decision.",
        undecided,
      );
    }
    if (undecided === "decision-not-a-candidate") {
      throw new ImportError(
        "A decision names a person that row did not match.",
        undecided,
      );
    }

    // A session previewed before the digest was recorded has none, and is
    // previewed again rather than trusted.
    if (planDigest(plan) !== session.previewDigest) {
      throw new ImportError(
        "Given these decisions, a row would be written differently from " +
          "the preview.",
        "preview-outdated",
      );
    }
  }

  private async loadForApply(sessionId: string): Promise<{
    columns: string[];
    mapping: string[];
    defaultRole: ImportRole | null;
    defaultMovedInOn: string | null;
    previewedAt: Date | null;
    ambiguousRows: Prisma.JsonValue;
    previewDigest: string | null;
  }> {
    // Not the uploaded rows: they are read by loadRows, and only when the
    // board has made decisions to plan them with.
    const session = await this.prisma.importSession.findUnique({
      where: { id: sessionId },
      select: {
        columns: true,
        mapping: true,
        defaultRole: true,
        defaultMovedInOn: true,
        previewedAt: true,
        ambiguousRows: true,
        previewDigest: true,
        status: true,
        expiresAt: true,
      },
    });
    return requireMapping(session);
  }

  /**
   * The uploaded rows, decrypted. Read on their own because they are the
   * whole member list, and an apply only needs them when it plans again.
   */
  private async loadRows(sessionId: string): Promise<string[][]> {
    const session = await this.prisma.importSession.findUnique({
      where: { id: sessionId },
      select: { rowsCipher: true, status: true, expiresAt: true },
    });
    return this.planner.decryptRows(requireMapping(session).rowsCipher);
  }
}

/** An upload still waiting for its import, or the reason it is not one. */
function requireMapping<T extends { status: string; expiresAt: Date } | null>(
  session: T,
): NonNullable<T> {
  if (session === null) {
    throw new ImportError("No such import.", "session-not-found");
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
    throw new ImportError(
      "Another import is running. Apply this one when it has finished.",
      "another-import-running",
    );
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
function planDigest(plan: ImportPlan): string {
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

/** Whether two lists of person ids name the same people. */
function samePeople(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((personId) => b.includes(personId));
}

/** The rows the preview could not resolve, read back from the session. */
function readAmbiguousRows(value: unknown): Record<string, string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const rows: Record<string, string[]> = {};
  for (const [rowNumber, candidates] of Object.entries(value)) {
    if (Array.isArray(candidates)) {
      rows[rowNumber] = candidates.filter(
        (candidate): candidate is string => typeof candidate === "string",
      );
    }
  }
  return rows;
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

/**
 * Which parser reads the bytes.
 *
 * The content decides, not the file name: an xlsx renamed to .csv is still a
 * zip archive, and reading it as text would produce one column of mojibake
 * rather than an error the board can act on.
 */
function detectFormat(bytes: Buffer, fileName: string): "CSV" | "XLSX" {
  // Every xlsx is a zip archive, and every zip starts "PK".
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    return "XLSX";
  }
  return fileName.toLowerCase().endsWith(".xlsx") ? "XLSX" : "CSV";
}

function toPreviewRow(row: PlannedRow): ImportPreviewRow {
  const { person, ...rest } = row;
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
