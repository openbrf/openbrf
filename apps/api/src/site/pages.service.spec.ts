import type { TFunction } from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import { isUsableSlug, PagesService } from "./pages.service";

/**
 * What the public website is allowed to answer with.
 *
 * The interesting behaviour here is a refusal that does not say it is a
 * refusal: a member-only page, an unpublished page and an address that names
 * nothing all come back as null, so the controller has one answer to give and
 * an anonymous visitor cannot learn which of the three they hit.
 */

const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

interface Fakes {
  service: PagesService;
  page: {
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

function build(): Fakes {
  const page = {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({ id: "page-1" }),
  };
  return {
    service: new PagesService({ page } as unknown as PrismaService),
    page,
  };
}

const PUBLISHED = {
  slug: "hem",
  title: "Välkommen",
  content: {
    version: 1,
    blocks: [{ type: "paragraph", runs: [{ text: "Hej." }] }],
  },
  published: true,
  visibility: "PUBLIC" as const,
};

describe("isUsableSlug", () => {
  it("accepts the shape a page address may have", () => {
    expect(isUsableSlug("hem")).toBe(true);
    expect(isUsableSlug("om-foreningen")).toBe(true);
    expect(isUsableSlug("2026")).toBe(true);
  });

  it("refuses anything that would change what a path means", () => {
    // A slug is a whole path segment. Every character below decides how a URL
    // is read, so a page carrying one could be reached as something other than
    // a page - or reach a file.
    expect(isUsableSlug("om/foreningen")).toBe(false);
    expect(isUsableSlug("../etc")).toBe(false);
    expect(isUsableSlug("index.html")).toBe(false);
    expect(isUsableSlug("%2e%2e")).toBe(false);
    expect(isUsableSlug("Hem")).toBe(false);
    expect(isUsableSlug("")).toBe(false);
    expect(isUsableSlug("-hem")).toBe(false);
    expect(isUsableSlug("a".repeat(81))).toBe(false);
  });

  it("refuses the names this instance already serves", () => {
    // Route matching would prefer the real route in every one of these cases,
    // so a page claiming the name would be a page nobody could ever open.
    for (const taken of ["app", "api", "health", "fonts", "setup"]) {
      expect(isUsableSlug(taken), taken).toBe(false);
    }
  });
});

describe("the front page", () => {
  it("is the first published public page", async () => {
    const { service, page } = build();
    page.findFirst.mockResolvedValue(PUBLISHED);

    await expect(service.homePage()).resolves.toEqual({
      slug: "hem",
      title: "Välkommen",
      content: {
        version: 1,
        blocks: [{ type: "paragraph", runs: [{ text: "Hej." }] }],
      },
    });

    // Lowest order first, oldest first on a tie, and never a member-only page:
    // the front door of an association's website is not a page half its
    // visitors are answered with a not-found for.
    expect(page.findFirst).toHaveBeenCalledWith({
      where: { published: true, visibility: "PUBLIC" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { slug: true, title: true, content: true },
    });
  });

  it("is nothing at all on an instance with no published page", async () => {
    const { service } = build();
    await expect(service.homePage()).resolves.toBeNull();
  });
});

describe("a page by its address", () => {
  it("is served when it is published and public", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue(PUBLISHED);

    await expect(service.bySlug("hem", false)).resolves.toMatchObject({
      slug: "hem",
    });
  });

  it("is nothing when it does not exist", async () => {
    const { service } = build();
    await expect(service.bySlug("styrelsen", true)).resolves.toBeNull();
  });

  it("is nothing when it exists but is unpublished", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ ...PUBLISHED, published: false });

    // Even for a signed-in member: a draft is not a page.
    await expect(service.bySlug("hem", true)).resolves.toBeNull();
  });

  it("is nothing when it is member-only and nobody is signed in", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ ...PUBLISHED, visibility: "MEMBER" });

    await expect(service.bySlug("hem", false)).resolves.toBeNull();
    await expect(service.bySlug("hem", true)).resolves.toMatchObject({
      slug: "hem",
    });
  });

  it("never asks the database about an address a page cannot have", async () => {
    const { service, page } = build();

    await expect(service.bySlug("../../etc/passwd", true)).resolves.toBeNull();
    await expect(service.bySlug("api", true)).resolves.toBeNull();
    expect(page.findUnique).not.toHaveBeenCalled();
  });

  it("keeps only the blocks this renderer knows", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({
      ...PUBLISHED,
      content: {
        version: 2,
        blocks: [
          { type: "paragraph", text: "Hej." },
          { type: "embed", src: "https://tracker.example/pixel" },
          { type: "paragraph" },
          "not a block",
        ],
      },
    });

    const found = await service.bySlug("hem", false);

    // A body written by a later editor renders as less, never as something
    // this version cannot vouch for.
    expect(found?.content.blocks).toEqual([
      { type: "paragraph", runs: [{ text: "Hej." }] },
    ]);
  });

  it("still reads a paragraph written before runs existed", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({
      ...PUBLISHED,
      content: {
        version: 1,
        blocks: [{ type: "paragraph", text: "Skrivet av den första guiden." }],
      },
    });

    // Bodies in the database are in that shape and there is no migration to
    // run: the plain string is read as one unmarked run.
    const found = await service.bySlug("hem", false);
    expect(found?.content.blocks).toEqual([
      { type: "paragraph", runs: [{ text: "Skrivet av den första guiden." }] },
    ]);
  });

  it("survives a body that is not a body at all", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ ...PUBLISHED, content: "hello" });

    const found = await service.bySlug("hem", false);

    expect(found?.title).toBe("Välkommen");
    expect(found?.content.blocks).toEqual([]);
  });
});

