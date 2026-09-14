import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { paragraphsContent, type PageContent } from "./page-content";
import {
  PagesWriteService,
  PageWriteError,
  type PageWriteReason,
} from "./pages-write.service";

/**
 * The publication guardrails, as rules rather than as endpoints.
 *
 * The refusals are what this file is for. Each one is a promise the platform
 * makes about what a housing cooperative can put on its own website by
 * accident, and each is asserted here against the service rather than through
 * HTTP, so the rule is pinned even if the routes around it change.
 */

interface Fakes {
  service: PagesWriteService;
  page: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  mediaFile: { findMany: ReturnType<typeof vi.fn> };
  audit: { record: ReturnType<typeof vi.fn> };
  prisma: { $transaction: ReturnType<typeof vi.fn> };
  /**
   * The client the transaction callback is handed, by identity.
   *
   * Exposed so a spec can assert that the audit entry was written with THIS
   * one rather than merely with something. The two are different objects here
   * on purpose: passing the root client would commit the entry separately from
   * the write it records, and an assertion that the argument is defined cannot
   * tell the two apart.
   */
  txClient: object;
}

const DRAFT = {
  id: "page-1",
  slug: "om-foreningen",
  title: "Om föreningen",
  content: paragraphsContent(["Hej."]),
  visibility: "PUBLIC" as const,
  published: false,
  publishedAt: null,
  sortOrder: 0,
  revision: 4,
  updatedAt: new Date("2026-08-29T10:00:00.000Z"),
};

function build(): Fakes {
  const page = {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    /*
     * What a claimed write reads back. A conditional update answers with a
     * count rather than a row, so the service reads the page it just wrote -
     * and this fake answers with the page as the caller asked for it.
     */
    findUniqueOrThrow: vi.fn().mockResolvedValue({ ...DRAFT, published: true }),
    aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 3 } }),
    create: vi.fn(async (args: { data: unknown }) => ({
      ...DRAFT,
      ...(args.data as object),
    })),
    update: vi.fn(async (args: { data: unknown }) => ({
      ...DRAFT,
      ...(args.data as object),
    })),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    delete: vi.fn().mockResolvedValue(DRAFT),
  };
  const mediaFile = { findMany: vi.fn().mockResolvedValue([]) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  const client = { page, mediaFile };

  const prisma = {
    ...client,
    /*
     * The interactive form, because every write here now carries its audit
     * entry inside the transaction. The callback is handed the same fakes the
     * service holds, so a spec can read what was written either way: what these
     * tests check is that the entry is written with the change, not that
     * Postgres isolates them.
     */
    $transaction: vi.fn(async (run: unknown) =>
      typeof run === "function"
        ? await (run as (tx: typeof client) => Promise<unknown>)(client)
        : run,
    ),
  };

  return {
    service: new PagesWriteService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
    ),
    page,
    mediaFile,
    audit,
    prisma,
    txClient: client,
  };
}

async function refusalOf(run: Promise<unknown>): Promise<PageWriteError> {
  try {
    await run;
  } catch (cause) {
    if (cause instanceof PageWriteError) {
      return cause;
    }
    throw cause;
  }
  throw new Error("The write was not refused.");
}

const WITH_PERSONNUMMER: PageContent = paragraphsContent([
  "Kontakta Anna.",
  "Hennes personnummer är 19811218-9876 om du behöver det.",
]);

describe("what a refusal answers with", () => {
  it("gives every reason the status its contract promises", () => {
    /*
     * Exhaustive by construction: a reason added to the union without a status
     * here is a compile error rather than a route that quietly answers the
     * wrong thing. The distinction that matters is between the three that are
     * about the request - the address is unusable, the address is taken, the
     * page is not there, or somebody else wrote first - and the four that are
     * about the content: the page exists and cannot be published as it stands,
     * which is unprocessable and not missing. A 404 on one of those reads as
     * "no such page".
     */
    const expected: Record<PageWriteReason, number> = {
      "not-found": 404,
      "invalid-slug": 400,
      "slug-taken": 409,
      // Nothing is wrong with what was sent: the page moved underneath it.
      "page-changed": 409,
      "personal-identity-number": 422,
      "photo-consent-required": 422,
      "image-not-found": 422,
      "image-not-public": 422,
    };

    for (const [reason, status] of Object.entries(expected)) {
      expect(
        new PageWriteError("refused", reason as PageWriteReason).status,
        reason,
      ).toBe(status);
    }
  });
});

