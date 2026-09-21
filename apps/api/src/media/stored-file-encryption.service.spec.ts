import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { openSealedFile } from "../crypto/stored-file-cipher";
import type { PrismaService } from "../database/prisma.service";
import type { StorageService } from "../storage/storage.service";
import { unwrapFileKey } from "./media.service";
import { StoredFileEncryptionService } from "./stored-file-encryption.service";
import { pdfBytes } from "./testing/document-fixtures";

/**
 * The job that encrypts files stored before stored files were encrypted, over
 * a fake database and a fake storage driver and the real field encryption.
 *
 * What these cases hold it to is that it never loses a file: a row is switched
 * only to a copy known to open, a file that is not what its row says is left
 * alone, and a row that changed under it keeps what it changed to.
 */

const TEST_ENV = {
  NODE_ENV: "development",
  OPENBRF_ENCRYPTION_KEY: "f".repeat(64),
} as Env;

interface Row {
  id: string;
  storageKey: string;
  encryption: "NONE" | "SECRETSTREAM_64K";
  dataKeyCipher: string | null;
  byteSize: number;
  checksum: string;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function build(options: { rowChangesBeforeUpdate?: boolean; env?: Env } = {}) {
  const rows = new Map<string, Row>();
  const objects = new Map<string, Buffer>();
  const encryption = new FieldEncryptionService(TEST_ENV);

  const storage = {
    put: vi.fn(async (key: string, body: Buffer) => {
      objects.set(key, body);
    }),
    open: vi.fn(async (key: string) => {
      const stored = objects.get(key);
      return stored === undefined ? null : Readable.from([stored]);
    }),
    remove: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };

  const mediaFile = {
    findMany: vi.fn(async () =>
      [...rows.values()]
        .filter((row) => row.encryption === "NONE")
        .map((row) => ({ ...row })),
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; storageKey: string; encryption: "NONE" };
        data: Partial<Row>;
      }) => {
        if (options.rowChangesBeforeUpdate === true) {
          rows.delete(where.id);
        }
        const row = rows.get(where.id);
        if (
          row === undefined ||
          row.storageKey !== where.storageKey ||
          row.encryption !== where.encryption
        ) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    ),
  };

  const service = new StoredFileEncryptionService(
    { mediaFile } as unknown as PrismaService,
    storage as unknown as StorageService,
    encryption,
    options.env ?? TEST_ENV,
  );
  const logger = (
    service as unknown as {
      logger: { log: () => void; error: (message: string) => void };
    }
  ).logger;
  const errors: string[] = [];
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation((message: string) => {
    errors.push(message);
  });

  /** A file as it was stored before stored files were encrypted. */
  function plant(id: string, bytes: Buffer, storageKey: string): void {
    objects.set(storageKey, bytes);
    rows.set(id, {
      id,
      storageKey,
      encryption: "NONE",
      dataKeyCipher: null,
      byteSize: bytes.length,
      checksum: sha256(bytes),
    });
  }

  return {
    service,
    rows,
    objects,
    storage,
    mediaFile,
    encryption,
    errors,
    plant,
  };
}

