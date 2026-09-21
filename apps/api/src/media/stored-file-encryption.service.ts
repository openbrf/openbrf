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
  SealedFileError,
} from "../crypto/stored-file-cipher";
import { PrismaService } from "../database/prisma.service";
import { failureFrames, failureName } from "../logging/failure";
import { generateStorageKey } from "../storage/storage-key";
import { StorageService } from "../storage/storage.service";
import { sealForStorage, unwrapFileKey } from "./media.service";

/** What one run of the job did. */
export interface StoredFileEncryptionRun {
  /** Files now held encrypted that were not before the run. */
  encrypted: number;
  /** Files left exactly as they were, by id, each with the reason. */
  left: { id: string; reason: string }[];
  /** Unencrypted objects removed, whichever run replaced them. */
  removed: number;
  /**
   * Files whose unencrypted object is still in storage, by id. Each is
   * recorded on its row, and the next run tries the removal again.
   */
  removalsPending: string[];
}

/** The row fields the job reads to encrypt a file. */
interface UnencryptedFile {
  id: string;
  storageKey: string;
  byteSize: number;
  checksum: string;
}

/** A run that could not be carried out, which stops the start. */
export class StoredFileEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredFileEncryptionError";
  }
}

/**
 * Encrypts every stored file still held as it was uploaded (ADR 0015).
 *
 * Runs once at start, before the server listens, so no request reaches a file
 * it is rewriting. It has work only on a database written before stored files
 * were encrypted, because nothing writes an unencrypted row any longer, and it
 * returns at once everywhere else. Blocking start on it is cheap because no
 * live instance held files before this: on a bucket of thousands it would
 * outlast the health check. It goes, with the NONE value and the
 * unencryptedStorageKey column, once no database holds either.
 *
 * One file at a time, and never in a way that loses one. The sealed copy is
 * written under a new storage key, read back and opened, and only then is the
 * row switched to it, by an update that holds only if the row still names the
 * old key and is still unencrypted. The same update records the old key in
 * unencryptedStorageKey, and the unencrypted object is removed after it; the
 * record is cleared once the removal has succeeded. A crash anywhere leaves a
 * row that opens, either still unencrypted with its object in place or switched
 * to a copy known to open, and an unencrypted object that is still in storage
 * is always named on its row, where every run looks for it first.
 *
 * Two kinds of failure, told apart on purpose. A fact about one file - its
 * object is gone, or does not match its recorded size and checksum - leaves
 * that file as it was, logged by id, and the run goes on: stopping the start on
 * it would keep the instance down for as long as that one file exists. A
 * failure of the run itself - the database or the storage not answering, or a
 * key that cannot be wrapped - stops the start. Serving through it would answer
 * every file still unencrypted as missing while the log scrolled past the
 * reason, and it costs nothing on any other start, because the job only has
 * work while an unencrypted file is left.
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
      // The class and the frames, never the message: a storage or database
      // error composes its message from what it was handling (ADR 0007).
      this.logger.error(
        `Could not finish encrypting the stored files, so the instance does not start: ${failureName(cause)}`,
        failureFrames(cause),
      );
      throw new StoredFileEncryptionError(
        "The stored files could not all be encrypted; see the log line before this one.",
      );
    }
  }

  /**
   * Removes the unencrypted objects an earlier run left, then encrypts every
   * unencrypted file it can. Throws when the run itself cannot be carried out.
   * Public so a test can drive it.
   */
  async encryptRemaining(): Promise<StoredFileEncryptionRun> {
    const run: StoredFileEncryptionRun = {
      encrypted: 0,
      left: [],
      removed: 0,
      removalsPending: [],
    };

    const replaced = await this.prisma.mediaFile.findMany({
      where: { unencryptedStorageKey: { not: null } },
      select: { id: true, unencryptedStorageKey: true },
    });
    for (const file of replaced) {
      if (file.unencryptedStorageKey !== null) {
        await this.removeUnencrypted(file.id, file.unencryptedStorageKey, run);
      }
    }

    const remaining = await this.prisma.mediaFile.findMany({
      where: { encryption: "NONE" },
      orderBy: { createdAt: "asc" },
      select: { id: true, storageKey: true, byteSize: true, checksum: true },
    });
    for (const file of remaining) {
      const reason = await this.encryptOne(file, run);
      if (reason === null) {
        run.encrypted += 1;
      } else {
        run.left.push({ id: file.id, reason });
      }
    }

    if (replaced.length > 0 || remaining.length > 0) {
      this.logger.log(
        `Encrypted ${String(run.encrypted)} stored files and left ${String(run.left.length)} as they were; ` +
          `removed ${String(run.removed)} unencrypted objects, and ${String(run.removalsPending.length)} are still to be removed.`,
      );
    }
    for (const { id, reason } of run.left) {
      this.logger.error(`Left the file ${id} unencrypted: ${reason}`);
    }
    return run;
  }

  /**
   * Encrypts one file, or says why it was left as it was. A failure that is
   * not about this file is thrown, and ends the run.
   */
  private async encryptOne(
    file: UnencryptedFile,
    run: StoredFileEncryptionRun,
  ): Promise<string | null> {
    const stored = await this.storage.open(file.storageKey);
    if (stored === null) {
      return "its object is not in storage.";
    }
    // Bounded by the upload that wrote it.
    const bytes = await buffer(stored);

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

    if (!(await this.opensTo(storageKey, sealed.dataKeyCipher, bytes))) {
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
        // In this update and not a later one, so there is no moment at which
        // the row has let go of the unencrypted object without naming it.
        unencryptedStorageKey: file.storageKey,
      },
    });
    if (count === 0) {
      // Removed or rewritten meanwhile; the encrypted copy belongs to no row.
      await this.removeQuietly(storageKey);
      return "its row changed while it was being encrypted.";
    }

    await this.removeUnencrypted(file.id, file.storageKey, run);
    return null;
  }

  /**
   * Removes a replaced unencrypted object and clears its record, or leaves the
   * record for the next run. A failed removal does not stop the start: the file
   * is served encrypted either way, and the object is named on its row until it
   * is gone.
   */
  private async removeUnencrypted(
    id: string,
    storageKey: string,
    run: StoredFileEncryptionRun,
  ): Promise<void> {
    try {
      await this.storage.remove(storageKey);
    } catch (cause) {
      this.logger.error(
        `Could not remove the unencrypted object of the file ${id}; it stays recorded on the row and the next start tries again: ${failureName(cause)}`,
      );
      run.removalsPending.push(id);
      return;
    }
    await this.prisma.mediaFile.updateMany({
      where: { id, unencryptedStorageKey: storageKey },
      data: { unencryptedStorageKey: null },
    });
    run.removed += 1;
  }

  /**
   * Whether the object at a key opens, under the wrapped key, to `bytes`.
   * False for a copy that does not verify; a storage failure is thrown.
   */
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
    try {
      const [, plaintext] = await Promise.all([
        pipeline(stored, opened),
        buffer(opened),
      ]);
      return plaintext.equals(bytes);
    } catch (cause) {
      if (cause instanceof SealedFileError) {
        return false;
      }
      throw cause;
    }
  }

  /** Removes an encrypted copy that belongs to no row. */
  private async removeQuietly(storageKey: string): Promise<void> {
    await this.storage.remove(storageKey).catch(() => {
      // Ciphertext whose key was never written anywhere: it opens for nobody.
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