describe("writing a page", () => {
  it("refuses an address a page may not have", async () => {
    const { service } = build();

    const refusal = await refusalOf(
      service.create(
        {
          slug: "api",
          title: "Hej",
          content: paragraphsContent(["Hej."]),
          visibility: "PUBLIC",
        },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("invalid-slug");
  });

  it("refuses an address another page already has", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ id: "page-9" });

    const refusal = await refusalOf(
      service.create(
        {
          slug: "hem",
          title: "Hej",
          content: paragraphsContent(["Hej."]),
          visibility: "PUBLIC",
        },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("slug-taken");
    expect(refusal.status).toBe(409);
  });

  it("writes a new page unpublished whatever else it says", async () => {
    const { service, page } = build();

    await service.create(
      {
        slug: "styrelsen",
        title: "Styrelsen",
        content: paragraphsContent(["Hej."]),
        visibility: "MEMBER",
      },
      { personId: "person-1", channel: "WEB" },
    );

    const written = page.create.mock.calls[0]?.[0] as {
      data: { published: boolean; sortOrder: number };
    };
    expect(written.data.published).toBe(false);
    expect(written.data.sortOrder).toBe(4);
  });

  it("records the content change, saying how much page there is and never what it says", async () => {
    const { service, audit } = build();

    await service.create(
      {
        slug: "styrelsen",
        title: "Styrelsen",
        content: paragraphsContent(["Ordförande är Anna.", "Kassör är Bo."]),
        visibility: "MEMBER",
      },
      { personId: "person-1", channel: "WEB" },
    );

    const [entry] = audit.record.mock.calls[0] as [
      {
        action: string;
        actorPersonId: string;
        targetKind: string;
        context: Record<string, unknown>;
      },
    ];
    expect(entry.action).toBe("PAGE_CONTENT_CHANGED");
    expect(entry.actorPersonId).toBe("person-1");
    expect(entry.targetKind).toBe("page");
    // Which page it was and how much of it there now is. The text itself has a
    // home on the row, and this table outlives that row.
    expect(entry.context).toEqual({
      slug: "styrelsen",
      blockCount: 2,
      published: false,
      created: true,
    });
    expect(JSON.stringify(entry.context)).not.toContain("Anna");
  });

  it("records a rewrite once, inside the transaction that wrote it", async () => {
    // Not beside it: an entry that outlived a rolled-back save would name a
    // page nobody rewrote.
    const { service, page, audit, prisma, txClient } = build();
    page.findUnique.mockResolvedValue(DRAFT);
    page.findUniqueOrThrow.mockResolvedValue({
      ...DRAFT,
      content: paragraphsContent(["Hej.", "Och välkommen."]),
      revision: 5,
    });

    await service.update(
      "page-1",
      {
        slug: DRAFT.slug,
        title: DRAFT.title,
        content: paragraphsContent(["Hej.", "Och välkommen."]),
      },
      { personId: "person-1", channel: "WEB" },
    );

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry, tx] = audit.record.mock.calls[0] as [
      { action: string; targetId: string; context: Record<string, unknown> },
      unknown,
    ];
    expect(entry.action).toBe("PAGE_CONTENT_CHANGED");
    expect(entry.targetId).toBe("page-1");
    // Counted off the page as it stands once the claim has held, which is what
    // the service reads back: a conditional write answers with a count and not
    // with a row.
    expect(entry.context).toEqual({
      slug: "om-foreningen",
      blockCount: 2,
      published: false,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    /*
     * The callback's own client, by identity. "Defined" would also be true of
     * the root client, and passing that one is exactly the defect this case
     * exists to catch: the entry would commit on its own connection and
     * survive a save that rolled back, naming a page nobody rewrote.
     */
    expect(tx).toBe(txClient);
  });

  it("saves a draft that carries a personal identity number", async () => {
    // Half-written text is where a board member pastes something from an email
    // to tidy up later. Nothing is readable by anyone until it is published,
    // which is the moment the rule applies.
    const { service, page } = build();
    page.findUnique.mockResolvedValue(DRAFT);

    await expect(
      service.update(
        "page-1",
        {
          slug: DRAFT.slug,
          title: DRAFT.title,
          content: WITH_PERSONNUMMER,
        },
        { personId: "person-1", channel: "WEB" },
      ),
    ).resolves.toMatchObject({ slug: "om-foreningen" });
  });

  it("refuses to leave a personal identity number on a published page", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, published: true });

    const refusal = await refusalOf(
      service.update(
        "page-1",
        {
          slug: DRAFT.slug,
          title: DRAFT.title,
          content: WITH_PERSONNUMMER,
        },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("personal-identity-number");
    expect(refusal.status).toBe(422);
    // Where, so the board can fix it - and never what, because the value found
    // is exactly the thing that must not be repeated.
    expect(refusal.details()["locations"]).toEqual([
      { part: "block", index: 1, offset: 23 },
    ]);
    expect(JSON.stringify(refusal.details())).not.toContain("9876");
  });

  it("scans the title as well as the body", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue(DRAFT);

    await expect(
      service.setPublished(
        "page-1",
        { published: true },
        { personId: "person-1", channel: "WEB" },
      ),
    ).resolves.toMatchObject({ published: true });

    page.findUnique.mockResolvedValue({
      ...DRAFT,
      title: "Anna 19811218-9876",
    });

    const second = await refusalOf(
      service.setPublished(
        "page-1",
        { published: true },
        { personId: "person-1", channel: "WEB" },
      ),
    );
    expect(second.reason).toBe("personal-identity-number");
    expect(second.details()["locations"]).toEqual([
      { part: "title", index: 0, offset: 5 },
    ]);
  });
});

