import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { normalizePersonalIdentityNumber } from "@openbrf/shared";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { FieldEncryptionService } from "./field-encryption.service";
import { NORMALIZATION_VERSION } from "./personal-data";

/**
 * Recomputing the blind index of every stored personal identity number written
 * under an older normalization.
 *
 * The index is a hash of the normalized number, so a change to how a number is
 * normalized leaves every index written before it describing the old form. A
 * lookup of the same number then computes the new form and finds nothing: the
 * import creates a person who is already in the register. Each person records
 * the normalization version their index was written under
 * (`personalIdentityNumberIndexVersion`), and this walks the ones below the
 * current version, decrypts the number and writes the index again.
 *
 * A job rather than a migration because the index needs the key and Argon2id,
 * neither of which SQL has; and a job rather than a step at start-up because
 * Argon2id costs 43.8 ms a number by design, which on a large register is
 * minutes (ADR 0002). Until it has run, a changed number is not found by a
 * lookup - which is how it already was before the change.
 *
 * It ends by itself: every person it reaches is written at the current
 * version, so the walk runs out, and the next start finds nothing to do.
 *
 * A number written without its century is dated by the day it was written,
 * not by today: `250101-1231` entered in 2000 is a person born in 1925, and
 * read today it would be one born in 2025. That day is not stored, but the
 * day the person was entered is no later than it, and nobody is entered
 * before they were born, so the most recent birth date on or before that day
 * is the one meant. That is what the number was given when it was written,
 * unless the old rule then put the birth date in the future, which is what
 * this corrects. A number written with `+` or with its century reads the same
 * now as then, and is read as of today.
 */

/** A number written without its century and without a plus. */
const DATED_BY_ITS_WRITING = /^\d{6}-?\d{4}$/;

/** Queue the walk runs on. */
export const IDENTITY_NUMBER_REINDEX_QUEUE = "identity-number-reindex";

/**
 * Persons read and written at a time. Small, because each one is a decrypt and
 * an Argon2id hash, and nothing is held open while they are computed.
 */
const BATCH = 50;

@Injectable()
export class IdentityNumberReindexService implements OnModuleInit {
  private readonly logger = new Logger(IdentityNumberReindexService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the walk themselves.
      return;
    }
    await this.jobs.work(IDENTITY_NUMBER_REINDEX_QUEUE, async () => {
      await this.reindex();
    });
    if (await this.outdated()) {
      await this.jobs.send(IDENTITY_NUMBER_REINDEX_QUEUE, {});
    }
  }

  /**
   * Writes the index of every outdated number again. Public so a test can
   * drive it. Answers how many numbers it reached, and how many of them the
   * current normalization no longer reads.
   */
  async reindex(): Promise<{ reindexed: number; unreadable: number }> {
    let reindexed = 0;
    let unreadable = 0;
    // Persons this walk could not reach, so a row that keeps failing is passed
    // over rather than read again forever.
    const failed: string[] = [];

    for (;;) {
      const persons = await this.prisma.person.findMany({
        where: {
          personalIdentityNumberCipher: { not: null },
          personalIdentityNumberIndexVersion: { lt: NORMALIZATION_VERSION },
          id: { notIn: failed },
        },
        select: {
          id: true,
          personalIdentityNumberCipher: true,
          createdAt: true,
        },
        orderBy: { id: "asc" },
        take: BATCH,
      });
      if (persons.length === 0) {
        break;
      }

      for (const person of persons) {
        const cipher = person.personalIdentityNumberCipher;
        if (cipher === null) {
          continue;
        }
        try {
          const number = await this.encryption.decrypt(
            "person.personalIdentityNumber",
            cipher,
          );
          const written = DATED_BY_ITS_WRITING.test(number.replace(/\s/g, ""))
            ? person.createdAt
            : new Date();
          const normalized = normalizePersonalIdentityNumber(number, written);
          const index =
            normalized === null
              ? null
              : await this.encryption.computeIndex(
                  "person.personalIdentityNumber",
                  normalized,
                );
          // Conditional on the ciphertext, so a number replaced while this one
          // was being hashed keeps the index its own writer gave it.
          await this.prisma.person.updateMany({
            where: { id: person.id, personalIdentityNumberCipher: cipher },
            data: {
              personalIdentityNumberIndex: index,
              personalIdentityNumberIndexVersion: NORMALIZATION_VERSION,
            },
          });
          reindexed++;
          if (index === null) {
            unreadable++;
          }
        } catch (error) {
          failed.push(person.id);
          // Named by its class and the person's id: what failed to decrypt is
          // an identity number.
          this.logger.error(
            `Person ${person.id}: identity number index not rewritten (${failureName(error)})`,
          );
        }
      }
    }

    if (reindexed > 0) {
      this.logger.log(
        `Rewrote the index of ${String(reindexed)} personal identity numbers` +
          (unreadable > 0
            ? `; ${String(unreadable)} are stored in a form the current rules do not read, are kept as stored, and are not found by a search on the number`
            : ""),
      );
    }
    return { reindexed, unreadable };
  }

  private async outdated(): Promise<boolean> {
    const count = await this.prisma.person.count({
      where: {
        personalIdentityNumberCipher: { not: null },
        personalIdentityNumberIndexVersion: { lt: NORMALIZATION_VERSION },
      },
    });
    return count > 0;
  }
}
