import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import {
  type EncryptedFieldId,
  type EncryptedValue,
  FieldEncryptionService,
} from "../crypto/field-encryption.service";
import {
  NORMALIZATION_VERSION,
  withPersonalIdentityNumberCentury,
} from "../crypto/personal-data";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { lockPersonIdentityNumbersInOrder } from "./person-identity-number-lock";
import { PersonReindexLock } from "./person-reindex-lock";

export const PERSON_REINDEX_QUEUE = "person-blind-index-reindex";

const IDENTITY_NUMBER: EncryptedFieldId = "person.personalIdentityNumber";

/** What the reindex reads of a person. */
interface StoredPerson {
  id: string;
  personalIdentityNumberCipher: string | null;
  personalIdentityNumberIndex: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * People read per round; each costs an Argon2id hash for its personal identity
 * number.
 */
const BATCH = 100;

/**
 * How long a row's write waits for the identity number locks.
 *
 * Longer than anybody else holds one: an import chunk holds its keys for its
 * whole transaction, which may run two minutes. A wait that still runs out
 * ends the run, and the job queues another (runJob).
 */
const ROW_LOCK_WAIT_MS = 180_000;

/** How long after a run that did not finish the next one starts. */
const RETRY_AFTER_MS = 60_000;

/**
 * How long runs that write nothing are tried again before the reindex gives
 * up, from the first of them.
 *
 * The hour an import waits for the reindex: a reindex that has written
 * nothing for this long has stopped on something an operator has to look at,
 * and every import that writes personal identity numbers has stopped waiting
 * for it by then.
 */
const RECOVERY_WINDOW_MS = 60 * 60_000;

/** Payload of the reindex job. */
export interface PersonReindexJob {
  /**
   * When the runs before this one began failing without writing a row, as an
   * ISO timestamp. Absent on a run nothing failed before, the one every boot
   * queues.
   */
  failingSince?: string;
  /** How many runs have failed since then. */
  failures?: number;
  [key: string]: unknown;
}

/**
 * A stored value the reindex cannot decrypt.
 *
 * The one failure known to repeat: the next run reads the same ciphertext with
 * the same key. Named by the person, so somebody can look at the row.
 */
class UnreadableValueError extends Error {
  constructor(
    readonly personId: string,
    readonly field: EncryptedFieldId,
    cause: unknown,
  ) {
    super(`Person ${personId}: their ${field} cannot be decrypted.`, {
      cause,
    });
    this.name = "UnreadableValueError";
  }
}

/**
 * Brings every person's blind indexes up to the current normalisation rules.
 *
 * A blind index is a keyed hash of the normalised value (ADR 0002), so when the
 * rules change, an index stored under the old ones stops matching a search
 * normalised under the new: the person is still in the register and can no
 * longer be found by phone or personal identity number, and the import's
 * duplicate check misses them. Only the application holds the key, so the indexes are
 * recomputed here, from the ciphertexts, which hold each value as entered (and,
 * for a personal identity number written since version 2, its century). The
 * email is left alone because its rules have not changed.
 *
 * A personal identity number is encrypted again as well. One entered without
 * its century was stored that way, and an index computed from it holds only
 * until the day it is read on passes the birthday it carries: from then on the
 * same digits are read as another person. So the century is written into the
 * ciphertext, the form every number has been stored in since, and a later
 * reindex reads the same person from it whatever the date. Which century is
 * decided by when the number was written, not by when this runs: see
 * withCenturyAsWritten.
 *
 * A row records the version it was indexed under, and one below
 * NORMALIZATION_VERSION is what this looks for, so a run that finds nothing
 * costs one indexed query. It is queued at every boot rather than awaited,
 * because a few hundred Argon2id hashes would hold the instance's start for
 * seconds, and a search that misses for those seconds is the same miss a
 * search made before the upgrade would have had.
 *
 * Each row is written only while both ciphertexts are still the ones its
 * indexes were computed from. A person edited mid-run was indexed by that edit,
 * and is picked up again by the next round if the edit left the version below.
 * One run at a time walks the register, whichever instance it is on
 * (PersonReindexLock).
 *
 * Until a row is rewritten, a lookup by its personal identity number misses
 * the person, and the import would enter them a second time: the import's
 * chunk waits for the run instead (identityNumbersAwaitReindex).
 */
@Injectable()
export class PersonReindexService implements OnModuleInit {
  private readonly logger = new Logger(PersonReindexService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly jobs: JobQueueService,
    private readonly lock: PersonReindexLock,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests call run() themselves.
      return;
    }
    await this.jobs.work<PersonReindexJob>(
      PERSON_REINDEX_QUEUE,
      async (job) => {
        await this.runJob(job);
      },
    );
    await this.jobs.send<PersonReindexJob>(PERSON_REINDEX_QUEUE, {});
  }

