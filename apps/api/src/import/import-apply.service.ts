import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { localDayOf } from "@openbrf/shared";

import { lockPersonEmailsInOrder } from "../address-book/person-email-lock";
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
import { residencyNotEndedOn } from "../registers/held-on";
import {
  appendOwedMembershipEvents,
  type MemberResidencySpan,
  readMemberResidencies,
} from "../registers/membership-transitions";
import {
  lockApartmentResidenciesInOrder,
  lockResidencyTransitionsInOrder,
} from "../registers/residency-lock";
import { readMapping } from "./import-columns";
import { ImportError, type ImportErrorReason } from "./import-errors";
import {
  apartmentNameKey,
  changedSincePreview,
  findUndecided,
  IMPORT_SEARCH_KEYS,
  type ImportDecision,
  type ImportDecisions,
  type ImportPlan,
  type PlannedRow,
  push,
  readPreviewedCandidates,
} from "./import-plan";
import {
  type IdentityIndexCache,
  ImportPlannerService,
} from "./import-planner.service";
import {
  type ImportApplyResult,
  isRunning,
  RUNNING_IMPORT_STATUSES,
} from "./import-run";

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
 * - **A new person is looked for again before it is written.** The plan is
 *   read before the transaction opens, so a row that writes a new person - or
 *   gives one the chunk creates an address or a residency - is checked against
 *   the register once the chunk holds its locks. Somebody added in between
 *   stops the import rather than being entered a second time.
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
 *
 * The queue keeps the name it was created with, so a job already waiting in it
 * on a running instance is still delivered. It has nothing to do with an
 * administrator abandoning an import, which is `ImportService.abandon`.
 */
export const IMPORT_APPLY_DEAD_LETTER_QUEUE = "import-apply-abandoned";

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
 * How long one chunk's transaction may run. It holds the session row for all
 * of it, so this is also the longest anything waiting for that row waits.
 */
export const IMPORT_CHUNK_TRANSACTION_MS = 120_000;

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
  deadLetter: IMPORT_APPLY_DEAD_LETTER_QUEUE,
} satisfies JobSendOptions;

