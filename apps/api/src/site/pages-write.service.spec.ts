import type { PageWriteReason } from "@openbrf/shared";
import { describe, expect, it, vi, type Mock } from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import type { BuiltInPage, PageStatus } from "../generated/prisma/enums";
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
    findFirst: ReturnType<typeof vi.fn>;
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
  status: "DRAFT" as PageStatus,
  frontPage: false,
  slugFollowsTitle: false,
  builtIn: null as BuiltInPage | null,
  publishedAt: null as Date | null,
  sortOrder: 0,
  revision: 4,
  updatedAt: new Date("2026-08-29T10:00:00.000Z"),
  // What the page's select reads of the menu: no entry for it.
  menuItems: [] as { id: string }[],
};

/** The news index, as the migration that made it a page wrote it. */
const NEWS: typeof DRAFT = {
  ...DRAFT,
  id: "built-in-news",
  slug: "nyheter",
  title: "Nyheter",
  content: { version: 1, blocks: [] },
  status: "PUBLIC",
  builtIn: "NEWS",
  publishedAt: new Date("2026-10-19T10:00:00.000Z"),
  sortOrder: 1001,
  revision: 1,
};

function build(): Fakes {
  const page = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    /*
     * What a claimed write reads back. A conditional update answers with a
     * count rather than a row, so the service reads the page it just wrote -
     * and this fake answers with the page as the caller asked for it.
     */
    findUniqueOrThrow: vi
      .fn()
      .mockResolvedValue({ ...DRAFT, status: "PUBLIC" }),
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

/**
 * A fake of `Fakes` seen through the signature a spec gives it, so its
 * implementation can be written with the arguments it will be called with.
 */
function asFake<Args extends unknown[], Result>(
  fake: ReturnType<typeof vi.fn>,
): Mock<(...args: Args) => Promise<Result> | Result> {
  return fake as unknown as Mock<(...args: Args) => Promise<Result> | Result>;
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
      // The front page has to be replaced first: a state of the site the
      // caller can change, like a page somebody else wrote.
      "front-page": 409,
      "front-page-not-public": 422,
      // A fact about the page that no request changes.
      "built-in": 422,
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
      },
      { personId: "person-1", channel: "WEB" },
    );

    const written = page.create.mock.calls[0]?.[0] as {
      data: { status: string; sortOrder: number };
    };
    expect(written.data.status).toBe("DRAFT");
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
      },
      { personId: "person-1", channel: "WEB" },
    );

    expect(page.aggregate).toHaveBeenCalledWith({
      where: { slug: { not: PRIVACY_NOTICE_SLUG }, builtIn: null },
      _max: { sortOrder: true },
    });
    const written = page.create.mock.calls[0]?.[0] as {
      data: { sortOrder: number };
    };
    expect(written.data.sortOrder).toBe(4);
  });

  describe("beside the pages the product wrote at the end of the list", () => {
    const NEW_PAGE = {
      slug: "ny-sida",
      title: "Ny sida",
      content: paragraphsContent(["Hej."]),
    };

    /**
     * A list whose last page the board wrote sits at `last`, followed by the
     * privacy notice and the built-in pages that sit after it.
     */
    function arranged(
      last: number | null,
      after: readonly { id: string; sortOrder: number }[],
    ) {
      const fakes = build();
      fakes.page.aggregate.mockResolvedValue({ _max: { sortOrder: last } });
      // The new address is free.
      fakes.page.findUnique.mockResolvedValueOnce(null);
      fakes.page.findMany.mockResolvedValue(after);
      return fakes;
    }

    function writtenSortOrder(page: { create: ReturnType<typeof vi.fn> }) {
      const written = page.create.mock.calls[0]?.[0] as
        { data: { sortOrder: number } } | undefined;
      return written?.data.sortOrder;
    }

    it("goes before them, moving each down in its order, once a reorder has numbered them", async () => {
      // Dragged once, the pages are numbered from nought and the notice and
      // the built-in pages with them. The next number after the last page the
      // board wrote is the notice's own, and the older notice sorted first.
      const { service, page } = arranged(0, [
        { id: "notice", sortOrder: 1 },
        { id: "built-in-news", sortOrder: 2 },
      ]);

      await service.create(NEW_PAGE, { personId: "person-1", channel: "WEB" });

      expect(writtenSortOrder(page)).toBe(1);
      expect(page.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "notice" },
          data: { sortOrder: 2 },
        }),
      );
      expect(page.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "built-in-news" },
          data: { sortOrder: 3 },
        }),
      );
    });

    it("goes before a notice that is the only page", async () => {
      const { service, page } = arranged(null, [
        { id: "notice", sortOrder: 0 },
      ]);

      await service.create(NEW_PAGE, { personId: "person-1", channel: "WEB" });

      expect(writtenSortOrder(page)).toBe(1);
      expect(page.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { sortOrder: 2 } }),
      );
    });

    it("moves only those still after every page the board wrote", async () => {
      // One the board moved up the list, or one a reorder that omitted pages
      // left tied with the last page, is where the board put it.
      const { service, page } = arranged(2, []);

      await service.create(NEW_PAGE, { personId: "person-1", channel: "WEB" });

      expect(writtenSortOrder(page)).toBe(3);
      expect(page.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [{ slug: PRIVACY_NOTICE_SLUG }, { builtIn: { not: null } }],
            sortOrder: { gt: 2 },
          },
        }),
      );
      expect(page.update).not.toHaveBeenCalled();
    });

    it("leaves them alone while there is room before them", async () => {
      const { service, page } = arranged(3, [
        { id: "notice", sortOrder: 1000 },
        { id: "built-in-news", sortOrder: 1001 },
      ]);

      await service.create(NEW_PAGE, { personId: "person-1", channel: "WEB" });

      expect(writtenSortOrder(page)).toBe(4);
      expect(page.update).not.toHaveBeenCalled();
    });

    it("decides under the page order lock", async () => {
      // A rearrangement committing between the reads and the writes would be
      // undone by them: the board drags the notice up, and the new page puts
      // it back at the end.
      const { service, page, txClient } = arranged(0, [
        { id: "notice", sortOrder: 1 },
      ]);

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
      status: "DRAFT",
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
      status: "DRAFT",
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
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

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
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

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
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

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
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

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
      service.setStatus(
        "page-1",
        { status: "PUBLIC" },
        { personId: "person-1", channel: "WEB" },
      ),
    ).resolves.toMatchObject({ status: "PUBLIC" });

    page.findUnique.mockResolvedValue({
      ...DRAFT,
      title: "Anna 19811218-9876",
    });

    const second = await refusalOf(
      service.setStatus(
        "page-1",
        { status: "PUBLIC" },
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

    await service.setStatus(
      "page-1",
      { status: "PUBLIC" },
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
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

    await service.setStatus(
      "page-1",
      { status: "DRAFT" },
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
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

    await service.setStatus(
      "page-1",
      { status: "PUBLIC" },
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
      status: "DRAFT",
      publishedAt: firstPublished,
    });

    await service.setStatus(
      "page-1",
      { status: "PUBLIC" },
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
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

    await service.setStatus(
      "page-1",
      { status: "MEMBERS_ONLY" },
      { personId: "person-1", channel: "WEB" },
    );

    const [entry] = audit.record.mock.calls[0] as [
      { action: string; context: { from: string; to: string } },
    ];
    expect(entry.action).toBe("PAGE_VISIBILITY_CHANGED");
    expect(entry.context).toMatchObject({ from: "PUBLIC", to: "MEMBERS_ONLY" });
  });

  it("runs the guardrails again, because the audience changed", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({
      ...DRAFT,
      content: WITH_PERSONNUMMER,
      status: "MEMBERS_ONLY",
    });

    const refusal = await refusalOf(
      service.setStatus(
        "page-1",
        { status: "PUBLIC" },
        { personId: "person-1", channel: "WEB" },
      ),
    );

    expect(refusal.reason).toBe("personal-identity-number");
  });

  it("writes nothing when the status is already that", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

    await service.setStatus(
      "page-1",
      { status: "PUBLIC" },
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
      status: "DRAFT",
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
      service.setStatus(
        "page-1",
        { status: "PUBLIC" },
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

    await service.setStatus(
      "page-1",
      { status: "PUBLIC", photoConsentConfirmed: true },
      { personId: "person-1", channel: "WEB" },
    );

    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("needs no confirmation when it shows nobody", async () => {
    const { service, mediaFile, audit } = publishedWithPicture();
    mediaFile.findMany.mockResolvedValue([
      { id: "file-1", visibility: "PUBLIC", showsIdentifiablePersons: false },
    ]);

    await service.setStatus(
      "page-1",
      { status: "PUBLIC" },
      { personId: "person-1", channel: "WEB" },
    );

    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it("is refused when the instance does not hold the file", async () => {
    const { service, mediaFile } = publishedWithPicture();
    mediaFile.findMany.mockResolvedValue([]);

    const refusal = await refusalOf(
      service.setStatus(
        "page-1",
        { status: "PUBLIC" },
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
      service.setStatus(
        "page-1",
        { status: "PUBLIC" },
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
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });
    page.delete.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

    await service.remove(
      "page-1",
      {},
      { personId: "person-1", channel: "WEB" },
    );

    expect(page.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "page-1", frontPage: false } }),
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
    page.delete.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

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
      fakes.service.setStatus(
        "page-1",
        { status: "PUBLIC" },
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

  describe("a save that sent no address and no revision", () => {
    const ACTOR = { personId: "person-1", channel: "WEB" as const };

    /**
     * One stored row, and a conditional write that matches its where clause
     * against that row as it stands when the write runs, as the database
     * would. `between` is another save, landing once this one has read the
     * page and before it writes.
     */
    function racing(read: typeof DRAFT, between: Partial<typeof DRAFT>) {
      const fakes = build();
      const stored = { ...read };
      asFake<[unknown], typeof DRAFT>(fakes.page.findUnique).mockImplementation(
        () => {
          const copy = { ...stored };
          Object.assign(stored, between);
          return copy;
        },
      );
      asFake<
        [{ where: Record<string, unknown>; data: Record<string, unknown> }],
        { count: number }
      >(fakes.page.updateMany).mockImplementation(({ where, data }) => {
        const matches = Object.entries(where).every(
          ([column, value]) => stored[column as keyof typeof stored] === value,
        );
        if (!matches) {
          return { count: 0 };
        }
        Object.assign(stored, data, { revision: stored.revision + 1 });
        return { count: 1 };
      });
      fakes.page.findUniqueOrThrow.mockImplementation(() => ({ ...stored }));
      return { ...fakes, stored };
    }

    it("refuses to move an address the board chose while it waited", async () => {
      const fakes = racing(
        { ...DRAFT, slugFollowsTitle: true },
        { slug: "vald-adress", slugFollowsTitle: false, revision: 5 },
      );

      const refusal = await refusalOf(
        fakes.service.update(
          "page-1",
          { title: "Ny rubrik", content: DRAFT.content },
          ACTOR,
        ),
      );

      expect(refusal.reason).toBe("page-changed");
      expect(fakes.stored).toMatchObject({
        slug: "vald-adress",
        slugFollowsTitle: false,
        revision: 5,
      });
      expect(fakes.audit.record).not.toHaveBeenCalled();
    });

    it("refuses to put back an address that was replaced while it waited", async () => {
      // A page that kept its address keeps the one it was read with; written
      // back over a newer one, it would undo the board's choice.
      const fakes = racing(
        { ...DRAFT, slugFollowsTitle: false },
        { slug: "ny-adress", revision: 5 },
      );

      const refusal = await refusalOf(
        fakes.service.update(
          "page-1",
          { title: "Ny rubrik", content: DRAFT.content },
          ACTOR,
        ),
      );

      expect(refusal.reason).toBe("page-changed");
      expect(fakes.stored).toMatchObject({ slug: "ny-adress", revision: 5 });
      expect(fakes.audit.record).not.toHaveBeenCalled();
    });

    it("refuses to put back a following address its title moved while it waited", async () => {
      // A save of the body alone keeps the address it read; written back over
      // the one a rename in between gave, it would undo that rename's address.
      const fakes = racing(
        { ...DRAFT, slugFollowsTitle: true },
        { title: "Om oss", slug: "om-oss", revision: 5 },
      );

      const refusal = await refusalOf(
        fakes.service.update(
          "page-1",
          { title: DRAFT.title, content: paragraphsContent(["Ny text."]) },
          ACTOR,
        ),
      );

      expect(refusal.reason).toBe("page-changed");
      expect(fakes.stored).toMatchObject({ slug: "om-oss", revision: 5 });
      expect(fakes.audit.record).not.toHaveBeenCalled();
    });

    it("still moves a following address with its title when nothing changed", async () => {
      const fakes = racing({ ...DRAFT, slugFollowsTitle: true }, {});

      const view = await fakes.service.update(
        "page-1",
        { title: "Ny rubrik", content: DRAFT.content },
        ACTOR,
      );

      expect(view.slug).toBe("ny-rubrik");
      expect(fakes.page.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "page-1", status: "DRAFT", slugFollowsTitle: true },
        }),
      );
    });
  });

  it("claims the revision and the publication state it checked", async () => {
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue(DRAFT);
    fakes.page.findUniqueOrThrow.mockResolvedValue({
      ...DRAFT,
      status: "PUBLIC",
      revision: 5,
    });

    await fakes.service.setStatus(
      "page-1",
      { status: "PUBLIC" },
      { personId: "person-1", channel: "WEB" },
    );

    expect(fakes.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "page-1", revision: 4, status: "DRAFT" },
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

    await fakes.service.setStatus(
      "page-1",
      { status: "PUBLIC", expectedRevision: 7 },
      { personId: "person-1", channel: "WEB" },
    );

    expect(fakes.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "page-1", revision: 7, status: "DRAFT" },
      }),
    );
  });

  it("changes the audience on a matching precondition, still claiming the page it read", async () => {
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({
      ...DRAFT,
      status: "PUBLIC",
      revision: 7,
    });

    await fakes.service.setStatus(
      "page-1",
      { status: "MEMBERS_ONLY", expectedRevision: 7 },
      { personId: "person-1", channel: "WEB" },
    );

    // Leaving public, so the claim also says the page is still not the front
    // page: one chosen in between is not to be closed under the root.
    expect(fakes.page.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "page-1",
          revision: 7,
          status: "PUBLIC",
          frontPage: false,
        },
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
      expect.objectContaining({
        where: { id: "page-1", frontPage: false, revision: 4 },
      }),
    );
  });

  it("refuses the deletion and records nothing when the claim finds no row", async () => {
    // The page this board member read is not the page that is there, and a
    // deletion has nothing to read again afterwards: what it would remove is
    // work they never saw.
    const fakes = build();
    fakes.page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });
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
      status: "PUBLIC",
      revision: 7,
    });

    const refusal = await refusalOf(
      fakes.service.setStatus(
        "page-1",
        { status: "PUBLIC", expectedRevision: 4 },
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
      status: "MEMBERS_ONLY",
      revision: 7,
    });

    const refusal = await refusalOf(
      fakes.service.setStatus(
        "page-1",
        { status: "MEMBERS_ONLY", expectedRevision: 4 },
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
      status: "PUBLIC",
      revision: 7,
    });

    const view = await fakes.service.setStatus(
      "page-1",
      { status: "PUBLIC", expectedRevision: 7 },
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
      fakes.service.setStatus(
        "page-1",
        { status: "PUBLIC", expectedRevision: 4 },
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
      status: "PUBLIC",
      revision: 9,
      content: WITH_PERSONNUMMER,
    });

    const refusal = await refusalOf(
      fakes.service.setStatus(
        "page-1",
        { status: "MEMBERS_ONLY", expectedRevision: 4 },
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
    fakes.page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

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
      expect.objectContaining({ where: { id: "page-1", frontPage: false } }),
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

describe("the address a page is given", () => {
  const ACTOR = { personId: "person-1", channel: "WEB" as const };

  function written(page: { create: ReturnType<typeof vi.fn> }) {
    const [args] = page.create.mock.calls[0] as [
      { data: { slug: string; slugFollowsTitle: boolean } },
    ];
    return args.data;
  }

  /**
   * Answers the reads for the addresses a title could take with these lists,
   * one per read, and the read for the pages at the end of the list - which
   * placing a new page makes - with none.
   */
  function addressesTaken(
    page: { findMany: ReturnType<typeof vi.fn> },
    ...answers: { slug: string }[][]
  ): void {
    asFake<[{ where: { slug?: unknown } }], unknown[]>(
      page.findMany,
    ).mockImplementation((args) =>
      args.where.slug === undefined ? [] : (answers.shift() ?? []),
    );
  }

  /** How many times the addresses a title could take were read. */
  function addressReads(page: { findMany: ReturnType<typeof vi.fn> }): number {
    return page.findMany.mock.calls.filter(
      ([args]) =>
        (args as { where: { slug?: unknown } }).where.slug !== undefined,
    ).length;
  }

  it("makes a new page's address from its title, with nothing typed", async () => {
    const { service, page } = build();

    await service.create(
      { title: "Om föreningen", content: paragraphsContent(["Hej."]) },
      ACTOR,
    );

    expect(written(page)).toMatchObject({
      slug: "om-foreningen",
      slugFollowsTitle: true,
    });
  });

  it("numbers an address another page already has", async () => {
    const { service, page } = build();
    page.findMany.mockResolvedValue([
      { slug: "styrelsen" },
      { slug: "styrelsen-2" },
    ]);

    await service.create(
      { title: "Styrelsen", content: paragraphsContent(["Hej."]) },
      ACTOR,
    );

    expect(written(page).slug).toBe("styrelsen-3");
  });

  it("numbers an address the router keeps for itself", async () => {
    const { service, page } = build();

    await service.create(
      { title: "Nyheter", content: paragraphsContent(["Hej."]) },
      ACTOR,
    );

    expect(written(page).slug).toBe("nyheter-2");
  });

  it("tries the next number when another page took the address in between", async () => {
    // Two pages created with one title at once both find the address free;
    // the unique index refuses the second, which is then given the next one.
    const { service, page } = build();
    addressesTaken(page, [], [{ slug: "styrelsen" }]);
    page.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed.", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const view = await service.create(
      { title: "Styrelsen", content: paragraphsContent(["Hej."]) },
      ACTOR,
    );

    expect(view.slug).toBe("styrelsen-2");
  });

  it("keeps an address the board typed, and stops it following the title", async () => {
    const { service, page } = build();

    await service.create(
      {
        slug: "kontakt",
        title: "Hör av dig",
        content: paragraphsContent(["Hej."]),
      },
      ACTOR,
    );

    expect(written(page)).toMatchObject({
      slug: "kontakt",
      slugFollowsTitle: false,
    });
  });

  function savedSlug(page: { updateMany: ReturnType<typeof vi.fn> }) {
    const [args] = page.updateMany.mock.calls[0] as [
      { data: { slug: string; slugFollowsTitle?: boolean } },
    ];
    return args.data;
  }

  it("moves a draft's address with its title while it follows it", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({
      ...DRAFT,
      slug: "om-foreningen",
      slugFollowsTitle: true,
    });

    await service.update(
      "page-1",
      { title: "Om oss", content: DRAFT.content },
      ACTOR,
    );

    expect(savedSlug(page)).toMatchObject({ slug: "om-oss" });
    expect(savedSlug(page).slugFollowsTitle).toBeUndefined();
    // Its own address is not in the way of itself.
    expect(page.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "page-1" } }),
      }),
    );
  });

  describe("a draft given a numbered address", () => {
    /**
     * A draft created as `Styrelsen` while another page held `styrelsen`, so
     * given `styrelsen-2`, which is the address the editor shows for it from
     * then on. The other page is then gone: nothing holds `styrelsen` any more.
     */
    async function numberedDraft() {
      const fakes = build();
      addressesTaken(fakes.page, [{ slug: "styrelsen" }]);
      const created = await fakes.service.create(
        { title: "Styrelsen", content: paragraphsContent(["Hej."]) },
        ACTOR,
      );
      expect(created).toMatchObject({
        slug: "styrelsen-2",
        slugFollowsTitle: true,
      });

      const [args] = fakes.page.create.mock.calls[0] as [{ data: object }];
      fakes.page.findUnique.mockResolvedValue({ ...DRAFT, ...args.data });
      addressesTaken(fakes.page);
      return fakes;
    }

    it("keeps it when only the body is saved, though its title's own is free again", async () => {
      const { service, page } = await numberedDraft();

      await service.update(
        "page-1",
        {
          title: "Styrelsen",
          content: paragraphsContent(["Ny text."]),
          expectedRevision: DRAFT.revision,
        },
        ACTOR,
      );

      expect(savedSlug(page).slug).toBe("styrelsen-2");
      expect(savedSlug(page).slugFollowsTitle).toBeUndefined();
      expect(addressReads(page)).toBe(1);
    });

    it("keeps it through a new title that gives the same address", async () => {
      const { service, page } = await numberedDraft();

      await service.update(
        "page-1",
        { title: "Styrelsen!", content: DRAFT.content },
        ACTOR,
      );

      expect(savedSlug(page).slug).toBe("styrelsen-2");
    });

    it("still moves it to the address a new title gives", async () => {
      const { service, page } = await numberedDraft();

      await service.update(
        "page-1",
        { title: "Valberedningen", content: DRAFT.content },
        ACTOR,
      );

      expect(savedSlug(page).slug).toBe("valberedningen");
    });

    it("gives a title renamed back its own address once that is free", async () => {
      // Renamed away and back, the title gives its address afresh, the way a
      // new page with it would get it.
      const { service, page } = await numberedDraft();
      page.findUnique.mockResolvedValue({
        ...DRAFT,
        title: "Valberedningen",
        slug: "valberedningen",
        slugFollowsTitle: true,
      });

      await service.update(
        "page-1",
        { title: "Styrelsen", content: DRAFT.content },
        ACTOR,
      );

      expect(savedSlug(page).slug).toBe("styrelsen");
    });
  });

  describe("the address the preview of a held save shows", () => {
    /*
     * Each case answers the read of the addresses the same way for the
     * preview as for the save after it, so the save writes what the preview
     * said it would.
     */
    it.each([
      {
        name: "a draft following its title, renamed",
        stored: { slug: "om-foreningen", slugFollowsTitle: true },
        sent: { title: "Om oss" },
        taken: [],
        slug: "om-oss",
      },
      {
        name: "a draft following its title, renamed to an address another page has",
        stored: { slug: "om-foreningen", slugFollowsTitle: true },
        sent: { title: "Om oss" },
        taken: [{ slug: "om-oss" }],
        slug: "om-oss-2",
      },
      {
        name: "a numbered draft whose title still gives the same address",
        stored: {
          slug: "styrelsen-2",
          title: "Styrelsen",
          slugFollowsTitle: true,
        },
        sent: { title: "Styrelsen!" },
        taken: [],
        slug: "styrelsen-2",
      },
      {
        name: "a page whose address no longer follows its title, renamed",
        stored: { slug: "om-foreningen", slugFollowsTitle: false },
        sent: { title: "Om oss" },
        taken: [],
        slug: "om-foreningen",
      },
      {
        name: "a draft following its title, sent an address",
        stored: { slug: "om-foreningen", slugFollowsTitle: true },
        sent: { title: "Om oss", slug: "kontakt" },
        taken: [],
        slug: "kontakt",
      },
    ])("is the one the save writes, for $name", async (example) => {
      const { service, page } = build();
      page.findUnique.mockResolvedValue({ ...DRAFT, ...example.stored });
      addressesTaken(page, example.taken, example.taken);

      const previewed = await service.slugAfterUpdate(
        await service.byId("page-1"),
        example.sent,
      );
      await service.update(
        "page-1",
        { ...example.sent, content: DRAFT.content },
        ACTOR,
      );

      expect(previewed).toBe(example.slug);
      expect(savedSlug(page).slug).toBe(example.slug);
    });

    it("is the title's own address when every number is taken, which the save refuses", async () => {
      const { service, page } = build();
      page.findUnique.mockResolvedValue({
        ...DRAFT,
        slug: "om-foreningen",
        slugFollowsTitle: true,
      });
      const everyNumber = [
        { slug: "om-oss" },
        ...Array.from({ length: 999 }, (_, index) => ({
          slug: `om-oss-${String(index + 2)}`,
        })),
      ];
      addressesTaken(page, everyNumber, everyNumber);

      await expect(
        service.slugAfterUpdate(await service.byId("page-1"), {
          title: "Om oss",
        }),
      ).resolves.toBe("om-oss");
      await expect(
        service.update(
          "page-1",
          { title: "Om oss", content: DRAFT.content },
          ACTOR,
        ),
      ).rejects.toMatchObject({ reason: "slug-taken" });
    });
  });

  it("leaves the address of a page that has been published alone on a rename", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({
      ...DRAFT,
      status: "PUBLIC",
      slug: "om-foreningen",
      slugFollowsTitle: false,
      publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    await service.update(
      "page-1",
      { title: "Om oss", content: DRAFT.content },
      ACTOR,
    );

    expect(savedSlug(page).slug).toBe("om-foreningen");
    expect(page.findMany).not.toHaveBeenCalled();
  });

  it("takes an address sent by hand, and keeps it from then on", async () => {
    const { service, page } = build();
    page.findUnique
      .mockResolvedValueOnce({ ...DRAFT, slugFollowsTitle: true })
      .mockResolvedValueOnce(null);

    await service.update(
      "page-1",
      { slug: "vara-hus", title: "Om oss", content: DRAFT.content },
      ACTOR,
    );

    expect(savedSlug(page)).toMatchObject({
      slug: "vara-hus",
      slugFollowsTitle: false,
    });
  });

  it("settles the address the first time the page is published", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, slugFollowsTitle: true });

    await service.setStatus("page-1", { status: "MEMBERS_ONLY" }, ACTOR);

    const claim = page.updateMany.mock.calls[0]?.[0] as {
      data: { slugFollowsTitle?: boolean };
    };
    expect(claim.data.slugFollowsTitle).toBe(false);
  });
});

