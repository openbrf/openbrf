import type { TFunction } from "i18next";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import type { MenuService } from "./menu.service";
import { isUsableSlug, PagesService } from "./pages.service";

/**
 * What the public website is allowed to answer with.
 *
 * The interesting behaviour here is a refusal that does not say it is a
 * refusal: a member-only page, a draft and an address that names
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
    updateMany: ReturnType<typeof vi.fn>;
  };
  /** The menu is the root's fallback, so it is the other half of this fake. */
  menu: { homePageSlug: ReturnType<typeof vi.fn> };
}

function build(): Fakes {
  const page = {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({ id: "page-1" }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const menu = { homePageSlug: vi.fn().mockResolvedValue(null) };
  return {
    service: new PagesService(
      { page } as unknown as PrismaService,
      menu as unknown as MenuService,
    ),
    page,
    menu,
  };
}

const PUBLISHED = {
  slug: "hem",
  title: "Välkommen",
  content: {
    version: 1,
    blocks: [{ type: "paragraph", runs: [{ text: "Hej." }] }],
  },
  status: "PUBLIC" as "DRAFT" | "MEMBERS_ONLY" | "PUBLIC",
};

/**
 * A findFirst that answers the front page query with `front` and the root's
 * last fallback with `fallback`, as the two different questions they are.
 */
function answering(
  findFirst: ReturnType<typeof vi.fn>,
  front: unknown,
  fallback: unknown,
): void {
  // Answered as a value rather than a promise, which the service awaits all
  // the same, as the fake in the case below does.
  findFirst.mockImplementation((args: { where: { frontPage?: true } }) =>
    args.where.frontPage === true ? front : fallback,
  );
}

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

  it("refuses the addresses of the pages the product generates", () => {
    /*
     * Both spellings of each, and the English ones are held even where only the
     * Swedish address is routed: a page written at /news or /calendar on an
     * English-speaking cooperative's instance would open today and stop opening
     * the day that route is added, and a page that stops opening is worse than
     * an address that was never free.
     */
    for (const taken of [
      "nyheter",
      "news",
      "kalender",
      "calendar",
      "maklarinfo",
      "broker",
    ]) {
      expect(isUsableSlug(taken), taken).toBe(false);
    }
  });
});

