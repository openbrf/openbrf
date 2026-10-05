import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import { EncryptionKeyProvider } from "./encryption-key.provider";

const directories: string[] = [];

function env(): Env {
  const dataDir = mkdtempSync(join(tmpdir(), "openbrf-key-"));
  directories.push(dataDir);
  return { NODE_ENV: "development", OPENBRF_DATA_DIR: dataDir } as Env;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("generating the development key", () => {
  it("keeps a key another process wrote first, rather than replacing it", () => {
    const settings = env();
    const keyPath = EncryptionKeyProvider.keyFilePath(settings);
    const theirs = "ab".repeat(32);
    // Written between this process finding no key and writing its own.
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, `${theirs}\n`);

    const generate = (
      EncryptionKeyProvider as unknown as {
        generateKeyFile: (path: string, env: Env) => string;
      }
    ).generateKeyFile.bind(EncryptionKeyProvider);

    expect(generate(keyPath, settings)).toBe(theirs);
    expect(readFileSync(keyPath, "utf8").trim()).toBe(theirs);
  });

  it("writes a key when none exists, and reads the same one back", () => {
    const settings = env();

    const key = EncryptionKeyProvider.resolve(settings);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(EncryptionKeyProvider.resolve(settings)).toBe(key);
  });
});