/** Payload of the apply job. */
interface ImportApplyJob {
  sessionId: string;
  [key: string]: unknown;
}

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
      IMPORT_APPLY_DEAD_LETTER_QUEUE,
      async (data) => {
        await this.recordRetriesSpent(data.sessionId);
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
    await this.jobs.ensureQueue(IMPORT_APPLY_DEAD_LETTER_QUEUE);
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
      where: { status: { in: [...RUNNING_IMPORT_STATUSES] } },
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
        ambiguousRows: true,
        unwrittenIdentityNumbers: true,
        createdPersons: true,
      },
    });
    if (session === null) {
      // Purged while it was running. There is nothing left to write from, and
      // nothing left to report on either.
      return false;
    }
    if (!isRunning(session.status)) {
      return false;
    }
    if (session.status === "QUEUED") {
      const started = await this.prisma.importSession.updateMany({
        where: { id: sessionId, status: "QUEUED" },
        data: { status: "APPLYING", startedAt: new Date() },
      });
      if (started.count === 0) {
        // Abandoned while it waited, or started by another worker a moment
        // ago. Either way there is nothing here for this one to do, and
        // stopping now spares decrypting and indexing a file whose chunk claim
        // would fail anyway.
        return false;
      }
    }

    const cursor = session.rowsDone;
    if (cursor >= session.rowCount) {
      // Every row is written, but the session was not marked applied: left by
      // an instance that marked it after the last chunk rather than with it.
      if (await finishImport(this.prisma, sessionId)) {
        this.logger.log(`Import session ${sessionId} applied`);
      }
      return false;
    }

    const decisions = readDecisions(session.decisions);
    const unwritten = readRowPersons(session.unwrittenIdentityNumbers);
    const created = readRowPersons(session.createdPersons);
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
      decisions,
      unwrittenIdentityNumbers: unwritten,
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
    // preview: the register can have changed since. A row that has become
    // ambiguous must not be resolved by a worker guessing, and a row that no
    // longer is must not be written to the person it now matches when the board
    // chose to skip it or to make it somebody new. Either way the board's
    // answers no longer fit the file, and it previews again.
    const undecided = findUndecided(plan, decisions, session.rowCount);
    if (undecided !== null) {
      await this.stop(
        sessionId,
        undecided === "decision-not-needed" ? "preview-outdated" : undecided,
      );
      return false;
    }

    // And each of those rows still matches the persons the preview showed the
    // board, which the request also checked, but a chunk is planned as long
    // after it as the apply has run. A row the board made a new person that now
    // also matches somebody added since would enter them a second time, and the
    // check inside the transaction below cannot tell, because it allows the
    // persons this plan found. The persons earlier chunks created are set
    // aside: the preview could not list them. Recorded as the register having
    // changed rather than as an outdated preview: the session cannot be
    // previewed again, and the board imports the rest as a new file.
    if (
      changedSincePreview(
        plan,
        readPreviewedCandidates(session.ambiguousRows),
        new Set(created.values()),
      )
    ) {
      await this.stop(sessionId, "register-changed-during-apply");
      return false;
    }

    // Every value that has to be encrypted is encrypted before the transaction
    // opens. The index for a personal identity number costs tens of
    // milliseconds by design, and a chunk of them inside a transaction would
    // hold it open long past any sensible timeout.
    const encrypted = await this.encryptRows(plan.rows, decisions, indexes);
    const done = cursor + plan.rows.length;
    const last = done >= session.rowCount;

    const counts = await this.prisma.$transaction(
      async (tx) => {
        // The cursor is claimed before anything is written, so a second worker
        // on this session blocks here rather than after doing the work, and
        // finds the cursor moved when the first one commits.
        const claimed = await tx.importSession.updateMany({
          where: { id: sessionId, status: "APPLYING", rowsDone: cursor },
          data: { rowsDone: done },
        });
        if (claimed.count === 0) {
          return null;
        }

        // The apartments first, before the persons: the charge and fee purges
        // decide from everybody who has ever lived in an apartment, and a
        // historical residency this chunk adds has to be either seen by them
        // or written after they finish. Ahead of the transition locks, in the
        // order lockApartmentResidencies gives.
        await lockApartmentResidenciesInOrder(
          tx,
          residencyApartments(plan, decisions),
        );

        // The addresses the chunk writes, so a sign-up approval matching one
        // of them either sees the person this chunk writes or finishes before
        // it does. After the apartments and before the transition locks, the
        // order person-email-lock.ts gives.
        await lockPersonEmailsInOrder(tx, writtenEmailIndexes(encrypted));

        // The plan was read before this transaction opened, and a person
        // committed since - added from the address book, linked by a sign-up
        // approval, moved in - is not in it. A row that writes a new person
        // would enter that human being a second time, and an access report or
        // an erasure asked for by person would find one of the two. Thrown
        // rather than returned, so the cursor claim rolls back with the chunk:
        // the worker does not decide who the row is about, and the board does
        // on a fresh preview.
        if (await newPersonsMatchedSincePlan(tx, plan, decisions, encrypted)) {
          throw new ImportError(
            "A row that writes a new person matches somebody the register gained since the plan.",
            "register-changed-during-apply",
          );
        }

        // Taken before the chunk reads anything about these persons. Whether a
        // member row begins a membership is decided from the person's other
        // tenant-ownerships as the chunk reads them, and a move-in or move-out
        // for the same person can commit between that read and the register
        // write - which would append
        // a second ENTRY to a register that refuses to have rows removed. In a
        // fixed order, because a chunk holds many of these locks at once.
        await lockResidencyTransitionsInOrder(
          tx,
          existingTargets(plan, decisions),
        );

        const written = await this.write(
          tx,
          plan,
          decisions,
          encrypted,
          unwritten,
          created,
        );
        await tx.importSession.update({
          where: { id: sessionId },
          data: {
            unwrittenIdentityNumbers: Object.fromEntries(unwritten),
            createdPersons: Object.fromEntries(created),
            personsCreated: { increment: written.personsCreated },
            personsUpdated: { increment: written.personsUpdated },
            residenciesCreated: { increment: written.residenciesCreated },
            memberRegisterEntriesCreated: {
              increment: written.memberRegisterEntriesCreated,
            },
            rowsSkipped: { increment: written.skipped },
            rowsWithProblems: { increment: written.errors },
            // The last chunk ends the import in the same commit that writes
            // its rows. Marked afterwards, there would be a moment when every
            // row was written and the session still read as running, and
            // anything that ended it then - an administrator's abandon, the
            // dead letter after a crash - would record a complete import as
            // one that failed.
            ...(last ? { status: "APPLIED", finishedAt: new Date() } : {}),
          },
        });
        return written;
      },
      { timeout: IMPORT_CHUNK_TRANSACTION_MS, maxWait: 20_000 },
    );

    if (counts === null) {
      // Another worker is ahead on this session. It will finish it.
      return false;
    }

    this.logger.log(
      `Import session ${sessionId}: ${String(done)} of ${String(session.rowCount)} rows`,
    );

    if (last) {
      this.logger.log(`Import session ${sessionId} applied`);
      return false;
    }
    return true;
  }

  /**
   * Records that an apply ran out of attempts without finishing. The dead
   * letter's handler.
   */
  private async recordRetriesSpent(sessionId: string): Promise<void> {
    if (await stopImport(this.prisma, sessionId, "apply-interrupted")) {
      this.logger.error(
        `Import session ${sessionId}: apply gave up after its retries`,
      );
    }
  }

  private async stop(
    sessionId: string,
    reason: ImportErrorReason,
  ): Promise<void> {
    if (await stopImport(this.prisma, sessionId, reason)) {
      this.logger.warn(`Import session ${sessionId} stopped: ${reason}`);
    }
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
    unwritten: Map<number, string>,
    created: Map<number, string>,
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
    /**
     * Each member's tenant-ownerships as they stood before this chunk's first
     * row for them, so what the register owes is settled once per person from
     * the whole chunk rather than row by row in the order the file lists them.
     */
    const membersBefore = new Map<string, MemberResidencySpan[]>();

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
        unwritten,
        result,
      );
      if (personId === null) {
        result.skipped++;
        continue;
      }

      await this.writeResidency(tx, row, personId, membersBefore, result);
    }
    for (const [rowNumber, personId] of createdByRow) {
      created.set(rowNumber, personId);
    }

    // After every row, so a file listing a person's newest apartment first
    // writes the same rows as one listing it last. A person whose rows fall in
    // two chunks is settled twice, and the second settles only the days the
    // second chunk changed.
    for (const [personId, before] of membersBefore) {
      result.memberRegisterEntriesCreated += (
        await appendOwedMembershipEvents(tx, personId, before)
      ).length;
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
   *
   * The identity number is the exception to filling in: it is written onto an
   * existing person only when the row reached them, and only them, through that
   * number. An email address or a name says who a row is probably about, and an
   * identity number stored on the strength of a probably is one person's number
   * in another person's record. A row the board decided is not written on the
   * strength of its number either: the number matched more than one person, or
   * the row reached the one it matched by another key. The row is remembered
   * instead, so a row in a later chunk stating the same number reaches the same
   * person rather than nobody.
   */
  private async upsertPerson(
    tx: Prisma.TransactionClient,
    row: PlannedRow,
    target: string | null,
    encrypted: ReadonlyMap<number, EncryptedRowValues>,
    createdByRow: Map<number, string>,
    unwritten: Map<number, string>,
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
      row.outcome === "update" &&
      row.matchedBy === "personalIdentityNumber" &&
      existing.personalIdentityNumberCipher === null &&
      values.personalIdentityNumber !== null
    ) {
      data.personalIdentityNumberCipher = values.personalIdentityNumber.cipher;
      data.personalIdentityNumberIndex = values.personalIdentityNumber.index;
    } else if (
      existing.personalIdentityNumberCipher === null &&
      values.personalIdentityNumber !== null
    ) {
      unwritten.set(row.rowNumber, existing.id);
    }

    if (Object.keys(data).length > 0) {
      await tx.person.update({ where: { id: existing.id }, data });
    }
    result.personsUpdated++;
    return existing.id;
  }

  /**
   * Writes the residency and, when the row is a member's, remembers what the
   * person held before the chunk touched them.
   *
   * The same rule as the move flows: the ENTRY row is written when a membership
   * begins and the EXIT row when the last tenant-ownership ends, so a member
   * with two apartments is recorded as one membership rather than two. The rows
   * themselves are written once the chunk's residencies are, by the caller.
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
    membersBefore: Map<string, MemberResidencySpan[]>,
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

    // Read before the insert, and only on the chunk's first row for the person:
    // the rows after it are part of the same change.
    if (row.role === "MEMBER" && !membersBefore.has(personId)) {
      membersBefore.set(personId, await readMemberResidencies(tx, personId));
    }

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
  }
}

/**
 * Ends a running import as FAILED, for the reason given, unless it has written
 * every row. Returns whether it ended it.
 *
 * Every way an import is stopped goes through here: a refusal the job meets,
 * the dead letter once the retries are spent, and an administrator's abandon.
 * So they agree on what can be stopped. An import whose cursor has reached the
 * end of the file has written all it was going to, whatever its status says,
 * and is never recorded as one that failed.
 *
 * One conditional statement, so a chunk holding the session row is waited for
 * and the condition is read again against what that chunk committed.
 */
