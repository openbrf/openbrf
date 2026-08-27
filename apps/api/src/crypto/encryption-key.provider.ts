import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Logger } from "@nestjs/common";

import type { Env } from "../config/env";

const KEY_FILE_NAME = "field-encryption.key";
const KEY_LENGTH_BYTES = 32;
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

/**
 * Resolves the field encryption key (ADR 0002).
 *
 * Precedence, deliberately fixed so a deploy is predictable:
 *
 *   1. OPENBRF_ENCRYPTION_KEY, which lets a hosting platform inject the key
 *      without a writable volume.
 *   2. <data dir>/keys/field-encryption.key on the data volume.
 *   3. A freshly generated key written to that path.
 *
 * Losing this key loses every encrypted field. Backups must cover the key and
 * the database together; there is no recovery path from one without the other.
 */
export class EncryptionKeyProvider {
  private static readonly logger = new Logger(EncryptionKeyProvider.name);

  static keyFilePath(env: Env): string {
    return resolve(join(env.OPENBRF_DATA_DIR, "keys", KEY_FILE_NAME));
  }

  static resolve(env: Env): string {
    if (env.OPENBRF_ENCRYPTION_KEY !== undefined) {
      return env.OPENBRF_ENCRYPTION_KEY.toLowerCase();
    }

    const keyPath = this.keyFilePath(env);
    if (existsSync(keyPath)) {
      return this.readKeyFile(keyPath);
    }

    return this.generateKeyFile(keyPath, env);
  }

  private static readKeyFile(keyPath: string): string {
    const contents = readFileSync(keyPath, "utf8").trim();
    if (!HEX_KEY_PATTERN.test(contents)) {
      throw new EncryptionKeyError(
        `The key at ${keyPath} is not 32 bytes hex encoded. Refusing to start: ` +
          "continuing with a different key would make existing encrypted " +
          "fields permanently unreadable.",
      );
    }
    return contents.toLowerCase();
  }

  private static generateKeyFile(keyPath: string, env: Env): string {
    if (env.NODE_ENV === "production") {
      // A fresh key in production almost always means the volume is missing.
      // Generating one would quietly start an instance that cannot read the
      // data it is about to be pointed at, and the first write of an encrypted
      // field would replace a readable value with ciphertext under a key that
      // no backup knows about. Refuse instead.
      throw new EncryptionKeyError(
        `No encryption key found at ${keyPath}. Refusing to start in ` +
          "production: generating a key here would make existing encrypted " +
          "fields permanently unreadable. Restore the original key, or set " +
          "OPENBRF_ENCRYPTION_KEY.",
      );
    }

    const key = randomBytes(KEY_LENGTH_BYTES).toString("hex");
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, `${key}\n`, { encoding: "utf8", mode: 0o600 });
    this.logger.log(
      `Generated a new field encryption key at ${keyPath}. Back it up together ` +
        "with the database: losing it loses the encrypted data.",
    );
    return key;
  }
}
