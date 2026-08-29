import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  capabilitiesFor,
  type Principal,
  type PrincipalRoles,
} from "../authorization/capabilities";
import type { PrismaService } from "../database/prisma.service";
import type { DocumentAudience } from "../generated/prisma/enums";
import type { MediaService } from "../media/media.service";
import { audiencesFor, DocumentsService } from "./documents.service";

/**
 * The archive over a fake database and a fake media layer.
 *
 * Two properties are load-bearing and are what these cases are for.
 *
 * A document's audience decides who is shown it, and the same decision is
 * written onto the file the media route serves - so the shelf and the lock
 * cannot say different things. The demotion is the case that matters: a
 * document taken off the public shelf whose file stayed PUBLIC would still be
 * fetchable by anyone who ever saw its address.
 *
 * And the two writes share a transaction. Recorded here by checking which
 * client each one was made on, because a passing test against two separate
 * writes would prove nothing about what happens when the second one fails.
 */

interface DocumentRow {
  id: string;
  title: string;
  category: string;
  audience: DocumentAudience;
  mediaFileId: string;
  uploadedByPersonId: string | null;
  createdAt: Date;
}

interface FileRow {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  visibility: "PUBLIC" | "INTERNAL";
  requiredCapability: string | null;
}

/** One write, and whether it joined the caller's transaction. */
interface RecordedWrite {
  what: "document.update" | "mediaFile.update";
  inTransaction: boolean;
}

interface Fakes {
  service: DocumentsService;
  documents: Map<string, DocumentRow>;
  files: Map<string, FileRow>;
  writes: RecordedWrite[];
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  /** Makes the next document.create fail, as a unique violation would. */
  breakCreate: () => void;
}

function principal(roles: Partial<PrincipalRoles>): Principal {
  const full: PrincipalRoles = {
    isAdmin: false,
    isBoardMember: false,
    isPropertyManager: false,
    isResident: false,
    isMember: false,
    ...roles,
  };
  return {
    personId: "person-1",
    ...full,
    capabilities: capabilitiesFor(full),
  };
}

function makeFakes(): Fakes {
  const documents = new Map<string, DocumentRow>();
  const files = new Map<string, FileRow>();
  const writes: RecordedWrite[] = [];
  let createFails = false;
  let nextId = 0;

  const withFile = (row: DocumentRow) => {
    const file = files.get(row.mediaFileId);
    if (file === undefined) {
      throw new Error(`no file ${row.mediaFileId}`);
    }
    return {
      ...row,
      mediaFile: {
        id: file.id,
        fileName: file.fileName,
        contentType: file.contentType,
        byteSize: file.byteSize,
      },
    };
  };

  const client = (inTransaction: boolean) => ({
    document: {
      findMany: vi.fn(
        ({ where }: { where: { audience: { in: DocumentAudience[] } } }) =>
          Promise.resolve(
            [...documents.values()]
              .filter((row) => where.audience.in.includes(row.audience))
              .map(withFile),
          ),
      ),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(documents.get(where.id) ?? null),
      ),
      create: vi.fn(
        ({ data }: { data: Omit<DocumentRow, "id" | "createdAt"> }) => {
          if (createFails) {
            return Promise.reject(new Error("the row could not be written"));
          }
          nextId += 1;
          const row: DocumentRow = {
            id: `document-${String(nextId)}`,
            createdAt: new Date("2026-08-29T09:00:00.000Z"),
            ...data,
          };
          documents.set(row.id, row);
          return Promise.resolve(withFile(row));
        },
      ),
      update: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<DocumentRow>;
        }) => {
          writes.push({ what: "document.update", inTransaction });
          const row = documents.get(where.id);
          if (row === undefined) {
            return Promise.reject(new Error("no such document"));
          }
          const updated = { ...row, ...data };
          documents.set(where.id, updated);
          return Promise.resolve(withFile(updated));
        },
      ),
    },
    mediaFile: {
      update: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FileRow>;
        }) => {
          writes.push({ what: "mediaFile.update", inTransaction });
          const file = files.get(where.id);
          if (file === undefined) {
            return Promise.reject(new Error("no such file"));
          }
          files.set(where.id, { ...file, ...data });
          return Promise.resolve(files.get(where.id));
        },
      ),
    },
  });

  const root = client(false);
  const prisma = {
    ...root,
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(client(true)),
  } as unknown as PrismaService;

  const upload = vi.fn(
    (input: {
      fileName: string;
      visibility: "PUBLIC" | "INTERNAL";
      requiredCapability?: string;
    }) => {
      nextId += 1;
      const file: FileRow = {
        id: `file-${String(nextId)}`,
        fileName: input.fileName,
        contentType: "application/pdf",
        byteSize: 2048,
        visibility: input.visibility,
        requiredCapability: input.requiredCapability ?? null,
      };
      files.set(file.id, file);
      return Promise.resolve({ ...file, url: `/api/media/${file.id}` });
    },
  );

  const remove = vi.fn((id: string) => {
    files.delete(id);
    // The reference cascades in the database, which is what the service leans
    // on rather than deleting the document row itself.
    for (const [key, row] of documents) {
      if (row.mediaFileId === id) {
        documents.delete(key);
      }
    }
    return Promise.resolve();
  });

  const media = { upload, remove } as unknown as MediaService;

  return {
    service: new DocumentsService(prisma, media),
    documents,
    files,
    writes,
    upload,
    remove,
    breakCreate: () => {
      createFails = true;
    },
  };
}

let fakes: Fakes;

beforeEach(() => {
  fakes = makeFakes();
});

