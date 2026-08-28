import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { I18nService } from "../i18n/i18n.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { parseCsv, writeCsv } from "./csv";
import {
  type ImportDecisions,
  ImportApplyService,
} from "./import-apply.service";
import {
  type ImportField,
  type ImportMapping,
  suggestMapping,
} from "./import-columns";
import { ImportError } from "./import-errors";
import type { ImportOutcome, ImportRole, PlannedRow } from "./import-plan";
import { ImportPlannerService } from "./import-planner.service";
import { IMPORT_RUN_SELECT, type ImportRunView, toRunView } from "./import-run";
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
 * that - so what is written is what was looked at, and the request that starts
 * it neither decrypts a row nor computes an index.
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
        status: { notIn: ["QUEUED", "APPLYING"] },
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
   * It also records what it showed: the mapping, the defaults, and which rows it
   * could not resolve to one person. The apply reads that back rather than being
   * told again, so the import that runs is the one the board looked at and a row
   * needing a decision cannot be slipped past by applying a mapping nobody
   * previewed.
   */
  async preview(
    sessionId: string,
    input: ImportMappingInput,
  ): Promise<ImportPreview> {
    const session = await this.loadForPreview(sessionId);

    const plan = await this.planner.plan({
      rows: await this.planner.decryptRows(session.rowsCipher),
      columnCount: session.columns.length,
      mapping: input.mapping,
      defaultRole: input.defaultRole,
      defaultMovedInOn: input.defaultMovedInOn,
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
   * quietly decided something the preview said it could not.
   *
   * Then the session is claimed and the job is queued, and that claim is the
   * whole concurrency guard. Two applies of one session overlap easily - a
   * double-clicked button is enough - and two jobs would each create the person,
   * the residency and the statutory ENTRY row. member_register_entry refuses
   * UPDATE and DELETE, so a member listed twice could only be answered with a
   * further correction entry. The conditional update takes the row lock, so the
   * second request finds nothing to claim and nothing is queued for it.
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

    for (const [rowNumber, candidates] of Object.entries(
      readAmbiguousRows(session.ambiguousRows),
    )) {
      const decision = input.decisions[rowNumber];
      if (decision === undefined) {
        throw new ImportError(
          "Some rows matched more than one person and have no decision.",
          "ambiguous-rows-undecided",
        );
      }
      if (
        decision.action === "use-person" &&
        !candidates.includes(decision.personId)
      ) {
        throw new ImportError(
          "A decision names a person that row did not match.",
          "decision-not-a-candidate",
        );
      }
    }

    // Before the transaction: creating a queue is the queue backend's own work
    // on its own connection and has no business inside this one.
    await this.applies.ensureQueues();

    const claimed = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.importSession.updateMany({
        where: { id: sessionId, status: "MAPPING" },
        data: {
          status: "QUEUED",
          decisions: input.decisions as Prisma.InputJsonValue,
        },
      });
      if (claim.count === 0) {
        return false;
      }
      // The job is written by this transaction too, so the claim and the work
      // it claims commit together. A session left claimed with no job behind it
      // is an import that never runs and never says so.
      await this.applies.enqueueInTransaction(tx, sessionId);
      return true;
    });
    if (!claimed) {
      throw new ImportError(
        "That import has already been started.",
        "session-already-applied",
      );
    }

    this.logger.log(`Import session ${sessionId}: apply queued`);
    return this.run(sessionId);
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
   */
  async activeRun(): Promise<ImportRunView | null> {
    const session = await this.prisma.importSession.findFirst({
      where: { status: { not: "MAPPING" }, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: IMPORT_RUN_SELECT,
    });
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
        return parseCsv(bytes.toString("utf8")).rows;
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

  private async loadForApply(sessionId: string): Promise<{
    previewedAt: Date | null;
    ambiguousRows: Prisma.JsonValue;
  }> {
    // The uploaded rows are deliberately not read here. Starting an import
    // decrypts nothing and indexes nothing: that is the job's work.
    const session = await this.prisma.importSession.findUnique({
      where: { id: sessionId },
      select: {
        previewedAt: true,
        ambiguousRows: true,
        status: true,
        expiresAt: true,
      },
    });
    return requireMapping(session);
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
