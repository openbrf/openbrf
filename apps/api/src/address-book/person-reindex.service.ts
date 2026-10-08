import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import {
  type EncryptedFieldId,
  type EncryptedValue,
  FieldEncryptionService,
} from "../crypto/field-encryption.service";
import { NORMALIZATION_VERSION } from "../crypto/personal-data";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";

export const PERSON_REINDEX_QUEUE = "person-blind-index-reindex";

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
 * recomputed here, from the ciphertexts, which hold each value as entered. The
 * email is left alone because its rules have not changed.
 *
 * A personal identity number is encrypted again as well. One entered without
 * its century was stored that way, and an index computed from it holds only
 * until the day it is read on passes the birthday it carries: from then on the
 * same digits are read as another person. So the century it is read with now is
 * written into the ciphertext, the form every number has been stored in since,
 * and a later reindex reads the same person from it whatever the date.
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
        },
        take: BATCH,
      });
      if (people.length === 0) {
        break;
      }
      for (const person of people) {
        const identityNumber = await this.reencrypt(
          "person.personalIdentityNumber",
          person.personalIdentityNumberCipher,
        );
        const { count } = await this.prisma.person.updateMany({
          where: person,
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

  /** Encrypted again in the form encrypt stores it today, with its index. */
  private async reencrypt(
    id: EncryptedFieldId,
    cipher: string | null,
  ): Promise<EncryptedValue | null> {
    return cipher === null
      ? null
      : this.encryption.encrypt(id, await this.encryption.decrypt(id, cipher));
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
