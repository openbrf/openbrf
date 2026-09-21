import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { buffer } from "node:stream/consumers";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import {
  openSealedFile,
  SEALED_FILE_CONTENT_TYPE,
} from "../crypto/stored-file-cipher";
import { PrismaService } from "../database/prisma.service";
import { generateStorageKey } from "../storage/storage-key";
import { StorageService } from "../storage/storage.service";
import { sealForStorage, unwrapFileKey } from "./media.service";

/** What one run of the job did. */
export interface StoredFileEncryptionRun {
  /** Files now held encrypted that were not before the run. */
  encrypted: number;
  /** Files left exactly as they were, by id, each with the reason. */
  left: { id: string; reason: string }[];
}

/** The row fields the job reads. */
interface UnencryptedFile {
  id: string;
  storageKey: string;
  byteSize: number;
  checksum: string;
}

/**
 * Encrypts every stored file still held as it was uploaded (ADR 0015).
 *
 * Runs once at start, before the server listens, so no request reaches a file
 * it is rewriting. It has work only on a database written before stored files
 * were encrypted, because nothing writes an unencrypted row any longer, and it
 * returns at once everywhere else. Blocking start on it is cheap because no
 * live instance held files before this: on a bucket of thousands it would
 * outlast the health check. It goes, with the NONE value, once no database
 * holds a NONE row.
 *
 * One file at a time, and never in a way that loses one. The sealed copy is
 * written under a new storage key, read back and opened, and only then is the
 * row switched to it, by an update that holds only if the row still names the
 * old key and is still unencrypted; the old object is removed last. A crash
 * anywhere leaves a row that opens: either still unencrypted with its object in
 * place, which the next start retries, or switched to a copy known to open.
 *
 * A file left unencrypted is never served: MediaService.open refuses a NONE
 * row as missing. Writes no audit entry, because it changes how the bytes are
 * held and not what they are or who may read them.
 */
@Injectable()
export class StoredFileEncryptionService implements OnModuleInit {
  private readonly logger = new Logger(StoredFileEncryptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly encryption: FieldEncryptionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration suites drive the job themselves, so a boot does not
      // rewrite files a suite is in the middle of arranging.
      return;
    }
    try {
      await this.encryptRemaining();
    } catch (cause) {
      // Logged and swallowed: the instance serves every encrypted file, refuses
      // the rest as missing, and the next start runs the job again.
      this.logger.error(
        "Could not encrypt the stored files left unencrypted; the next start tries again.",
        cause instanceof Error ? cause.stack : undefined,
      );
    }
  }

  /** Encrypts every unencrypted file it can. Public so a test can drive it. */
  async encryptRemaining(): Promise<StoredFileEncryptionRun> {
    const remaining = await this.prisma.mediaFile.findMany({
      where: { encryption: "NONE" },
      orderBy: { createdAt: "asc" },
      select: { id: true, storageKey: true, byteSize: true, checksum: true },
    });
    const run: StoredFileEncryptionRun = { encrypted: 0, left: [] };
    if (remaining.length === 0) {
      return run;
    }

    for (const file of remaining) {
      const reason = await this.encryptOne(file).catch(
        () => "it could not be encrypted.",
      );
      if (reason === null) {
        run.encrypted += 1;
      } else {
        run.left.push({ id: file.id, reason });
      }
    }

    this.logger.log(
      `Encrypted ${String(run.encrypted)} stored files; left ${String(run.left.length)} as they were.`,
    );
    for (const { id, reason } of run.left) {
      this.logger.error(`Left the file ${id} unencrypted: ${reason}`);
    }
    return run;
  }

  /** Encrypts one file, or says why it was left as it was. */
  private async encryptOne(file: UnencryptedFile): Promise<string | null> {
    let bytes: Buffer;
    try {
      const stored = await this.storage.open(file.storageKey);
      if (stored === null) {
        return "its object is not in storage.";
      }
      // Bounded by the upload that wrote it.
      bytes = await buffer(stored);
    } catch {
      return "its object could not be read.";
    }

    // Checked against the size and the SHA-256 the row was written with, before
    // anything is written: a file that is not the one its row describes is left
    // for somebody to look at rather than sealed as if it were.
    if (
      bytes.length !== file.byteSize ||
      createHash("sha256").update(bytes).digest("hex") !== file.checksum
    ) {
      return "its object does not match its recorded size and checksum.";
    }

    const sealed = await sealForStorage(this.encryption, bytes);
    // Never the old key: a crash between this write and the row update would
    // leave an unencrypted row pointing at ciphertext nothing could read.
    const storageKey = generateStorageKey(
      prefixOf(file.storageKey),
      SEALED_FILE_CONTENT_TYPE,
    );
    await this.storage.put(storageKey, sealed.body, SEALED_FILE_CONTENT_TYPE);

    const opens = await this.opensTo(
      storageKey,
      sealed.dataKeyCipher,
      bytes,
    ).catch(() => false);
    if (!opens) {
      await this.removeQuietly(storageKey);
      return "its encrypted copy did not open to the same bytes.";
    }

    const { count } = await this.prisma.mediaFile.updateMany({
      where: { id: file.id, storageKey: file.storageKey, encryption: "NONE" },
      data: {
        storageKey,
        encryption: "SECRETSTREAM_64K",
        dataKeyCipher: sealed.dataKeyCipher,
        checksum: sealed.checksum,
      },
    });
    if (count === 0) {
      // Removed or rewritten meanwhile; the encrypted copy belongs to no row.
      await this.removeQuietly(storageKey);
      return "its row changed while it was being encrypted.";
    }

    await this.storage.remove(file.storageKey).catch(() => {
      // The one leftover the job can produce, and named so it can be found.
      this.logger.error(
        `Encrypted the file ${file.id} but could not remove its unencrypted object at ${file.storageKey}.`,
      );
    });
    return null;
  }

  /** Whether the object at a key opens, under the wrapped key, to `bytes`. */
  private async opensTo(
    storageKey: string,
    dataKeyCipher: string,
    bytes: Buffer,
  ): Promise<boolean> {
    const stored = await this.storage.open(storageKey);
    if (stored === null) {
      return false;
    }
    const key = await unwrapFileKey(this.encryption, dataKeyCipher);
    const opened = openSealedFile(key, bytes.length);
    const [, plaintext] = await Promise.all([
      pipeline(stored, opened),
      buffer(opened),
    ]);
    return plaintext.equals(bytes);
  }

  private async removeQuietly(storageKey: string): Promise<void> {
    await this.storage.remove(storageKey).catch(() => {
      this.logger.warn(`Left an unreferenced object at ${storageKey}.`);
    });
  }
}

/**
 * The prefix a replacement object is stored under: the old key's own when it
 * is one the upload writes, and the general one otherwise.
 */
function prefixOf(storageKey: string): "branding" | "documents" | "media" {
  const first = storageKey.split("/", 1)[0];
  return first === "branding" || first === "documents" ? first : "media";
}
