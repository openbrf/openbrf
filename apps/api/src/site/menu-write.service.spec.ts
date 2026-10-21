import { describe, expect, it, vi } from "vite-plus/test";

import type { ActorContext } from "../audit/actor-context";
import type { AuditLogService } from "../audit/audit-log.service";
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

const ACTOR: ActorContext = { personId: "person-1", channel: "WEB" };

const ROW = {
  id: "item-1",
  label: "Om oss",
  kind: "PAGE" as const,
  parentId: null,
  sortOrder: 0,
  pageId: "page-1",
  url: null,
  membersOnly: false,
  page: {
    slug: "om-foreningen",
    title: "Om föreningen",
    status: "PUBLIC" as const,
    builtIn: null,
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
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const page = {
    findUnique: vi
      .fn()
      .mockResolvedValue({ id: "page-1", title: "Om föreningen" }),
  };

  /*
   * The transaction's client, and the only one that can write or decide
   * anything. `$executeRaw` is the menu lock.
   */
  const client = {
    menuItem,
    page,
    $executeRaw: vi.fn().mockResolvedValue(1),
  };

  const prisma = {
    /*
     * The root client offers the read `list()` makes and nothing else. Every
     * check a write decides on is read inside its transaction, under the menu
     * lock, and a regression that read one through the root client again -
     * outside the lock, where a concurrent move can change the answer - fails
     * here on a method that is not there rather than passing on a shared fake.
     */
    menuItem: { findMany: menuItem.findMany },
    $transaction: vi.fn(async (run: unknown) =>
      typeof run === "function"
        ? await (run as (tx: typeof client) => Promise<unknown>)(client)
        : run,
    ),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  return {
    service: new MenuWriteService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
    ),
    menuItem,
    page,
    prisma,
    audit,
    txClient: client,
  };
}

/** The entry written by the call under test. */
function entryFrom(audit: { record: ReturnType<typeof vi.fn> }): {
  action: string;
  channel: string;
  actorPersonId: string | null;
  targetKind: string | null;
  targetId: string | null;
  context: Record<string, unknown>;
} {
  return audit.record.mock.calls[0]?.[0] as never;
}

describe("adding an entry", () => {
  it("takes the page's own title when the board typed no label", async () => {
    const { service, menuItem } = build();

    await service.create({ kind: "PAGE", label: "", pageId: "page-1" }, ACTOR);

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

    await service.create(
      { kind: "PAGE", label: "Om oss", pageId: "page-1" },
      ACTOR,
    );

    const written = menuItem.create.mock.calls[0]?.[0] as {
      data: { label: string };
    };
    expect(written.data.label).toBe("Om oss");
  });

  it("takes the menu lock before it reads anything it decides on", async () => {
    // Read first, an entry added under one that is being moved under another
    // passes its depth check against a menu the move is about to change, and
    // the menu gains a third level. The races in menu.int-spec.ts only catch
    // that on the rounds where the two interleave.
    const { service, menuItem, page, txClient } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-2", parentId: null });

    await service.create(
      { kind: "PAGE", label: "", pageId: "page-1", parentId: "item-2" },
      ACTOR,
    );

    const locked = txClient.$executeRaw.mock.invocationCallOrder[0] ?? Infinity;
    const reads = [
      ...menuItem.findUnique.mock.invocationCallOrder,
      ...menuItem.count.mock.invocationCallOrder,
      ...menuItem.aggregate.mock.invocationCallOrder,
      ...page.findUnique.mock.invocationCallOrder,
    ];
    expect(menuItem.findUnique).toHaveBeenCalled();
    expect(Math.min(...reads)).toBeGreaterThan(locked);
  });

  it("refuses a page entry naming a page the instance has not got", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue(null);

    await expect(
      service.create({ kind: "PAGE", label: "", pageId: "page-9" }, ACTOR),
    ).rejects.toMatchObject({ reason: "page-not-found" });
  });

  it("refuses a page entry naming no page at all", async () => {
    const { service } = build();

    await expect(
      service.create({ kind: "PAGE", label: "Om oss" }, ACTOR),
    ).rejects.toMatchObject({ reason: "target-required" });
  });

  it("borrows a built-in page's title exactly as it borrows any page's", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({
      id: "built-in-news",
      title: "Nyheter",
    });

    await expect(
      service.create(
        { kind: "PAGE", label: "", pageId: "built-in-news" },
        ACTOR,
      ),
    ).resolves.toMatchObject({ label: "Nyheter", pageId: "built-in-news" });
  });

  it("needs a label for an entry with no title to borrow", async () => {
    const { service } = build();

    await expect(
      service.create(
        {
          kind: "EXTERNAL",
          label: "  ",
          url: "https://boverket.invalid",
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ reason: "label-required" });
  });

  it("refuses a label too long for a menu rather than cutting it", async () => {
    const { service, menuItem } = build();

    // Cut, the entry would be saved under words the board never wrote and
    // answered with as though they had.
    await expect(
      service.create(
        { kind: "PAGE", label: "a".repeat(61), pageId: "page-1" },
        ACTOR,
      ),
    ).rejects.toMatchObject({ reason: "label-too-long" });
    expect(menuItem.create).not.toHaveBeenCalled();

    await expect(
      service.create(
        { kind: "PAGE", label: "a".repeat(60), pageId: "page-1" },
        ACTOR,
      ),
    ).resolves.toMatchObject({ label: "a".repeat(60) });
  });

  it("cuts a title it borrows from a page, which the board did not type", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue({
      id: "page-1",
      title: "Ö".repeat(80),
    });

    await expect(
      service.create({ kind: "PAGE", label: "", pageId: "page-1" }, ACTOR),
    ).resolves.toMatchObject({ label: "Ö".repeat(60) });
  });

  it("does not cut a borrowed title through the middle of an emoji", async () => {
    const { service, page } = build();
    // The 60th code unit is the first half of the house.
    page.findUnique.mockResolvedValue({
      id: "page-1",
      title: `${"a".repeat(59)}🏠 och mer`,
    });

    await expect(
      service.create({ kind: "PAGE", label: "", pageId: "page-1" }, ACTOR),
    ).resolves.toMatchObject({ label: "a".repeat(59) });
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
        service.create({ kind: "EXTERNAL", label: "Länk", url }, ACTOR),
        url,
      ).rejects.toBeInstanceOf(MenuWriteError);
    }
  });

  it("clears the field belonging to the kind it is not", async () => {
    // The reader decides what to follow from the kind. A stale page reference
    // on an entry that has become a link is one bug away from being followed.
    const { service, menuItem } = build();

    await service.create(
      {
        kind: "EXTERNAL",
        label: "Boverket",
        url: "https://boverket.invalid",
        pageId: "page-1",
      },
      ACTOR,
    );

    const written = menuItem.create.mock.calls[0]?.[0] as {
      data: { pageId: null; url: string };
    };
    expect(written.data.pageId).toBeNull();
    expect(written.data.url).toBe("https://boverket.invalid");
  });
});

