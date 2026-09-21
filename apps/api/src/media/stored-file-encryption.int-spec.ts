import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../app.module";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { StorageService } from "../storage/storage.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { pdfBytes } from "./testing/document-fixtures";
import { MediaService } from "./media.service";
import { StoredFileEncryptionService } from "./stored-file-encryption.service";

/**
 * The job that encrypts the files stored before stored files were encrypted,
 * against a real database and the local driver on a data directory of its own.
 *
 * The files are planted the way the upload wrote them before: the bytes as
 * uploaded, under a key with an extension, and a row with no encryption and
 * the plain SHA-256. What only this suite can show is the whole of it on real
 * files: the object on disk replaced, the row switched by the database's own
 * conditional update, the file still served byte for byte, and the CHECK that
 * keeps a row's key and its encryption in step. The job's start-up hook skips
 * under test, so the suite drives it.
 */

const baseEnv = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let storage: StorageService;
let media: MediaService;
let job: StoredFileEncryptionService;
let dataDir: string;

const suffix = process.hrtime.bigint().toString(36);
const fileIds: string[] = [];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A PDF of three chunks and a bit, different for every call. */
function largeDocument(): Buffer {
  return Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.from(randomUUID().repeat(6000), "latin1"),
    Buffer.from("\n%%EOF\n", "latin1"),
  ]);
}

/** Where the local driver keeps the object at a storage key. */
function onDisk(storageKey: string): string {
  return join(dataDir, "uploads", storageKey);
}

/** A file as it was stored before stored files were encrypted. */
async function plant(
  bytes: Buffer,
  options: { withObject?: boolean; checksum?: string } = {},
): Promise<{ id: string; storageKey: string }> {
  const id = `sfe-${suffix}-${String(fileIds.length)}`;
  const storageKey = `documents/2026/09/${randomUUID()}.pdf`;
  fileIds.push(id);
  if (options.withObject !== false) {
    await storage.put(storageKey, bytes, "application/pdf");
  }
  await prisma.mediaFile.create({
    data: {
      id,
      storageKey,
      encryption: "NONE",
      contentType: "application/pdf",
      byteSize: bytes.length,
      checksum: options.checksum ?? sha256(bytes),
      fileName: "protokoll.pdf",
      visibility: "PUBLIC",
    },
  });
  return { id, storageKey };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "openbrf-stored-file-encryption-"));
  const env: Env = {
    ...baseEnv,
    OPENBRF_STORAGE_DRIVER: "local",
    OPENBRF_DATA_DIR: dataDir,
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();

  prisma = app.get(PrismaService);
  storage = app.get(StorageService);
  media = app.get(MediaService);
  job = app.get(StoredFileEncryptionService);
}, 180_000);

