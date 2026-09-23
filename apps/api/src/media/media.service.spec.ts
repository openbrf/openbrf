import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import {
  capabilitiesFor,
  type Capability,
  type Principal,
} from "../authorization/capabilities";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import {
  sealedLength,
  STORED_FILE_CHUNK_BYTES,
} from "../crypto/stored-file-cipher";
import type { PrismaService } from "../database/prisma.service";
import type { StorageService } from "../storage/storage.service";
import {
  MediaError,
  type MediaVisibility,
  MediaService,
} from "./media.service";
import { pdfBytes } from "./testing/document-fixtures";
import { pngBytes } from "./testing/image-fixtures";

/**
 * The media layer over a fake database and a fake storage driver.
 *
 * Two properties are load-bearing and are what these cases are for. A file is
 * identified from its bytes rather than from what the request said it was,
 * because the type stored here is the type it will later be served with. And a
 * viewer who may not read a file is told the same thing as a viewer asking for
 * one that does not exist, so this route cannot be used to enumerate what an
 * instance holds.
 *
 * The field encryption is the real one, because a stored file's key is
 * wrapped by it and its checksum is keyed by it, and a fake would decide
 * exactly what these cases have to show.
 */

const TEST_ENV = {
  NODE_ENV: "test",
  OPENBRF_ENCRYPTION_KEY: "d".repeat(64),
} as Env;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

interface Row {
  id: string;
  storageKey: string;
  encryption: "NONE" | "SECRETSTREAM_64K";
  dataKeyCipher: string | null;
  unencryptedStorageKey: string | null;
  contentType: string;
  byteSize: number;
  checksum: string;
  fileName: string;
  width: number | null;
  height: number | null;
  showsIdentifiablePersons: boolean | null;
  visibility: MediaVisibility;
  requiredCapability: string | null;
  apartmentId: string | null;
  uploadedByPersonId: string | null;
}

/**
 * A residency, as the serving path asks after one.
 *
 * Both ends as dates, because that is what the columns are and what
 * `residencyHeldOn` compares: a move-in dated ahead and a move-out dated today
 * are the two cases the binder's visibilities exist to get right.
 */
interface ResidencyRow {
  personId: string;
  apartmentId: string;
  role: "MEMBER" | "RESIDENT";
  movedInOn: Date;
  movedOutOn: Date | null;
}

/** One recorded audit write, plus whether it joined the caller's transaction. */
interface AuditedEntry {
  action: string;
  targetId?: string | null;
  /** True when the entry was written on a transaction client. */
  inTransaction: boolean;
}