  /**
   * The job: a run, under the lock that keeps runs apart, and another queued
   * for later when this one does not finish. Public so a test can drive it.
   *
   * A run that finds another one holding the lock does nothing: that one
   * reads every row left, and answers for its own failure.
   *
   * A failure is not left to the queue's retries, which are few and soon
   * spent, and nothing else would queue the run again before the next boot.
   * Until it finishes, every import that writes personal identity numbers
   * waits for it. Rows written before the failure stay written, so the next
   * run carries on from the rest. But a failure that repeats is not tried
   * again for ever: see {@link afterFailure}.
   */
  async runJob(job: PersonReindexJob = {}): Promise<void> {
    const progress = { reindexed: 0 };
    try {
      const ran = await this.lock.whileHeld((lockLost) =>
        this.reindex(progress, lockLost),
      );
      if (!ran) {
        this.logger.log(
          "Reindex left to the run already under way on this or another instance",
        );
      }
    } catch (error) {
      await this.afterFailure(job, progress.reindexed, error);
    }
  }

  /**
   * Queues the next run after one that failed, or gives up and says what the
   * operator has to do.
   *
   * Given up on at once when the failure is one the next run would meet
   * again: a value that cannot be decrypted. The list is of what is known to
   * repeat, and everything else is tried again - a lock wait that ran out
   * behind an import, a database that restarted - because a failure nobody
   * foresaw would otherwise end the reindex at its first occurrence.
   *
   * Tried again for {@link RECOVERY_WINDOW_MS} from the first of the runs that
   * failed without writing a row, a time carried from each run's job to the
   * next. A run that wrote rows before it failed starts the time again: it got
   * further than the one before it, and the rows left are fewer, so the
   * reindex still ends. A boot queues a run without that time, and gives the
   * reindex another hour.
   */
  private async afterFailure(
    job: PersonReindexJob,
    reindexed: number,
    error: unknown,
  ): Promise<void> {
    const now = Date.now();
    const carried = readFailingSince(job.failingSince);
    const afresh = reindexed > 0 || carried === null;
    const failingSince = afresh ? now : carried;
    const failures = (afresh ? 0 : (job.failures ?? 0)) + 1;
    // Named by its class only: the run holds personal identity numbers.
    const failure = failureName(error);

    if (error instanceof UnreadableValueError) {
      this.logger.error(
        `Reindex stopped: person ${error.personId}'s ${error.field} cannot be decrypted (${failure}), and every run would stop on it again. Personal identity numbers left under older rules are not found by a search, and imports that write them stop after waiting an hour. Check the instance's encryption key and that person's record, then restart the instance to queue the reindex again.`,
      );
      return;
    }
    if (now - failingSince >= RECOVERY_WINDOW_MS) {
      this.logger.error(
        `Reindex gave up after ${String(failures)} runs that failed without writing a row over ${String(Math.round((now - failingSince) / 60_000))} minutes, the last with ${failure}. Personal identity numbers left under older rules are not found by a search, and imports that write them stop after waiting an hour. Find the cause in the failures logged before this one, then restart the instance to queue the reindex again.`,
      );
      return;
    }
    this.logger.error(
      `Reindex stopped with ${failure}; trying again in ${String(RETRY_AFTER_MS / 1000)} seconds`,
    );
    await this.jobs.sendAt<PersonReindexJob>(
      PERSON_REINDEX_QUEUE,
      { failingSince: new Date(failingSince).toISOString(), failures },
      new Date(now + RETRY_AFTER_MS),
    );
  }