describe("an entry kept for members", () => {
  it("is for whoever may open its target unless the board says otherwise", async () => {
    const { service, menuItem } = build();

    await service.create(
      { kind: "PAGE", label: "Kalender", pageId: "page-1" },
      ACTOR,
    );
    await service.create(
      { kind: "PAGE", label: "Kalender", pageId: "page-1", membersOnly: true },
      ACTOR,
    );

    const written = menuItem.create.mock.calls.map(
      (call) => (call[0] as { data: { membersOnly: boolean } }).data,
    );
    expect(written.map((data) => data.membersOnly)).toEqual([false, true]);
  });

  it("stays kept for members when a change does not mention it", async () => {
    // Leaving a field out must not show an entry to somebody the board kept
    // it from: a caller that knows nothing of the setting, renaming it.
    const { service, menuItem, audit } = build();
    menuItem.findUnique.mockResolvedValue({
      id: "item-1",
      parentId: null,
      membersOnly: true,
    });

    await service.update(
      "item-1",
      { kind: "PAGE", label: "Händer i huset", pageId: "page-1" },
      ACTOR,
    );

    const written = menuItem.update.mock.calls[0]?.[0] as {
      data: { membersOnly: boolean };
    };
    expect(written.data.membersOnly).toBe(true);
    expect(entryFrom(audit).context).toMatchObject({ membersOnly: true });
  });

  it("is offered to everybody again when the board says so", async () => {
    const { service, menuItem, audit } = build();
    menuItem.findUnique.mockResolvedValue({
      id: "item-1",
      parentId: null,
      membersOnly: true,
    });

    await service.update(
      "item-1",
      { kind: "PAGE", label: "Kalender", pageId: "page-1", membersOnly: false },
      ACTOR,
    );

    const written = menuItem.update.mock.calls[0]?.[0] as {
      data: { membersOnly: boolean };
    };
    expect(written.data.membersOnly).toBe(false);
    expect(entryFrom(audit).context).toMatchObject({ membersOnly: false });
  });
});

