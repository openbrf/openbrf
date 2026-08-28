import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { normalizePersonalIdentityNumber } from "../crypto/personal-data";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import { I18nService } from "../i18n/i18n.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { parseCsv, writeCsv } from "./csv";
import {
  type ImportField,
  type ImportMapping,
  suggestMapping,
  validateMapping,
} from "./import-columns";
import {
  apartmentNameKey,
  hasIndexableIdentityNumber,
  type ImportOutcome,
  type ImportPlan,
  type ImportRole,
  planImport,
  type PlannedRow,
  type PreparedRow,
  readRow,
  type RegisterSnapshot,
} from "./import-plan";
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
 */

export type ImportErrorReason =
  | "session-not-found"
  | "session-expired"
  | "session-already-applied"
  | "file-empty"
  | "file-too-large"
  | "file-unreadable"
  | "too-many-rows"
  | "too-many-identity-numbers"
  | "mapping-invalid"
  | "ambiguous-rows-undecided"
  | "decision-not-a-candidate";

export class ImportError extends DomainError {
  override readonly status: number;
  override readonly reason: ImportErrorReason;

  constructor(message: string, reason: ImportErrorReason) {
    super(message);
    this.reason = reason;
    this.status =
      reason === "session-not-found"
        ? 404
        : reason === "session-expired" || reason === "session-already-applied"
          ? 409
          : 400;
  }
}

/**
 * Blind indexes computed during one request.
 *
 * Keyed by the normalized personal identity number rather than by a hash of
 * it. A hash would look like a protection it is not: the value space of a
 * personal identity number is small enough to reverse by brute force, and the
 * uploaded rows are decrypted in this same process for the length of the
 * request anyway. What keeps the exposure bounded is the lifetime - the map is
 * created per request and is gone when it returns, so nothing derived from an
 * identity number outlives the call that needed it.
 *
 * It exists because the apply path needs each index twice: once to match the
 * row against the register, once to write the person. At 43.8 ms a value that
 * is the difference between one pass and two.
 */
type IdentityIndexCache = Map<string, string>;

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
 * How many personal identity numbers one import may index.
 *
 * The index for a personal identity number is deliberately expensive - 43.8 ms
 * per value, because the value space is small enough to sweep offline and a
 * cheap index would be reversible if the database leaked (ADR 0002). Nothing
 * else in an import comes close: an email index costs 0.07 ms.
 *
 * The cost is therefore set by how many identity numbers the file carries, not
 * by how many rows it has, and this is the cap on the expensive half alone. At
 * this ceiling a pass spends about 22 seconds in Argon2id, which a request can
 * finish; a file with no identity number column keeps the full row allowance.
 * A board past the ceiling has two ways through that need nobody's help: leave
 * the identity number column unmapped, or split the file. ADR 0002 records the
 * chunked job with progress reporting as the answer for larger files, and this
 * refusal is what keeps a request from being the wrong place to find that out.
 */
export const MAX_INDEXED_IDENTITY_NUMBERS = 500;

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

export type ImportDecision =
  | { action: "use-person"; personId: string }
  | { action: "create" }
  | { action: "skip" };

