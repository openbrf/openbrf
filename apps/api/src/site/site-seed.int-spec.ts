import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import {
  type ApplicationOnOwnDatabase,
  applicationOnOwnDatabase,
} from "../testing/application-on-own-database";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { PagesService } from "./pages.service";

/**
 * The ready-made website a new association is given when setup is finished.
 *
 * What a unit test with a fake database cannot show is that the five pages and
 * the six menu entries are written as one act that a second act finds done, and
 * that an association which already has a page of its own is given nothing.
 * Both are properties of the rows, so both run on a migrated database of their
 * own: "no page of its own" is a state the worker's shared database cannot be
 * put in without deleting what other suites wrote.
 */

loadEnvForIntegrationTests();

const association = {
  name: "Brf Talgoxen",
  organizationNumber: "769600-1234",
};

const i18n = new I18nService();

/** The pages the wizard writes, as they sit in the board's list. */
async function ownPages(prisma: PrismaService) {
  return prisma.page.findMany({
    where: { builtIn: null, slug: { not: "integritetspolicy" } },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      frontPage: true,
      content: true,
    },
  });
}

/** The top level of the menu, as the page each entry names and its place. */
async function menuOrder(prisma: PrismaService) {
  const entries = await prisma.menuItem.findMany({
    orderBy: { sortOrder: "asc" },
    select: {
      label: true,
      kind: true,
      parentId: true,
      sortOrder: true,
      page: { select: { slug: true, builtIn: true } },
    },
  });
  return entries;
}

describe("a new association's ready-made website", () => {
  let fresh: ApplicationOnOwnDatabase;
  let pages: PagesService;

  beforeAll(async () => {
    await i18n.init();
    fresh = await applicationOnOwnDatabase("seed_fresh");
    pages = fresh.app.get(PagesService);
  });

  afterAll(async () => {
    await fresh?.close();
  });

  it("starts with no page of its own and no menu", async () => {
    expect(await ownPages(fresh.prisma)).toEqual([]);
    expect(await menuOrder(fresh.prisma)).toEqual([]);
  });

  it("is written once: five public pages, Home the front page, and the menu in order", async () => {
    await expect(
      pages.seedDefaultPage(i18n.translatorFor("sv"), association),
    ).resolves.toEqual({ created: true });

    const written = await ownPages(fresh.prisma);
    expect(written.map((page) => page.slug)).toEqual([
      "hem",
      "om-oss",
      "styrelsen",
      "dokument",
      "kontakt",
    ]);
    expect(written.every((page) => page.status === "PUBLIC")).toBe(true);
    expect(written.map((page) => page.frontPage)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);

    // Every entry is a page, the five and then the broker information page,
    // and none of them hangs under another.
    const menu = await menuOrder(fresh.prisma);
    expect(
      menu.map((entry) => [entry.label, entry.page?.slug ?? entry.page]),
    ).toEqual([
      ["Välkommen", "hem"],
      ["Om oss", "om-oss"],
      ["Styrelsen", "styrelsen"],
      ["Dokument", "dokument"],
      ["Kontakt", "kontakt"],
      ["Mäklarinfo", "maklarinfo"],
    ]);
    expect(menu.every((entry) => entry.kind === "PAGE")).toBe(true);
    expect(menu.every((entry) => entry.parentId === null)).toBe(true);
    expect(menu.at(-1)?.page?.builtIn).toBe("BROKER_INFORMATION");
  });

  it("serves the front page at the root, to somebody with no session", async () => {
    const home = await pages.homePage();

    expect(home?.slug).toBe("hem");
    expect(home?.publiclyReadable).toBe(true);
    expect(home?.content.blocks.length).toBeGreaterThan(0);
  });

  it("writes nothing the second time, and leaves what the board has written", async () => {
    await fresh.prisma.page.update({
      where: { slug: "om-oss" },
      data: { title: "Vår förening" },
    });
    const pagesBefore = await ownPages(fresh.prisma);
    const menuBefore = await menuOrder(fresh.prisma);

    await expect(
      pages.seedDefaultPage(i18n.translatorFor("sv"), association),
    ).resolves.toEqual({ created: false });
    await expect(
      pages.seedDefaultPage(i18n.translatorFor("en"), association),
    ).resolves.toEqual({ created: false });

    expect(await ownPages(fresh.prisma)).toEqual(pagesBefore);
    expect(await menuOrder(fresh.prisma)).toEqual(menuBefore);
  });
});

describe("an association that already has a page of its own", () => {
  let existing: ApplicationOnOwnDatabase;

  beforeAll(async () => {
    await i18n.init();
    existing = await applicationOnOwnDatabase("seed_existing");
    await existing.prisma.page.create({
      data: {
        slug: "vara-hus",
        title: "Våra hus",
        content: { version: 1, blocks: [] },
        status: "DRAFT",
      },
    });
  });

  afterAll(async () => {
    await existing?.close();
  });

  it("is given nothing, not even a menu", async () => {
    const service = existing.app.get(PagesService);

    await expect(
      service.seedDefaultPage(i18n.translatorFor("sv"), association),
    ).resolves.toEqual({ created: false });

    expect((await ownPages(existing.prisma)).map((page) => page.slug)).toEqual([
      "vara-hus",
    ]);
    expect(await menuOrder(existing.prisma)).toEqual([]);
  });
});

describe("two completions of setup at the same moment", () => {
  let racing: ApplicationOnOwnDatabase;

  beforeAll(async () => {
    await i18n.init();
    racing = await applicationOnOwnDatabase("seed_race");
  });

  afterAll(async () => {
    await racing?.close();
  });

  it("write one website between them", async () => {
    const service = racing.app.get(PagesService);
    const t = i18n.translatorFor("sv");

    const outcomes = await Promise.all([
      service.seedDefaultPage(t, association),
      service.seedDefaultPage(t, association),
      service.seedDefaultPage(t, association),
    ]);

    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(await ownPages(racing.prisma)).toHaveLength(5);
    expect(await menuOrder(racing.prisma)).toHaveLength(6);
    // One front page, which the partial unique index would have refused a
    // second of in any case; the count is what says nothing was written twice.
    expect(await racing.prisma.page.count({ where: { frontPage: true } })).toBe(
      1,
    );
  });
});