describe("the two-level rule", () => {
  it("lets an entry hang from a top-level one", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-1", parentId: null });

    await service.create(
      {
        kind: "PAGE",
        label: "",
        pageId: "page-1",
        parentId: "item-1",
      },
      ACTOR,
    );

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
      service.create(
        {
          kind: "PAGE",
          label: "",
          pageId: "page-1",
          parentId: "item-2",
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ reason: "nesting-too-deep" });
  });

  it("refuses a parent the instance has not got", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockResolvedValue(null);

    await expect(
      service.create(
        {
          kind: "PAGE",
          label: "",
          pageId: "page-1",
          parentId: "item-9",
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ reason: "parent-not-found" });
  });

  it("refuses to put an entry inside itself", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-1", parentId: null });

    await expect(
      service.update(
        "item-1",
        {
          kind: "PAGE",
          label: "",
          pageId: "page-1",
          parentId: "item-1",
        },
        ACTOR,
      ),
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
      service.update(
        "item-1",
        {
          kind: "PAGE",
          label: "",
          pageId: "page-1",
          parentId: "item-2",
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ reason: "nesting-too-deep" });
  });

  it("takes the menu lock before it reads anything it decides on", async () => {
    // Read first, each of two opposite moves passes its check against a menu
    // the other is about to change, and the two entries end up hanging from
    // each other - off the website, since nothing reaches them from the top.
    const { service, menuItem, page, txClient } = build();
    menuItem.findUnique.mockImplementation(
      async (args: { where: { id: string } }) =>
        args.where.id === "item-1"
          ? { id: "item-1", parentId: null }
          : { id: "item-2", parentId: null },
    );

    await service.update(
      "item-1",
      { kind: "PAGE", label: "", pageId: "page-1", parentId: "item-2" },
      ACTOR,
    );

    const locked = txClient.$executeRaw.mock.invocationCallOrder[0] ?? Infinity;
    const reads = [
      ...menuItem.findUnique.mock.invocationCallOrder,
      ...menuItem.count.mock.invocationCallOrder,
      ...menuItem.aggregate.mock.invocationCallOrder,
      ...page.findUnique.mock.invocationCallOrder,
    ];
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.min(...reads)).toBeGreaterThan(locked);
  });
});

describe("rearranging the menu", () => {
  it("orders one level and cannot reach into another", async () => {
    const { service, menuItem } = build();

    await service.reorder(null, ["b", "a"], ACTOR);

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

    await service.update(
      "item-1",
      {
        kind: "PAGE",
        label: "",
        pageId: "page-1",
        parentId: "item-2",
      },
      ACTOR,
    );

    const written = menuItem.update.mock.calls[0]?.[0] as {
      data: { sortOrder?: number };
    };
    expect(written.data.sortOrder).toBe(3);
  });

  it("leaves the position alone when the level has not changed", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-1", parentId: null });

    await service.update(
      "item-1",
      {
        kind: "PAGE",
        label: "",
        pageId: "page-1",
      },
      ACTOR,
    );

    const written = menuItem.update.mock.calls[0]?.[0] as {
      data: { sortOrder?: number };
    };
    expect(written.data.sortOrder).toBeUndefined();
  });
});

describe("removing an entry", () => {
  it("refuses one the instance has not got", async () => {
    const { service } = build();

    await expect(service.remove("item-9", ACTOR)).rejects.toMatchObject({
      reason: "not-found",
      status: 404,
    });
  });

  it("removes the one it was asked about", async () => {
    const { service, menuItem } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-1", parentId: null });

    await service.remove("item-1", ACTOR);

    expect(menuItem.delete).toHaveBeenCalledWith({ where: { id: "item-1" } });
  });
});