describe("one status for a page", () => {
  const ACTOR = { personId: "person-1", channel: "WEB" as const };

  function entryOf(audit: { record: ReturnType<typeof vi.fn> }) {
    return (
      audit.record.mock.calls[0] as [
        { action: string; context: Record<string, unknown> },
      ]
    )[0];
  }

  it("records a draft opened to the members as a publication", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue(DRAFT);
    page.findUniqueOrThrow.mockResolvedValue({
      ...DRAFT,
      status: "MEMBERS_ONLY",
    });

    await service.setStatus("page-1", { status: "MEMBERS_ONLY" }, ACTOR);

    expect(entryOf(audit)).toMatchObject({
      action: "PAGE_PUBLISHED",
      context: { published: true, status: "MEMBERS_ONLY" },
    });
  });

  it("records a published page moved to the street as a change of audience", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "MEMBERS_ONLY" });
    page.findUniqueOrThrow.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

    await service.setStatus("page-1", { status: "PUBLIC" }, ACTOR);

    expect(entryOf(audit)).toMatchObject({
      action: "PAGE_VISIBILITY_CHANGED",
      context: { from: "MEMBERS_ONLY", to: "PUBLIC", published: true },
    });
  });

  it("does not scan a page being made a draft", async () => {
    // Taking a page down makes nothing readable, so what is on it does not
    // stop it coming down.
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue({
      ...DRAFT,
      status: "PUBLIC",
      content: WITH_PERSONNUMMER,
    });
    page.findUniqueOrThrow.mockResolvedValue(DRAFT);

    await service.setStatus("page-1", { status: "DRAFT" }, ACTOR);

    expect(entryOf(audit)).toMatchObject({
      action: "PAGE_PUBLISHED",
      context: { published: false, status: "DRAFT" },
    });
  });
});

