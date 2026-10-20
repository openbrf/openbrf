import { describe, expect, it, vi } from "vite-plus/test";

import type { PrismaService } from "../database/prisma.service";
import { PluginNewsService } from "./plugin-news.service";

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

function serviceReading(rows: unknown[] = [ROW]) {
  const findMany = vi.fn(async () => rows);
  const prisma = { news: { findMany } } as unknown as PrismaService;
  return { service: new PluginNewsService(prisma), findMany };
}

function queryOf(findMany: ReturnType<typeof vi.fn>) {
  return findMany.mock.calls[0]?.[0] as {
    where: Record<string, unknown>;
    select: Record<string, unknown>;
    take: number;
  };
}

describe("published", () => {
  it("reads the published items, the title, the body, the audience and the date, and nothing else", async () => {
    const { service, findMany } = serviceReading();

    await service.published();

    const query = queryOf(findMany);
    expect(query.where).toEqual({ published: true });
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

    await expect(service.published()).resolves.toEqual([
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

    const [item] = await service.published();

    expect(item?.publishedAt).toBe("2026-10-19T08:00:00.000Z");
    expect(item?.audience).toBe("anyone");
  });

  it("narrows by audience, by date and by count when asked", async () => {
    const { service, findMany } = serviceReading([]);

    await service.published({
      audience: "anyone",
      since: "2026-10-01T00:00:00Z",
      limit: 5,
    });

    const since = new Date("2026-10-01T00:00:00Z");
    const query = queryOf(findMany);
    expect(query.where).toEqual({
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

    await expect(service.published(options as never)).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