afterAll(async () => {
  try {
    await prisma?.mediaFile.deleteMany({ where: { id: { in: fileIds } } });
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

describe("the files stored before stored files were encrypted", () => {
  let encrypted: { id: string; storageKey: string };
  let bytes: Buffer;
  let missing: { id: string; storageKey: string };
  let mismatched: { id: string; storageKey: string };
  let mismatchedBytes: Buffer;

  beforeAll(async () => {
    bytes = largeDocument();
    encrypted = await plant(bytes);
    missing = await plant(pdfBytes(), { withObject: false });
    mismatchedBytes = pdfBytes("1.4");
    mismatched = await plant(mismatchedBytes, {
      checksum: sha256(Buffer.from("a different file")),
    });

    // Refused while unencrypted, though its bytes are right there on disk.
    await expect(media.open(encrypted.id, null)).rejects.toMatchObject({
      reason: "not-found",
    });

    const run = await job.encryptRemaining();
    const mine = run.left.filter((left) => fileIds.includes(left.id));
    expect(run.encrypted).toBe(1);
    expect(mine.map((left) => left.id).sort()).toEqual(
      [missing.id, mismatched.id].sort(),
    );
  });

  it("is encrypted under a key of its own, in a new object, and the old one is gone", async () => {
    const row = await prisma.mediaFile.findUniqueOrThrow({
      where: { id: encrypted.id },
    });

    expect(row.encryption).toBe("SECRETSTREAM_64K");
    expect(row.dataKeyCipher).toMatch(/^brng:/);
    expect(row.unencryptedStorageKey).toBeNull();
    expect(row.storageKey).not.toBe(encrypted.storageKey);
    expect(row.storageKey).toMatch(/^documents\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    expect(row.checksum).toBe(
      await app.get(FieldEncryptionService).storedFileChecksum(bytes),
    );
    expect(existsSync(onDisk(encrypted.storageKey))).toBe(false);

    // The object on disk, read as the storage holds it.
    const stored = await readFile(onDisk(row.storageKey));
    expect(stored.includes(bytes.subarray(0, 64))).toBe(false);
    expect(stored.equals(bytes)).toBe(false);
  });

  it("is still served as the bytes that were uploaded", async () => {
    const served = await media.open(encrypted.id, null);

    expect((await buffer(served.stream)).equals(bytes)).toBe(true);
  });

  it("leaves a file whose object is gone as it was", async () => {
    const row = await prisma.mediaFile.findUniqueOrThrow({
      where: { id: missing.id },
    });

    expect(row.encryption).toBe("NONE");
    expect(row.storageKey).toBe(missing.storageKey);
  });

  it("leaves a file that does not match its checksum as it was, object and all", async () => {
    const row = await prisma.mediaFile.findUniqueOrThrow({
      where: { id: mismatched.id },
    });

    expect(row.encryption).toBe("NONE");
    expect(row.storageKey).toBe(mismatched.storageKey);
    expect(
      (await readFile(onDisk(mismatched.storageKey))).equals(mismatchedBytes),
    ).toBe(true);
    // And never serves it: an unencrypted row is refused as missing.
    await expect(media.open(mismatched.id, null)).rejects.toMatchObject({
      reason: "not-found",
    });
  });

  it("changes nothing on a second run", async () => {
    const before = await prisma.mediaFile.findMany({
      where: { id: { in: fileIds } },
      orderBy: { id: "asc" },
    });

    const run = await job.encryptRemaining();

    const after = await prisma.mediaFile.findMany({
      where: { id: { in: fileIds } },
      orderBy: { id: "asc" },
    });
    expect(run.encrypted).toBe(0);
    expect(after).toEqual(before);
  });

  it("refuses a file whose stored object was changed by a byte, as a missing file", async () => {
    const row = await prisma.mediaFile.findUniqueOrThrow({
      where: { id: encrypted.id },
    });
    const path = onDisk(row.storageKey);
    const original = await readFile(path);
    const changed = Buffer.from(original);
    changed[100] = (changed[100] ?? 0) ^ 0x01;
    await writeFile(path, changed);

    try {
      await expect(media.open(encrypted.id, null)).rejects.toMatchObject({
        reason: "not-found",
      });
    } finally {
      await writeFile(path, original);
    }
  });
});

describe("an unencrypted object that could not be removed", () => {
  it("stays named on its row until a later run removes it", async () => {
    const bytes = largeDocument();
    const planted = await plant(bytes);
    const remove = vi
      .spyOn(storage, "remove")
      .mockRejectedValueOnce(new Error("the disk is busy"));

    let first;
    try {
      first = await job.encryptRemaining();
    } finally {
      remove.mockRestore();
    }

    // Switched to the encrypted copy, with the old object still on disk and
    // named on the row by the same update that switched it.
    const switched = await prisma.mediaFile.findUniqueOrThrow({
      where: { id: planted.id },
    });
    expect(switched.encryption).toBe("SECRETSTREAM_64K");
    expect(switched.unencryptedStorageKey).toBe(planted.storageKey);
    expect(existsSync(onDisk(planted.storageKey))).toBe(true);
    expect(first.removalsPending).toEqual([planted.id]);
    // Served from the encrypted copy meanwhile.
    const served = await media.open(planted.id, null);
    expect((await buffer(served.stream)).equals(bytes)).toBe(true);

    const second = await job.encryptRemaining();

    const cleared = await prisma.mediaFile.findUniqueOrThrow({
      where: { id: planted.id },
    });
    expect(existsSync(onDisk(planted.storageKey))).toBe(false);
    expect(cleared.unencryptedStorageKey).toBeNull();
    expect(cleared.storageKey).toBe(switched.storageKey);
    expect(second.removed).toBeGreaterThanOrEqual(1);
    expect(second.removalsPending).not.toContain(planted.id);
  });
});

describe("the CHECK on a row's key and its encryption", () => {
  it("refuses an encrypted row without a key", async () => {
    await expect(
      prisma.mediaFile.create({
        data: {
          storageKey: `media/check-${suffix}-a`,
          encryption: "SECRETSTREAM_64K",
          dataKeyCipher: null,
          contentType: "image/png",
          byteSize: 1,
          checksum: "0".repeat(64),
          fileName: "a.png",
        },
      }),
    ).rejects.toThrow(/media_file_key_matches_encryption/);
  });

  it("refuses an unencrypted row with a key", async () => {
    await expect(
      prisma.mediaFile.create({
        data: {
          storageKey: `media/check-${suffix}-b`,
          encryption: "NONE",
          dataKeyCipher: "brng:not-a-real-one",
          contentType: "image/png",
          byteSize: 1,
          checksum: "0".repeat(64),
          fileName: "b.png",
        },
      }),
    ).rejects.toThrow(/media_file_key_matches_encryption/);
  });
});

describe("the CHECK on an unencrypted object waiting to be removed", () => {
  it("refuses one on a row that is not encrypted", async () => {
    await expect(
      prisma.mediaFile.create({
        data: {
          storageKey: `media/check-${suffix}-c`,
          encryption: "NONE",
          unencryptedStorageKey: `media/check-${suffix}-c-old`,
          contentType: "image/png",
          byteSize: 1,
          checksum: "0".repeat(64),
          fileName: "c.png",
        },
      }),
    ).rejects.toThrow(/media_file_unencrypted_key_only_when_replaced/);
  });

  it("refuses one that names the encrypted object itself", async () => {
    await expect(
      prisma.mediaFile.create({
        data: {
          storageKey: `media/check-${suffix}-d`,
          encryption: "SECRETSTREAM_64K",
          dataKeyCipher: "brng:not-a-real-one",
          unencryptedStorageKey: `media/check-${suffix}-d`,
          contentType: "image/png",
          byteSize: 1,
          checksum: "0".repeat(64),
          fileName: "d.png",
        },
      }),
    ).rejects.toThrow(/media_file_unencrypted_key_only_when_replaced/);
  });
});
