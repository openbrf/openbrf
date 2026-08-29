import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  type JobSendOptions,
  JobQueueService,
  type TransactionalSql,
} from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockResidencyTransitionsInOrder } from "../registers/residency-lock";
import {
  type ImportField,
  IMPORT_FIELDS,
  type ImportMapping,
} from "./import-columns";
import { ImportError, type ImportErrorReason } from "./import-errors";
import type { ImportPlan, PlannedRow } from "./import-plan";
import {
  type IdentityIndexCache,
  ImportPlannerService,
} from "./import-planner.service";
import type { ImportApplyResult } from "./import-run";

/**
 * Writing the register, as a background job.
 *
 * The blind index of a personal identity number costs 43.8 ms by design, so a
 * member list of any size is minutes of CPU and belongs nowhere near a request
 * (ADR 0002). The apply is therefore a pg-boss job that walks the file in
 * chunks, and every property that matters follows from what a chunk is:
 *
 * - **One chunk is one transaction.** It advances the session's cursor and
 *   writes its rows together, so a chunk is either wholly applied and counted or
 *   not applied at all. A process killed mid-chunk rolls the chunk back.
 * - **The cursor is claimed conditionally.** Two workers on one session - a
 *   retry overlapping a run, a restart racing a queue - block on the same row
 *   and only one commits. The other finds the cursor moved and stops. The
 *   member register refuses UPDATE and DELETE, so a chunk applied twice could
 *   only be answered with a further correction entry.
 * - **A chunk plans against the register as it stands.** What the chunk before
 *   it wrote is in the snapshot, so a person listed twice in one file is matched
 *   the second time rather than created twice - by the same match-key precedence
 *   the preview used.
 * - **Resuming is the same code as starting.** There is no separate recovery
 *   path: the job reads the cursor and carries on from it, whether it was
 *   written a millisecond ago or before the last restart.
 */

/** Queue the apply runs on. */
export const IMPORT_APPLY_QUEUE = "import-apply";

/**
 * Where an apply lands once its retries are spent. The handler records the
 * interruption on the session, so a job that never got to finish is reported as
 * stopped rather than left looking like one that is still running.
 */
export const IMPORT_APPLY_ABANDONED_QUEUE = "import-apply-abandoned";

/**
 * Rows one chunk plans, encrypts and writes.
 *
 * The number is set by the expensive half: a hundred rows carrying identity
 * numbers is about 4.4 seconds of Argon2id, all of it before the transaction
 * opens, and a transaction of a hundred rows' writes is short. Smaller chunks
 * would report progress more finely and re-read the register more often for it;
 * larger ones would hold a transaction open longer and lose more work to an
 * interruption.
 */
export const IMPORT_CHUNK_ROWS = 100;

/**
 * How long the queue waits before deciding a worker is gone.
 *
 * Generous, because one job execution walks the whole file: the largest file the
 * upload accepts is minutes of Argon2id. A restart does not wait for this - the
 * module re-queues everything it finds unfinished as it comes up.
 */
const APPLY_EXPIRE_SECONDS = 30 * 60;

const APPLY_JOB_OPTIONS = {
  // A failed attempt resumes from the cursor rather than starting again, so
  // retrying costs only the chunk that was interrupted. These retries are for
  // the failures a second attempt can change - a database that went away, a
  // worker that was killed. A refusal never reaches them: `runApply` records it
  // and finishes the job.
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
  expireInSeconds: APPLY_EXPIRE_SECONDS,
  deadLetter: IMPORT_APPLY_ABANDONED_QUEUE,
} satisfies JobSendOptions;

/** Payload of the apply job. */
interface ImportApplyJob {
  sessionId: string;
  [key: string]: unknown;
}

export type ImportDecision =
  | { action: "use-person"; personId: string }
  | { action: "create" }
  | { action: "skip" };

export type ImportDecisions = Record<string, ImportDecision>;

