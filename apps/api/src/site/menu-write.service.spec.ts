import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { MenuWriteError, MenuWriteService } from "./menu-write.service";

/**
 * The rules a menu has to obey, as rules rather than as endpoints.
 *
 * Three of them, and each one is a property of the website rather than a
 * preference: an entry points at exactly one thing, the menu is two levels
 * deep at most because a third would need a script to open, and an address
 * that leaves the instance is https because the entry is printed on every page
 * the association publishes.
 */

const ROW = {
  id: "item-1",
  label: "Om oss",
  kind: "PAGE" as const,
  parentId: null,
  sortOrder: 0,
  pageId: "page-1",
  generatedKey: null,
  url: null,
  page: {
    slug: "om-foreningen",
    title: "Om föreningen",
    published: true,
    visibility: "PUBLIC" as const,
  },
};

function build() {
  const menuItem = {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 2 } }),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(async (args: { data: unknown }) => ({
      ...ROW,
      ...(args.data as object),
    })),
    update: vi.fn(async (args: { data: unknown }) => ({
      ...ROW,
      ...(args.data as object),
    })),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    delete: vi.fn().mockResolvedValue(ROW),
  };
  const page = {
    findUnique: vi
      .fn()
      .mockResolvedValue({ id: "page-1", title: "Om föreningen" }),
  };

  const prisma = {
    menuItem,
    page,
    $transaction: vi.fn(async (calls: unknown) => calls),
  };

  return {
    service: new MenuWriteService(prisma as unknown as PrismaService),
    menuItem,
    page,
    prisma,
  };
}

describe("adding an entry", () => {
  it("takes the page's own title when the board typed no label", async () => {
    const { service, menuItem } = build();

    await service.create({ kind: "PAGE", label: "", pageId: "page-1" });

    const written = menuItem.create.mock.calls[0]?.[0] as {
      data: { label: string; pageId: string; sortOrder: number };
    };
    expect(written.data.label).toBe("Om föreningen");
    expect(written.data.pageId).toBe("page-1");
    // At the end of its level.
    expect(written.data.sortOrder).toBe(3);
  });

  it("keeps the label the board typed instead", async () => {
    const { service, menuItem } = build();

    await service.create({ kind: "PAGE", label: "Om oss", pageId: "page-1" });

    const written = menuItem.create.mock.calls[0]?.[0] as {
      data: { label: string };
    };
    expect(written.data.label).toBe("Om oss");
  });

  it("refuses a page entry naming a page the instance has not got", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue(null);

    await expect(
      service.create({ kind: "PAGE", label: "", pageId: "page-9" }),
    ).rejects.toMatchObject({ reason: "page-not-found" });
  });

  it("refuses a page entry naming no page at all", async () => {
    const { service } = build();

    await expect(
      service.create({ kind: "PAGE", label: "Om oss" }),
    ).rejects.toMatchObject({ reason: "target-required" });
  });

  it("refuses a generated entry this instance does not recognise", async () => {
    const { service } = build();

    await expect(
      service.create({
        kind: "GENERATED",
        label: "Något",
        generatedKey: "framtiden",
      }),
    ).rejects.toMatchObject({ reason: "unknown-generated-key" });
  });

  it("needs a label for an entry with no title to borrow", async () => {
    const { service } = build();

    await expect(
      service.create({ kind: "GENERATED", label: "", generatedKey: "news" }),
    ).rejects.toMatchObject({ reason: "label-required" });
    await expect(
      service.create({
        kind: "EXTERNAL",
        label: "  ",
        url: "https://boverket.invalid",
      }),
    ).rejects.toMatchObject({ reason: "label-required" });
  });

  it("refuses a label too long for a menu rather than cutting it", async () => {
    const { service, menuItem } = build();

    // Cut, the entry would be saved under words the board never wrote and
    // answered with as though they had.
    await expect(
      service.create({
        kind: "GENERATED",
        label: "a".repeat(61),
        generatedKey: "news",
      }),
    ).rejects.toMatchObject({ reason: "label-too-long" });
    expect(menuItem.create).not.toHaveBeenCalled();

    await expect(
      service.create({
        kind: "GENERATED",
        label: "a".repeat(60),
        generatedKey: "news",
      }),
    ).resolves.toMatchObject({ label: "a".repeat(60) });
  });

  it("cuts a title it borrows from a page, which the board did not type", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({
      id: "page-1",
      title: "Ö".repeat(80),
    });

    await expect(
      service.create({ kind: "PAGE", label: "", pageId: "page-1" }),
    ).resolves.toMatchObject({ label: "Ö".repeat(60) });
  });

  it("refuses an address that is not https", async () => {
    const { service } = build();

    for (const url of [
      "http://exempel.invalid",
      "mailto:styrelsen@exempel.invalid",
      "/en-sida",
      "javascript:alert(1)",
    ]) {
      await expect(
        service.create({ kind: "EXTERNAL", label: "Länk", url }),
        url,
      ).rejects.toBeInstanceOf(MenuWriteError);
    }
  });

  it("clears the fields belonging to the kinds it is not", async () => {
    // The reader decides what to follow from the kind. A stale page reference
    // on an entry that has become a link is one bug away from being followed.
    const { service, menuItem } = build();

    await service.create({
      kind: "EXTERNAL",
      label: "Boverket",
      url: "https://boverket.invalid",
      pageId: "page-1",
      generatedKey: "news",
    });

    const written = menuItem.create.mock.calls[0]?.[0] as {
      data: { pageId: null; generatedKey: null; url: string };
    };
    expect(written.data.pageId).toBeNull();
    expect(written.data.generatedKey).toBeNull();
    expect(written.data.url).toBe("https://boverket.invalid");
  });
});