export interface ImportApplyResult {
  personsCreated: number;
  personsUpdated: number;
  residenciesCreated: number;
  memberRegisterEntriesCreated: number;
  skipped: number;
  errors: number;
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
   */
  async purgeExpiredSessions(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.importSession.deleteMany({
      where: { expiresAt: { lt: now } },
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

  /** Works out what the mapping would do, without doing any of it. */
  async preview(
    sessionId: string,
    input: ImportMappingInput,
  ): Promise<ImportPreview> {
    const session = await this.loadSession(sessionId);
    const plan = await this.plan(session, input, new Map());

    return {
      sessionId,
      summary: plan.summary,
      rows: plan.rows.map(toPreviewRow),
    };
  }

  /**
   * Applies the mapping.
   *
   * The plan is computed again rather than taken from the preview, so the
   * import acts on the register as it stands now. Between a board previewing an
   * import and pressing apply, someone else may have added the very person the
   * preview said would be created.
   *
   * Every ambiguous row needs a decision. Applying with one unanswered would
   * mean the import quietly decided something the preview said it could not.
   */
  async apply(
    sessionId: string,
    input: ImportMappingInput & {
      decisions: Record<string, ImportDecision>;
    },
  ): Promise<ImportApplyResult> {
    const session = await this.loadSession(sessionId);
    const indexes: IdentityIndexCache = new Map();
    const plan = await this.plan(session, input, indexes);

    for (const row of plan.rows) {
      if (row.outcome !== "ambiguous") {
        continue;
      }
      const decision = input.decisions[String(row.rowNumber)];
      if (decision === undefined) {
        throw new ImportError(
          "Some rows matched more than one person and have no decision.",
          "ambiguous-rows-undecided",
        );
      }
      if (
        decision.action === "use-person" &&
        !row.candidates.some(
          (candidate) => candidate.personId === decision.personId,
        )
      ) {
        throw new ImportError(
          "A decision names a person that row did not match.",
          "decision-not-a-candidate",
        );
      }
    }

    // Every value that has to be encrypted is encrypted before the transaction
    // opens. The index for a personal identity number costs tens of
    // milliseconds by design, and two hundred of them inside a transaction
    // would hold it open long past any sensible timeout.
    const encrypted = await this.encryptRows(
      plan.rows,
      input.decisions,
      indexes,
    );

    const result = await this.prisma.$transaction(
      async (tx) => {
        // The session is claimed inside the transaction that writes, not after
        // it. Two applies of one session overlap easily - a double-clicked
        // button is enough - and both would pass loadSession, both would run
        // write, and both would create the person, the residency and the
        // statutory ENTRY row. member_register_entry refuses UPDATE and
        // DELETE, so a member listed twice could only be answered with a
        // further correction entry. The conditional update takes the row lock,
        // so the second request finds nothing to claim and writes nothing.
        const claimed = await tx.importSession.updateMany({
          where: { id: sessionId, status: "MAPPING" },
          data: { status: "APPLIED", appliedAt: new Date() },
        });
        if (claimed.count === 0) {
          throw new ImportError(
            "That import has already been applied.",
            "session-already-applied",
          );
        }
        return this.write(tx, plan, input.decisions, encrypted);
      },
      { timeout: 120_000, maxWait: 20_000 },
    );

    this.logger.log(
      `Import session ${sessionId} applied: ${String(result.personsCreated)} created, ` +
        `${String(result.personsUpdated)} updated`,
    );
    return result;
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

  private async loadSession(sessionId: string): Promise<{
    id: string;
    columns: string[];
    rowsCipher: string;
  }> {
    const session = await this.prisma.importSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        columns: true,
        rowsCipher: true,
        status: true,
        expiresAt: true,
      },
    });
    if (session === null) {
      throw new ImportError("No such import.", "session-not-found");
    }
    if (session.status === "APPLIED") {
      throw new ImportError(
        "That import has already been applied.",
        "session-already-applied",
      );
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw new ImportError("That upload has expired.", "session-expired");
    }
    return session;
  }

  private async plan(
    session: { id: string; columns: string[]; rowsCipher: string },
    input: ImportMappingInput,
    indexes: IdentityIndexCache,
  ): Promise<ImportPlan> {
    const mappingProblems = validateMapping({
      mapping: input.mapping,
      columnCount: session.columns.length,
      defaultRole: input.defaultRole,
      defaultMovedInOn: input.defaultMovedInOn,
    });
    if (mappingProblems.length > 0) {
      throw new ImportError(
        `The mapping cannot be applied: ${mappingProblems.join(", ")}.`,
        "mapping-invalid",
      );
    }

    const rows = JSON.parse(
      await this.encryption.decrypt("importSession.rows", session.rowsCipher),
    ) as string[][];

    const rowValues = rows.map((cells) => readRow(cells, input.mapping));
    this.checkIdentityNumberBudget(rowValues);

    const prepared: PreparedRow[] = [];
    for (const [index, values] of rowValues.entries()) {
      prepared.push({
        rowNumber: index + 1,
        values,
        identityNumberIndex: hasIndexableIdentityNumber(values)
          ? await this.identityNumberIndex(
              values.personalIdentityNumber ?? "",
              indexes,
            )
          : null,
        emailIndex:
          values.email === undefined
            ? null
            : await this.encryption.computeIndex("person.email", values.email),
      });
    }

    const snapshot = await this.snapshot();
    return planImport(prepared, snapshot, {
      defaultRole: input.defaultRole,
      defaultMovedInOn: input.defaultMovedInOn,
    });
  }

  /**
   * Refuses a mapping whose identity numbers cost more than a request has.
   *
   * Counted before any of them is indexed, and by distinct value, because the
   * per-request cache means a number repeated across rows is paid for once. A
   * board that runs into this is told before it waits rather than after.
   */
  private checkIdentityNumberBudget(
    rowValues: readonly Partial<Record<ImportField, string>>[],
  ): void {
    const distinct = new Set<string>();
    for (const values of rowValues) {
      if (!hasIndexableIdentityNumber(values)) {
        continue;
      }
      const normalized = normalizePersonalIdentityNumber(
        values.personalIdentityNumber ?? "",
      );
      if (normalized !== null) {
        distinct.add(normalized);
      }
    }

    if (distinct.size > MAX_INDEXED_IDENTITY_NUMBERS) {
      throw new ImportError(
        `That file carries ${String(distinct.size)} personal identity numbers, ` +
          `and at most ${String(MAX_INDEXED_IDENTITY_NUMBERS)} can be imported ` +
          "at a time.",
        "too-many-identity-numbers",
      );
    }
  }

  /**
   * The register as matching needs to see it.
   *
   * Loaded whole rather than queried per row: a per-row lookup on a two hundred
   * row file is two hundred round trips, and the register of one housing
   * cooperative is small enough to hold in memory. Only the columns matching
   * needs are read - no ciphertext leaves the database here.
   */
  private async snapshot(): Promise<RegisterSnapshot> {
    const now = new Date();

    const [apartments, persons] = await Promise.all([
      this.prisma.apartment.findMany({
        select: {
          id: true,
          number: true,
          addressId: true,
          address: { select: { street: true, number: true } },
        },
      }),
      this.prisma.person.findMany({
        select: {
          id: true,
          firstName: true,
          lastName: true,
          emailIndex: true,
          personalIdentityNumberIndex: true,
          residencies: {
            where: { OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }] },
            select: { apartmentId: true },
          },
        },
      }),
    ]);