@Injectable()
export class ImportApplyService implements OnModuleInit {
  private readonly logger = new Logger(ImportApplyService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly planner: ImportPlannerService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests start the worker themselves, so a job under test is
      // not raced by a worker that came up with the module.
      return;
    }
    await this.startApplyWorker();
    await this.resumeInterruptedApplies();
  }

  /** Registers the workers. Public so an integration test can drive the job. */
  async startApplyWorker(): Promise<void> {
    await this.jobs.work<ImportApplyJob>(IMPORT_APPLY_QUEUE, async (data) => {
      await this.runApply(data.sessionId);
    });
    await this.jobs.work<ImportApplyJob>(
      IMPORT_APPLY_ABANDONED_QUEUE,
      async (data) => {
        await this.recordAbandoned(data.sessionId);
      },
    );
  }

  /**
   * Creates the queues the apply uses.
   *
   * Awaited before a transaction that enqueues, because creating a queue is the
   * queue backend's own work on its own connection.
   */
  async ensureQueues(): Promise<void> {
    await this.jobs.ensureQueue(IMPORT_APPLY_QUEUE);
    await this.jobs.ensureQueue(IMPORT_APPLY_ABANDONED_QUEUE);
  }

  /**
   * Puts the session's apply on the queue, inside the transaction that claimed
   * it.
   *
   * The claim and the job commit together or not at all. A job queued after the
   * claim committed could fail on its own and leave a session claimed with
   * nothing coming for it; a claim committed after the job could be raced by a
   * second request.
   */
  async enqueueInTransaction(
    tx: TransactionalSql,
    sessionId: string,
  ): Promise<void> {
    await this.jobs.sendInTransaction<ImportApplyJob>(
      tx,
      IMPORT_APPLY_QUEUE,
      { sessionId },
      APPLY_JOB_OPTIONS,
    );
  }

  /** Puts the session's apply on the queue. Used when resuming one. */
  async enqueue(sessionId: string): Promise<void> {
    await this.jobs.send<ImportApplyJob>(
      IMPORT_APPLY_QUEUE,
      { sessionId },
      APPLY_JOB_OPTIONS,
    );
  }

  /**
   * Re-queues every apply that was in flight.
   *
   * Called as the module comes up. An apply interrupted by a restart is left
   * with its cursor where the last committed chunk put it, and re-queueing is
   * all it takes: the job resumes from that cursor rather than repeating what is
   * already written. Queueing one twice is harmless - the chunk claim lets only
   * one of them commit.
   */
  async resumeInterruptedApplies(): Promise<number> {
    const unfinished = await this.prisma.importSession.findMany({
      where: { status: { in: ["QUEUED", "APPLYING"] } },
      select: { id: true },
    });

    for (const session of unfinished) {
      await this.enqueue(session.id);
    }
    if (unfinished.length > 0) {
      this.logger.log(
        `Re-queued ${String(unfinished.length)} unfinished import applies`,
      );
    }
    return unfinished.length;
  }

  /**
   * Walks the session's remaining chunks. Public so a test can drive it.
   *
   * Two kinds of failure end an apply, and they are answered differently:
   *
   * - **A refusal** carries an `ImportError`, whose vocabulary describes the
   *   file, the mapping or the board's decisions. None of those changes between
   *   attempts, so every retry reaches the same answer. It is recorded on the
   *   session under its own reason and the job is finished.
   * - **Anything else** is a failure of the machinery rather than of the
   *   import: a database that went away, a worker that was killed. It is thrown
   *   on so the queue retries it, and the retry resumes from the last committed
   *   chunk.
   *
   * Only the second kind can reach the dead letter, so the session a board
   * reads as interrupted is one that really did run out of attempts.
   */
  async runApply(sessionId: string): Promise<void> {
    try {
      while (await this.applyNextChunk(sessionId)) {
        // Each chunk commits on its own; the loop simply carries on from the
        // cursor the last one left.
      }
    } catch (error) {
      if (error instanceof ImportError) {
        // Recorded rather than retried, and recorded as what it was: the reason
        // is the same vocabulary a request answers with, so the screen names
        // the mapping or the decision that stopped the import instead of
        // reporting it as an interruption five attempts later.
        await this.stop(sessionId, error.reason);
        return;
      }
      // Thrown on rather than swallowed. The session stays in APPLYING
      // meanwhile, which is what it is.
      //
      // Named by its class and the session, and not by what it was carrying: a
      // constraint violation names the value that broke it, and this job's
      // values are a cooperative's member list.
      this.logger.error(
        `Import session ${sessionId}: apply failed with ${failureName(error)}`,
      );
      throw error;
    }
  }

  /**
   * Applies one chunk. Returns whether rows remain.
   *
   * Public so an integration test can stop an apply between two chunks, which
   * is the state a killed process leaves behind and the one resuming has to
   * converge from.
   */
  async applyNextChunk(sessionId: string): Promise<boolean> {
    const session = await this.prisma.importSession.findUnique({
      where: { id: sessionId },
      select: {
        columns: true,
        rowsCipher: true,
        rowCount: true,
        rowsDone: true,
        status: true,
        mapping: true,
        defaultRole: true,
        defaultMovedInOn: true,
        decisions: true,
      },
    });
    if (session === null) {
      // Purged while it was running. There is nothing left to write from, and
      // nothing left to report on either.
      return false;
    }
    if (session.status !== "QUEUED" && session.status !== "APPLYING") {
      return false;
    }
    if (session.status === "QUEUED") {
      await this.prisma.importSession.updateMany({
        where: { id: sessionId, status: "QUEUED" },
        data: { status: "APPLYING", startedAt: new Date() },
      });
    }

    const cursor = session.rowsDone;
    if (cursor >= session.rowCount) {
      await this.finish(sessionId, cursor);
      return false;
    }

    const decisions = readDecisions(session.decisions);
    const rows = await this.planner.decryptRows(session.rowsCipher);

    // The cache of identity number indexes belongs to this chunk and to nothing
    // wider: it is created here and dropped when the chunk ends, so nothing
    // derived from an identity number outlives the unit of work that needed it.
    const indexes: IdentityIndexCache = new Map();
    const plan = await this.planner.plan({
      rows,
      columnCount: session.columns.length,
      mapping: readMapping(session.mapping),
      defaultRole: session.defaultRole,
      defaultMovedInOn: session.defaultMovedInOn,
      window: { from: cursor, count: IMPORT_CHUNK_ROWS },
      // A person this chunk writes carries the index, so it is owed whatever
      // the register looks like.
      indexEveryIdentityNumber: true,
      indexes,
    });

    if (plan.rows.length === 0) {
      // The file holds fewer rows than the session counted, which nothing in
      // the upload can produce. Stopping says so; carrying on would be a loop
      // that never advances the cursor.
      await this.stop(sessionId, "apply-interrupted");
      return false;
    }

    // Checked again although the request already checked it against the
    // preview: the register can have changed since, and a row that has become
    // ambiguous must not be resolved by a worker guessing.
    const undecided = findUndecided(plan, decisions);
    if (undecided !== null) {
      await this.stop(sessionId, undecided);
      return false;
    }

    // Every value that has to be encrypted is encrypted before the transaction
    // opens. The index for a personal identity number costs tens of
    // milliseconds by design, and a chunk of them inside a transaction would
    // hold it open long past any sensible timeout.
    const encrypted = await this.encryptRows(plan.rows, decisions, indexes);
    const planned = plan.rows.length;

    const counts = await this.prisma.$transaction(
      async (tx) => {
        // The cursor is claimed before anything is written, so a second worker
        // on this session blocks here rather than after doing the work, and
        // finds the cursor moved when the first one commits.
        const claimed = await tx.importSession.updateMany({
          where: { id: sessionId, status: "APPLYING", rowsDone: cursor },
          data: { rowsDone: cursor + planned },
        });
        if (claimed.count === 0) {
          return null;
        }

        // Taken before the chunk reads anything about these persons. Whether a
        // member row begins a membership is decided by counting the person's
        // other residencies, and a move-in or move-out for the same person can
        // commit between that count and the register write - which would append
        // a second ENTRY to a register that refuses to have rows removed. In a
        // fixed order, because a chunk holds many of these locks at once.
        await lockResidencyTransitionsInOrder(
          tx,
          existingTargets(plan, decisions),
        );

        const written = await this.write(tx, plan, decisions, encrypted);
        await tx.importSession.update({
          where: { id: sessionId },
          data: {
            personsCreated: { increment: written.personsCreated },
            personsUpdated: { increment: written.personsUpdated },
            residenciesCreated: { increment: written.residenciesCreated },
            memberRegisterEntriesCreated: {
              increment: written.memberRegisterEntriesCreated,
            },
            rowsSkipped: { increment: written.skipped },
            rowsWithProblems: { increment: written.errors },
          },
        });
        return written;
      },
      { timeout: 120_000, maxWait: 20_000 },
    );

    if (counts === null) {
      // Another worker is ahead on this session. It will finish it.
      return false;
    }

    const done = cursor + planned;
    this.logger.log(
      `Import session ${sessionId}: ${String(done)} of ${String(session.rowCount)} rows`,
    );

    if (done >= session.rowCount) {
      await this.finish(sessionId, done);
      return false;
    }
    return true;
  }

  /** Records that an apply ran out of attempts without finishing. */
  private async recordAbandoned(sessionId: string): Promise<void> {
    const { count } = await this.prisma.importSession.updateMany({
      where: { id: sessionId, status: { in: ["QUEUED", "APPLYING"] } },
      data: {
        status: "FAILED",
        failureReason: "apply-interrupted",
        finishedAt: new Date(),
      },
    });
    if (count > 0) {
      this.logger.error(
        `Import session ${sessionId}: apply abandoned after its retries`,
      );
    }
  }

  private async finish(sessionId: string, rowsDone: number): Promise<void> {
    const { count } = await this.prisma.importSession.updateMany({
      where: { id: sessionId, status: "APPLYING", rowsDone },
      data: { status: "APPLIED", finishedAt: new Date() },
    });
    if (count > 0) {
      this.logger.log(`Import session ${sessionId} applied`);
    }
  }

  private async stop(
    sessionId: string,
    reason: ImportErrorReason,
  ): Promise<void> {
    await this.prisma.importSession.updateMany({
      where: { id: sessionId, status: { in: ["QUEUED", "APPLYING"] } },
      data: {
        status: "FAILED",
        failureReason: reason,
        finishedAt: new Date(),
      },
    });
    this.logger.warn(`Import session ${sessionId} stopped: ${reason}`);
  }

  /** Ciphertexts and indexes for every row that will be written. */
  private async encryptRows(
    rows: readonly PlannedRow[],
    decisions: ImportDecisions,
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
                index: await this.planner.identityNumberIndex(
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
    decisions: ImportDecisions,
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

    /** Persons this chunk created, so a second row reaches the same one. */
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
   *
   * The residency this row would create is looked up first, which is also what
   * makes a chunk safe to attempt twice: a row whose residency is already there
   * writes nothing further, and no second entry reaches a register that refuses
   * to have rows removed.
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

/** The first row of the chunk the board has not answered for, if there is one. */
function findUndecided(
  plan: ImportPlan,
  decisions: ImportDecisions,
): ImportErrorReason | null {
  for (const row of plan.rows) {
    if (row.outcome !== "ambiguous") {
      continue;
    }
    const decision = decisions[String(row.rowNumber)];
    if (decision === undefined) {
      return "ambiguous-rows-undecided";
    }
    if (
      decision.action === "use-person" &&
      !row.candidates.some(
        (candidate) => candidate.personId === decision.personId,
      )
    ) {
      return "decision-not-a-candidate";
    }
  }
  return null;
}

/** The stored mapping, read back. An empty entry is a column not imported. */
function readMapping(stored: readonly string[]): ImportMapping {
  return stored.map((field) =>
    (IMPORT_FIELDS as readonly string[]).includes(field)
      ? (field as ImportField)
      : null,
  );
}

/**
 * The stored decisions, read back.
 *
 * Narrowed rather than cast: the column is JSON, and a value that does not
 * describe a decision is dropped rather than carried into a register write. A
 * dropped decision leaves its row undecided, which stops the import instead of
 * resolving it by accident.
 */
function readDecisions(value: unknown): ImportDecisions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const decisions: ImportDecisions = {};
  for (const [rowNumber, raw] of Object.entries(value)) {
    const decision = readDecision(raw);
    if (decision !== null) {
      decisions[rowNumber] = decision;
    }
  }
  return decisions;
}

function readDecision(raw: unknown): ImportDecision | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const action = (raw as { action?: unknown }).action;
  if (action === "create" || action === "skip") {
    return { action };
  }
  if (action !== "use-person") {
    return null;
  }
  const personId = (raw as { personId?: unknown }).personId;
  return typeof personId === "string" && personId !== ""
    ? { action, personId }
    : null;
}

