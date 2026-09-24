import { HttpStatus } from "@nestjs/common";
import { localDayOf } from "@openbrf/shared";
import { describe, expect, it, vi } from "vitest";

import {
  capabilitiesFor,
  type Principal,
  type PrincipalRoles,
} from "../authorization/capabilities";
import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import type { MediaService } from "../media/media.service";
import { ApartmentBinderError } from "./apartment-binder.error";
import {
  ApartmentBinderService,
  BINDER_BYTES_PER_APARTMENT,
  refusePersonalIdentityNumbers,
} from "./apartment-binder.service";

/**
 * Filing into a binder, over a fake database and a fake media layer.
 *
 * These cases are the refusals, and the order they come in. Every one of them
 * has to happen before a byte is stored: an upload that was going to be refused
 * should not have cost the disk it was refused for, and a refusal arriving
 * after the file was written would leave an object nothing references.
 *
 * What a fake cannot honestly answer is what the reading side asks - an
 * audience filter written as part of a query, an ordering the database
 * performs, a relation filter on a residency held today - so those are in
 * `apartment-binder.int-spec.ts` against a real database rather than against a
 * stub that would decide exactly what the case was meant to show.
 */

const APARTMENT = "apartment-1201";

const PDF = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "latin1",
);

function principal(overrides: Partial<PrincipalRoles> = {}): Principal {
  const roles: PrincipalRoles = {
    isAdmin: false,
    isBoardMember: false,
    isPropertyManager: false,
    isResident: true,
    isMember: true,
    ...overrides,
  };
  return {
    personId: "holder-1",
    ...roles,
    capabilities: capabilitiesFor(roles),
  };
}

interface Fakes {
  service: ApartmentBinderService;
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  audited: { action: string }[];
}

function build(
  options: {
    holdsApartment?: boolean;
    bytesStored?: number;
    createFails?: boolean;
  } = {},
): Fakes {
  const upload = vi.fn(async () => ({ id: "file-1" }));
  const remove = vi.fn(async () => undefined);
  const create = vi.fn(async () => {
    if (options.createFails === true) {
      throw new Error("the entry could not be written");
    }
    return {
      id: "entry-1",
      apartmentId: APARTMENT,
      kind: "DRAWING",
      audience: "HOUSEHOLD",
      title: "Ritning badrum",
      datedOn: null,
      filedAs: "TENANT_OWNER",
      filedByPersonId: "holder-1",
      createdAt: new Date("2026-09-23T10:00:00.000Z"),
      mediaFile: {
        id: "file-1",
        fileName: "ritning.pdf",
        contentType: "application/pdf",
        byteSize: PDF.length,
      },
    };
  });

  const prisma = {
    residency: {
      count: vi.fn(async () => ((options.holdsApartment ?? true) ? 1 : 0)),
    },
    apartment: { count: vi.fn(async () => 1) },
    mediaFile: {
      aggregate: vi.fn(async () => ({
        _sum: { byteSize: options.bytesStored ?? 0 },
      })),
    },
    apartmentDocument: {
      create,
      // The entry a take-out finds. The relation filter on a residency held
      // today is what only the integration suite can honestly answer, so this
      // stands for "the caller may take this one out" and the case here is
      // about what the removal records.
      findFirst: vi.fn(async () => ({ mediaFileId: "file-1" })),
    },
  };

  const audited: { action: string }[] = [];
  const audit = {
    record: vi.fn(async (entry: { action: string }) => {
      audited.push(entry);
    }),
    withAuditedRead: vi.fn(
      async (
        entry: { action: string },
        read: (tx: unknown) => Promise<unknown>,
      ) => {
        const result = await read(prisma);
        audited.push(entry);
        return result;
      },
    ),
  };

  const service = new ApartmentBinderService(
    prisma as unknown as PrismaService,
    { upload, remove } as unknown as MediaService,
    audit as unknown as AuditLogService,
  );

  return { service, upload, remove, create, audited };
}

function filing(overrides: Record<string, unknown> = {}) {
  return {
    apartmentId: APARTMENT,
    kind: "DRAWING" as const,
    audience: "HOUSEHOLD" as const,
    title: "Ritning badrum",
    datedOn: null,
    bytes: PDF,
    fileName: "ritning.pdf",
    actor: principal(),
    ...overrides,
  };
}