interface Fakes {
  service: MediaService;
  rows: Map<string, Row>;
  residencies: ResidencyRow[];
  objects: Map<string, Buffer>;
  audited: AuditedEntry[];
  storage: {
    put: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  logged: string[];
  mediaFile: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  transactionMediaFile: { delete: ReturnType<typeof vi.fn> };
}

function build(
  options: {
    createFails?: boolean;
    auditFailsOn?: string;
    wrapFails?: boolean;
    residencies?: ResidencyRow[];
  } = {},
): Fakes {
  const rows = new Map<string, Row>();
  const residencies = options.residencies ?? [];
  const objects = new Map<string, Buffer>();
  const audited: AuditedEntry[] = [];
  let nextId = 0;

  const storage = {
    put: vi.fn(async (key: string, body: Buffer) => {
      objects.set(key, body);
    }),
    /*
     * In slices, as a driver delivers a file: a read stream on a disk and a
     * response body from a bucket both arrive a few kilobytes at a time, so a
     * chunk after the first is read only once the reader has asked for more.
     */
    open: vi.fn(async (key: string) => {
      const stored = objects.get(key);
      if (stored === undefined) {
        return null;
      }
      const slices: Buffer[] = [];
      for (let offset = 0; offset < stored.length; offset += 16 * 1024) {
        slices.push(stored.subarray(offset, offset + 16 * 1024));
      }
      return Readable.from(slices);
    }),
    remove: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };

  const mediaFile = {
    create: vi.fn(async ({ data }: { data: Omit<Row, "id"> }) => {
      if (options.createFails === true) {
        throw new Error("the row could not be written");
      }
      nextId += 1;
      // A nullable column the write leaves out is null, as in the database.
      const row: Row = {
        id: `file-${String(nextId)}`,
        ...data,
        unencryptedStorageKey: data.unencryptedStorageKey ?? null,
        apartmentId: data.apartmentId ?? null,
      };
      rows.set(row.id, row);
      return row;
    }),
    findUnique: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        rows.get(where.id) ?? null,
    ),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      rows.delete(where.id);
    }),
  };

  /*
   * A delegate of its own, not the root one under another name. Both write to
   * the same rows, so the service behaves identically either way and only the
   * spy tells them apart: a delete issued on the root client outside the
   * transaction would leave the row gone with no audit entry, and sharing one
   * delegate would let that pass.
   */
  const transactionMediaFile = {
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      rows.delete(where.id);
    }),
  };

  /*
   * One object, so a caller can be checked against the client the transaction
   * actually handed out rather than against "some client was passed". The root
   * client would satisfy the weaker check while leaving the write outside the
   * transaction.
   */
  const transactionClient = { mediaFile: transactionMediaFile };

  /*
   * The residency question the two apartment visibilities ask, answered the way
   * the database answers it. Written out rather than stubbed with a number,
   * because what these cases have to show is the comparison itself: a move-in
   * dated ahead is not held, and a move-out dated today is not held either.
   */
  const residency = {
    count: vi.fn(
      async ({
        where,
      }: {
        where: {
          personId?: string;
          apartmentId?: string;
          role?: "MEMBER";
          movedInOn: { lte: Date };
          OR: ({ movedOutOn: null } | { movedOutOn: { gt: Date } })[];
        };
      }) =>
        residencies.filter((row) => {
          // An absent field is an unconstrained one, as in the database: a
          // query that stopped naming the apartment would ask about every
          // apartment rather than about none, and a fake that refused instead
          // would hide exactly that mistake.
          if (where.personId !== undefined && row.personId !== where.personId) {
            return false;
          }
          if (
            where.apartmentId !== undefined &&
            row.apartmentId !== where.apartmentId
          ) {
            return false;
          }
          if (where.role !== undefined && row.role !== where.role) {
            return false;
          }
          if (row.movedInOn.getTime() > where.movedInOn.lte.getTime()) {
            return false;
          }
          return where.OR.some((clause) =>
            "movedOutOn" in clause && clause.movedOutOn === null
              ? row.movedOutOn === null
              : row.movedOutOn !== null &&
                row.movedOutOn.getTime() >
                  (
                    clause as { movedOutOn: { gt: Date } }
                  ).movedOutOn.gt.getTime(),
          );
        }).length,
    ),
  };

  const prisma = {
    mediaFile,
    residency,
    /*
     * Rolls back, because that is the property under test rather than a
     * convenience. A statement that succeeded inside a transaction whose later
     * statement threw did not happen, and a fake that kept it would let a
     * service pass a test the database would fail.
     */
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      const snapshot = new Map(rows);
      const writtenBefore = audited.length;
      try {
        return await run(transactionClient);
      } catch (cause) {
        rows.clear();
        for (const [id, row] of snapshot) {
          rows.set(id, row);
        }
        audited.length = writtenBefore;
        throw cause;
      }
    }),
  };

  const audit = {
    record: vi.fn(
      async (
        entry: { action: string; targetId?: string },
        client?: unknown,
      ) => {
        if (options.auditFailsOn === entry.action) {
          throw new Error("the audit entry could not be written");
        }
        audited.push({ ...entry, inTransaction: client === transactionClient });
      },
    ),
  };

  const encryption = new FieldEncryptionService(TEST_ENV);
  if (options.wrapFails === true) {
    vi.spyOn(encryption, "encrypt").mockRejectedValue(
      new Error("the key could not be wrapped"),
    );
  }

  const service = new MediaService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    audit as unknown as AuditLogService,
    encryption,
  );

  const logged: string[] = [];
  vi.spyOn(
    (service as unknown as { logger: { error: (message: string) => void } })
      .logger,
    "error",
  ).mockImplementation((message: string) => {
    logged.push(message);
  });

  return {
    service,
    rows,
    residencies,
    objects,
    audited,
    storage,
    logged,
    mediaFile,
    transactionMediaFile,
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  const roles = {
    isAdmin: false,
    isBoardMember: false,
    isPropertyManager: false,
    isResident: true,
    isMember: false,
  };
  return {
    personId: "person-1",
    ...roles,
    capabilities: capabilitiesFor(roles),
    ...overrides,
  };
}