  /**
   * Reindexes every person below the current version. Answers how many.
   *
   * Without the lock that keeps runs apart, which runJob takes: for a caller
   * that knows no other run is under way.
   */
  async run(): Promise<number> {
    const progress = { reindexed: 0 };
    await this.reindex(progress);
    return progress.reindexed;
  }

  /**
   * The run itself, counting the rows written into `progress` as it goes, so
   * a run that fails part way still says how far it got.
   */
  private async reindex(
    progress: { reindexed: number },
    lockLost?: AbortSignal,
  ): Promise<void> {
    for (;;) {
      const people = await this.prisma.person.findMany({
        where: { blindIndexVersion: { lt: NORMALIZATION_VERSION } },
        select: {
          id: true,
          phoneCipher: true,
          personalIdentityNumberCipher: true,
          personalIdentityNumberIndex: true,
          createdAt: true,
          updatedAt: true,
        },
        take: BATCH,
      });
      if (people.length === 0) {
        break;
      }
      for (const person of people) {
        // Hashed before the transaction opens, so the locks below are held
        // for the write and not for the Argon2id.
        const identityNumber = await this.identityNumber(person);
        const phoneIndex = await this.indexOf(person, person.phoneCipher);
        const { count } = await this.prisma.$transaction(
          async (tx) => {
            // The wait is bounded by the server, so a lock held past it ends
            // the wait itself and not only the client's patience with it.
            await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${String(ROW_LOCK_WAIT_MS)}ms`}, true)`;
            // The number's key under the index it leaves and under the one it
            // gets, as every writer of an identity number takes it. Both, in
            // the order every caller sorts them in: an import chunk holding
            // the new index's key may also hold the old one's for a number of
            // its own.
            await lockPersonIdentityNumbersInOrder(
              tx,
              [
                person.personalIdentityNumberIndex,
                identityNumber?.index ?? null,
              ].filter((index) => index !== null),
            );
            // Last before the write, after the lock waits: a run whose lock
            // went while it waited is no longer the only one.
            lockLost?.throwIfAborted();
            return tx.person.updateMany({
              where: {
                id: person.id,
                phoneCipher: person.phoneCipher,
                personalIdentityNumberCipher:
                  person.personalIdentityNumberCipher,
              },
              data: {
                phoneIndex,
                personalIdentityNumberCipher: identityNumber?.cipher ?? null,
                personalIdentityNumberIndex: identityNumber?.index ?? null,
                blindIndexVersion: NORMALIZATION_VERSION,
              },
            });
          },
          // Past the lock wait, so the server's answer arrives before the
          // client gives up on the transaction.
          { timeout: ROW_LOCK_WAIT_MS + 10_000, maxWait: 20_000 },
        );
        progress.reindexed += count;
      }
    }
    if (progress.reindexed > 0) {
      this.logger.log(
        `Reindexed ${String(progress.reindexed)} people under normalisation version ${String(NORMALIZATION_VERSION)}`,
      );
    }
  }

  /** The personal identity number encrypted again with its century, and its index. */
  private async identityNumber(
    person: StoredPerson,
  ): Promise<EncryptedValue | null> {
    if (person.personalIdentityNumberCipher === null) {
      return null;
    }
    const entered = await this.decrypt(
      person,
      IDENTITY_NUMBER,
      person.personalIdentityNumberCipher,
    );
    return this.encryption.encrypt(
      IDENTITY_NUMBER,
      await this.withCenturyAsWritten(entered, person),
    );
  }