describe("the front page", () => {
  const ACTOR = { personId: "person-1", channel: "WEB" as const };
  const FRONT = { ...DRAFT, status: "PUBLIC" as PageStatus, frontPage: true };

  it.each(["DRAFT", "MEMBERS_ONLY"] as const)(
    "stays public: making it %s is refused until another is chosen",
    async (status) => {
      const { service, page, audit } = build();
      page.findUnique.mockResolvedValue(FRONT);

      const refusal = await refusalOf(
        service.setStatus("page-1", { status }, ACTOR),
      );

      expect(refusal.reason).toBe("front-page");
      expect(refusal.status).toBe(409);
      expect(page.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it("is not deleted until another is chosen", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue(FRONT);

    const refusal = await refusalOf(service.remove("page-1", {}, ACTOR));

    expect(refusal.reason).toBe("front-page");
    expect(page.delete).not.toHaveBeenCalled();
  });

  it.each(["DRAFT", "MEMBERS_ONLY"] as const)(
    "is never a page that is %s",
    async (status) => {
      const { service, page } = build();
      page.findUnique.mockResolvedValue({ ...DRAFT, status });

      const refusal = await refusalOf(
        service.setFrontPage("page-1", {}, ACTOR),
      );

      expect(refusal.reason).toBe("front-page-not-public");
      expect(page.updateMany).not.toHaveBeenCalled();
    },
  );

  it("replaces the one before it, under its lock, and records both", async () => {
    const { service, page, audit, txClient } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });
    page.findFirst.mockResolvedValue({ id: "page-0" });
    page.findUniqueOrThrow.mockResolvedValue({
      ...DRAFT,
      status: "PUBLIC",
      frontPage: true,
    });

    const view = await service.setFrontPage("page-1", {}, ACTOR);

    expect(view.frontPage).toBe(true);
    expect(page.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "page-0" },
        data: { frontPage: false },
      }),
    );
    // Claimed as still public in the statement that makes it the front page.
    expect(page.updateMany).toHaveBeenCalledWith({
      where: { id: "page-1", status: "PUBLIC" },
      data: { frontPage: true },
    });
    const locked = txClient.$executeRaw.mock.invocationCallOrder[0] ?? Infinity;
    expect(page.findFirst.mock.invocationCallOrder[0]).toBeGreaterThan(locked);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAGE_FRONT_PAGE_CHANGED",
        targetId: "page-1",
        context: { slug: "om-foreningen", previous: "page-0" },
      }),
      txClient,
    );
  });

  it("claims the revision the caller read in the statement that makes the page the front page", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

    await service.setFrontPage("page-1", { expectedRevision: 4 }, ACTOR);

    expect(page.updateMany).toHaveBeenCalledWith({
      where: { id: "page-1", status: "PUBLIC", revision: 4 },
      data: { frontPage: true },
    });
    // Choosing a front page does not move the page's revision.
    expect(page.updateMany.mock.calls[0]?.[0].data).not.toHaveProperty(
      "revision",
    );
  });

  it("refuses a page saved by somebody else while the lock was awaited, and keeps the former front page", async () => {
    const { service, page, audit, txClient, prisma } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });
    page.findFirst.mockResolvedValue({ id: "page-0" });
    // The pages as they stand in the database: another editor saves page-1
    // while this request waits for the front-page lock.
    const stored = { revision: 4, frontPage: { "page-0": true } };
    asFake<[], number>(txClient.$executeRaw).mockImplementation(() => {
      stored.revision = 5;
      return Promise.resolve(1);
    });
    asFake<[{ where: { id: string } }], object>(page.update).mockImplementation(
      (args) => {
        stored.frontPage[args.where.id as "page-0"] = false;
        return Promise.resolve({ ...DRAFT });
      },
    );
    asFake<[{ where: { revision?: number } }], { count: number }>(
      page.updateMany,
    ).mockImplementation((args) =>
      Promise.resolve({
        count:
          args.where.revision === undefined ||
          args.where.revision === stored.revision
            ? 1
            : 0,
      }),
    );
    // Postgres undoes what a transaction wrote when its callback throws.
    asFake<[(tx: typeof txClient) => Promise<unknown>], unknown>(
      prisma.$transaction,
    ).mockImplementation(async (run) => {
      const before = { ...stored.frontPage };
      try {
        return await run(txClient);
      } catch (error) {
        stored.frontPage = before;
        throw error;
      }
    });

    const refusal = await refusalOf(
      service.setFrontPage("page-1", { expectedRevision: 4 }, ACTOR),
    );

    expect(refusal.reason).toBe("page-changed");
    expect(refusal.status).toBe(409);
    // The former front page was cleared inside the transaction, then restored
    // when the refusal aborted it.
    expect(page.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { frontPage: false } }),
    );
    expect(stored.frontPage["page-0"]).toBe(true);
    expect(audit.record).not.toHaveBeenCalled();
    expect(page.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("makes the page the front page without a revision when the caller sent none", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });

    await service.setFrontPage("page-1", {}, ACTOR);

    expect(page.updateMany).toHaveBeenCalledWith({
      where: { id: "page-1", status: "PUBLIC" },
      data: { frontPage: true },
    });
  });

  it("refuses a page taken down since it was read", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue({ ...DRAFT, status: "PUBLIC" });
    page.updateMany.mockResolvedValue({ count: 0 });

    const refusal = await refusalOf(service.setFrontPage("page-1", {}, ACTOR));

    expect(refusal.reason).toBe("page-changed");
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("writes nothing when the page already is the front page", async () => {
    const { service, page, audit } = build();
    page.findUnique.mockResolvedValue(FRONT);

    await service.setFrontPage("page-1", {}, ACTOR);

    expect(page.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe("a built-in page", () => {
  const ACTOR = { personId: "person-1", channel: "WEB" } as const;

  it("takes a new title, which is what a menu entry for it borrows", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue(NEWS);
    page.findUniqueOrThrow.mockResolvedValue({ ...NEWS, title: "Aktuellt" });

    await expect(
      service.update(
        "built-in-news",
        { title: "Aktuellt", content: { version: 1, blocks: [] } },
        ACTOR,
      ),
    ).resolves.toMatchObject({ title: "Aktuellt", builtIn: "NEWS" });

    // At the address it is served at, whatever the new title would give.
    const [claim] = page.updateMany.mock.calls[0] as [
      { data: { slug: string } },
    ];
    expect(claim.data.slug).toBe("nyheter");
  });

  it("refuses a body, which nobody would ever be shown", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue(NEWS);

    const refusal = await refusalOf(
      service.update(
        "built-in-news",
        { title: "Nyheter", content: paragraphsContent(["Hej."]) },
        ACTOR,
      ),
    );

    expect(refusal.reason).toBe("built-in");
    expect(page.updateMany).not.toHaveBeenCalled();
  });

  it("refuses another address, and takes back the one it has", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue(NEWS);
    const empty: PageContent = { version: 1, blocks: [] };

    const refusal = await refusalOf(
      service.update(
        "built-in-news",
        { title: "Nyheter", slug: "aktuellt", content: empty },
        ACTOR,
      ),
    );
    expect(refusal.reason).toBe("built-in");

    await expect(
      service.update(
        "built-in-news",
        { title: "Nyheter", slug: "nyheter", content: empty },
        ACTOR,
      ),
    ).resolves.toBeDefined();
  });

  it.each(["DRAFT", "MEMBERS_ONLY"] as const)(
    "stays public rather than become %s",
    async (status) => {
      const { service, page, audit } = build();
      page.findUnique.mockResolvedValue(NEWS);

      const refusal = await refusalOf(
        service.setStatus("built-in-news", { status }, ACTOR),
      );

      expect(refusal.reason).toBe("built-in");
      expect(page.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it("is never the front page", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue(NEWS);

    const refusal = await refusalOf(
      service.setFrontPage("built-in-news", {}, ACTOR),
    );

    expect(refusal.reason).toBe("built-in");
    expect(page.updateMany).not.toHaveBeenCalled();
  });

  it("is not removed", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue(NEWS);

    const refusal = await refusalOf(service.remove("built-in-news", {}, ACTOR));

    expect(refusal.reason).toBe("built-in");
    expect(page.delete).not.toHaveBeenCalled();
  });
});