    const personsByIdentityNumber = new Map<string, string[]>();
    const personsByEmail = new Map<string, string[]>();
    const personsByApartmentAndName = new Map<string, string[]>();
    const personNames = new Map<string, string>();

    for (const person of persons) {
      personNames.set(
        person.id,
        `${person.firstName} ${person.lastName}`.trim(),
      );
      if (person.personalIdentityNumberIndex !== null) {
        push(
          personsByIdentityNumber,
          person.personalIdentityNumberIndex,
          person.id,
        );
      }
      if (person.emailIndex !== null) {
        push(personsByEmail, person.emailIndex, person.id);
      }
      for (const residency of person.residencies) {
        push(
          personsByApartmentAndName,
          apartmentNameKey(
            residency.apartmentId,
            person.firstName,
            person.lastName,
          ),
          person.id,
        );
      }
    }

    return {
      apartments: apartments.map((apartment) => ({
        id: apartment.id,
        number: apartment.number,
        addressId: apartment.addressId,
        addressLabel: `${apartment.address.street} ${apartment.address.number}`,
      })),
      personsByIdentityNumber,
      personsByEmail,
      personsByApartmentAndName,
      personNames,
    };
  }

  private async identityNumberIndex(
    value: string,
    indexes: IdentityIndexCache,
  ): Promise<string | null> {
    const normalized = normalizePersonalIdentityNumber(value);
    if (normalized === null) {
      return null;
    }

    const cached = indexes.get(normalized);
    if (cached !== undefined) {
      return cached;
    }

    const index = await this.encryption.computeIndex(
      "person.personalIdentityNumber",
      value,
    );
    if (index !== null) {
      indexes.set(normalized, index);
    }
    return index;
  }

  /** Ciphertexts and indexes for every row that will be written. */
  private async encryptRows(
    rows: readonly PlannedRow[],
    decisions: Record<string, ImportDecision>,
    indexes: IdentityIndexCache,
  ): Promise<Map<number, EncryptedRowValues>> {
    const encrypted = new Map<number, EncryptedRowValues>();

    for (const row of rows) {
      if (!willWrite(row, decisions)) {
        continue;
      }
      encrypted.set(row.rowNumber, {
        email:
          row.person.email === null
            ? null
            : await this.encryption.encrypt("person.email", row.person.email),
        phone:
          row.person.phone === null
            ? null
            : await this.encryption.encrypt("person.phone", row.person.phone),
        personalIdentityNumber:
          row.person.personalIdentityNumber === null
            ? null
            : {
                cipher: (
                  await this.encryption.encrypt(
                    "person.personalIdentityNumber",
                    row.person.personalIdentityNumber,
                  )
                ).cipher,
                index: await this.identityNumberIndex(
                  row.person.personalIdentityNumber,
                  indexes,
                ),
              },
      });
    }

    return encrypted;
  }

  private async write(
    tx: Prisma.TransactionClient,
    plan: ImportPlan,
    decisions: Record<string, ImportDecision>,
    encrypted: ReadonlyMap<number, EncryptedRowValues>,
  ): Promise<ImportApplyResult> {
    const result: ImportApplyResult = {
      personsCreated: 0,
      personsUpdated: 0,
      residenciesCreated: 0,
      memberRegisterEntriesCreated: 0,
      skipped: 0,
      errors: 0,
    };

    /** Persons this run created, so a second row reaches the same one. */
    const createdByRow = new Map<number, string>();

    for (const row of plan.rows) {
      if (row.outcome === "error") {
        result.errors++;
        continue;
      }

      const target = resolveTarget(row, decisions, createdByRow);
      if (target.action === "skip") {
        result.skipped++;
        continue;
      }

      const personId = await this.upsertPerson(
        tx,
        row,
        target.action === "update" ? target.personId : null,
        encrypted,
        createdByRow,
        result,
      );
      if (personId === null) {
        result.skipped++;
        continue;
      }

      await this.writeResidency(tx, row, personId, result);
    }

    return result;
  }

  /**
   * Finds or creates the person a row writes to.
   *
   * Returns null when the row is skipped. An update fills in what the register
   * does not have and never overwrites what it does: a spreadsheet is not a
   * more reliable source than the register it is being loaded into, and a bulk
   * overwrite is how a register stops being evidence.
   */
  private async upsertPerson(
    tx: Prisma.TransactionClient,
    row: PlannedRow,
    target: string | null,
    encrypted: ReadonlyMap<number, EncryptedRowValues>,
    createdByRow: Map<number, string>,
    result: ImportApplyResult,
  ): Promise<string | null> {
    const values = encrypted.get(row.rowNumber);
    if (values === undefined) {
      return null;
    }

    if (target === null) {
      const created = await tx.person.create({
        data: {
          firstName: row.person.firstName,
          lastName: row.person.lastName,
          postalStreet: row.person.postalStreet,
          postalCode: row.person.postalCode,
          postalCity: row.person.postalCity,
          emailCipher: values.email?.cipher ?? null,
          emailIndex: values.email?.index ?? null,
          phoneCipher: values.phone?.cipher ?? null,
          phoneIndex: values.phone?.index ?? null,
          personalIdentityNumberCipher:
            values.personalIdentityNumber?.cipher ?? null,
          personalIdentityNumberIndex:
            values.personalIdentityNumber?.index ?? null,
        },
        select: { id: true },
      });
      createdByRow.set(row.rowNumber, created.id);
      result.personsCreated++;
      return created.id;
    }

    const existing = await tx.person.findUnique({
      where: { id: target },
      select: {
        id: true,
        postalStreet: true,
        postalCode: true,
        postalCity: true,
        emailCipher: true,
        phoneCipher: true,
        personalIdentityNumberCipher: true,
      },
    });
    if (existing === null) {
      return null;
    }

    const data: Prisma.PersonUpdateInput = {};
    if (existing.postalStreet === null && row.person.postalStreet !== null) {
      data.postalStreet = row.person.postalStreet;
    }
    if (existing.postalCode === null && row.person.postalCode !== null) {
      data.postalCode = row.person.postalCode;
    }
    if (existing.postalCity === null && row.person.postalCity !== null) {
      data.postalCity = row.person.postalCity;
    }
    if (existing.emailCipher === null && values.email !== null) {
      data.emailCipher = values.email.cipher;
      data.emailIndex = values.email.index;
    }
    if (existing.phoneCipher === null && values.phone !== null) {
      data.phoneCipher = values.phone.cipher;
      data.phoneIndex = values.phone.index;
    }
    if (
      existing.personalIdentityNumberCipher === null &&
      values.personalIdentityNumber !== null
    ) {
      data.personalIdentityNumberCipher = values.personalIdentityNumber.cipher;
      data.personalIdentityNumberIndex = values.personalIdentityNumber.index;
    }

    if (Object.keys(data).length > 0) {
      await tx.person.update({ where: { id: existing.id }, data });
    }
    result.personsUpdated++;
    return existing.id;
  }

  /**
   * Writes the residency and, when the row makes someone a member, the
   * statutory register entries that go with it.
   *
   * The same rule as the move flows: the ENTRY row is written when a membership
   * begins and the EXIT row when the last tenant-ownership ends, so a member
   * with two apartments is recorded as one membership rather than two.
   */
  private async writeResidency(
    tx: Prisma.TransactionClient,
    row: PlannedRow,
    personId: string,
    result: ImportApplyResult,
  ): Promise<void> {
    if (row.apartment === null || row.role === null || row.movedInOn === null) {
      return;
    }

    const movedInOn = new Date(`${row.movedInOn}T00:00:00.000Z`);
    const movedOutOn =
      row.movedOutOn === null
        ? null
        : new Date(`${row.movedOutOn}T00:00:00.000Z`);

    const existing = await tx.residency.count({
      where: { personId, apartmentId: row.apartment.id },
    });
    if (existing > 0) {
      return;
    }

    const alreadyMember =
      row.role === "MEMBER"
        ? (await tx.residency.count({
            where: {
              personId,
              role: "MEMBER",
              OR: [{ movedOutOn: null }, { movedOutOn: { gt: movedInOn } }],
            },
          })) > 0
        : false;

    await tx.residency.create({
      data: {
        personId,
        apartmentId: row.apartment.id,
        role: row.role,
        movedInOn,
        movedOutOn,
      },
    });
    result.residenciesCreated++;

    if (row.role !== "MEMBER") {
      return;
    }

    const person = await tx.person.findUniqueOrThrow({
      where: { id: personId },
      select: {
        firstName: true,
        lastName: true,
        postalStreet: true,
        postalCode: true,
        postalCity: true,
      },
    });
    const recorded = {
      recordedFirstName: person.firstName,
      recordedLastName: person.lastName,
      recordedPostalStreet: person.postalStreet,
      recordedPostalCode: person.postalCode,
      recordedPostalCity: person.postalCity,
    };

    if (!alreadyMember) {
      await tx.memberRegisterEntry.create({
        data: {
          personId,
          apartmentId: row.apartment.id,
          eventType: "ENTRY",
          eventOn: movedInOn,
          ...recorded,
        },
      });
      result.memberRegisterEntriesCreated++;
    }

    if (movedOutOn === null) {
      return;
    }

    // A row for someone who has already left has to close its own membership,
    // or the register would show them as a member for ever.
    const stillHeld = await tx.residency.count({
      where: {
        personId,
        role: "MEMBER",
        OR: [{ movedOutOn: null }, { movedOutOn: { gt: movedOutOn } }],
      },
    });
    if (stillHeld === 0) {
      await tx.memberRegisterEntry.create({
        data: {
          personId,
          apartmentId: row.apartment.id,
          eventType: "EXIT",
          eventOn: movedOutOn,
          ...recorded,
        },
      });
      result.memberRegisterEntriesCreated++;
    }
  }
}

