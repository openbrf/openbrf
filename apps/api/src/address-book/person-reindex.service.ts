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
import { JobQueueService } from "../jobs/job-queue.service";

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
 */
@Injectable()
export class PersonReindexService implements OnModuleInit {
  private readonly logger = new Logger(PersonReindexService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests call run() themselves.
      return;
    }
    await this.jobs.work(PERSON_REINDEX_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.send(PERSON_REINDEX_QUEUE, {});
  }

  /** Reindexes every person below the current version. Answers how many. */
  async run(): Promise<number> {
    let reindexed = 0;
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
        const identityNumber = await this.identityNumber(person);
        const { count } = await this.prisma.person.updateMany({
          where: {
            id: person.id,
            phoneCipher: person.phoneCipher,
            personalIdentityNumberCipher: person.personalIdentityNumberCipher,
          },
          data: {
            phoneIndex: await this.indexOf("person.phone", person.phoneCipher),
            personalIdentityNumberCipher: identityNumber?.cipher ?? null,
            personalIdentityNumberIndex: identityNumber?.index ?? null,
            blindIndexVersion: NORMALIZATION_VERSION,
          },
        });
        reindexed += count;
      }
    }
    if (reindexed > 0) {
      this.logger.log(
        `Reindexed ${String(reindexed)} people under normalisation version ${String(NORMALIZATION_VERSION)}`,
      );
    }
    return reindexed;
  }

  /** The personal identity number encrypted again with its century, and its index. */
  private async identityNumber(
    person: StoredPerson,
  ): Promise<EncryptedValue | null> {
    if (person.personalIdentityNumberCipher === null) {
      return null;
    }
    const entered = await this.encryption.decrypt(
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

  private async indexOf(
    id: EncryptedFieldId,
    cipher: string | null,
  ): Promise<string | null> {
    return cipher === null
      ? null
      : this.encryption.computeIndex(
          id,
          await this.encryption.decrypt(id, cipher),
        );
  }
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