describe("the two-level rule", () => {
  it("lets an entry hang from a top-level one", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-1", parentId: null });

    await service.create({
      kind: "PAGE",
      label: "",
      pageId: "page-1",
      parentId: "item-1",
    });

    const written = menuItem.create.mock.calls[0]?.[0] as {
      data: { parentId: string };
    };
    expect(written.data.parentId).toBe("item-1");
  });

  it("refuses a third level", async () => {
    // A dropdown that opens a dropdown needs a script to be usable, and the
    // website has none.
    const { service, menuItem } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-2", parentId: "item-1" });

    await expect(
      service.create({
        kind: "PAGE",
        label: "",
        pageId: "page-1",
        parentId: "item-2",
      }),
    ).rejects.toMatchObject({ reason: "nesting-too-deep" });
  });

  it("refuses a parent the instance has not got", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockResolvedValue(null);

    await expect(
      service.create({
        kind: "PAGE",
        label: "",
        pageId: "page-1",
        parentId: "item-9",
      }),
    ).rejects.toMatchObject({ reason: "parent-not-found" });
  });

  it("refuses to put an entry inside itself", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-1", parentId: null });

    await expect(
      service.update("item-1", {
        kind: "PAGE",
        label: "",
        pageId: "page-1",
        parentId: "item-1",
      }),
    ).rejects.toMatchObject({ reason: "nesting-too-deep" });
  });

  it("refuses to move an entry that has entries of its own", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockImplementation(
      async (args: { where: { id: string } }) =>
        args.where.id === "item-2"
          ? { id: "item-2", parentId: null }
          : { id: "item-1", parentId: null },
    );
    menuItem.count.mockResolvedValue(2);

    await expect(
      service.update("item-1", {
        kind: "PAGE",
        label: "",
        pageId: "page-1",
        parentId: "item-2",
      }),
    ).rejects.toMatchObject({ reason: "nesting-too-deep" });
  });
});

describe("rearranging the menu", () => {
  it("orders one level and cannot reach into another", async () => {
    const { service, menuItem } = build();

    await service.reorder(null, ["b", "a"]);

    // The parent is part of every where clause, so a reorder can only ever
    // move entries within the level it was asked about.
    expect(menuItem.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "b", parentId: null },
      data: { sortOrder: 0 },
    });
    expect(menuItem.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "a", parentId: null },
      data: { sortOrder: 1 },
    });
  });

  it("moves an entry to the end of the level it arrives in", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockImplementation(
      async (args: { where: { id: string } }) =>
        args.where.id === "item-1"
          ? { id: "item-1", parentId: null }
          : { id: "item-2", parentId: null },
    );

    await service.update("item-1", {
      kind: "PAGE",
      label: "",
      pageId: "page-1",
      parentId: "item-2",
    });

    const written = menuItem.update.mock.calls[0]?.[0] as {
      data: { sortOrder?: number };
    };
    expect(written.data.sortOrder).toBe(3);
  });

  it("leaves the position alone when the level has not changed", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-1", parentId: null });

    await service.update("item-1", {
      kind: "PAGE",
      label: "",
      pageId: "page-1",
    });

    const written = menuItem.update.mock.calls[0]?.[0] as {
      data: { sortOrder?: number };
    };
    expect(written.data.sortOrder).toBeUndefined();
  });
});

describe("removing an entry", () => {
  it("refuses one the instance has not got", async () => {
    const { service } = build();

    await expect(service.remove("item-9")).rejects.toMatchObject({
      reason: "not-found",
      status: 404,
    });
  });

  it("removes the one it was asked about", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-1", parentId: null });

    await service.remove("item-1");

    expect(menuItem.delete).toHaveBeenCalledWith({ where: { id: "item-1" } });
  });
});
