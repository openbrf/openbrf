import { Injectable } from "@nestjs/common";
import type {
  PluginContentAudience,
  PluginNewsItem,
} from "@openbrf/plugin-sdk";

import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { PageVisibility } from "../generated/prisma/enums";
import { HOUSE_NEWS } from "../news/news-audience";
import { readPageContent, textBlocksOnly } from "../site/page-content";
import { contentAudience, readInstant, visibilityOf } from "./plugin-content";

/** The most items one call returns, and how many it returns unasked. */
const MAX_NEWS_ITEMS = 50;

/**
 * The association's news, as a plugin holding news:read reads it (ADR 0032).
 *
 * The website's rule and nothing wider: an item is there when it is published,
 * and a draft, an item taken down, a deleted one and one the board wrote to
 * Styrelsen or Administratörer in the feed are absent, the last because it is
 * that audience's alone however it is published ({@link HOUSE_NEWS}). Unlike
 * the website, both audiences come back to every caller, each item saying which
 * it is, because the host cannot know where the plugin puts it.
 *
 * The select is the boundary. It names the title, the body, the audience and
 * the publication date, so nothing about who wrote an item, who asked for it to
 * be mailed or who commented on it can reach a plugin however the mapping below
 * is later changed.
 */
@Injectable()
export class PluginNewsService {
  constructor(private readonly prisma: PrismaService) {}

  async published(
    options: {
      audience?: PluginContentAudience;
      limit?: number;
      since?: string;
    } = {},
  ): Promise<PluginNewsItem[]> {
    const limit = newsLimit(options.limit);
    const since =
      options.since === undefined
        ? undefined
        : readInstant(options.since, "since");
    const visibility =
      options.audience === undefined
        ? undefined
        : visibilityOf(options.audience);

    const where: Prisma.NewsWhereInput = {
      ...HOUSE_NEWS,
      published: true,
      ...(visibility === undefined ? {} : { visibility }),
      ...(since === undefined
        ? {}
        : {
            /*
             * A published item always carries its date. The second branch is
             * the fallback the website's own reader takes for a row that does
             * not, so that an item read with a `since` is the one read without.
             */
            OR: [
              { publishedAt: { gte: since } },
              { publishedAt: null, createdAt: { gte: since } },
            ],
          }),
    };

    const rows = await this.prisma.news.findMany({
      where,
      // The website's order, the identifier breaking a tie.
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true,
        title: true,
        content: true,
        visibility: true,
        publishedAt: true,
        createdAt: true,
      },
    });

    return rows.map((row) => toNewsItem(row));
  }
}

function toNewsItem(row: {
  id: string;
  title: string;
  content: unknown;
  visibility: PageVisibility;
  publishedAt: Date | null;
  createdAt: Date;
}): PluginNewsItem {
  /*
   * Narrowed to prose exactly as the website narrows it, so a body that reached
   * the column carrying anything else gives a plugin its text and nothing more.
   * Each paragraph and heading is its runs' text, without the links: what a
   * plugin puts on a screen is words, and an address the website would publish
   * as a link is not one of them.
   */
  const content = textBlocksOnly(readPageContent(row.content));
  return {
    id: row.id,
    title: row.title,
    paragraphs: content.blocks.flatMap((block) =>
      block.type === "paragraph" || block.type === "heading"
        ? [block.runs.map((run) => run.text).join("")]
        : [],
    ),
    // A news body is prose (isTextBlock), so there is no picture to name.
    pictures: [],
    audience: contentAudience(row.visibility),
    publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
  };
}

function newsLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return MAX_NEWS_ITEMS;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NEWS_ITEMS) {
    throw new RangeError(
      `A news read takes a limit from 1 to ${String(MAX_NEWS_ITEMS)}.`,
    );
  }
  return limit;
}