describe("publishing a page", () => {
  it("records the publication in the audit log with the change", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue(DRAFT);

    await service.setPublished(
      "page-1",
      { published: true },
      { personId: "person-1", channel: "WEB" },
    );

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry] = audit.record.mock.calls[0] as [
      {
        action: string;
        actorPersonId: string;
        targetKind: string;
        targetId: string;
        context: { published: boolean };
      },
    ];
    expect(entry.action).toBe("PAGE_PUBLISHED");
    expect(entry.actorPersonId).toBe("person-1");
    expect(entry.targetKind).toBe("page");
    expect(entry.targetId).toBe("page-1");
    expect(entry.context.published).toBe(true);
  });

  it("records taking a page down as the publication change it is", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, published: true });

    await service.setPublished(
      "page-1",
      { published: false },
      { personId: "person-1", channel: "WEB" },
    );

    const [entry] = audit.record.mock.calls[0] as [
      { action: string; context: { published: boolean } },
    ];
    expect(entry.action).toBe("PAGE_PUBLISHED");
    expect(entry.context.published).toBe(false);
  });

  it("writes nothing when the page is already in that state", async () => {
    // Pressing publish on a published page is not an event, and an audit log
    // that recorded it would be padded with acts nobody performed.
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, published: true });

    await service.setPublished(
      "page-1",
      { published: true },
      { personId: "person-1", channel: "WEB" },
    );

    expect(page.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("keeps the date a page was first published", async () => {
    const { service, page } = build();
    const firstPublished = new Date("2026-01-02T00:00:00.000Z");
    page.findUnique.mockResolvedValue({
      ...DRAFT,
      published: false,
      publishedAt: firstPublished,
    });

    await service.setPublished(
      "page-1",
      { published: true },
      { personId: "person-1", channel: "WEB" },
    );

    // Through the claimed write, which is what publishing uses so that a save
    // landing after the guardrails ran cannot be published unread.
    const written = page.updateMany.mock.calls[0]?.[0] as {
      data: { publishedAt: Date };
    };
    // A republish after a correction does not make it a newer page.
    expect(written.data.publishedAt).toBe(firstPublished);
  });
});

