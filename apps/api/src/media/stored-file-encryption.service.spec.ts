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
import {
  StoredFileEncryptionError,
  StoredFileEncryptionService,
} from "./stored-file-encryption.service";
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
  unencryptedStorageKey: string | null;
  byteSize: number;
  checksum: string;
}

/** Whether a row matches a where clause of plain equalities and `not: null`. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, expected]) => {
    const actual = row[field as keyof Row];
    if (
      typeof expected === "object" &&
      expected !== null &&
      "not" in expected &&
      (expected as { not: unknown }).not === null
    ) {
      return actual !== null && actual !== undefined;
    }
    return actual === expected;
  });
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
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...rows.values()]
        .filter((row) => matches(row, where))
        .map((row) => ({ ...row })),
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown> & { id: string };
        data: Partial<Row>;
      }) => {
        if (options.rowChangesBeforeUpdate === true) {
          rows.delete(where.id);
        }
        const row = rows.get(where.id);
        if (row === undefined || !matches(row, where)) {
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
      unencryptedStorageKey: null,
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
    expect(run).toEqual({
      encrypted: 1,
      left: [],
      removed: 1,
      removalsPending: [],
    });
    expect(row?.unencryptedStorageKey).toBeNull();
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

    expect(run).toEqual({
      encrypted: 0,
      left: [],
      removed: 0,
      removalsPending: [],
    });
    expect(job.storage.open).not.toHaveBeenCalled();
    expect(job.storage.put).not.toHaveBeenCalled();
    expect(job.mediaFile.updateMany).not.toHaveBeenCalled();
  });

  it("keeps the unencrypted object's key on the row when it cannot be removed, and removes it on the next run", async () => {
    /*
     * The one leftover the job can make is the unencrypted object it has just
     * replaced, and it is exactly what the work exists to get rid of. So the
     * old key goes onto the row in the same update that switches the row to
     * the encrypted copy, and it comes off only once the object is gone.
     */
    const job = build();
    const oldKey = "media/2026/09/iiii.png";
    job.plant("file-1", pdfBytes(), oldKey);
    job.storage.remove.mockRejectedValueOnce(new Error("the disk is busy"));

    const first = await job.service.encryptRemaining();

    const update = job.mediaFile.updateMany.mock.calls[0]?.[0];
    expect(update?.data.unencryptedStorageKey).toBe(oldKey);
    expect(job.rows.get("file-1")?.encryption).toBe("SECRETSTREAM_64K");
    expect(job.rows.get("file-1")?.unencryptedStorageKey).toBe(oldKey);
    expect(job.objects.has(oldKey)).toBe(true);
    expect(first.removalsPending).toEqual(["file-1"]);

    const second = await job.service.encryptRemaining();

    expect(job.objects.has(oldKey)).toBe(false);
    expect(job.rows.get("file-1")?.unencryptedStorageKey).toBeNull();
    expect(second.removed).toBe(1);
    expect(second.removalsPending).toEqual([]);
  });

  it("changes nothing on a second run", async () => {
    const job = build();
    job.plant("file-1", pdfBytes(), "media/2026/09/ffff.png");
    await job.service.encryptRemaining();
    const after = { ...job.rows.get("file-1") };

    const run = await job.service.encryptRemaining();

    expect(run).toEqual({
      encrypted: 0,
      left: [],
      removed: 0,
      removalsPending: [],
    });
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

  /*
   * A run that cannot be carried out stops the start, loudly. Serving anyway
   * would answer every unencrypted file as missing while the log scrolled past
   * the reason. It costs nothing on any other start: the job has work only
   * while an unencrypted file is left.
   */
  it("stops the start when the database cannot be read", async () => {
    const job = build();
    job.mediaFile.findMany.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED db:5432 for anna@exempel.se"),
    );

    await expect(job.service.onModuleInit()).rejects.toBeInstanceOf(
      StoredFileEncryptionError,
    );
    // The class of the failure, and nothing the message carried.
    expect(job.errors).toEqual([
      "Could not finish encrypting the stored files, so the instance does not start: Error",
    ]);
  });

  it("stops the start when storage cannot be read", async () => {
    const job = build();
    job.plant("file-1", pdfBytes(), "media/2026/09/jjjj.png");
    job.storage.open.mockRejectedValueOnce(new Error("storage unreachable"));

    await expect(job.service.onModuleInit()).rejects.toBeInstanceOf(
      StoredFileEncryptionError,
    );
    expect(job.rows.get("file-1")?.encryption).toBe("NONE");
  });

  it("lets the start go on past a file that does not match its checksum", async () => {
    // A fact about one file rather than about the run. Stopping on it would
    // keep the instance down for as long as that file exists.
    const job = build();
    job.plant("file-1", pdfBytes(), "media/2026/09/kkkk.png");
    const row = job.rows.get("file-1");
    if (row !== undefined) {
      row.checksum = sha256(Buffer.from("another file"));
    }

    await expect(job.service.onModuleInit()).resolves.toBeUndefined();
    expect(job.rows.get("file-1")?.encryption).toBe("NONE");
  });
});