function willWrite(row: PlannedRow, decisions: ImportDecisions): boolean {
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
 * An ambiguous row is decided by the board and by nothing else - the apply
 * refuses to run at all while one is unanswered. A row that shares a new person
 * with an earlier row follows that row, and is skipped when the earlier one was.
 */
/**
 * The persons a chunk will write to that the register already holds.
 *
 * A person the chunk creates is deliberately not in this set. Their id does not
 * exist outside the transaction until it commits, so no other writer can be
 * holding the register open for them, and there is nothing to serialize
 * against. That is also why an empty map of rows-to-created-persons is the
 * right one to resolve against here: a row that points at a person an earlier
 * row creates resolves to no target, which is exactly the case with no lock to
 * take.
 *
 * Resolved through resolveTarget rather than read off the rows directly, so the
 * set cannot drift from the persons the write loop actually reaches.
 */
function existingTargets(
  plan: ImportPlan,
  decisions: ImportDecisions,
): string[] {
  const created = new Map<number, string>();
  const ids: string[] = [];

  for (const row of plan.rows) {
    if (row.outcome === "error") {
      continue;
    }
    const target = resolveTarget(row, decisions, created);
    if (target.action === "update") {
      ids.push(target.personId);
    }
  }

  return ids;
}

function resolveTarget(
  row: PlannedRow,
  decisions: ImportDecisions,
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
