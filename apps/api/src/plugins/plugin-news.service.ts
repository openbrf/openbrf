import { Injectable } from "@nestjs/common";
import type {
  PluginContentAudience,
  PluginNewsItem,
} from "@openbrf/plugin-sdk";

import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { PageVisibility } from "../generated/prisma/enums";
import { HOUSE_NEWS } from "../news/news-audience";
import { newsItemTexts } from "../register-check/checked-texts";
import { RegisterCheckService } from "../register-check/register-check.service";
import {
  proseParagraphs,
  readPageContent,
  textBlocksOnly,
} from "../site/page-content";
import {
  type ContentReader,
  contentAudience,
  readInstant,
  visibilityOf,
} from "./plugin-content";

/** The most items one call returns, and how many it returns unasked. */
const MAX_NEWS_ITEMS = 50;

/**
 * The most pages of items a read for a plugin with a device route goes
 * through to fill its limit, so that a register that withholds nearly every
 * item does not make every call from a polling screen read the whole history.
 */
export const MAX_DEVICE_NEWS_PAGES = 10;

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
 *
 * For a plugin with a device route an item whose title or paragraphs fail the
 * register check is absent, and the read goes on to older items until it has
 * as many as were asked for, so the answer is the one an unpublished item
 * would give: a plugin asking for five gets five whenever five pass among the
 * newest {@link MAX_DEVICE_NEWS_PAGES} pages of fifty. Past those it returns
 * what it has.
 */
@Injectable()
export class PluginNewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registerCheck: RegisterCheckService,
  ) {}

  async published(
    options: {
      audience?: PluginContentAudience;
      limit?: number;
      since?: string;
    },
    reader: ContentReader,
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
      ...(reader.onScreensOnly === true ? { onScreens: true } : {}),
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

    const page = (skip: number, take: number) =>
      this.prisma.news.findMany({
        where,
        // The website's order, the identifier breaking a tie.
        orderBy: [
          { publishedAt: "desc" },
          { createdAt: "desc" },
          { id: "asc" },
        ],
        skip,
        take,
        select: {
          id: true,
          title: true,
          content: true,
          visibility: true,
          publishedAt: true,
          createdAt: true,
          onScreens: true,
        },
      });

    if (!reader.forDevices) {
      return (await page(0, limit)).map((row) => toNewsItem(row));
    }

    const check = await this.registerCheck.load();
    const kept: PluginNewsItem[] = [];
    for (let pages = 0; pages < MAX_DEVICE_NEWS_PAGES; pages += 1) {
      const items = (await page(pages * MAX_NEWS_ITEMS, MAX_NEWS_ITEMS)).map(
        (row) => toNewsItem(row),
      );
      const passes = await check.passes(
        items.map((item) => newsItemTexts(item)),
      );
      kept.push(...items.filter((_, index) => passes[index]));
      if (kept.length >= limit || items.length < MAX_NEWS_ITEMS) {
        break;
      }
    }
    return kept.slice(0, limit);
  }
}

function toNewsItem(row: {
  id: string;
  title: string;
  content: unknown;
  visibility: PageVisibility;
  publishedAt: Date | null;
  createdAt: Date;
  onScreens: boolean;
}): PluginNewsItem {
  /*
   * Narrowed to prose exactly as the website narrows it, so a body that reached
   * the column carrying anything else gives a plugin its text and nothing more.
   * Each paragraph and heading is its runs' text, without the links: what a
   * plugin puts on a screen is words, and an address the website would publish
   * as a link is not one of them.
   */
  return {
    id: row.id,
    title: row.title,
    paragraphs: proseParagraphs(textBlocksOnly(readPageContent(row.content))),
    // A news body is prose (isTextBlock), so there is no picture to name.
    pictures: [],
    audience: contentAudience(row.visibility),
    publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
    onScreens: row.onScreens,
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