  /**
   * A number stored without its century, with the century it was written
   * with.
   *
   * Read today it could be somebody else: 260301-1234 entered in 2025 meant
   * 1926, and reads as 2026 since 1 March 2026. The row does not record the day
   * the number was written, only that it was no earlier than the row's
   * creation and no later than its last change, and a change of the row is
   * not a change of the number: setting the protected personal data flag moves
   * the last change and leaves the number alone. So the number is taken as
   * written when the row was created, unless the index stored beside it shows
   * it came later.
   *
   * That index is the one version 1 computed on the day the number was
   * written, by the year alone (byYearAlone): every day of one year gives the
   * same reading, and the reading moves on 1 January of the year the birth
   * date carries (of the year the person turns 100, for a number written with
   * a plus). When the two days fall on either side of that 1 January, the
   * index says which side the number was written on. Matching it against
   * today's readings instead would say nothing about the day: 261201-1235
   * written in March 2026 was indexed as 2026, which is what today's rules
   * read on any day from 1 December 2026, so an unrelated change made after
   * that day would pass for the day the number was written.
   *
   * What the row cannot tell apart is logged, so somebody can check the
   * century with the person. A number whose index matches the year the row
   * was created in, but whose last change came after its birthday that year -
   * 261201-1235 in a row created in March 2026 and changed in December - was
   * either written when the row was made, a person born in 1926, or added in
   * December, a person born in 2026: it is read as written when the row was
   * made. A number whose index shows it was added after the row was made, at
   * some point before the last change that the birthday falls within, keeps
   * the reading that index carries, the one the register has found the person
   * by since.
   */
  private async withCenturyAsWritten(
    entered: string,
    person: StoredPerson,
  ): Promise<string> {
    const { createdAt, updatedAt } = person;
    const atChange = byYearAlone(entered, updatedAt);
    // The days the number can have been written on.
    let from = createdAt;
    let to = updatedAt;
    if (byYearAlone(entered, createdAt) !== atChange) {
      // Version 1's reading moved on a 1 January between the two days, and
      // the index says on which side the number was written.
      let year = updatedAt.getFullYear();
      while (byYearAlone(entered, new Date(year - 1, 0, 1)) === atChange) {
        year--;
      }
      if (
        person.personalIdentityNumberIndex !== null &&
        (await this.encryption.computeIndex(IDENTITY_NUMBER, atChange)) ===
          person.personalIdentityNumberIndex
      ) {
        from = new Date(year, 0, 1);
      } else {
        to = new Date(year - 1, 11, 31);
      }
    }
    const first = withPersonalIdentityNumberCentury(entered, from);
    const last = withPersonalIdentityNumberCentury(entered, to);
    if (first !== last) {
      this.logger.warn(
        `Person ${person.id}: the century of their personal identity number cannot be told from their record, and was taken from ${from === createdAt ? "the day they were added" : "its stored index"}. Check its century with them.`,
      );
    }
    return from === createdAt ? first : last;
  }

  /** The phone number's index, computed from the phone number as stored. */
  private async indexOf(
    person: StoredPerson,
    cipher: string | null,
  ): Promise<string | null> {
    return cipher === null
      ? null
      : this.encryption.computeIndex(
          "person.phone",
          await this.decrypt(person, "person.phone", cipher),
        );
  }

  /** A stored value of the person's, or the failure that every run would meet. */
  private async decrypt(
    person: StoredPerson,
    field: EncryptedFieldId,
    cipher: string,
  ): Promise<string> {
    try {
      return await this.encryption.decrypt(field, cipher);
    } catch (cause) {
      throw new UnreadableValueError(person.id, field, cause);
    }
  }
}

/**
 * Whether a person's personal identity number still carries an index computed
 * under older rules than today's.
 *
 * A lookup computes the index under today's rules, so it cannot find that
 * person by their number until the reindex has rewritten it, and a writer that
 * decides from the persons who hold a number - the import entering a row as a
 * new person when nobody does - would decide wrong. Taking the identity number
 * lock does not help it: the key it takes is the new index's, and the person
 * still sits under the old one, which the writer cannot compute. It asks this
 * instead, and does not decide while the answer is yes.
 *
 * The answer can only go from yes to no. A person written today gets the
 * current version from the column default, and only the reindex changes it, so
 * a no read once holds for every read after it.
 */
export async function identityNumbersAwaitReindex(
  client: Prisma.TransactionClient,
): Promise<boolean> {
  const stale = await client.person.findFirst({
    where: {
      blindIndexVersion: { lt: NORMALIZATION_VERSION },
      personalIdentityNumberCipher: { not: null },
    },
    select: { id: true },
  });
  return stale !== null;
}

/**
 * The number with the century version 1 read it with on a day: the latest
 * year not after that day's, judged by the year alone and not the birthday.
 * That is today's reading on the last day of the same year, when every birth
 * date of the year has come.
 */
function byYearAlone(entered: string, day: Date): string {
  return withPersonalIdentityNumberCentury(
    entered,
    new Date(day.getFullYear(), 11, 31),
  );
}

/** The time a job says its runs began failing, or null where it says none. */
function readFailingSince(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}