describe("changing who may read a page", () => {
  it("records the change in the audit log, naming both ends", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, published: true });

    await service.setVisibility(
      "page-1",
      { visibility: "MEMBER" },
      { personId: "person-1", channel: "WEB" },
    );

    const [entry] = audit.record.mock.calls[0] as [
      { action: string; context: { from: string; to: string } },
    ];
    expect(entry.action).toBe("PAGE_VISIBILITY_CHANGED");
    expect(entry.context).toMatchObject({ from: "PUBLIC", to: "MEMBER" });
  });

  it("runs the guardrails again, because the audience changed", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({
      ...DRAFT,
      published: true,
      content: WITH_PERSONNUMMER,
      visibility: "MEMBER",
    });

    const refusal = await refusalOf(
      service.setVisibility(
        "page-1",
        { visibility: "PUBLIC" },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("personal-identity-number");
  });

  it("writes nothing when the visibility is already that", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue(DRAFT);

    await service.setVisibility(
      "page-1",
      { visibility: "PUBLIC" },
      { personId: "person-1", channel: "WEB" },
    );

    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe("a picture on a published page", () => {
  const withPicture: PageContent = {
    version: 1,
    blocks: [
      { type: "paragraph", runs: [{ text: "Sommarfesten." }] },
      { type: "image", mediaFileId: "file-1", alt: "Gården" },
    ],
  };

  function publishedWithPicture() {
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({
      ...DRAFT,
      published: false,
      content: withPicture,
    });
    return fakes;
  }

  it("is refused when it shows identifiable persons and nobody confirmed the consents", async () => {
    const { service, mediaFile } = publishedWithPicture();
    mediaFile.findMany.mockResolvedValue([
      { id: "file-1", visibility: "PUBLIC", showsIdentifiablePersons: true },
    ]);

    const refusal = await refusalOf(
      service.setPublished(
        "page-1",
        { published: true },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("photo-consent-required");
    expect(refusal.details()["locations"]).toEqual([
      { part: "block", index: 1 },
    ]);
  });

  it("is published once the board confirms them", async () => {
    const { service, mediaFile, audit } = publishedWithPicture();
    mediaFile.findMany.mockResolvedValue([
      { id: "file-1", visibility: "PUBLIC", showsIdentifiablePersons: true },
    ]);

    await service.setPublished(
      "page-1",
      { published: true, photoConsentConfirmed: true },
      { personId: "person-1", channel: "WEB" },
    );

    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("needs no confirmation when it shows nobody", async () => {
    const { service, mediaFile, audit } = publishedWithPicture();
    mediaFile.findMany.mockResolvedValue([
      { id: "file-1", visibility: "PUBLIC", showsIdentifiablePersons: false },
    ]);

    await service.setPublished(
      "page-1",
      { published: true },
      { personId: "person-1", channel: "WEB" },
    );

    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("is refused when the instance does not hold the file", async () => {
    const { service, mediaFile } = publishedWithPicture();
    mediaFile.findMany.mockResolvedValue([]);

    const refusal = await refusalOf(
      service.setPublished(
        "page-1",
        { published: true },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("image-not-found");
  });

  it("is refused when the file is not served publicly", async () => {
    // A published page with a picture nobody can fetch is a broken page, and
    // finding that out from a visitor is worse than being told now.
    const { service, mediaFile } = publishedWithPicture();
    mediaFile.findMany.mockResolvedValue([
      { id: "file-1", visibility: "INTERNAL", showsIdentifiablePersons: false },
    ]);

    const refusal = await refusalOf(
      service.setPublished(
        "page-1",
        { published: true },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("image-not-public");
  });
});

describe("the order the pages sit in", () => {
  it("writes each id the position it arrived at", async () => {
    const { service, page } = build();

    await service.reorder(["page-2", "page-1"], {
      personId: "person-1",
      channel: "WEB",
    });

    expect(page.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "page-2" },
      data: { sortOrder: 0 },
    });
    expect(page.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "page-1" },
      data: { sortOrder: 1 },
    });
  });

  it("ignores an id the instance does not have", async () => {
    // This is a drag on a list, and a stale row in the browser must not lose
    // the whole arrangement. Ignored means the write is attempted and matches
    // no row, rather than the arrangement being refused: the ids beside the
    // stale one are still written the positions they arrived at.
    const { service, page } = build();
    // The stale id matches no row; the one beside it matches its own.
    page.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await service.reorder(["page-9", "page-1"], {
      personId: "person-1",
      channel: "WEB",
    });

    expect(page.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "page-9" },
      data: { sortOrder: 0 },
    });
    expect(page.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "page-1" },
      data: { sortOrder: 1 },
    });
  });

  it("records the arrangement, counting the ids the board sent", async () => {
    // Ids the instance does not have are ignored, so how many rows moved is
    // not a number this call knows. What it does know is what it was asked to
    // arrange, and an entry either way is the honest record that the board
    // rearranged the website.
    const { service, page, audit } = build();
    page.updateMany.mockResolvedValue({ count: 0 });

    await service.reorder(["page-9", "page-2", "page-1"], {
      personId: "person-1",
      channel: "WEB",
    });

    const [entry] = audit.record.mock.calls[0] as [
      {
        action: string;
        targetKind: string;
        targetId: string | null;
        context: Record<string, unknown>;
      },
    ];
    expect(entry.action).toBe("PAGE_REORDERED");
    expect(entry.targetKind).toBe("page");
    // No one page was the act.
    expect(entry.targetId).toBeNull();
    expect(entry.context).toEqual({ count: 3 });
  });
});

describe("removing a page", () => {
  it("records taking a published page off the website", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, published: true });

    await service.remove("page-1", { personId: "person-1", channel: "WEB" });

    expect(page.delete).toHaveBeenCalledWith({ where: { id: "page-1" } });
    const [entry] = audit.record.mock.calls[0] as [
      { action: string; context: { deleted: boolean } },
    ];
    expect(entry.action).toBe("PAGE_PUBLISHED");
    expect(entry.context.deleted).toBe(true);
  });

  it("records nothing for a draft nobody could read", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue(DRAFT);

    await service.remove("page-1", { personId: "person-1", channel: "WEB" });

    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses a page that is not there", async () => {
    const { service } = build();
    const refusal = await refusalOf(
      service.remove("page-9", { personId: "person-1", channel: "WEB" }),
    );

    expect(refusal.reason).toBe("not-found");
    expect(refusal.status).toBe(404);
  });
});