export async function stopImport(
  client: Prisma.TransactionClient,
  sessionId: string,
  reason: ImportErrorReason,
): Promise<boolean> {
  const { count } = await client.importSession.updateMany({
    where: {
      id: sessionId,
      status: { in: [...RUNNING_IMPORT_STATUSES] },
      rowsDone: { lt: client.importSession.fields.rowCount },
    },
    data: { status: "FAILED", failureReason: reason, finishedAt: new Date() },
  });
  return count > 0;
}

/**
 * Marks an import applied whose cursor has reached the end of the file but
 * which still reads as applying. Returns whether it did.
 *
 * The last chunk marks its import applied in its own commit, so only a session
 * left by an instance that did that afterwards, and stopped in between, is in
 * this state. Its rows are all written; nothing is left but to say so.
 */
export async function finishImport(
  client: Prisma.TransactionClient,
  sessionId: string,
): Promise<boolean> {
  const { count } = await client.importSession.updateMany({
    where: {
      id: sessionId,
      status: "APPLYING",
      rowsDone: { gte: client.importSession.fields.rowCount },
    },
    data: { status: "APPLIED", finishedAt: new Date() },
  });
  return count > 0;
}

interface EncryptedRowValues {
  email: { cipher: string; index: string | null } | null;
  phone: { cipher: string; index: string | null } | null;
  personalIdentityNumber: { cipher: string; index: string | null } | null;
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

/**
 * Rows of earlier chunks, read back as row number to a person: those whose
 * identity number was not written, to the person each was written to, and
 * those written as a new person, to that person. Narrowed rather than cast,
 * like the decisions.
 */
function readRowPersons(value: unknown): Map<number, string> {
  const persons = new Map<number, string>();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return persons;
  }
  for (const [rowNumber, personId] of Object.entries(value)) {
    const row = Number(rowNumber);
    if (Number.isInteger(row) && row > 0 && typeof personId === "string") {
      persons.set(row, personId);
    }
  }
  return persons;
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

/**
 * The apartments a chunk may write a residency on.
 *
 * Every row that will write and names one, whether or not it turns out to add
 * anything: a row already present costs a lock nobody else was waiting for, and
 * one missed would be a residency written past a purge that never saw it. A row
 * the board decided to skip is left out, so the chunk does not hold up move-ins
 * and purges on an apartment it never writes to.
 */
function residencyApartments(
  plan: ImportPlan,
  decisions: ImportDecisions,
): string[] {
  return plan.rows.flatMap((row) =>
    willWrite(row, decisions) && row.apartment !== null
      ? [row.apartment.id]
      : [],
  );
}

/**
 * The person-scoped address indexes a chunk may write.
 *
 * Read off the encrypted values, which hold exactly the rows that will write.
 * A row updating a person who already has an address leaves it alone, and its
 * lock is one nobody else was waiting for; one missed would be a person
 * written past a sign-up approval that never saw it.
 */
function writtenEmailIndexes(
  encrypted: ReadonlyMap<number, EncryptedRowValues>,
): string[] {
  return [...encrypted.values()].flatMap(({ email }) =>
    email === null || email.index === null ? [] : [email.index],
  );
}

/**
 * Whether a row that writes a person the chunk creates matches somebody in the
 * register the plan did not find for it.
 *
 * Asked of every row whose writes go to a new person: one planned as `create`,
 * one the board decided to enter as a new person, and one that reaches the
 * person an earlier row of the chunk creates and may give them an address or a
 * residency. The keys are the planner's own - the identity number, the email
 * address, and the name of somebody whose residency in the row's apartment has
 * not ended - and a row is asked under the keys the plan looked under for it:
 * all three when it found nobody, and otherwise the ones up to the key it found
 * its candidates under. Under those the plan found the row's candidates and
 * nobody else in the register, so anybody else found now was added, or given
 * that address or that residency, after the plan read the register. The keys
 * after that one were never looked under, and a person found there would not
 * change the plan. A row the board decided has the candidates the preview
 * showed for it, and besides them only persons earlier chunks created: the
 * chunk made sure of that before the transaction opened.
 *
 * Read through the chunk's transaction, after its apartment and email locks.
 * Every writer of an address takes the email lock and every writer of a
 * residency the apartment lock, so on those two keys nobody can match a row
 * between this read and the commit. An identity number has no lock of its own,
 * so on that key the read narrows the gap to the length of the transaction
 * rather than closing it.
 */
async function newPersonsMatchedSincePlan(
  tx: Prisma.TransactionClient,
  plan: ImportPlan,
  decisions: ImportDecisions,
  encrypted: ReadonlyMap<number, EncryptedRowValues>,
): Promise<boolean> {
  const asked = plan.rows.flatMap((row) =>
    writesNewPerson(row, decisions)
      ? [askedKeys(row, encrypted.get(row.rowNumber))]
      : [],
  );

  const identityNumberIndexes = asked.flatMap(({ identityNumberIndex }) =>
    identityNumberIndex === null ? [] : [identityNumberIndex],
  );
  const emailIndexes = asked.flatMap(({ emailIndex }) =>
    emailIndex === null ? [] : [emailIndex],
  );
  const apartmentIds = [
    ...new Set(
      asked.flatMap(({ apartmentId }) =>
        apartmentId === null ? [] : [apartmentId],
      ),
    ),
  ];

  const byIdentityNumber = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  const byName = new Map<string, string[]>();

  if (identityNumberIndexes.length > 0 || emailIndexes.length > 0) {
    const persons = await tx.person.findMany({
      where: {
        OR: [
          { personalIdentityNumberIndex: { in: identityNumberIndexes } },
          { emailIndex: { in: emailIndexes } },
        ],
      },
      select: { id: true, personalIdentityNumberIndex: true, emailIndex: true },
    });
    for (const person of persons) {
      if (person.personalIdentityNumberIndex !== null) {
        push(byIdentityNumber, person.personalIdentityNumberIndex, person.id);
      }
      if (person.emailIndex !== null) {
        push(byEmail, person.emailIndex, person.id);
      }
    }
  }

  if (apartmentIds.length > 0) {
    // The residencies that have not ended, the rule the plan's snapshot reads
    // the register by, and asked of the database: an apartment's past
    // residents are no match, and need not be read under the chunk's locks.
    const residencies = await tx.residency.findMany({
      where: {
        apartmentId: { in: apartmentIds },
        ...residencyNotEndedOn(localDayOf(new Date())),
      },
      select: {
        apartmentId: true,
        person: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    for (const residency of residencies) {
      push(
        byName,
        apartmentNameKey(
          residency.apartmentId,
          residency.person.firstName,
          residency.person.lastName,
        ),
        residency.person.id,
      );
    }
  }

  return asked.some((row) =>
    [
      ...under(byIdentityNumber, row.identityNumberIndex),
      ...under(byEmail, row.emailIndex),
      ...under(byName, row.nameKey),
    ].some((personId) => !row.candidates.has(personId)),
  );
}

/**
 * Whether a row's writes go to a person the chunk creates: a row planned as
 * one, one the board decided to enter as one, or one that reaches the person
 * an earlier row of the chunk creates.
 */
function writesNewPerson(row: PlannedRow, decisions: ImportDecisions): boolean {
  if (row.outcome === "create") {
    return true;
  }
  if (row.outcome === "ambiguous") {
    return decisions[String(row.rowNumber)]?.action === "create";
  }
  return row.outcome === "update" && row.matchedPersonId === null;
}

/** A row's values under the keys the plan looked under for it. */
interface AskedKeys {
  identityNumberIndex: string | null;
  emailIndex: string | null;
  apartmentId: string | null;
  nameKey: string | null;
  /** The register persons the plan found under them. */
  candidates: ReadonlySet<string>;
}

function askedKeys(
  row: PlannedRow,
  values: EncryptedRowValues | undefined,
): AskedKeys {
  const searched = new Set(
    row.foundUnder === null
      ? IMPORT_SEARCH_KEYS
      : IMPORT_SEARCH_KEYS.slice(
          0,
          IMPORT_SEARCH_KEYS.indexOf(row.foundUnder) + 1,
        ),
  );
  const apartment = searched.has("apartmentAndName") ? row.apartment : null;
  return {
    identityNumberIndex: searched.has("personalIdentityNumber")
      ? (values?.personalIdentityNumber?.index ?? null)
      : null,
    emailIndex: searched.has("email") ? (values?.email?.index ?? null) : null,
    apartmentId: apartment?.id ?? null,
    nameKey:
      apartment === null
        ? null
        : apartmentNameKey(
            apartment.id,
            row.person.firstName,
            row.person.lastName,
          ),
    candidates: new Set(row.candidates.map(({ personId }) => personId)),
  };
}

function under(
  map: ReadonlyMap<string, readonly string[]>,
  key: string | null,
): readonly string[] {
  return key === null ? [] : (map.get(key) ?? []);
}

/** Where a row's writes go, once the board's decisions are taken into account. */
type RowTarget =
  | { action: "skip" }
  | { action: "create" }
  | { action: "update"; personId: string };

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

/**
 * The person a row writes to.
 *
 * An ambiguous row is decided by the board and by nothing else - the apply
 * refuses to run at all while one is unanswered, and stops at a decision for a
 * row that is not ambiguous rather than drop it here. A row that shares a new
 * person with an earlier row follows that row, and is skipped when the earlier
 * one was.
 */
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