describe("what the log keeps about a menu edit", () => {
  it("records where the entry points and never what it says", async () => {
    const { service, audit } = build();

    await service.create(
      { kind: "PAGE", label: "Om oss", pageId: "page-1" },
      ACTOR,
    );

    const entry = entryFrom(audit);
    expect(entry.action).toBe("MENU_ITEM_ADDED");
    expect(entry.targetKind).toBe("menuItem");
    expect(entry.context).toEqual({
      kind: "PAGE",
      parentId: null,
      membersOnly: false,
      target: "page-1",
    });
    // The label is the board's own text, it has a home on the row, and this
    // table outlives that row.
    expect(JSON.stringify(entry.context)).not.toContain("Om oss");
  });

  it("records the address of an entry that leaves the instance", async () => {
    // The one target a reader can be sent to that the association does not
    // hold, and the reason the menu is audited at all.
    const { service, audit } = build();

    await service.create(
      { kind: "EXTERNAL", label: "Boverket", url: "https://boverket.invalid" },
      ACTOR,
    );

    expect(entryFrom(audit).context).toEqual({
      kind: "EXTERNAL",
      parentId: null,
      membersOnly: false,
      target: null,
      href: "https://boverket.invalid",
    });
  });

  it("carries no address for an entry that stays on the website", async () => {
    const { service, audit } = build();

    await service.create(
      { kind: "PAGE", label: "Om oss", pageId: "page-1" },
      ACTOR,
    );

    const { context } = entryFrom(audit);
    expect(context).toEqual({
      kind: "PAGE",
      parentId: null,
      membersOnly: false,
      target: "page-1",
    });
    expect("href" in context).toBe(false);
  });

  it("records a change against the entry it changed", async () => {
    const { service, menuItem, audit } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-1", parentId: null });

    await service.update(
      "item-1",
      { kind: "PAGE", label: "Om oss", pageId: "page-1" },
      ACTOR,
    );

    const entry = entryFrom(audit);
    expect(entry.action).toBe("MENU_ITEM_CHANGED");
    expect(entry.targetId).toBe("item-1");
  });

  it("records a reorder against the level, counting what was sent", async () => {
    const { service, audit } = build();

    await service.reorder("item-1", ["b", "a"], ACTOR);

    const entry = entryFrom(audit);
    expect(entry.action).toBe("MENU_ITEM_REORDERED");
    expect(entry.targetKind).toBe("menuLevel");
    expect(entry.targetId).toBe("item-1");
    expect(entry.context).toEqual({ parentId: "item-1", count: 2 });
  });

  it("records a reorder that moved nothing", async () => {
    // Ids outside the level are ignored, so "how many rows moved" is not a
    // number this call knows. An entry either way is the honest record that
    // the board rearranged the level.
    const { service, menuItem, audit } = build();
    menuItem.updateMany.mockResolvedValue({ count: 0 });

    await service.reorder(null, ["a"], ACTOR);

    expect(entryFrom(audit).context).toEqual({ parentId: null, count: 1 });
  });

  it("records what a removal took with it", async () => {
    const { service, menuItem, audit } = build();
    menuItem.findUnique.mockResolvedValue({ id: "item-1", kind: "PAGE" });
    menuItem.count.mockResolvedValue(2);

    await service.remove("item-1", ACTOR);

    const entry = entryFrom(audit);
    expect(entry.action).toBe("MENU_ITEM_REMOVED");
    expect(entry.context).toEqual({ kind: "PAGE", childrenRemoved: 2 });
  });

  it("names the person and the way they reached the menu", async () => {
    const { service, audit } = build();

    await service.create(
      { kind: "PAGE", label: "Om oss", pageId: "page-1" },
      { personId: "person-7", channel: "MCP", clientId: "client-1" },
    );

    expect(entryFrom(audit)).toMatchObject({
      channel: "MCP",
      actorPersonId: "person-7",
      clientId: "client-1",
    });
  });

  it("writes the entry inside the transaction that made the change", async () => {
    // Not beside it: an entry that survived a rolled-back write would claim a
    // menu nobody arranged.
    const { service, audit, prisma, txClient } = build();

    await service.create(
      { kind: "PAGE", label: "Om oss", pageId: "page-1" },
      ACTOR,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // The callback's own client, by identity: "defined" is also true of the
    // root client, which would commit the entry apart from the change.
    expect(audit.record.mock.calls[0]?.[1]).toBe(txClient);
  });
});

describe("arranging the whole menu", () => {
  const MENU = [
    { id: "a", parentId: null },
    { id: "b", parentId: null },
    { id: "c", parentId: "a" },
  ];

  it("writes every entry's level and place, and records one entry for the act", async () => {
    const { service, menuItem, audit } = build();
    menuItem.findMany.mockResolvedValueOnce(MENU);

    await service.arrange(
      [
        { id: "b", parentId: null },
        { id: "a", parentId: null },
        { id: "c", parentId: "b" },
      ],
      ACTOR,
    );

    const writes = menuItem.update.mock.calls.map(
      (call) =>
        call[0] as { where: { id: string }; data: object } as {
          where: { id: string };
          data: object;
        },
    );
    expect(writes.map((write) => [write.where.id, write.data])).toEqual([
      ["b", { parentId: null, sortOrder: 0 }],
      ["a", { parentId: null, sortOrder: 1 }],
      ["c", { parentId: "b", sortOrder: 0 }],
    ]);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(entryFrom(audit)).toMatchObject({
      action: "MENU_ITEM_REORDERED",
      context: { count: 3, moved: 1 },
    });
  });

  it("refuses a list that is not the menu the server has", async () => {
    const { service, menuItem } = build();
    menuItem.findMany.mockResolvedValue(MENU);

    for (const items of [
      // One missing.
      [
        { id: "a", parentId: null },
        { id: "b", parentId: null },
      ],
      // One that is not there.
      [...MENU, { id: "z", parentId: null }],
      // One twice.
      [...MENU.slice(0, 2), { id: "b", parentId: null }],
    ]) {
      await expect(service.arrange(items, ACTOR)).rejects.toMatchObject({
        reason: "menu-changed",
      });
    }
    expect(menuItem.update).not.toHaveBeenCalled();
  });

  it("refuses a third level and writes nothing", async () => {
    const { service, menuItem, audit } = build();
    menuItem.findMany.mockResolvedValue(MENU);

    await expect(
      service.arrange(
        [
          { id: "a", parentId: null },
          { id: "c", parentId: "a" },
          // Under an entry that hangs from another.
          { id: "b", parentId: "c" },
        ],
        ACTOR,
      ),
    ).rejects.toMatchObject({ reason: "nesting-too-deep" });

    // An entry that hangs from itself is no top-level entry to hang from.
    await expect(
      service.arrange(
        [
          { id: "a", parentId: "a" },
          { id: "b", parentId: null },
          { id: "c", parentId: "a" },
        ],
        ACTOR,
      ),
    ).rejects.toMatchObject({ reason: "nesting-too-deep" });

    expect(menuItem.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers menu-changed as a conflict", () => {
    expect(new MenuWriteError("x", "menu-changed").status).toBe(409);
  });
});

describe("a page's Show in menu switch", () => {
  it("adds the page last on the top level, named for its title, cut to fit", async () => {
    const { service, menuItem, page, audit } = build();
    page.findUnique.mockResolvedValue({ id: "page-1", title: "x".repeat(90) });

    await service.showPage("page-1", ACTOR);

    const written = menuItem.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(written.data).toMatchObject({
      kind: "PAGE",
      pageId: "page-1",
      parentId: null,
      sortOrder: 3,
      label: "x".repeat(60),
    });
    expect(entryFrom(audit)).toMatchObject({
      action: "MENU_ITEM_ADDED",
      context: { kind: "PAGE", target: "page-1" },
    });
  });

  it("adds nothing for a page that has an entry", async () => {
    const { service, menuItem, audit } = build();
    menuItem.count.mockResolvedValue(1);

    await service.showPage("page-1", ACTOR);

    expect(menuItem.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses a page there is not", async () => {
    const { service, page } = build();
    page.findUnique.mockResolvedValue(null);

    await expect(service.showPage("page-1", ACTOR)).rejects.toMatchObject({
      reason: "page-not-found",
    });
    await expect(service.hidePage("page-1", ACTOR)).rejects.toMatchObject({
      reason: "page-not-found",
    });
  });

  it("takes the entry out and lets its dropdown go before the database would take it too", async () => {
    const { service, menuItem, page, audit } = build();
    page.findUnique.mockResolvedValue({ id: "page-1" });
    menuItem.findMany
      .mockResolvedValueOnce([{ id: "b", kind: "PAGE" }])
      .mockResolvedValueOnce([
        { id: "a", parentId: null },
        { id: "b", parentId: null },
        { id: "c", parentId: "b" },
        { id: "d", parentId: null },
      ]);

    await service.hidePage("page-1", ACTOR);

    // Moved to the top level first, and only then is the entry deleted: the
    // cascade would otherwise take the dropdown with it.
    const promoted = menuItem.updateMany.mock.invocationCallOrder[0] ?? 0;
    const deleted = menuItem.deleteMany.mock.invocationCallOrder[0] ?? 0;
    expect(promoted).toBeLessThan(deleted);
    expect(menuItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["c"] } },
      data: { parentId: null },
    });
    expect(menuItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["b"] } },
    });
    expect(
      menuItem.update.mock.calls.map((call) => [
        (call[0] as unknown as { where: { id: string } }).where.id,
        (call[0] as unknown as { data: { sortOrder: number } }).data.sortOrder,
      ]),
    ).toEqual([
      ["a", 0],
      ["c", 1],
      ["d", 2],
    ]);
    expect(entryFrom(audit)).toMatchObject({
      action: "MENU_ITEM_REMOVED",
      targetId: "b",
      // Its dropdown item moved up rather than went with it.
      context: { childrenRemoved: 0, promoted: 1 },
    });
  });

  it("does nothing for a page that has no entry", async () => {
    const { service, menuItem, page, audit } = build();
    page.findUnique.mockResolvedValue({ id: "page-1" });
    menuItem.findMany.mockResolvedValue([]);

    await service.hidePage("page-1", ACTOR);

    expect(menuItem.deleteMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