function withCapability(capability: Capability): Principal {
  const base = principal();
  return { ...base, capabilities: new Set([...base.capabilities, capability]) };
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

let fakes: Fakes;

beforeEach(() => {
  fakes = build();
});

describe("uploading", () => {
  it("stores the bytes and records what they are", async () => {
    const file = await fakes.service.upload({
      bytes: pngBytes(200, 60),
      fileName: "logotyp.png",
      visibility: "PUBLIC",
      showsIdentifiablePersons: false,
      channel: "WEB",
    });

    expect(file.contentType).toBe("image/png");
    expect(file.width).toBe(200);
    expect(file.height).toBe(60);
    expect(file.url).toBe(`/api/media/${file.id}`);
  });

  it("generates the storage key rather than taking it from the file name", async () => {
    await fakes.service.upload({
      bytes: pngBytes(10, 10),
      fileName: "../../etc/passwd",
      visibility: "PUBLIC",
      showsIdentifiablePersons: false,
      channel: "WEB",
    });

    const key = [...fakes.objects.keys()][0] ?? "";

    // No extension: the object is ciphertext, and a .png on it would tell the
    // storage's own logs what kind of file it holds.
    expect(key).toMatch(/^media\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
  });

  it("stores the file encrypted, never the bytes that were uploaded", async () => {
    const bytes = pngBytes(200, 60);
    const file = await fakes.service.upload({
      bytes,
      fileName: "logotyp.png",
      visibility: "PUBLIC",
      showsIdentifiablePersons: false,
      channel: "WEB",
    });

    // What the storage driver was handed, not what the service serves back.
    const [[storageKey, body, contentType]] = fakes.storage.put.mock.calls as [
      [string, Buffer, string],
    ];
    const row = fakes.rows.get(file.id);

    expect(body.equals(bytes)).toBe(false);
    expect(body.includes(PNG_SIGNATURE)).toBe(false);
    expect(body.length).toBe(sealedLength(bytes.length));
    expect(contentType).toBe("application/octet-stream");
    expect(row?.storageKey).toBe(storageKey);
    expect(row?.encryption).toBe("SECRETSTREAM_64K");
    expect(row?.dataKeyCipher).toMatch(/^brng:/);
    // The file's own size and type, not the ciphertext's.
    expect(row?.byteSize).toBe(bytes.length);
    expect(row?.contentType).toBe("image/png");
  });

  it("records a keyed checksum of the upload, not its plain SHA-256", async () => {
    const bytes = pngBytes(10, 10);
    const file = await fakes.service.upload({
      bytes,
      fileName: "logotyp.png",
      visibility: "PUBLIC",
      showsIdentifiablePersons: false,
      channel: "WEB",
    });

    const checksum = fakes.rows.get(file.id)?.checksum;

    expect(checksum).toBe(
      await new FieldEncryptionService(TEST_ENV).storedFileChecksum(bytes),
    );
    expect(checksum).not.toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("stores nothing when the file's key cannot be wrapped", async () => {
    const failing = build({ wrapFails: true });

    await expect(
      failing.service.upload({
        bytes: pngBytes(10, 10),
        fileName: "logotyp.png",
        visibility: "PUBLIC",
        showsIdentifiablePersons: false,
        channel: "WEB",
      }),
    ).rejects.toThrow("the key could not be wrapped");

    expect(failing.storage.put).not.toHaveBeenCalled();
    expect(failing.rows.size).toBe(0);
  });

  it("keeps the file name but strips what a header or a path would take", async () => {
    const file = await fakes.service.upload({
      bytes: pngBytes(10, 10),
      fileName: '../logo"; drop.png',
      visibility: "PUBLIC",
      showsIdentifiablePersons: false,
      channel: "WEB",
    });

    expect(file.fileName).toBe("..logo; drop.png");
  });

  it("refuses a file that is neither an image nor a document, whatever it is named", async () => {
    await expect(
      fakes.service.upload({
        bytes: Buffer.from("<html><script>alert(1)</script>", "utf8"),
        fileName: "logotyp.png",
        visibility: "PUBLIC",
        showsIdentifiablePersons: false,
        channel: "WEB",
      }),
    ).rejects.toMatchObject({ reason: "unsupported-type" });
  });

  it("stores nothing when the file is refused", async () => {
    await fakes.service.upload
      .call(fakes.service, {
        bytes: Buffer.from("not an image", "utf8"),
        fileName: "x.png",
        visibility: "PUBLIC",
        showsIdentifiablePersons: false,
        channel: "WEB",
      })
      .catch(() => undefined);

    expect(fakes.storage.put).not.toHaveBeenCalled();
  });

  it("refuses an empty file", async () => {
    await expect(
      fakes.service.upload({
        bytes: Buffer.alloc(0),
        fileName: "x.png",
        visibility: "PUBLIC",
        showsIdentifiablePersons: false,
        channel: "WEB",
      }),
    ).rejects.toMatchObject({ reason: "empty-file" });
  });

  it("requires the identifiable-persons declaration on an image", async () => {
    /*
     * Required rather than defaulted. A default would record an answer nobody
     * gave, and the publication guardrails will read this field to decide
     * whether an image may appear on a public page at all.
     */
    await expect(
      fakes.service.upload({
        bytes: pngBytes(10, 10),
        fileName: "gard.png",
        visibility: "INTERNAL",
        channel: "WEB",
      }),
    ).rejects.toMatchObject({ reason: "declaration-required" });
  });

  it("accepts a document, and records neither a canvas nor a declaration for it", async () => {
    const file = await fakes.service.upload({
      bytes: pdfBytes(),
      fileName: "stadgar.pdf",
      accept: "document",
      visibility: "PUBLIC",
      channel: "WEB",
      prefix: "documents",
    });

    expect(file.contentType).toBe("application/pdf");
    // A document has no canvas to measure, and no face in it to declare
    // against a publication consent. Both are recorded as absent rather than
    // as an answer nobody gave.
    expect(file.width).toBeNull();
    expect(file.height).toBeNull();
    expect(file.showsIdentifiablePersons).toBeNull();
  });

  it("keeps the declaration off a document even when one is passed", async () => {
    const file = await fakes.service.upload({
      bytes: pdfBytes(),
      fileName: "stadgar.pdf",
      accept: "document",
      visibility: "PUBLIC",
      showsIdentifiablePersons: true,
      channel: "WEB",
    });

    expect(file.showsIdentifiablePersons).toBeNull();
  });

  it("refuses a document where an image was asked for, and the other way round", async () => {
    /*
     * The caller says which kind it is asking for, so neither of these is a
     * near miss: a PDF is not the housing cooperative's mark, and a photograph
     * in the document archive would be a picture of people carrying no
     * declaration about whether it shows any.
     */
    await expect(
      fakes.service.upload({
        bytes: pdfBytes(),
        fileName: "logotyp.png",
        visibility: "PUBLIC",
        showsIdentifiablePersons: false,
        channel: "WEB",
      }),
    ).rejects.toMatchObject({ reason: "unsupported-type" });

    await expect(
      fakes.service.upload({
        bytes: pngBytes(10, 10),
        fileName: "stadgar.pdf",
        accept: "document",
        visibility: "PUBLIC",
        channel: "WEB",
      }),
    ).rejects.toMatchObject({ reason: "unsupported-type" });
  });

  it("records the declaration as given", async () => {
    const file = await fakes.service.upload({
      bytes: pngBytes(10, 10),
      fileName: "sommarfest.png",
      visibility: "INTERNAL",
      showsIdentifiablePersons: true,
      channel: "WEB",
    });

    expect(file.showsIdentifiablePersons).toBe(true);
  });

  it("writes the upload to the audit log", async () => {
    const file = await fakes.service.upload({
      bytes: pngBytes(10, 10),
      fileName: "logotyp.png",
      visibility: "PUBLIC",
      showsIdentifiablePersons: false,
      uploadedByPersonId: "person-1",
      channel: "WEB",
    });

    expect(fakes.audited).toContainEqual(
      expect.objectContaining({ action: "MEDIA_UPLOADED", targetId: file.id }),
    );
  });

  it("removes the object again when its row cannot be written", async () => {
    const failing = build({ createFails: true });

    await failing.service
      .upload({
        bytes: pngBytes(10, 10),
        fileName: "logotyp.png",
        visibility: "PUBLIC",
        showsIdentifiablePersons: false,
        channel: "WEB",
      })
      .catch(() => undefined);

    // A row pointing at nothing is indistinguishable from a deleted file; an
    // object with no row merely costs disk.
    expect(failing.objects.size).toBe(0);
  });
});

describe("serving", () => {
  async function upload(
    overrides: {
      visibility?: "PUBLIC" | "INTERNAL" | "MEMBER";
      requiredCapability?: Capability;
      bytes?: Buffer;
    } = {},
  ): Promise<string> {
    const file = await fakes.service.upload({
      bytes: overrides.bytes ?? pngBytes(10, 10),
      fileName: "logotyp.png",
      visibility: overrides.visibility ?? "INTERNAL",
      requiredCapability: overrides.requiredCapability,
      showsIdentifiablePersons: false,
      channel: "WEB",
    });
    return file.id;
  }

  /** A PNG header and then enough bytes to fill three chunks and a bit. */
  function largeImage(): Buffer {
    const bytes = Buffer.alloc(3 * STORED_FILE_CHUNK_BYTES + 100);
    pngBytes(10, 10).copy(bytes);
    for (let index = 33; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }
    return bytes;
  }

  /** Flips one bit of the stored object for a file, at an offset into it. */
  function changeStoredByte(id: string, offset: number): void {
    const storageKey = fakes.rows.get(id)?.storageKey ?? "";
    const stored = Buffer.from(
      fakes.objects.get(storageKey) ?? Buffer.alloc(0),
    );
    stored[offset] = (stored[offset] ?? 0) ^ 0x01;
    fakes.objects.set(storageKey, stored);
  }

  it("serves a public file to nobody in particular", async () => {
    const id = await upload({ visibility: "PUBLIC" });

    const served = await fakes.service.open(id, null);

    expect(served.contentType).toBe("image/png");
    expect(await collect(served.stream)).toEqual(pngBytes(10, 10));
  });

  it.each(["PUBLIC", "INTERNAL", "MEMBER"] as const)(
    "serves a file of several chunks as the bytes that were uploaded (%s)",
    async (visibility) => {
      const bytes = largeImage();
      const id = await upload({ visibility, bytes });

      const served = await fakes.service.open(
        id,
        principal({ isMember: true }),
      );

      expect(served.byteSize).toBe(bytes.length);
      expect((await collect(served.stream)).equals(bytes)).toBe(true);
    },
  );

  it("gives the keyed checksum as the entity tag", async () => {
    const id = await upload({ visibility: "PUBLIC" });

    const served = await fakes.service.open(id, null);

    expect(served.checksum).toBe(fakes.rows.get(id)?.checksum);
  });

  it("answers a changed first chunk as a missing file, before anything is served", async () => {
    const id = await upload({ visibility: "PUBLIC", bytes: largeImage() });
    changeStoredByte(id, 24 + 100);

    const refused = await fakes.service
      .open(id, null)
      .catch((error: MediaError) => error);
    const absent = await fakes.service
      .open("file-absent", null)
      .catch((error: MediaError) => error);

    expect((refused as MediaError).reason).toBe("not-found");
    expect((refused as MediaError).status).toBe((absent as MediaError).status);
    // The class and the code of the failure, never its message.
    expect(fakes.logged).toContainEqual(
      `The file ${id} failed verification: SealedFileError (unverified-chunk)`,
    );
  });

  it("answers a changed header as a missing file", async () => {
    const id = await upload({ visibility: "PUBLIC" });
    changeStoredByte(id, 3);

    await expect(fakes.service.open(id, null)).rejects.toMatchObject({
      reason: "not-found",
    });
    expect(fakes.logged).toContainEqual(expect.stringContaining(id));
  });

  it("fails the stream at a changed later chunk, after the chunks before it", async () => {
    const bytes = largeImage();
    const id = await upload({ visibility: "PUBLIC", bytes });
    // Inside the third chunk.
    changeStoredByte(id, 24 + 2 * (STORED_FILE_CHUNK_BYTES + 17) + 10);

    const served = await fakes.service.open(id, null);
    const received: Buffer[] = [];
    const failure = await (async () => {
      for await (const chunk of served.stream) {
        received.push(Buffer.from(chunk as Buffer));
      }
      return null;
    })().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    // Two whole chunks went out, verified; nothing of the changed one did.
    expect(
      Buffer.concat(received).equals(
        bytes.subarray(0, 2 * STORED_FILE_CHUNK_BYTES),
      ),
    ).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fakes.logged).toContainEqual(
      expect.stringContaining(`The file ${id} stopped partway through`),
    );
  });

  it("answers a file whose key does not open as a missing file, without logging the key", async () => {
    const id = await upload({ visibility: "PUBLIC" });
    const row = fakes.rows.get(id);
    const other = await new FieldEncryptionService({
      ...TEST_ENV,
      OPENBRF_ENCRYPTION_KEY: "e".repeat(64),
    }).encrypt("mediaFile.dataKey", "ab".repeat(32));
    if (row !== undefined) {
      row.dataKeyCipher = other.cipher;
    }

    await expect(fakes.service.open(id, null)).rejects.toMatchObject({
      reason: "not-found",
    });
    expect(fakes.logged).toEqual([
      `The key of the file ${id} does not open under the instance's key.`,
    ]);
    expect(fakes.storage.open).not.toHaveBeenCalled();
  });

  it("never serves a file that is not encrypted, and says so by id", async () => {
    /*
     * A row the job at start could not encrypt. Its bytes may well be in
     * storage and readable, and serving them would be the one path by which a
     * file leaves unencrypted; it is refused as missing instead.
     */
    const id = await upload({ visibility: "PUBLIC" });
    const row = fakes.rows.get(id);
    if (row !== undefined) {
      fakes.objects.set(row.storageKey, pngBytes(10, 10));
      row.encryption = "NONE";
      row.dataKeyCipher = null;
    }

    await expect(fakes.service.open(id, null)).rejects.toMatchObject({
      reason: "not-found",
    });
    expect(fakes.logged).toEqual([
      `The file ${id} is not encrypted at rest and is not served.`,
    ]);
    expect(fakes.storage.open).not.toHaveBeenCalled();
  });

  it("refuses an internal file to an anonymous caller", async () => {
    const id = await upload({ visibility: "INTERNAL" });

    await expect(fakes.service.open(id, null)).rejects.toBeInstanceOf(
      MediaError,
    );
  });

  it("answers for a file it will not serve exactly as for one that is not there", async () => {
    /*
     * The same reason and the same status. A different answer would let an
     * anonymous caller confirm that a particular file exists on this instance.
     */
    const id = await upload({ visibility: "INTERNAL" });

    const refused = await fakes.service
      .open(id, null)
      .catch((error: MediaError) => error);
    const absent = await fakes.service
      .open("file-absent", null)
      .catch((error: MediaError) => error);

    expect((refused as MediaError).reason).toBe("not-found");
    expect((absent as MediaError).reason).toBe("not-found");
    expect((refused as MediaError).status).toBe((absent as MediaError).status);
  });

  it("serves an internal file to anyone signed in", async () => {
    const id = await upload({ visibility: "INTERNAL" });

    await expect(fakes.service.open(id, principal())).resolves.toMatchObject({
      contentType: "image/png",
    });
  });

  it("narrows a file to the capability it names", async () => {
    const id = await upload({
      visibility: "INTERNAL",
      requiredCapability: "memberRegister:read",
    });

    await expect(fakes.service.open(id, principal())).rejects.toBeInstanceOf(
      MediaError,
    );
    await expect(
      fakes.service.open(id, withCapability("memberRegister:read")),
    ).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("keeps a member file from a signed-in caller who is not a member", async () => {
    /*
     * The case the MEMBER visibility exists for. INTERNAL would have served
     * this to any account at all, so a resident who is not a member - or an
     * external property manager - could read it by holding the address alone.
     */
    const id = await upload({ visibility: "MEMBER" });

    await expect(fakes.service.open(id, principal())).rejects.toMatchObject({
      reason: "not-found",
    });
    await expect(
      fakes.service.open(id, principal({ isMember: true })),
    ).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("refuses a member file to an anonymous caller", async () => {
    const id = await upload({ visibility: "MEMBER" });

    await expect(fakes.service.open(id, null)).rejects.toMatchObject({
      reason: "not-found",
    });
  });

  it("opens a member file to the capability it names, without a residency", async () => {
    // On a MEMBER file the capability widens rather than narrows: it is how
    // the board and an administrator read the members' shelf, neither of whom
    // necessarily holds a tenant-ownership.
    const id = await upload({
      visibility: "MEMBER",
      requiredCapability: "documents:manage",
    });

    await expect(
      fakes.service.open(id, withCapability("documents:manage")),
    ).resolves.toMatchObject({ contentType: "image/png" });
    await expect(fakes.service.open(id, principal())).rejects.toMatchObject({
      reason: "not-found",
    });
  });

  it("answers for a member file it will not serve exactly as for one that is not there", async () => {
    const id = await upload({ visibility: "MEMBER" });

    const refused = await fakes.service
      .open(id, principal())
      .catch((error: MediaError) => error);
    const absent = await fakes.service
      .open("file-absent", principal())
      .catch((error: MediaError) => error);

    expect((refused as MediaError).reason).toBe((absent as MediaError).reason);
    expect((refused as MediaError).status).toBe((absent as MediaError).status);
  });

  it("logs the serve of a capability-restricted file, and only that", async () => {
    const restricted = await upload({
      visibility: "INTERNAL",
      requiredCapability: "memberRegister:read",
    });
    const ordinary = await upload({ visibility: "INTERNAL" });
    const open = await upload({ visibility: "PUBLIC" });
    const members = await upload({
      visibility: "MEMBER",
      requiredCapability: "documents:manage",
    });

    await fakes.service.open(restricted, withCapability("memberRegister:read"));
    await fakes.service.open(ordinary, principal());
    await fakes.service.open(open, null);
    await fakes.service.open(members, principal({ isMember: true }));
    await fakes.service.open(members, withCapability("documents:manage"));

    const accesses = fakes.audited.filter(
      (entry) => entry.action === "MEDIA_ACCESSED",
    );

    // One row per image request would swamp an append-only table that the law
    // requires to carry protected-data accesses and register extracts. A
    // member file is narrowed and still not logged, by the same argument: the
    // members read the bylaws and every set of minutes as a matter of course,
    // and a permanent record of who read what is not what the log is for.
    expect(accesses).toEqual([
      expect.objectContaining({ targetId: restricted }),
    ]);
  });

  it("refuses a visibility this code does not know", async () => {
    /*
     * The branch that decides is an allowlist with a refusing default, so a
     * visibility added to the schema and not handled here is withheld until
     * somebody handles it. Falling through to "serve it" would publish a class
     * of file nobody had decided to publish.
     */
    const id = await upload({ visibility: "PUBLIC" });
    const row = fakes.rows.get(id);
    if (row !== undefined) {
      row.visibility = "EVERY_TENANT" as "PUBLIC";
    }

    await expect(fakes.service.open(id, null)).rejects.toMatchObject({
      reason: "not-found",
    });
  });

  it("reports a row whose bytes are gone as missing", async () => {
    const id = await upload({ visibility: "PUBLIC" });
    fakes.objects.clear();

    await expect(fakes.service.open(id, null)).rejects.toMatchObject({
      reason: "not-found",
    });
  });

  it("does not serve a file with an unrecognised capability name to anyone", async () => {
    // A typo in the column has to fail closed. Failing open would widen access
    // silently and nothing would report it.
    const id = await upload({ visibility: "INTERNAL" });
    const row = fakes.rows.get(id);
    if (row !== undefined) {
      row.requiredCapability = "memberRegister:reed";
    }

    const admin = principal({
      isAdmin: true,
      capabilities: capabilitiesFor({
        isAdmin: true,
        isBoardMember: false,
        isPropertyManager: false,
        isResident: false,
        isMember: false,
      }),
    });

    await expect(fakes.service.open(id, admin)).rejects.toBeInstanceOf(
      MediaError,
    );
  });
});

describe("removing", () => {
  async function stored(fixture: Fakes = fakes): Promise<string> {
    const file = await fixture.service.upload({
      bytes: pngBytes(10, 10),
      fileName: "logotyp.png",
      visibility: "PUBLIC",
      showsIdentifiablePersons: false,
      channel: "WEB",
    });
    return file.id;
  }

  it("removes the row, the bytes and writes the audit entry", async () => {
    const id = await stored();

    await fakes.service.remove(id, "person-1", "WEB");

    expect(fakes.rows.size).toBe(0);
    expect(fakes.objects.size).toBe(0);
    expect(fakes.audited).toContainEqual(
      expect.objectContaining({ action: "MEDIA_DELETED", targetId: id }),
    );
  });

  it("removes an unencrypted object still recorded on the row as well", async () => {
    /*
     * A file the job at start encrypted whose old object could not yet be
     * removed. The row is the only record of that object, so deleting the file
     * without it would leave an unencrypted copy that nothing names.
     */
    const id = await stored();
    const row = fakes.rows.get(id);
    if (row !== undefined) {
      row.unencryptedStorageKey = "media/2026/09/kvar.png";
    }
    fakes.objects.set("media/2026/09/kvar.png", pngBytes(10, 10));

    await fakes.service.remove(id, "person-1", "WEB");

    expect(fakes.objects.size).toBe(0);
    expect(fakes.storage.remove).toHaveBeenCalledWith("media/2026/09/kvar.png");
  });

  it("writes the entry on the transaction that deletes the row", async () => {
    /*
     * Not a detail of how it is written. The entry is the statutory evidence
     * that the deletion happened and who asked for it, and the log is
     * append-only, so the two have to share one fate: an entry on the root
     * client could be lost while the deletion stood.
     */
    const id = await stored();

    await fakes.service.remove(id, "person-1", "WEB");

    expect(fakes.transactionMediaFile.delete).toHaveBeenCalledWith({
      where: { id },
    });
    expect(fakes.mediaFile.delete).not.toHaveBeenCalled();

    expect(fakes.audited).toContainEqual(
      expect.objectContaining({
        action: "MEDIA_DELETED",
        targetId: id,
        inTransaction: true,
      }),
    );
  });

  it("keeps the file when the deletion cannot be recorded", async () => {
    const failing = build({ auditFailsOn: "MEDIA_DELETED" });
    const id = await stored(failing);

    await expect(
      failing.service.remove(id, "person-1", "WEB"),
    ).rejects.toThrow();

    // The entry cannot be added afterwards, so the file must still be there to
    // be deleted again once the log can accept it. The bytes in particular are
    // beyond recovery: nothing rolls a storage backend back.
    expect(failing.rows.has(id)).toBe(true);
    expect(failing.objects.size).toBe(1);
    expect(failing.storage.remove).not.toHaveBeenCalled();
  });

  it("does nothing for a file that is not there", async () => {
    await expect(
      fakes.service.remove("file-absent", undefined, "WEB"),
    ).resolves.toBeUndefined();

    /*
     * Stated as the absence of the side effects rather than as the absence of
     * a throw. An entry for a deletion that never happened cannot be taken
     * back, and a removal call carrying an undefined key is a request to the
     * storage backend that nobody made.
     */
    expect(fakes.audited).toEqual([]);
    expect(fakes.mediaFile.delete).not.toHaveBeenCalled();
    expect(fakes.storage.remove).not.toHaveBeenCalled();
  });
});

/**
 * The two visibilities decided against a residency on the file's own apartment.
 *
 * What the apartment binder promises is this and nothing else: a binder file is
 * served to whoever lives in the apartment it names, from the day their
 * residency begins to the day before it ends, to a holder of
 * `apartmentBinder:manage` with an audit entry, and to nobody else. Every case
 * below is one household or one day either side of that.
 *
 * The days are pinned rather than taken from the clock. The comparison is on
 * the association's own calendar day, so a residency dated relative to "today"
 * would be a test that changed its mind at midnight here rather than at
 * midnight UTC.
 */
describe("serving a file the apartment decides", () => {
  const APARTMENT = "apartment-1201";
  const OTHER_APARTMENT = "apartment-1202";

  /** Yesterday, a day well inside every residency below. */
  const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");
  /** A move-in the board recorded ahead of the day the buyer takes over. */
  const NEXT_YEAR = new Date("2099-01-01T00:00:00.000Z");

  const board = (): Principal => {
    const roles = {
      isAdmin: false,
      isBoardMember: true,
      isPropertyManager: false,
      isResident: false,
      isMember: false,
    };
    return {
      personId: "board-1",
      ...roles,
      capabilities: capabilitiesFor(roles),
    };
  };

  const administrator = (): Principal => {
    const roles = {
      isAdmin: true,
      isBoardMember: false,
      isPropertyManager: false,
      isResident: false,
      isMember: false,
    };
    return {
      personId: "admin-1",
      ...roles,
      capabilities: capabilitiesFor(roles),
    };
  };

  async function fileFor(
    fakes: Fakes,
    visibility: "TENANT_OWNERS" | "HOUSEHOLD",
  ): Promise<string> {
    const file = await fakes.service.upload({
      bytes: pdfBytes(),
      fileName: "ritning.pdf",
      accept: "document",
      visibility,
      requiredCapability: "apartmentBinder:manage",
      apartmentId: APARTMENT,
      recordFileName: false,
      channel: "WEB",
      prefix: "binder",
    });
    return file.id;
  }

  async function read(fakes: Fakes, id: string, viewer: Principal | null) {
    const served = await fakes.service.open(id, viewer);
    const chunks: Buffer[] = [];
    for await (const chunk of served.stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  it("serves a household file to whoever lives there", async () => {
    const fakes = build({
      residencies: [
        {
          personId: "partner-1",
          apartmentId: APARTMENT,
          role: "RESIDENT",
          movedInOn: LONG_AGO,
          movedOutOn: null,
        },
      ],
    });
    const id = await fileFor(fakes, "HOUSEHOLD");

    const bytes = await read(fakes, id, principal({ personId: "partner-1" }));

    expect(bytes).toEqual(pdfBytes());
    // A household reading its own binder is not logged. Its residency is the
    // whole of the rule, and a row per serve would be a permanent record of
    // which resident opened which of their own papers when.
    expect(fakes.audited.filter((e) => e.action === "MEDIA_ACCESSED")).toEqual(
      [],
    );
  });

  it("serves a tenant-owners file to the tenant-owner and not to the lodger", async () => {
    const fakes = build({
      residencies: [
        {
          personId: "holder-1",
          apartmentId: APARTMENT,
          role: "MEMBER",
          movedInOn: LONG_AGO,
          movedOutOn: null,
        },
        {
          personId: "partner-1",
          apartmentId: APARTMENT,
          role: "RESIDENT",
          movedInOn: LONG_AGO,
          movedOutOn: null,
        },
      ],
    });
    const id = await fileFor(fakes, "TENANT_OWNERS");

    await expect(
      read(fakes, id, principal({ personId: "holder-1" })),
    ).resolves.toEqual(pdfBytes());

    await expect(
      fakes.service.open(id, principal({ personId: "partner-1" })),
    ).rejects.toMatchObject({ reason: "not-found" });
  });

  it("refuses a resident of another apartment", async () => {
    const fakes = build({
      residencies: [
        {
          personId: "neighbour-1",
          apartmentId: OTHER_APARTMENT,
          role: "MEMBER",
          movedInOn: LONG_AGO,
          movedOutOn: null,
        },
      ],
    });
    const id = await fileFor(fakes, "HOUSEHOLD");

    await expect(
      fakes.service.open(id, principal({ personId: "neighbour-1" })),
    ).rejects.toMatchObject({ reason: "not-found" });
  });

  it("refuses a buyer whose move-in has not arrived", async () => {
    /*
     * The move flow records a buyer when the board admits them, which is before
     * tillträde. Until that day the seller still lives there and the binder is
     * the seller's household's, so the buyer reads nothing - which is what
     * `residencyHeldOn` settles by reading the start as well as the end
     * (ADR 0014).
     */
    const fakes = build({
      residencies: [
        {
          personId: "buyer-1",
          apartmentId: APARTMENT,
          role: "MEMBER",
          movedInOn: NEXT_YEAR,
          movedOutOn: null,
        },
      ],
    });
    const id = await fileFor(fakes, "TENANT_OWNERS");

    await expect(
      fakes.service.open(id, principal({ personId: "buyer-1" })),
    ).rejects.toMatchObject({ reason: "not-found" });
  });

  it("refuses a household that has moved out", async () => {
    const fakes = build({
      residencies: [
        {
          personId: "seller-1",
          apartmentId: APARTMENT,
          role: "MEMBER",
          movedInOn: LONG_AGO,
          // The first day not held, and it has been and gone.
          movedOutOn: new Date("2021-01-01T00:00:00.000Z"),
        },
      ],
    });
    const id = await fileFor(fakes, "HOUSEHOLD");

    await expect(
      fakes.service.open(id, principal({ personId: "seller-1" })),
    ).rejects.toMatchObject({ reason: "not-found" });
  });

  it("refuses an anonymous caller holding the address", async () => {
    const fakes = build();
    const id = await fileFor(fakes, "HOUSEHOLD");

    await expect(fakes.service.open(id, null)).rejects.toMatchObject({
      reason: "not-found",
    });
  });

  it("serves the board and writes the serve to the audit log", async () => {
    const fakes = build();
    const id = await fileFor(fakes, "TENANT_OWNERS");

    await expect(read(fakes, id, board())).resolves.toEqual(pdfBytes());

    expect(
      fakes.audited.filter((entry) => entry.action === "MEDIA_ACCESSED"),
    ).toMatchObject([
      {
        action: "MEDIA_ACCESSED",
        targetId: id,
        inTransaction: false,
        context: { requiredCapability: "apartmentBinder:manage" },
      },
    ]);
  });

  it("refuses an administrator who holds no seat", async () => {
    // The administrator's grant is every capability but the seat-bound ones,
    // so there is no branch here to get right: the file names a capability the
    // grant does not carry (ADR 0017).
    const fakes = build();
    const id = await fileFor(fakes, "HOUSEHOLD");

    await expect(fakes.service.open(id, administrator())).rejects.toMatchObject(
      { reason: "not-found" },
    );
    expect(fakes.audited.filter((e) => e.action === "MEDIA_ACCESSED")).toEqual(
      [],
    );
  });

  it("serves a board member who lives there as a resident, unlogged", async () => {
    // The household is asked first, so reading one's own binder is not written
    // down as the board having read a household's papers.
    const fakes = build({
      residencies: [
        {
          personId: "board-1",
          apartmentId: APARTMENT,
          role: "MEMBER",
          movedInOn: LONG_AGO,
          movedOutOn: null,
        },
      ],
    });
    const id = await fileFor(fakes, "TENANT_OWNERS");

    await expect(read(fakes, id, board())).resolves.toEqual(pdfBytes());
    expect(fakes.audited.filter((e) => e.action === "MEDIA_ACCESSED")).toEqual(
      [],
    );
  });

  it("leaves the file name out of the upload entry when asked", async () => {
    const fakes = build();
    await fileFor(fakes, "HOUSEHOLD");

    const uploaded = fakes.audited.find(
      (entry) => entry.action === "MEDIA_UPLOADED",
    ) as { context?: Record<string, unknown> } | undefined;

    expect(uploaded?.context).not.toHaveProperty("fileName");
    // Still on the row, and still served in the disposition: only the
    // append-only log does without it.
    expect([...fakes.rows.values()][0]?.fileName).toBe("ritning.pdf");
  });

  it("keeps the file name in the entry for every other upload", async () => {
    const fakes = build();
    await fakes.service.upload({
      bytes: pdfBytes(),
      fileName: "stadgar.pdf",
      accept: "document",
      visibility: "MEMBER",
      channel: "WEB",
      prefix: "documents",
    });

    const uploaded = fakes.audited.find(
      (entry) => entry.action === "MEDIA_UPLOADED",
    ) as { context?: Record<string, unknown> } | undefined;

    expect(uploaded?.context).toMatchObject({ fileName: "stadgar.pdf" });
  });

  it("refuses to store a household file that names no apartment", async () => {
    // A programming error rather than a caller's, so it throws before a byte is
    // written: the column carries the same rule as a CHECK, and reaching the
    // database would make it look like a storage fault.
    const fakes = build();

    await expect(
      fakes.service.upload({
        bytes: pdfBytes(),
        fileName: "ritning.pdf",
        accept: "document",
        visibility: "HOUSEHOLD",
        channel: "WEB",
      }),
    ).rejects.toThrow(/names an apartment/);
    expect(fakes.objects.size).toBe(0);
    expect(fakes.rows.size).toBe(0);
  });

  it("refuses to store an apartment on a file held any other way", async () => {
    const fakes = build();

    await expect(
      fakes.service.upload({
        bytes: pdfBytes(),
        fileName: "stadgar.pdf",
        accept: "document",
        visibility: "MEMBER",
        apartmentId: APARTMENT,
        channel: "WEB",
      }),
    ).rejects.toThrow(/names an apartment/);
    expect(fakes.objects.size).toBe(0);
  });
});