describe("the front page", () => {
  const EXPECTED = {
    slug: "hem",
    title: "Välkommen",
    content: {
      version: 1,
      blocks: [{ type: "paragraph", runs: [{ text: "Hej." }] }],
    },
    // Public by both of the queries that can find it, and the renderer needs
    // to know: a public form renders on no other kind of page.
    publiclyReadable: true,
  };

  it("is the page the board chose, whatever the menu says", async () => {
    const { service, page, menu } = build();
    menu.homePageSlug.mockResolvedValue("annat");
    answering(page.findFirst, PUBLISHED, null);

    await expect(service.homePage()).resolves.toEqual(EXPECTED);

    // Public in the query too: the root never asks who is reading, so it does
    // not rest on the constraint alone.
    expect(page.findFirst).toHaveBeenCalledWith({
      where: { frontPage: true, status: "PUBLIC" },
      select: { slug: true, title: true, content: true, status: true },
    });
    // Arranging the menu is not choosing the front page.
    expect(menu.homePageSlug).not.toHaveBeenCalled();
  });

  it("is the menu's first page entry while no front page is chosen", async () => {
    const { service, page, menu } = build();
    menu.homePageSlug.mockResolvedValue("hem");
    page.findUnique.mockResolvedValue(PUBLISHED);

    await expect(service.homePage()).resolves.toEqual(EXPECTED);

    // The root asks the menu rather than sorting the pages a second time, the
    // way it did before there was a front page to choose.
    expect(page.findUnique).toHaveBeenCalledWith({
      where: { slug: "hem" },
      select: { slug: true, title: true, content: true, status: true },
    });
    expect(page.findFirst).toHaveBeenCalledTimes(1);
  });

  it("passes over the page it names once that page is closed", async () => {
    // The menu names only pages anybody may read, and it answered from an
    // earlier query. A page unpublished or kept for the members between the
    // two must not be served at the one address that would otherwise take the
    // menu's word for it.
    for (const closed of [
      { ...PUBLISHED, status: "DRAFT" as const },
      { ...PUBLISHED, status: "MEMBERS_ONLY" as const },
    ]) {
      const { service, page, menu } = build();
      menu.homePageSlug.mockResolvedValue("hem");
      page.findUnique.mockResolvedValue(closed);
      answering(page.findFirst, null, { ...PUBLISHED, slug: "annat" });

      await expect(service.homePage()).resolves.toMatchObject({
        slug: "annat",
      });
    }
  });

  it("falls back to the lowest sort order when the menu names no page", async () => {
    const { service, page, menu } = build();
    menu.homePageSlug.mockResolvedValue(null);
    answering(page.findFirst, null, PUBLISHED);

    await expect(service.homePage()).resolves.toEqual(EXPECTED);

    // A board that empties its menu still has a website. Lowest order first,
    // oldest first on a tie, and never a member-only page: the front door of
    // an association's website is not a page half its visitors are answered
    // with a not-found for. Never a built-in page either, whose row has no
    // body for the root to serve.
    expect(page.findFirst).toHaveBeenLastCalledWith({
      where: {
        status: "PUBLIC",
        slug: { not: "integritetspolicy" },
        builtIn: null,
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { slug: true, title: true, content: true, status: true },
    });
  });

  it("never falls back to the privacy notice, whatever order the pages are in", async () => {
    /*
     * The board dragged its two pages once, which numbered them 0 and 1 - the
     * privacy notice included. A page created after that is placed after the
     * highest page that is not the notice, so it ties with the notice at 1,
     * and the notice is the older of the two. Then the board removed the old
     * front page and emptied the menu of it.
     */
    const rows = [
      {
        ...PUBLISHED,
        slug: "integritetspolicy",
        sortOrder: 1,
        createdAt: new Date("2026-01-01"),
      },
      {
        ...PUBLISHED,
        slug: "hem",
        sortOrder: 1,
        createdAt: new Date("2026-09-01"),
      },
    ];
    const { service, page, menu } = build();
    menu.homePageSlug.mockResolvedValue(null);
    page.findFirst.mockImplementation(
      (args: { where: { frontPage?: true; slug?: { not: string } } }) =>
        args.where.frontPage === true
          ? null
          : (rows
              .filter((row) => row.slug !== args.where.slug?.not)
              .toSorted(
                (a, b) =>
                  a.sortOrder - b.sortOrder ||
                  a.createdAt.getTime() - b.createdAt.getTime(),
              )[0] ?? null),
    );

    await expect(service.homePage()).resolves.toMatchObject({ slug: "hem" });
  });

  it("falls back when the menu names a page that has since gone", async () => {
    const { service, page, menu } = build();
    menu.homePageSlug.mockResolvedValue("hem");
    page.findUnique.mockResolvedValue(null);
    answering(page.findFirst, null, PUBLISHED);

    await expect(service.homePage()).resolves.toEqual(EXPECTED);
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

  it("is nothing when it exists but is a draft", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ ...PUBLISHED, status: "DRAFT" });

    // Even for a signed-in member: a draft is not a page.
    await expect(service.bySlug("hem", true)).resolves.toBeNull();
  });

  it("is nothing when it is member-only and nobody is signed in", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({
      ...PUBLISHED,
      status: "MEMBERS_ONLY",
    });

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

  it("writes one public page, chosen as the front page", async () => {
    const { service, page } = build();

    await expect(
      service.seedDefaultPage(i18n.translatorFor("sv"), association),
    ).resolves.toEqual({ created: true });

    const written = page.create.mock.calls[0]?.[0] as {
      data: {
        slug: string;
        title: string;
        status: string;
        frontPage: boolean;
        slugFollowsTitle: boolean;
        content: { blocks: { runs: { text: string }[] }[] };
      };
    };
    expect(written.data.slug).toBe("hem");
    expect(written.data.status).toBe("PUBLIC");
    // Chosen, so the root serves it whatever the board later does to the menu.
    expect(written.data.frontPage).toBe(true);
    // Published from the start, so its address is settled from the start.
    expect(written.data.slugFollowsTitle).toBe(false);
    expect(written.data.content.blocks).toHaveLength(2);
    expect(written.data.content.blocks[0]?.runs[0]?.text).toContain(
      "Brf Talgoxen",
    );
    expect(written.data.content.blocks[1]?.runs[0]?.text).toContain(
      "769600-1234",
    );
  });

  it("gives it a menu entry", async () => {
    // Written with the page, so a claimed instance cannot end up with a page
    // and no menu.
    const { service, page } = build();

    await service.seedDefaultPage(i18n.translatorFor("sv"), association);

    const written = page.create.mock.calls[0]?.[0] as {
      data: {
        menuItems: {
          create: { label: string; kind: string; sortOrder: number };
        };
      };
    };
    expect(written.data.menuItems.create).toEqual({
      label: "Välkommen",
      kind: "PAGE",
      sortOrder: 0,
    });
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

  it("does not count the privacy notice or the built-in pages as the instance having a page", async () => {
    // The notice is seeded by the same act of claiming an instance, and
    // counting it would make whether a front page is written depend on which
    // of them ran first. The built-in pages are on every instance from its
    // first migration, so counting them would mean no instance ever got one.
    const { service, page } = build();

    await service.seedDefaultPage(i18n.translatorFor("sv"), association);

    expect(page.count).toHaveBeenCalledWith({
      where: { slug: { not: "integritetspolicy" }, builtIn: null },
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
        status: string;
        frontPage?: boolean;
        sortOrder: number;
        content: { blocks: { type: string; level?: number }[] };
      };
    };
    expect(written.data.slug).toBe("integritetspolicy");
    expect(written.data.status).toBe("PUBLIC");
    // Never chosen as the front page, and last in the board's list.
    expect(written.data.frontPage).toBeUndefined();
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
  it("is linked once the page is public", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({ status: "PUBLIC" });

    await expect(service.privacyNoticePath()).resolves.toBe(
      "/integritetspolicy",
    );
  });

  it("is not linked when it is missing, a draft or member-only", async () => {
    // The footer is on every page, including the ones an anonymous visitor
    // reads. A link printed there for a page they would be answered 404 for is
    // both a broken link and a hint that the page exists.
    const { service, page } = build();

    await expect(service.privacyNoticePath()).resolves.toBeNull();

    page.findUnique.mockResolvedValue({ status: "DRAFT" });
    await expect(service.privacyNoticePath()).resolves.toBeNull();

    page.findUnique.mockResolvedValue({ status: "MEMBERS_ONLY" });
    await expect(service.privacyNoticePath()).resolves.toBeNull();
  });
});

describe("naming the built-in pages", () => {
  it("names each in the language the wizard was finished in, unless the board has saved it since", async () => {
    // Running the wizard again from settings must not undo a rename. The
    // revision moves on every save, so the first one is a page nobody has
    // touched.
    const { service, page } = build();

    await service.titleBuiltInPages(i18n.translatorFor("en"));

    expect(page.updateMany.mock.calls.map(([args]: unknown[]) => args)).toEqual(
      [
        { where: { builtIn: "NEWS", revision: 1 }, data: { title: "News" } },
        {
          where: { builtIn: "CALENDAR", revision: 1 },
          data: { title: "Calendar" },
        },
        {
          where: { builtIn: "BROKER_INFORMATION", revision: 1 },
          data: { title: "Broker information" },
        },
        {
          where: { builtIn: "REQUEST_ACCOUNT", revision: 1 },
          data: { title: "Request an account" },
        },
      ],
    );
  });
});
