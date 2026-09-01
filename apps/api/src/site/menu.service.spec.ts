import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { isMenuExternalUrl, MenuService } from "./menu.service";

/**
 * What the website's navigation is allowed to say.
 *
 * The rule under test is one sentence: an entry appears only if the visitor
 * could open what it points at. Everything below is a way of getting that
 * wrong - a member-only page, a feature that is switched off, a page taken
 * down, a destination this version does not recognise - and each one has to
 * end with the entry simply not being there, because a navigation that listed
 * an address a visitor is answered 404 for would be the navigation telling
 * them the page exists.
 */

interface Row {
  id: string;
  label: string;
  kind: "PAGE" | "GENERATED" | "EXTERNAL";
  generatedKey?: string | null;
  url?: string | null;
  parentId?: string | null;
  page?: {
    slug: string;
    published: boolean;
    visibility: "PUBLIC" | "MEMBER";
  } | null;
}

function build(rows: Row[]) {
  const findMany = vi.fn().mockResolvedValue(
    rows.map((row) => ({
      generatedKey: null,
      url: null,
      parentId: null,
      page: null,
      ...row,
    })),
  );
  return {
    service: new MenuService({
      menuItem: { findMany },
    } as unknown as PrismaService),
    findMany,
  };
}

const ANONYMOUS = { hasSession: false, selfSignupEnabled: true };
const MEMBER = { hasSession: true, selfSignupEnabled: true };

const PUBLIC_PAGE = {
  slug: "om-foreningen",
  published: true,
  visibility: "PUBLIC" as const,
};
const MEMBER_PAGE = {
  slug: "styrelseprotokoll",
  published: true,
  visibility: "MEMBER" as const,
};

describe("the menu a visitor is served", () => {
  it("carries the board's own words and the page's address", async () => {
    const { service } = build([
      { id: "1", label: "Om oss", kind: "PAGE", page: PUBLIC_PAGE },
    ]);

    await expect(service.siteMenu(ANONYMOUS)).resolves.toEqual([
      {
        label: "Om oss",
        href: "/om-foreningen",
        external: false,
        children: [],
      },
    ]);
  });

  it("leaves out a member-only page for a visitor with no session", async () => {
    const { service } = build([
      { id: "1", label: "Om oss", kind: "PAGE", page: PUBLIC_PAGE },
      { id: "2", label: "Protokoll", kind: "PAGE", page: MEMBER_PAGE },
    ]);

    // The whole point. An anonymous visitor may not read the page, and the
    // navigation must not be the thing that tells them it is there.
    await expect(service.siteMenu(ANONYMOUS)).resolves.toEqual([
      {
        label: "Om oss",
        href: "/om-foreningen",
        external: false,
        children: [],
      },
    ]);

    const forMember = await service.siteMenu(MEMBER);
    expect(forMember.map((entry) => entry.label)).toEqual([
      "Om oss",
      "Protokoll",
    ]);
  });

  it("leaves out a page that is not published, to anybody", async () => {
    const { service } = build([
      {
        id: "1",
        label: "Utkast",
        kind: "PAGE",
        page: { slug: "utkast", published: false, visibility: "PUBLIC" },
      },
    ]);

    await expect(service.siteMenu(ANONYMOUS)).resolves.toEqual([]);
    await expect(service.siteMenu(MEMBER)).resolves.toEqual([]);
  });

  it("hangs one level of entries under a top-level one", async () => {
    const { service } = build([
      { id: "1", label: "Om oss", kind: "PAGE", page: PUBLIC_PAGE },
      {
        id: "2",
        label: "Stadgar",
        kind: "PAGE",
        parentId: "1",
        page: { slug: "stadgar", published: true, visibility: "PUBLIC" },
      },
    ]);

    await expect(service.siteMenu(ANONYMOUS)).resolves.toEqual([
      {
        label: "Om oss",
        href: "/om-foreningen",
        external: false,
        children: [{ label: "Stadgar", href: "/stadgar", external: false }],
      },
    ]);
  });

  it("hides a member-only entry inside a dropdown too", async () => {
    const { service } = build([
      { id: "1", label: "Om oss", kind: "PAGE", page: PUBLIC_PAGE },
      {
        id: "2",
        label: "Protokoll",
        kind: "PAGE",
        parentId: "1",
        page: MEMBER_PAGE,
      },
    ]);

    const [entry] = await service.siteMenu(ANONYMOUS);
    expect(entry?.children).toEqual([]);
  });

  it("drops a whole group whose own entry the visitor may not open", async () => {
    // The parent is the group's name. Rendering the children without it would
    // put an unnamed list of addresses in the navigation.
    const { service } = build([
      { id: "1", label: "Protokoll", kind: "PAGE", page: MEMBER_PAGE },
      {
        id: "2",
        label: "Stadgar",
        kind: "PAGE",
        parentId: "1",
        page: { slug: "stadgar", published: true, visibility: "PUBLIC" },
      },
    ]);

    await expect(service.siteMenu(ANONYMOUS)).resolves.toEqual([]);
  });

  it("leaves out a generated page whose feature this instance has not got", async () => {
    // A menu survives a feature being switched off, and survives being written
    // by a newer version of the product than the one rendering it.
    const { service } = build([
      {
        id: "2",
        label: "Något nytt",
        kind: "GENERATED",
        generatedKey: "en-nyhet-fran-framtiden",
      },
    ]);

    await expect(service.siteMenu(ANONYMOUS)).resolves.toEqual([]);
  });

  it("offers the news index to everybody, session or none", async () => {
    // The news module serves /nyheter, so the entry pointing at it is one the
    // menu may render. Who may read which item is the index's own question and
    // never the menu's: the entry is the same for both readers, and a visitor
    // with no session is answered with the items anybody may read rather than
    // with a count of the ones they may not.
    const { service } = build([
      { id: "1", label: "Nyheter", kind: "GENERATED", generatedKey: "news" },
    ]);
    const entry = [
      { label: "Nyheter", href: "/nyheter", external: false, children: [] },
    ];

    await expect(service.siteMenu(ANONYMOUS)).resolves.toEqual(entry);
    await expect(service.siteMenu(MEMBER)).resolves.toEqual(entry);
  });

  it("offers the calendar to everybody, session or none", async () => {
    // The calendar page answers a visitor with no session with the dates
    // anybody may see, exactly as the news index answers with the items
    // anybody may read, so the entry is the same for both readers.
    const { service } = build([
      {
        id: "1",
        label: "Kalender",
        kind: "GENERATED",
        generatedKey: "calendar",
      },
    ]);
    const entry = [
      { label: "Kalender", href: "/kalender", external: false, children: [] },
    ];

    await expect(service.siteMenu(ANONYMOUS)).resolves.toEqual(entry);
    await expect(service.siteMenu(MEMBER)).resolves.toEqual(entry);
  });

  it("offers the broker information page, which every claimed instance has", async () => {
    // The page is generated from the association's own facts and needs no
    // setting turned on, so the entry is shown to anybody - a broker reading
    // the site has no account, and is the reader it is there for.
    const { service } = build([
      {
        id: "1",
        label: "Mäklarinfo",
        kind: "GENERATED",
        generatedKey: "broker",
      },
    ]);

    await expect(service.siteMenu(ANONYMOUS)).resolves.toEqual([
      {
        label: "Mäklarinfo",
        href: "/maklarinfo",
        external: false,
        children: [],
      },
    ]);
  });

  it("offers the account request form only while it is open and unused", async () => {
    const { service } = build([
      {
        id: "1",
        label: "Ansök om konto",
        kind: "GENERATED",
        generatedKey: "requestAccount",
      },
    ]);

    await expect(service.siteMenu(ANONYMOUS)).resolves.toEqual([
      {
        label: "Ansök om konto",
        href: "/app/request-account",
        external: false,
        children: [],
      },
    ]);

    // Switched off by the board.
    await expect(
      service.siteMenu({ hasSession: false, selfSignupEnabled: false }),
    ).resolves.toEqual([]);

    // Already signed in: the screen sends them away, so the entry would be a
    // link that bounces whoever follows it.
    await expect(service.siteMenu(MEMBER)).resolves.toEqual([]);
  });

  it("carries an external address only when it is https", async () => {
    const { service } = build([
      {
        id: "1",
        label: "Boverket",
        kind: "EXTERNAL",
        url: "https://boverket.invalid",
      },
      {
        id: "2",
        label: "Osäker",
        kind: "EXTERNAL",
        url: "http://exempel.invalid",
      },
      { id: "3", label: "Tom", kind: "EXTERNAL", url: null },
    ]);

    await expect(service.siteMenu(ANONYMOUS)).resolves.toEqual([
      {
        label: "Boverket",
        href: "https://boverket.invalid",
        external: true,
        children: [],
      },
    ]);
  });

  it("reads the menu in the order the board arranged it", async () => {
    const { service, findMany } = build([]);

    await service.siteMenu(ANONYMOUS);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
    );
  });
});

