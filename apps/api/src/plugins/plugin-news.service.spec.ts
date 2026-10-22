import { describe, expect, it, vi } from "vite-plus/test";

import type { PrismaService } from "../database/prisma.service";
import { HOUSE_NEWS } from "../news/news-audience";
import type {
  CheckedItem,
  RegisterCheckService,
} from "../register-check/register-check.service";
import {
  MAX_DEVICE_NEWS_PAGES,
  PluginNewsService,
} from "./plugin-news.service";

/**
 * What news:read releases: what the website publishes, with the audience on
 * every item, and nothing about who wrote it or who read it (ADR 0032).
 */

const ROW = {
  id: "news-1",
  title: "Städdag i november",
  content: {
    version: 1,
    blocks: [
      { type: "heading", level: 2, runs: [{ text: "Lördag 15 november" }] },
      {
        type: "paragraph",
        runs: [
          { text: "Vi ses på gården " },
          { text: "klockan tio", marks: ["bold"] },
          { text: "." },
        ],
      },
      // Written by hand or by a newer editor: the website shows its text only.
      { type: "image", mediaFileId: "media-1", alt: "Gården" },
    ],
  },
  visibility: "MEMBER",
  publishedAt: new Date("2026-10-20T08:00:00Z"),
  createdAt: new Date("2026-10-19T08:00:00Z"),
};

/** A plugin with no device route. */
const OPEN = { forDevices: false };
/** A plugin that declares a device route. */
const DEVICE = { forDevices: true };

/** A register check that withholds whatever mentions Svensson. */
function registerCheckDouble() {
  const passes = vi.fn(async (items: readonly CheckedItem[]) =>
    items.map((item) => !item.some((text) => text?.includes("Svensson"))),
  );
  const load = vi.fn(async () => ({ passes, matches: vi.fn() }));
  return { check: { load } as unknown as RegisterCheckService, load, passes };
}

function serviceReading(rows: unknown[] = [ROW]) {
  // Answers each page out of the rows, as the database would.
  const findMany = vi.fn(async (query: { skip?: number; take: number }) =>
    rows.slice(query.skip ?? 0, (query.skip ?? 0) + query.take),
  );
  const prisma = { news: { findMany } } as unknown as PrismaService;
  const register = registerCheckDouble();
  return {
    service: new PluginNewsService(prisma, register.check),
    findMany,
    register,
  };
}

function queryOf(findMany: ReturnType<typeof vi.fn>) {
  return findMany.mock.calls[0]?.[0] as {
    where: Record<string, unknown>;
    select: Record<string, unknown>;
    take: number;
  };
}

describe("published", () => {
  it("reads the published items for the house, the title, the body, the audience and the date, and nothing else", async () => {
    const { service, findMany } = serviceReading();

    await service.published({}, OPEN);

    const query = queryOf(findMany);
    expect(query.where).toEqual({ ...HOUSE_NEWS, published: true });
    expect(query.take).toBe(50);
    expect(Object.keys(query.select).sort()).toEqual([
      "content",
      "createdAt",
      "id",
      "publishedAt",
      "title",
      "visibility",
    ]);
  });

  it("gives the body's prose as one string per paragraph or heading", async () => {
    const { service } = serviceReading();

    await expect(service.published({}, OPEN)).resolves.toEqual([
      {
        id: "news-1",
        title: "Städdag i november",
        paragraphs: ["Lördag 15 november", "Vi ses på gården klockan tio."],
        pictures: [],
        audience: "members",
        publishedAt: "2026-10-20T08:00:00.000Z",
      },
    ]);
  });

  it("dates an item that carries no publication date as the website does", async () => {
    const { service } = serviceReading([
      { ...ROW, visibility: "PUBLIC", publishedAt: null },
    ]);

    const [item] = await service.published({}, OPEN);

    expect(item?.publishedAt).toBe("2026-10-19T08:00:00.000Z");
    expect(item?.audience).toBe("anyone");
  });

  it("narrows by audience, by date and by count when asked", async () => {
    const { service, findMany } = serviceReading([]);

    await service.published(
      {
        audience: "anyone",
        since: "2026-10-01T00:00:00Z",
        limit: 5,
      },
      OPEN,
    );

    const since = new Date("2026-10-01T00:00:00Z");
    const query = queryOf(findMany);
    expect(query.where).toEqual({
      ...HOUSE_NEWS,
      published: true,
      visibility: "PUBLIC",
      OR: [
        { publishedAt: { gte: since } },
        { publishedAt: null, createdAt: { gte: since } },
      ],
    });
    expect(query.take).toBe(5);
  });

  it.each([
    ["a limit of none", { limit: 0 }],
    ["a limit above fifty", { limit: 51 }],
    ["a limit that is not a whole number", { limit: 2.5 }],
    ["a since that is not an instant", { since: "yesterday" }],
    ["an audience the contract does not name", { audience: "board" }],
  ])("refuses %s", async (_what, options) => {
    const { service, findMany } = serviceReading();

    await expect(
      service.published(options as never, OPEN),
    ).rejects.toBeInstanceOf(RangeError);
    expect(findMany).not.toHaveBeenCalled();
  });
});

/**
 * A plugin with a device route is handed only what passes the register check,
 * and cannot tell a withheld item from one never published (ADR 0032).
 */
describe("published, for a plugin with a device route", () => {
  const item = (index: number, title = `Nyhet ${String(index)}`) => ({
    ...ROW,
    id: `news-${String(index)}`,
    title,
  });

  it("leaves out an item whose title or paragraphs fail the check", async () => {
    const named = {
      ...item(2),
      content: {
        version: 1,
        blocks: [{ type: "paragraph", runs: [{ text: "Tack, Svensson!" }] }],
      },
    };
    const { service } = serviceReading([item(1), named, item(3, "Grillkväll")]);

    const items = await service.published({}, DEVICE);

    expect(items.map((news) => news.id)).toEqual(["news-1", "news-3"]);
  });

  it("reads on to older items until it has as many as were asked for", async () => {
    const rows = [
      ...Array.from({ length: 50 }, (_, index) => item(index, "Svensson")),
      ...Array.from({ length: 10 }, (_, index) => item(50 + index)),
    ];
    const { service, findMany, register } = serviceReading(rows);

    const items = await service.published({ limit: 3 }, DEVICE);

    expect(items.map((news) => news.id)).toEqual([
      "news-50",
      "news-51",
      "news-52",
    ]);
    expect(findMany).toHaveBeenCalledTimes(2);
    // The register is read once for the whole call.
    expect(register.load).toHaveBeenCalledTimes(1);
  });

  it("stops when the items run out", async () => {
    const { service, findMany } = serviceReading([item(1, "Svensson")]);

    await expect(service.published({}, DEVICE)).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("reads no further back than a bounded number of pages", async () => {
    const rows = [
      ...Array.from({ length: 50 * MAX_DEVICE_NEWS_PAGES }, (_, index) =>
        item(index, "Svensson"),
      ),
      item(50 * MAX_DEVICE_NEWS_PAGES),
    ];
    const { service, findMany } = serviceReading(rows);

    await expect(service.published({ limit: 1 }, DEVICE)).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(MAX_DEVICE_NEWS_PAGES);
  });

  it("never reads the register for a plugin without one", async () => {
    const { service, register } = serviceReading([item(1, "Svensson")]);

    await expect(service.published({}, OPEN)).resolves.toHaveLength(1);
    expect(register.load).not.toHaveBeenCalled();
  });
});
