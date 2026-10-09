import type { PageWriteReason } from "@openbrf/shared";
import { describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { paragraphsContent, type PageContent } from "./page-content";
import { PagesWriteService, PageWriteError } from "./pages-write.service";
import { PRIVACY_NOTICE_SLUG } from "./pages.service";

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
    deleteMany: ReturnType<typeof vi.fn>;
  };
  mediaFile: { findMany: ReturnType<typeof vi.fn> };
  menuItem: { findMany: ReturnType<typeof vi.fn> };
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
  txClient: { $executeRaw: ReturnType<typeof vi.fn> };
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
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const mediaFile = { findMany: vi.fn().mockResolvedValue([]) };
  const menuItem = { findMany: vi.fn().mockResolvedValue([]) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  // `$executeRaw` is the menu lock a removal takes.
  const client = {
    page,
    mediaFile,
    menuItem,
    $executeRaw: vi.fn().mockResolvedValue(1),
  };

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
    menuItem,
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

  it("answers an address taken since it was checked as taken, not as a failure", async () => {
    // Two creates to one address at once both pass the check, and the unique
    // index refuses the second write. That is the conflict the check answers,
    // and the client already knows how to show it.
    const { service, page } = build();
    page.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed.", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

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

  it("answers a rename to an address taken since it was checked the same way", async () => {
    const { service, page } = build();
    page.updateMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed.", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    for (const expectedRevision of [undefined, DRAFT.revision]) {
      // The page by its id, then nothing at the new address when it is checked.
      page.findUnique.mockResolvedValueOnce(DRAFT).mockResolvedValueOnce(null);
      const refusal = await refusalOf(
        service.update(
          "page-1",
          {
            slug: "hem",
            title: DRAFT.title,
            content: DRAFT.content,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          },
          { personId: "person-1", channel: "WEB" },
        ),
      );
      expect(refusal.reason, String(expectedRevision)).toBe("slug-taken");
    }
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

  it("places a new page before the privacy notice, which is never the front page", async () => {
    // The notice is seeded at 1000 so it is never the lowest page. A page
    // placed after it would leave the notice first once the pages before it
    // are gone, and the root would serve it.
    const { service, page } = build();

    await service.create(
      {
        slug: "ny-framsida",
        title: "Välkommen",
        content: paragraphsContent(["Hej."]),
        visibility: "PUBLIC",
      },
      { personId: "person-1", channel: "WEB" },
    );

    expect(page.aggregate).toHaveBeenCalledWith({
      where: { slug: { not: PRIVACY_NOTICE_SLUG } },
      _max: { sortOrder: true },
    });
    const written = page.create.mock.calls[0]?.[0] as {
      data: { sortOrder: number };
    };
    expect(written.data.sortOrder).toBe(4);
  });

  describe("beside a privacy notice the board's list has numbered", () => {
    const NEW_PAGE = {
      slug: "ny-sida",
      title: "Ny sida",
      content: paragraphsContent(["Hej."]),
      visibility: "PUBLIC" as const,
    };

    /** A list whose last other page sits at `last` and notice at `notice`. */
    function arranged(last: number | null, notice: number) {
      const fakes = build();
      fakes.page.aggregate.mockResolvedValue({ _max: { sortOrder: last } });
      // The new address is free, and then the notice is where it is.
      fakes.page.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ sortOrder: notice });
      return fakes;
    }

    function writtenSortOrder(page: { create: ReturnType<typeof vi.fn> }) {
      const written = page.create.mock.calls[0]?.[0] as
        { data: { sortOrder: number } } | undefined;
      return written?.data.sortOrder;
    }

    it("goes before the notice, moving the notice down, once a reorder has numbered them", async () => {
      // Dragged once, the pages are numbered from nought and the notice with
      // them: one page at 0 and the notice at 1. The next number after the
      // last page is the notice's own, and the older notice sorted first.
      const { service, page } = arranged(0, 1);

      await service.create(NEW_PAGE, { personId: "person-1", channel: "WEB" });

      expect(writtenSortOrder(page)).toBe(1);
      expect(page.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: PRIVACY_NOTICE_SLUG },
          data: { sortOrder: 2 },
        }),
      );
    });

    it("goes before a notice that is the only page", async () => {
      const { service, page } = arranged(null, 0);

      await service.create(NEW_PAGE, { personId: "person-1", channel: "WEB" });

      expect(writtenSortOrder(page)).toBe(1);
      expect(page.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { sortOrder: 2 } }),
      );
    });

    it("leaves a notice the board moved up the list where the board put it", async () => {
      const { service, page } = arranged(1, 0);

      await service.create(NEW_PAGE, { personId: "person-1", channel: "WEB" });

      expect(writtenSortOrder(page)).toBe(2);
      expect(page.update).not.toHaveBeenCalled();
    });

    it("leaves a notice tied with the last page where the board put it", async () => {
      // A reorder that omitted pages can leave both at one number, and the
      // older notice then sorts first on purpose.
      const { service, page } = arranged(2, 2);

      await service.create(NEW_PAGE, { personId: "person-1", channel: "WEB" });

      expect(writtenSortOrder(page)).toBe(3);
      expect(page.update).not.toHaveBeenCalled();
    });

    it("leaves a notice with room before it alone", async () => {
      const { service, page } = arranged(3, 1000);

      await service.create(NEW_PAGE, { personId: "person-1", channel: "WEB" });

      expect(writtenSortOrder(page)).toBe(4);
      expect(page.update).not.toHaveBeenCalled();
    });

    it("decides under the page order lock", async () => {
      // A rearrangement committing between the reads and the writes would be
      // undone by them: the board drags the notice up, and the new page puts
      // it back at the end.
      const { service, page, txClient } = arranged(0, 1);

      await service.create(NEW_PAGE, { personId: "person-1", channel: "WEB" });

      const locked =
        txClient.$executeRaw.mock.invocationCallOrder[0] ?? Infinity;
      expect(page.aggregate.mock.invocationCallOrder[0]).toBeGreaterThan(
        locked,
      );
      expect(page.update.mock.invocationCallOrder[0]).toBeGreaterThan(locked);
    });
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

  it("refuses a personal identity number in a link's address", async () => {
    // Nobody reads the address as text, and it is in the page's HTML all the
    // same: a mailto: link carries whatever was typed into its subject line.
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, published: true });

    const refusal = await refusalOf(
      service.update(
        "page-1",
        {
          slug: DRAFT.slug,
          title: DRAFT.title,
          content: {
            version: 1,
            blocks: [
              {
                type: "paragraph",
                runs: [
                  {
                    text: "Skriv till Anna",
                    link: "mailto:anna@exempel.se?subject=19811218-9876",
                  },
                ],
              },
            ],
          },
        },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("personal-identity-number");
    // Placed by its block alone, once for the address as written and decoded:
    // the number is not in the words, so no offset into them can point at it.
    expect(refusal.details()["locations"]).toEqual([
      { part: "block", index: 0 },
    ]);
  });

  it("refuses an address escaped too deeply to be read, placed by its block", async () => {
    // Each decoding pass may take off one level only. Decoding a link of the
    // length the schema allows to the end took a thousand passes and kept
    // every reading, so a body of such links held the process for seconds.
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, published: true });

    const refusal = await refusalOf(
      service.update(
        "page-1",
        {
          slug: DRAFT.slug,
          title: DRAFT.title,
          content: {
            version: 1,
            blocks: [
              { type: "paragraph", runs: [{ text: "Hej" }] },
              {
                type: "paragraph",
                runs: [{ text: "Se här", link: `%${"25".repeat(999)}2D` }],
              },
            ],
          },
        },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("personal-identity-number");
    expect(refusal.details()["locations"]).toEqual([
      { part: "block", index: 1 },
    ]);
  });

  it("places a number in a later FAQ item where it is, whatever an earlier item links to", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, published: true });

    const refusal = await refusalOf(
      service.update(
        "page-1",
        {
          slug: DRAFT.slug,
          title: DRAFT.title,
          content: {
            version: 1,
            blocks: [
              {
                type: "faq",
                items: [
                  {
                    question: "Vem?",
                    answer: [{ text: "Anna", link: "/styrelsen" }],
                  },
                  {
                    question: "19811218-9876?",
                    answer: [{ text: "Nej." }],
                  },
                ],
              },
            ],
          },
        },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    // "Vem? Anna " is ten characters, and the address is not among them.
    expect(refusal.details()["locations"]).toEqual([
      { part: "block", index: 0, offset: 10 },
    ]);
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

  it("takes the page order lock before it writes a position", async () => {
    const { service, page, txClient } = build();

    await service.reorder(["page-2", "page-1"], {
      personId: "person-1",
      channel: "WEB",
    });

    const locked = txClient.$executeRaw.mock.invocationCallOrder[0] ?? Infinity;
    expect(page.updateMany.mock.invocationCallOrder[0]).toBeGreaterThan(locked);
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
    page.delete.mockResolvedValue({ ...DRAFT, published: true });

    await service.remove(
      "page-1",
      {},
      { personId: "person-1", channel: "WEB" },
    );

    expect(page.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "page-1" } }),
    );
    const [entry] = audit.record.mock.calls[0] as [
      { action: string; context: { deleted: boolean } },
    ];
    expect(entry.action).toBe("PAGE_PUBLISHED");
    expect(entry.context.deleted).toBe(true);
  });

  it("records a page published after it was read, from the row it deleted", async () => {
    // Read as a draft, published by somebody else, then deleted: deciding from
    // the read would take a public page off the website with nothing said.
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue(DRAFT);
    page.delete.mockResolvedValue({ ...DRAFT, published: true });

    await service.remove(
      "page-1",
      {},
      { personId: "person-1", channel: "WEB" },
    );

    const [entry] = audit.record.mock.calls[0] as [
      { action: string; context: Record<string, unknown> },
    ];
    expect(entry.action).toBe("PAGE_PUBLISHED");
    expect(entry.context).toEqual({
      slug: "om-foreningen",
      published: false,
      deleted: true,
    });
  });

  it("records each menu entry the page takes with it", async () => {
    // The cascade removes them, and every menu write is audited whichever way
    // it was reached: the log has to say what left the menu, and who took it.
    const { service, page, menuItem, audit, txClient } = build();
    page.findUnique.mockResolvedValue(DRAFT);
    menuItem.findMany.mockResolvedValue([
      { id: "item-1", kind: "PAGE", parentId: null, _count: { children: 5 } },
      { id: "item-2", kind: "PAGE", parentId: null, _count: { children: 0 } },
    ]);

    await service.remove(
      "page-1",
      {},
      { personId: "person-1", channel: "WEB" },
    );

    expect(menuItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pageId: "page-1" } }),
    );
    const entries = audit.record.mock.calls.map(
      ([entry, tx]) => [entry, tx] as [Record<string, unknown>, unknown],
    );
    expect(entries.map(([entry]) => entry)).toEqual([
      expect.objectContaining({
        action: "MENU_ITEM_REMOVED",
        actorPersonId: "person-1",
        targetKind: "menuItem",
        targetId: "item-1",
        context: { kind: "PAGE", childrenRemoved: 5, withPage: "page-1" },
      }),
      expect.objectContaining({
        action: "MENU_ITEM_REMOVED",
        targetId: "item-2",
        context: { kind: "PAGE", childrenRemoved: 0, withPage: "page-1" },
      }),
    ]);
    for (const [, tx] of entries) {
      expect(tx).toBe(txClient);
    }
  });

  it("records an entry under another entry for the page once, as its parent's child", async () => {
    // The child goes with its parent, and the parent's record counts it. A
    // second record of its own would say the menu lost two things where the
    // board removed one.
    const { service, page, menuItem, audit } = build();
    page.findUnique.mockResolvedValue(DRAFT);
    menuItem.findMany.mockResolvedValue([
      { id: "item-1", kind: "PAGE", parentId: null, _count: { children: 1 } },
      {
        id: "item-2",
        kind: "PAGE",
        parentId: "item-1",
        _count: { children: 0 },
      },
    ]);

    await service.remove(
      "page-1",
      {},
      { personId: "person-1", channel: "WEB" },
    );

    expect(audit.record.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({
        action: "MENU_ITEM_REMOVED",
        targetId: "item-1",
        context: { kind: "PAGE", childrenRemoved: 1, withPage: "page-1" },
      }),
    ]);
  });

  it("still records an entry for the page that hangs under an entry for another", async () => {
    const { service, page, menuItem, audit } = build();
    page.findUnique.mockResolvedValue(DRAFT);
    menuItem.findMany.mockResolvedValue([
      {
        id: "item-2",
        kind: "PAGE",
        parentId: "item-elsewhere",
        _count: { children: 0 },
      },
    ]);

    await service.remove(
      "page-1",
      {},
      { personId: "person-1", channel: "WEB" },
    );

    expect(audit.record.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({
        action: "MENU_ITEM_REMOVED",
        targetId: "item-2",
      }),
    ]);
  });

  it("finds the entries under the menu lock, so none can be added unrecorded", async () => {
    const { service, page, menuItem, txClient } = build();
    page.findUnique.mockResolvedValue(DRAFT);

    await service.remove(
      "page-1",
      {},
      { personId: "person-1", channel: "WEB" },
    );

    const locked = txClient.$executeRaw.mock.invocationCallOrder[0] ?? Infinity;
    expect(menuItem.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      locked,
    );
    expect(page.delete.mock.invocationCallOrder[0]).toBeGreaterThan(locked);
  });

  it("records nothing for a draft nobody could read", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue(DRAFT);

    await service.remove(
      "page-1",
      {},
      { personId: "person-1", channel: "WEB" },
    );

    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses a page that is not there", async () => {
    const { service } = build();
    const refusal = await refusalOf(
      service.remove("page-9", {}, { personId: "person-1", channel: "WEB" }),
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

describe("a write built on a copy somebody else has replaced", () => {
  /**
   * The precondition the caller sends, which is a wider claim than the one the
   * method makes for itself.
   *
   * The claim a line above the write only refuses a save that lands inside one
   * call. This one refuses a publication, a change of audience or a deletion
   * decided on a copy of the page read minutes ago and rewritten since - which
   * is the ordinary way two board members lose each other's work, and the case
   * the page save has taken a precondition for all along.
   */
  it("publishes on a matching precondition, still claiming the page it read", async () => {
    /*
     * The caller's precondition is answered before any of this, so by the time
     * the write runs the two numbers are the same one. The claim stays because
     * it answers a different question: whether anything landed between this
     * method's own read and its write.
     */
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({ ...DRAFT, revision: 7 });

    await fakes.service.setPublished(
      "page-1",
      { published: true, expectedRevision: 7 },
      { personId: "person-1", channel: "WEB" },
    );

    expect(fakes.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "page-1", revision: 7, published: false },
      }),
    );
  });

  it("changes the audience on a matching precondition, still claiming the page it read", async () => {
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({ ...DRAFT, revision: 7 });

    await fakes.service.setVisibility(
      "page-1",
      { visibility: "MEMBER", expectedRevision: 7 },
      { personId: "person-1", channel: "WEB" },
    );

    expect(fakes.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "page-1", revision: 7, visibility: "PUBLIC" },
      }),
    );
  });

  it("claims the revision the caller read when deleting", async () => {
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue(DRAFT);

    await fakes.service.remove(
      "page-1",
      { expectedRevision: 4 },
      { personId: "person-1", channel: "WEB" },
    );

    expect(fakes.page.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "page-1", revision: 4 } }),
    );
  });

  it("refuses the deletion and records nothing when the claim finds no row", async () => {
    // The page this board member read is not the page that is there, and a
    // deletion has nothing to read again afterwards: what it would remove is
    // work they never saw.
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({ ...DRAFT, published: true });
    fakes.menuItem.findMany.mockResolvedValue([
      { id: "item-1", kind: "PAGE", _count: { children: 0 } },
    ]);
    fakes.page.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("No record was found.", {
        code: "P2025",
        clientVersion: "test",
      }),
    );

    const refusal = await refusalOf(
      fakes.service.remove(
        "page-1",
        { expectedRevision: 4 },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("page-changed");
    expect(refusal.status).toBe(409);
    expect(fakes.audit.record).not.toHaveBeenCalled();
  });

  it("refuses a publication already made, where the caller read an older copy", async () => {
    /*
     * Somebody else rewrote the page and published it. The caller asked to
     * publish the revision it read, and answering "done" would tell it that
     * the content it decided on is what is now on the website.
     */
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({
      ...DRAFT,
      published: true,
      revision: 7,
    });

    const refusal = await refusalOf(
      fakes.service.setPublished(
        "page-1",
        { published: true, expectedRevision: 4 },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("page-changed");
    expect(refusal.status).toBe(409);
    expect(fakes.page.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an audience already set, where the caller read an older copy", async () => {
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({
      ...DRAFT,
      visibility: "MEMBER",
      revision: 7,
    });

    const refusal = await refusalOf(
      fakes.service.setVisibility(
        "page-1",
        { visibility: "MEMBER", expectedRevision: 4 },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("page-changed");
    expect(fakes.page.updateMany).not.toHaveBeenCalled();
  });

  it("answers a publication already made as a no-op where the caller read this copy", async () => {
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({
      ...DRAFT,
      published: true,
      revision: 7,
    });

    const view = await fakes.service.setPublished(
      "page-1",
      { published: true, expectedRevision: 7 },
      { personId: "person-1", channel: "WEB" },
    );

    expect(view.revision).toBe(7);
    expect(fakes.page.updateMany).not.toHaveBeenCalled();
    expect(fakes.audit.record).not.toHaveBeenCalled();
  });

  it("answers a stale publication with the conflict, not with the stored page's guardrail", async () => {
    /*
     * The guardrails on this path read the page as it is stored, which is
     * content a caller holding an older copy has never seen. Run before the
     * precondition, a page somebody else had left carrying a personal identity
     * number would answer 422 about that content - and the caller, whose real
     * problem is that its copy is stale, would be handed a refusal on the
     * merits of somebody else's writing and never reach its conflict path.
     */
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({
      ...DRAFT,
      revision: 9,
      content: WITH_PERSONNUMMER,
    });

    const refusal = await refusalOf(
      fakes.service.setPublished(
        "page-1",
        { published: true, expectedRevision: 4 },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("page-changed");
    expect(refusal.status).toBe(409);
  });

  it("answers a stale change of audience the same way", async () => {
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({
      ...DRAFT,
      published: true,
      revision: 9,
      content: WITH_PERSONNUMMER,
    });

    const refusal = await refusalOf(
      fakes.service.setVisibility(
        "page-1",
        { visibility: "MEMBER", expectedRevision: 4 },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("page-changed");
    expect(refusal.status).toBe(409);
  });

  it("still refuses a save on the merits of what the caller itself submitted", async () => {
    /*
     * The other side of the rule, and why `update` is left as it is: its
     * guardrails read the content in the request rather than the content on
     * the page. A personal identity number in what this caller typed is its
     * own problem whether or not its copy is stale, and answering the conflict
     * instead would hide the thing it has to fix.
     */
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({ ...DRAFT, published: true });

    const refusal = await refusalOf(
      fakes.service.update(
        "page-1",
        {
          slug: DRAFT.slug,
          title: DRAFT.title,
          content: WITH_PERSONNUMMER,
          expectedRevision: 4,
        },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("personal-identity-number");
    expect(refusal.status).toBe(422);
  });

  it("deletes without a precondition, as the route always has", async () => {
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue(DRAFT);

    await fakes.service.remove(
      "page-1",
      {},
      { personId: "person-1", channel: "WEB" },
    );

    expect(fakes.page.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "page-1" } }),
    );
  });
});

describe("reading the pages a few at a time", () => {
  it("refuses a cursor whose sort order no page can have, without asking the database", async () => {
    const { service, page } = build();

    for (const cursor of ["9999999999:page-1", "-2147483649:page-1"]) {
      const refusal = await refusalOf(
        service.listSummaries({ limit: 1, cursor }),
      );
      expect(refusal.reason, cursor).toBe("not-found");
    }
    expect(page.findMany).not.toHaveBeenCalled();
  });

  it("still reads a cursor at either end of the column's range", async () => {
    const { service, page } = build();

    for (const cursor of ["2147483647:page-1", "-2147483648:page-1"]) {
      await service.listSummaries({ limit: 1, cursor });
    }
    expect(page.findMany).toHaveBeenCalledTimes(2);
  });
});