interface EncryptedRowValues {
  email: { cipher: string; index: string | null } | null;
  phone: { cipher: string; index: string | null } | null;
  personalIdentityNumber: { cipher: string; index: string | null } | null;
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
  // Every xlsx is a zip archive, and every zip starts "PK".
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

function push(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}

function willWrite(
  row: PlannedRow,
  decisions: Record<string, ImportDecision>,
): boolean {
  if (row.outcome === "error") {
    return false;
  }
  if (row.outcome !== "ambiguous") {
    return true;
  }
  return decisions[String(row.rowNumber)]?.action !== "skip";
}

/** Where a row's writes go, once the board's decisions are taken into account. */
type RowTarget =
  | { action: "skip" }
  | { action: "create" }
  | { action: "update"; personId: string };

/**
 * The person a row writes to.
 *
 * An ambiguous row is decided by the board and by nothing else - the apply step
 * refuses to run at all while one is unanswered. A row that shares a new person
 * with an earlier row follows that row, and is skipped when the earlier one was.
 */
function resolveTarget(
  row: PlannedRow,
  decisions: Record<string, ImportDecision>,
  createdByRow: ReadonlyMap<number, string>,
): RowTarget {
  if (row.outcome === "ambiguous") {
    const decision = decisions[String(row.rowNumber)];
    if (decision === undefined || decision.action === "skip") {
      return { action: "skip" };
    }
    return decision.action === "create"
      ? { action: "create" }
      : { action: "update", personId: decision.personId };
  }

  if (row.matchedPersonId !== null) {
    return { action: "update", personId: row.matchedPersonId };
  }
  if (row.sameAsRowNumber !== null) {
    const earlier = createdByRow.get(row.sameAsRowNumber);
    return earlier === undefined
      ? { action: "skip" }
      : { action: "update", personId: earlier };
  }
  return { action: "create" };
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