async function file(audience: DocumentAudience) {
  return fakes.service.add({
    title: "Stadgar 2024",
    category: "Stadgar",
    audience,
    bytes: Buffer.from("%PDF-1.7"),
    fileName: "stadgar.pdf",
    actorPersonId: "person-1",
  });
}

describe("who reads which audience", () => {
  it("gives an anonymous caller the published shelf and nothing else", () => {
    expect(audiencesFor(null)).toEqual(["PUBLIC"]);
  });

  it("gives a resident who is not a member the published shelf", () => {
    // Not every resident is a member (GLOSSARY: boende, medlem), and the
    // member shelf is where the minutes and the annual report live.
    expect(audiencesFor(principal({ isResident: true }))).toEqual(["PUBLIC"]);
  });

  it("gives a member their own shelf as well", () => {
    expect(
      audiencesFor(principal({ isResident: true, isMember: true })),
    ).toEqual(["MEMBER", "PUBLIC"]);
  });

  it("gives the board all three", () => {
    expect(audiencesFor(principal({ isBoardMember: true }))).toEqual([
      "BOARD",
      "MEMBER",
      "PUBLIC",
    ]);
  });

  it("does not give the property manager the board's shelf", () => {
    // The property manager is an external party with issue handling only
    // (decision 11), and the archive is not on that list.
    expect(audiencesFor(principal({ isPropertyManager: true }))).toEqual([
      "PUBLIC",
    ]);
  });
});

describe("filing a document", () => {
  it("publishes the file when the document is published", async () => {
    await file("PUBLIC");

    expect(fakes.upload.mock.calls[0]?.[0]).toMatchObject({
      visibility: "PUBLIC",
      requiredCapability: undefined,
      prefix: "documents",
    });
  });

  it("keeps a member document internal without narrowing it", async () => {
    await file("MEMBER");

    expect(fakes.upload.mock.calls[0]?.[0]).toMatchObject({
      visibility: "INTERNAL",
      requiredCapability: undefined,
    });
  });

  it("narrows a board document to the capability that audits every serve", async () => {
    await file("BOARD");

    // documents:manage on the file is what makes the media service write
    // MEDIA_ACCESSED: it records a serve for exactly the files whose access is
    // narrowed by a capability.
    expect(fakes.upload.mock.calls[0]?.[0]).toMatchObject({
      visibility: "INTERNAL",
      requiredCapability: "documents:manage",
    });
  });

  it("answers with the path the media route serves the file from", async () => {
    const document = await file("PUBLIC");

    expect(document.url).toBe("/api/media/file-1");
    expect(document.fileName).toBe("stadgar.pdf");
  });

  it("removes the file again when its document row cannot be written", async () => {
    fakes.breakCreate();

    await expect(file("PUBLIC")).rejects.toThrow();
    // Otherwise the instance keeps bytes nothing references and nobody can
    // reach, which is the one outcome an upload must not leave behind twice.
    expect(fakes.remove).toHaveBeenCalledWith("file-1", "person-1");
    expect(fakes.files.size).toBe(0);
  });
});

describe("changing who a document is for", () => {
  it("locks the file in the same transaction as the demotion", async () => {
    const document = await file("PUBLIC");

    await fakes.service.edit(document.id, {
      title: document.title,
      category: document.category,
      audience: "BOARD",
    });

    expect(fakes.files.get("file-1")).toMatchObject({
      visibility: "INTERNAL",
      requiredCapability: "documents:manage",
    });
    // Both writes, both on the transaction client. A demotion that committed
    // the shelf without the lock would leave the document fetchable at its own
    // address by anyone who had seen it while it was public.
    expect(fakes.writes).toEqual([
      { what: "mediaFile.update", inTransaction: true },
      { what: "document.update", inTransaction: true },
    ]);
  });

  it("publishes the file when a document is put on the public shelf", async () => {
    const document = await file("BOARD");

    await fakes.service.edit(document.id, {
      title: document.title,
      category: document.category,
      audience: "PUBLIC",
    });

    expect(fakes.files.get("file-1")).toMatchObject({
      visibility: "PUBLIC",
      requiredCapability: null,
    });
  });

  it("touches nothing for a document that does not exist", async () => {
    await expect(
      fakes.service.edit("document-404", {
        title: "Stadgar",
        category: "Stadgar",
        audience: "PUBLIC",
      }),
    ).rejects.toMatchObject({ reason: "not-found", status: 404 });

    expect(fakes.writes).toEqual([]);
  });
});

describe("taking a document out of the archive", () => {
  it("removes it through the media service, so the removal is recorded", async () => {
    const document = await file("MEMBER");

    await fakes.service.remove(document.id, "person-2");

    expect(fakes.remove).toHaveBeenCalledWith("file-1", "person-2");
    expect(fakes.documents.size).toBe(0);
    expect(fakes.files.size).toBe(0);
  });

  it("refuses a document that does not exist rather than deleting nothing quietly", async () => {
    await expect(
      fakes.service.remove("document-404", "person-1"),
    ).rejects.toMatchObject({ reason: "not-found" });

    expect(fakes.remove).not.toHaveBeenCalled();
  });
});

describe("listing the archive", () => {
  it("asks only for the audiences the viewer reads", async () => {
    await file("BOARD");
    await file("MEMBER");
    await file("PUBLIC");

    const member = await fakes.service.list(
      principal({ isResident: true, isMember: true }),
    );
    expect(member.map((entry) => entry.audience)).toEqual(["MEMBER", "PUBLIC"]);

    const resident = await fakes.service.list(principal({ isResident: true }));
    expect(resident.map((entry) => entry.audience)).toEqual(["PUBLIC"]);
  });
});