describe("encrypting the files stored before", () => {
  it("replaces the unencrypted object with a sealed copy that opens to it", async () => {
    const job = build();
    const bytes = pdfBytes();
    job.plant("file-1", bytes, "documents/2026/09/aaaa.pdf");

    const run = await job.service.encryptRemaining();

    const row = job.rows.get("file-1");
    expect(run).toEqual({ encrypted: 1, left: [] });
    expect(row?.encryption).toBe("SECRETSTREAM_64K");
    // Under a new key in the same feature's prefix, and without an extension.
    expect(row?.storageKey).toMatch(/^documents\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    expect(job.objects.has("documents/2026/09/aaaa.pdf")).toBe(false);
    expect([...job.objects.keys()]).toEqual([row?.storageKey]);

    const sealed = job.objects.get(row?.storageKey ?? "") ?? Buffer.alloc(0);
    expect(sealed.includes(bytes)).toBe(false);
    const key = await unwrapFileKey(job.encryption, row?.dataKeyCipher ?? "");
    const opener = openSealedFile(key, bytes.length);
    opener.end(sealed);
    expect((await buffer(opener)).equals(bytes)).toBe(true);
  });

  it("replaces the plain SHA-256 with the keyed checksum", async () => {
    const job = build();
    const bytes = pdfBytes();
    job.plant("file-1", bytes, "media/2026/09/bbbb.png");

    await job.service.encryptRemaining();

    expect(job.rows.get("file-1")?.checksum).toBe(
      await job.encryption.storedFileChecksum(bytes),
    );
  });

  it("leaves a file whose object does not match its checksum exactly as it was", async () => {
    const job = build();
    const bytes = pdfBytes();
    job.plant("file-1", bytes, "media/2026/09/cccc.png");
    const row = job.rows.get("file-1");
    if (row !== undefined) {
      row.checksum = sha256(Buffer.from("another file"));
    }

    const run = await job.service.encryptRemaining();

    expect(run.encrypted).toBe(0);
    expect(run.left).toEqual([
      {
        id: "file-1",
        reason: "its object does not match its recorded size and checksum.",
      },
    ]);
    expect(job.rows.get("file-1")?.encryption).toBe("NONE");
    expect(job.objects.get("media/2026/09/cccc.png")).toEqual(bytes);
    expect(job.storage.put).not.toHaveBeenCalled();
    expect(job.errors).toContainEqual(
      expect.stringContaining("Left the file file-1 unencrypted"),
    );
  });

  it("leaves a file whose object is gone, and says so by id", async () => {
    const job = build();
    job.plant("file-1", pdfBytes(), "media/2026/09/dddd.png");
    job.objects.clear();

    const run = await job.service.encryptRemaining();

    expect(run.left).toEqual([
      { id: "file-1", reason: "its object is not in storage." },
    ]);
    expect(job.storage.put).not.toHaveBeenCalled();
  });

  it("leaves no new object behind when the row goes between the read and the update", async () => {
    const job = build({ rowChangesBeforeUpdate: true });
    job.plant("file-1", pdfBytes(), "media/2026/09/eeee.png");

    const run = await job.service.encryptRemaining();

    expect(run.left).toEqual([
      { id: "file-1", reason: "its row changed while it was being encrypted." },
    ]);
    // The sealed copy was written, found to belong to no row, and removed;
    // the old object is the removal's to deal with, not the job's.
    expect([...job.objects.keys()]).toEqual(["media/2026/09/eeee.png"]);
  });

  it("returns at once on a database that holds no unencrypted file", async () => {
    const job = build();

    const run = await job.service.encryptRemaining();

    expect(run).toEqual({ encrypted: 0, left: [] });
    expect(job.storage.open).not.toHaveBeenCalled();
    expect(job.storage.put).not.toHaveBeenCalled();
    expect(job.mediaFile.updateMany).not.toHaveBeenCalled();
  });

  it("changes nothing on a second run", async () => {
    const job = build();
    job.plant("file-1", pdfBytes(), "media/2026/09/ffff.png");
    await job.service.encryptRemaining();
    const after = { ...job.rows.get("file-1") };

    const run = await job.service.encryptRemaining();

    expect(run).toEqual({ encrypted: 0, left: [] });
    expect(job.rows.get("file-1")).toEqual(after);
    expect(job.storage.put).toHaveBeenCalledTimes(1);
  });
});

describe("running at start", () => {
  it("does nothing under test, where the suites drive it themselves", async () => {
    const job = build({ env: { ...TEST_ENV, NODE_ENV: "test" } });
    job.plant("file-1", pdfBytes(), "media/2026/09/gggg.png");

    await job.service.onModuleInit();

    expect(job.mediaFile.findMany).not.toHaveBeenCalled();
    expect(job.rows.get("file-1")?.encryption).toBe("NONE");
  });

  it("encrypts what is left before the application goes on", async () => {
    const job = build();
    job.plant("file-1", pdfBytes(), "media/2026/09/hhhh.png");

    await job.service.onModuleInit();

    expect(job.rows.get("file-1")?.encryption).toBe("SECRETSTREAM_64K");
  });

  it("logs a failure and lets the application start, so the next start retries", async () => {
    const job = build();
    job.mediaFile.findMany.mockRejectedValueOnce(new Error("no database"));

    await expect(job.service.onModuleInit()).resolves.toBeUndefined();
    expect(job.errors).toContainEqual(
      expect.stringContaining("the next start tries again"),
    );
  });
});