describe("filing as a tenant-owner", () => {
  it("stores the file and the entry", async () => {
    const fakes = build();

    const entry = await fakes.service.file(filing());

    expect(entry.filedAs).toBe("TENANT_OWNER");
    expect(entry.filedByYou).toBe(true);
    expect(fakes.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        accept: "document",
        visibility: "HOUSEHOLD",
        apartmentId: APARTMENT,
        requiredCapability: "apartmentBinder:manage",
        // The household's own words, in a table the purge cannot reach.
        recordFileName: false,
        prefix: "binder",
      }),
    );
  });

  it("maps the tenant-owners audience onto its own visibility", async () => {
    const fakes = build();

    await fakes.service.file(filing({ audience: "TENANT_OWNERS" }));

    expect(fakes.upload).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: "TENANT_OWNERS" }),
    );
  });

  it("answers not-found for an apartment the filer does not hold", async () => {
    // The same answer as an apartment that does not exist: a refusal naming
    // the difference would confirm which apartments there are and who holds
    // them.
    const fakes = build({ holdsApartment: false });

    await expect(fakes.service.file(filing())).rejects.toMatchObject({
      reason: "not-found",
      status: HttpStatus.NOT_FOUND,
    });
    expect(fakes.upload).not.toHaveBeenCalled();
  });

  it("refuses the board's permission, and stores nothing", async () => {
    const fakes = build();

    await expect(
      fakes.service.file(
        filing({
          kind: "ALTERATION_PERMISSION",
          datedOn: localDayOf(new Date()),
        }),
      ),
    ).rejects.toMatchObject({
      reason: "kind-is-the-boards",
      status: HttpStatus.FORBIDDEN,
    });
    expect(fakes.upload).not.toHaveBeenCalled();
  });

  it("refuses a title carrying a personal identity number, naming the field", async () => {
    const fakes = build();

    const error = await fakes.service
      .file(filing({ title: "Ritning 19811218-9876" }))
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApartmentBinderError);
    const refusal = error as ApartmentBinderError;
    expect(refusal.reason).toBe("personal-identity-number");
    expect(refusal.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(refusal.details()).toEqual({
      locations: [{ part: "title", offset: 8 }],
    });
    // The number itself is exactly what must not travel back.
    expect(JSON.stringify(refusal.details())).not.toContain("19811218");
    expect(fakes.upload).not.toHaveBeenCalled();
  });

  it("refuses a file name carrying a personal identity number", async () => {
    /*
     * The name is stored on the row, answered in every household's listing and
     * echoed in the download disposition, so a number in it reaches the next
     * household with no retention clock - the disclosure the title rule exists
     * to stop. `safeFileName` strips characters and looks at nothing.
     */
    const fakes = build();

    const error = await fakes.service
      .file(filing({ fileName: "19811218-9876_besiktning.pdf" }))
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApartmentBinderError);
    const refusal = error as ApartmentBinderError;
    expect(refusal.reason).toBe("personal-identity-number");
    expect(refusal.details()).toEqual({
      locations: [{ part: "fileName", offset: 0 }],
    });
    expect(JSON.stringify(refusal.details())).not.toContain("19811218");
    expect(fakes.upload).not.toHaveBeenCalled();
  });

  it("names both fields when the title and the file name each carry one", async () => {
    const fakes = build();

    const error = await fakes.service
      .file(
        filing({
          title: "Ritning 19811218-9876",
          fileName: "19811218-9876.pdf",
        }),
      )
      .catch((cause: unknown) => cause);

    expect((error as ApartmentBinderError).details().locations).toEqual([
      { part: "title", offset: 8 },
      { part: "fileName", offset: 0 },
    ]);
  });

  it("refuses a filing the binder has no room for", async () => {
    const fakes = build({ bytesStored: BINDER_BYTES_PER_APARTMENT });

    await expect(fakes.service.file(filing())).rejects.toMatchObject({
      reason: "binder-full",
      status: HttpStatus.CONFLICT,
    });
    expect(fakes.upload).not.toHaveBeenCalled();
  });

  it("removes the stored file when the entry cannot be written", async () => {
    // The file goes first and the entry second, for the reason the media
    // service gives about bytes and rows: this order can only ever leave an
    // unreferenced object, while the other would leave an entry pointing at
    // nothing.
    const fakes = build({ createFails: true });

    await expect(fakes.service.file(filing())).rejects.toThrow(
      /could not be written/,
    );
    // And the rollback withholds the name too: an upload that failed to become
    // an entry still wrote a MEDIA_UPLOADED row that left it out.
    expect(fakes.remove).toHaveBeenCalledWith("file-1", "holder-1", "WEB", {
      recordFileName: false,
    });
  });
});

describe("taking an entry out", () => {
  it("removes the file without putting its name in the log", async () => {
    // The removal entry is the other half of the rule the upload's
    // `recordFileName: false` states: the log never holds a household's own
    // words about its own home.
    const fakes = build();

    await fakes.service.takeOut("entry-1", principal());

    expect(fakes.remove).toHaveBeenCalledWith("file-1", "holder-1", "WEB", {
      recordFileName: false,
    });
  });
});

describe("filing as the board", () => {
  it("files the permission, with its day, as the board", async () => {
    const fakes = build();

    await fakes.service.fileAsBoard(
      filing({
        kind: "ALTERATION_PERMISSION",
        audience: "TENANT_OWNERS",
        datedOn: localDayOf(new Date("2026-05-04T10:00:00.000Z")),
        actor: principal({ isBoardMember: true }),
      }),
    );

    expect(fakes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "ALTERATION_PERMISSION",
          filedAs: "BOARD",
        }),
      }),
    );
  });

  it("refuses the permission without the day the board decided", async () => {
    const fakes = build();

    await expect(
      fakes.service.fileAsBoard(
        filing({
          kind: "ALTERATION_PERMISSION",
          datedOn: null,
          actor: principal({ isBoardMember: true }),
        }),
      ),
    ).rejects.toMatchObject({
      reason: "date-required",
      status: HttpStatus.BAD_REQUEST,
    });
    expect(fakes.upload).not.toHaveBeenCalled();
  });
});

describe("the personal identity number guardrail", () => {
  it("lets an ordinary title through", () => {
    expect(() =>
      refusePersonalIdentityNumbers("Besiktning ventilation 2024"),
    ).not.toThrow();
  });

  it("catches a number in the file name too", () => {
    const error = (() => {
      try {
        refusePersonalIdentityNumbers("Besiktning", "19811218-9876.pdf");
      } catch (cause) {
        return cause as ApartmentBinderError;
      }
      return null;
    })();

    expect(error?.details().locations).toEqual([
      { part: "fileName", offset: 0 },
    ]);
  });

  it("catches every number in a title", () => {
    const error = (() => {
      try {
        refusePersonalIdentityNumbers("19811218-9876 och 19811218-9876");
      } catch (cause) {
        return cause as ApartmentBinderError;
      }
      return null;
    })();

    expect(error?.details().locations).toHaveLength(2);
  });
});