describe("seeding the association its first page", () => {
  const association = {
    name: "Brf Talgoxen",
    organizationNumber: "769600-1234",
  };

  it("writes one published public page", async () => {
    const { service, page } = build();

    await expect(
      service.seedDefaultPage(i18n.translatorFor("sv"), association),
    ).resolves.toEqual({ created: true });

    const written = page.create.mock.calls[0]?.[0] as {
      data: {
        slug: string;
        title: string;
        published: boolean;
        visibility: string;
        content: { blocks: { runs: { text: string }[] }[] };
      };
    };
    expect(written.data.slug).toBe("hem");
    expect(written.data.published).toBe(true);
    expect(written.data.visibility).toBe("PUBLIC");
    expect(written.data.content.blocks).toHaveLength(2);
    expect(written.data.content.blocks[0]?.runs[0]?.text).toContain(
      "Brf Talgoxen",
    );
    expect(written.data.content.blocks[1]?.runs[0]?.text).toContain(
      "769600-1234",
    );
  });

  it("writes nothing when the instance already has a page", async () => {
    const { service, page } = build();
    page.count.mockResolvedValue(1);

    await expect(
      service.seedDefaultPage(i18n.translatorFor("sv"), association),
    ).resolves.toEqual({ created: false });
    expect(page.create).not.toHaveBeenCalled();
  });

  it("leaves out the organisation number when there is none", async () => {
    const { service, page } = build();

    await service.seedDefaultPage(i18n.translatorFor("sv"), {
      name: "Brf Talgoxen",
      organizationNumber: null,
    });

    const written = page.create.mock.calls[0]?.[0] as {
      data: { content: { blocks: unknown[] } };
    };
    expect(written.data.content.blocks).toHaveLength(1);
  });

  it("refuses to write a page at an address nobody could open", async () => {
    // A slug comes out of the catalog, and a catalog is edited by hand. A
    // translation that produced "api" or "Om oss" would otherwise write a page
    // that is either unreachable or malformed.
    const { service, page } = build();
    const broken = ((key: string) =>
      key === "site.seed.slug" ? "Om oss" : key) as unknown as TFunction;

    await expect(service.seedDefaultPage(broken, association)).resolves.toEqual(
      { created: false },
    );
    expect(page.create).not.toHaveBeenCalled();
  });

  it("does not count the privacy notice as the instance having a page", async () => {
    // The two are seeded by the same act of claiming an instance. Counting the
    // notice would make whether a front page is written depend on which of them
    // ran first.
    const { service, page } = build();

    await service.seedDefaultPage(i18n.translatorFor("sv"), association);

    expect(page.count).toHaveBeenCalledWith({
      where: { slug: { not: "integritetspolicy" } },
    });
  });
});

describe("seeding the privacy notice", () => {
  it("writes a published public page of headings for the board to answer", async () => {
    const { service, page } = build();

    await expect(
      service.seedPrivacyNotice(i18n.translatorFor("sv")),
    ).resolves.toEqual({ created: true });

    const written = page.create.mock.calls[0]?.[0] as {
      data: {
        slug: string;
        published: boolean;
        visibility: string;
        sortOrder: number;
        content: { blocks: { type: string; level?: number }[] };
      };
    };
    expect(written.data.slug).toBe("integritetspolicy");
    expect(written.data.published).toBe(true);
    expect(written.data.visibility).toBe("PUBLIC");
    // Never the lowest sort order, so the notice can never become the front
    // page of the association's website.
    expect(written.data.sortOrder).toBeGreaterThan(0);

    const blocks = written.data.content.blocks;
    expect(blocks[0]?.type).toBe("paragraph");
    expect(blocks.slice(1).every((block) => block.type === "heading")).toBe(
      true,
    );
    expect(blocks.slice(1).every((block) => block.level === 2)).toBe(true);
  });

  it("writes nothing when the notice already exists", async () => {
    const { service, page } = build();
    page.count.mockResolvedValue(1);

    await expect(
      service.seedPrivacyNotice(i18n.translatorFor("sv")),
    ).resolves.toEqual({ created: false });
    expect(page.create).not.toHaveBeenCalled();
  });
});

describe("the privacy notice the footer links", () => {
  it("is linked once the page is published and public", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({
      published: true,
      visibility: "PUBLIC",
    });

    await expect(service.privacyNoticePath()).resolves.toBe(
      "/integritetspolicy",
    );
  });

  it("is not linked when it is missing, unpublished or member-only", async () => {
    // The footer is on every page, including the ones an anonymous visitor
    // reads. A link printed there for a page they would be answered 404 for is
    // both a broken link and a hint that the page exists.
    const { service, page } = build();

    await expect(service.privacyNoticePath()).resolves.toBeNull();

    page.findUnique.mockResolvedValue({
      published: false,
      visibility: "PUBLIC",
    });
    await expect(service.privacyNoticePath()).resolves.toBeNull();

    page.findUnique.mockResolvedValue({
      published: true,
      visibility: "MEMBER",
    });
    await expect(service.privacyNoticePath()).resolves.toBeNull();
  });
});
