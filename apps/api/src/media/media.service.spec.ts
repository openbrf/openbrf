import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import {
  capabilitiesFor,
  type Capability,
  type Principal,
} from "../authorization/capabilities";
import type { PrismaService } from "../database/prisma.service";
import type { StorageService } from "../storage/storage.service";
import { MediaError, MediaService } from "./media.service";
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
 */

interface Row {
  id: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  fileName: string;
  width: number | null;
  height: number | null;
  showsIdentifiablePersons: boolean | null;
  visibility: "PUBLIC" | "INTERNAL" | "MEMBER";
  requiredCapability: string | null;
  uploadedByPersonId: string | null;
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
  objects: Map<string, Buffer>;
  audited: AuditedEntry[];
  storage: {
    put: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  mediaFile: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  transactionMediaFile: { delete: ReturnType<typeof vi.fn> };
}

function build(
  options: { createFails?: boolean; auditFailsOn?: string } = {},
): Fakes {
  const rows = new Map<string, Row>();
  const objects = new Map<string, Buffer>();
  const audited: AuditedEntry[] = [];
  let nextId = 0;

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
    create: vi.fn(async ({ data }: { data: Omit<Row, "id"> }) => {
      if (options.createFails === true) {
        throw new Error("the row could not be written");
      }
      nextId += 1;
      const row: Row = { id: `file-${String(nextId)}`, ...data };
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

  const prisma = {
    mediaFile,
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

  const service = new MediaService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    audit as unknown as AuditLogService,
  );

  return {
    service,
    rows,
    objects,
    audited,
    storage,
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
    });

    const key = [...fakes.objects.keys()][0] ?? "";

    expect(key).toMatch(/^media\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
  });

  it("keeps the file name but strips what a header or a path would take", async () => {
    const file = await fakes.service.upload({
      bytes: pngBytes(10, 10),
      fileName: '../logo"; drop.png',
      visibility: "PUBLIC",
      showsIdentifiablePersons: false,
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
      }),
    ).rejects.toMatchObject({ reason: "declaration-required" });
  });

  it("accepts a document, and records neither a canvas nor a declaration for it", async () => {
    const file = await fakes.service.upload({
      bytes: pdfBytes(),
      fileName: "stadgar.pdf",
      accept: "document",
      visibility: "PUBLIC",
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
      }),
    ).rejects.toMatchObject({ reason: "unsupported-type" });

    await expect(
      fakes.service.upload({
        bytes: pngBytes(10, 10),
        fileName: "stadgar.pdf",
        accept: "document",
        visibility: "PUBLIC",
      }),
    ).rejects.toMatchObject({ reason: "unsupported-type" });
  });

  it("records the declaration as given", async () => {
    const file = await fakes.service.upload({
      bytes: pngBytes(10, 10),
      fileName: "sommarfest.png",
      visibility: "INTERNAL",
      showsIdentifiablePersons: true,
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
    } = {},
  ): Promise<string> {
    const file = await fakes.service.upload({
      bytes: pngBytes(10, 10),
      fileName: "logotyp.png",
      visibility: overrides.visibility ?? "INTERNAL",
      requiredCapability: overrides.requiredCapability,
      showsIdentifiablePersons: false,
    });
    return file.id;
  }

  it("serves a public file to nobody in particular", async () => {
    const id = await upload({ visibility: "PUBLIC" });

    const served = await fakes.service.open(id, null);

    expect(served.contentType).toBe("image/png");
    expect(await collect(served.stream)).toEqual(pngBytes(10, 10));
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
    });
    return file.id;
  }

  it("removes the row, the bytes and writes the audit entry", async () => {
    const id = await stored();

    await fakes.service.remove(id, "person-1");

    expect(fakes.rows.size).toBe(0);
    expect(fakes.objects.size).toBe(0);
    expect(fakes.audited).toContainEqual(
      expect.objectContaining({ action: "MEDIA_DELETED", targetId: id }),
    );
  });

  it("writes the entry on the transaction that deletes the row", async () => {
    /*
     * Not a detail of how it is written. The entry is the statutory evidence
     * that the deletion happened and who asked for it, and the log is
     * append-only, so the two have to share one fate: an entry on the root
     * client could be lost while the deletion stood.
     */
    const id = await stored();

    await fakes.service.remove(id, "person-1");

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

    await expect(failing.service.remove(id, "person-1")).rejects.toThrow();

    // The entry cannot be added afterwards, so the file must still be there to
    // be deleted again once the log can accept it. The bytes in particular are
    // beyond recovery: nothing rolls a storage backend back.
    expect(failing.rows.has(id)).toBe(true);
    expect(failing.objects.size).toBe(1);
    expect(failing.storage.remove).not.toHaveBeenCalled();
  });

  it("does nothing for a file that is not there", async () => {
    await expect(fakes.service.remove("file-absent")).resolves.toBeUndefined();

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