describe("the front page the menu names", () => {
  it("is the first page entry, read as the menu is read", async () => {
    const { service } = build([
      {
        id: "1",
        label: "Boverket",
        kind: "EXTERNAL",
        url: "https://boverket.invalid",
      },
      { id: "2", label: "Om oss", kind: "PAGE", page: PUBLIC_PAGE },
    ]);

    await expect(service.homePageSlug()).resolves.toBe("om-foreningen");
  });

  it("reaches into a dropdown before moving to the next entry", async () => {
    const { service } = build([
      {
        id: "1",
        label: "Nyheter",
        kind: "GENERATED",
        generatedKey: "news",
      },
      {
        id: "2",
        label: "Hem",
        kind: "PAGE",
        parentId: "1",
        page: { slug: "hem", published: true, visibility: "PUBLIC" },
      },
      { id: "3", label: "Om oss", kind: "PAGE", page: PUBLIC_PAGE },
    ]);

    expect(await service.homePageSlug()).toBe("hem");
  });

  it("passes over a member-only page even though a member could read it", async () => {
    // The front door is answered to everybody, so it cannot be a page half the
    // visitors are shown the not-found document for.
    const { service } = build([
      { id: "1", label: "Protokoll", kind: "PAGE", page: MEMBER_PAGE },
      { id: "2", label: "Om oss", kind: "PAGE", page: PUBLIC_PAGE },
    ]);

    await expect(service.homePageSlug()).resolves.toBe("om-foreningen");
  });

  it("is nothing when the menu names no page at all", async () => {
    const { service } = build([
      {
        id: "1",
        label: "Boverket",
        kind: "EXTERNAL",
        url: "https://boverket.invalid",
      },
    ]);

    await expect(service.homePageSlug()).resolves.toBeNull();
  });
});

describe("an address a menu entry may carry", () => {
  it("is https and nothing else", () => {
    expect(isMenuExternalUrl("https://boverket.invalid/sida")).toBe(true);

    // A standing invitation printed on every page of the website: http would
    // be the association handing its readers to whoever sits between them.
    expect(isMenuExternalUrl("http://exempel.invalid")).toBe(false);
    expect(isMenuExternalUrl("mailto:styrelsen@exempel.invalid")).toBe(false);
    expect(isMenuExternalUrl("/en-sida")).toBe(false);
    expect(isMenuExternalUrl("//exempel.invalid")).toBe(false);
    expect(isMenuExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isMenuExternalUrl("")).toBe(false);
  });
});