describe("a write that was checked and then overtaken", () => {
  /**
   * Publishing reads the page, checks it against the guardrails and then
   * writes. A content save landing between those two is a save nothing read -
   * it was checked as a draft, because that is what the page still was - and
   * this write would make it public.
   *
   * The write therefore claims the page it validated: its revision and its
   * publication state. This is asserted here rather than through HTTP because
   * the window is inside one call, between two statements a request cannot be
   * interleaved with from outside.
   */
  it("refuses the publication and records nothing when the claim finds no row", async () => {
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue(DRAFT);
    // Somebody saved between the read above and this write, so the revision
    // this claim names is gone.
    fakes.page.updateMany.mockResolvedValue({ count: 0 });

    const refusal = await refusalOf(
      fakes.service.setPublished(
        "page-1",
        { published: true },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("page-changed");
    // The log says a page was published only where one was.
    expect(fakes.audit.record).not.toHaveBeenCalled();
  });

  it("refuses the save and records nothing when the claim finds no row", async () => {
    // The entry rolls back with the write it records. A log saying the page
    // was rewritten, where the rewrite never landed, would be worse than no
    // log at all: it is read as evidence of who changed what.
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue(DRAFT);
    // Somebody saved between the read above and this write, so the revision
    // the caller is claiming on is gone.
    fakes.page.updateMany.mockResolvedValue({ count: 0 });

    const refusal = await refusalOf(
      fakes.service.update(
        "page-1",
        {
          slug: DRAFT.slug,
          title: DRAFT.title,
          content: paragraphsContent(["Rättad."]),
          expectedRevision: 4,
        },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("page-changed");
    expect(fakes.audit.record).not.toHaveBeenCalled();
  });

  it("claims the revision and the publication state it checked", async () => {
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue(DRAFT);
    fakes.page.findUniqueOrThrow.mockResolvedValue({
      ...DRAFT,
      published: true,
      revision: 5,
    });

    await fakes.service.setPublished(
      "page-1",
      { published: true },
      { personId: "person-1", channel: "WEB" },
    );

    expect(fakes.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "page-1", revision: 4, published: false },
      }),
    );
  });
});
