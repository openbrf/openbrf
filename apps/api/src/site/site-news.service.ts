import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import {
  type PageContent,
  readPageContent,
  textBlocksOnly,
} from "./page-content";
import type { NewsTeaser } from "./site-html";

/**
 * The association's news, as the public website reads them.
 *
 * Reads only, and the twin of PagesService in every way that matters. It
 * answers three questions - what is published, what is at this address, and
 * what is recent - and the second of them is answered with a single null for
 * "no such item", "not published" and "members only", so the controller has one
 * answer to give and cannot leak which case it was in.
 *
 * The writing half lives in src/news, apart from this file and outside this
 * directory, because it decrypts the members' email addresses to mail them. The
 * boundary that keeps the statutory registers out of the public website is the
 * module graph, and it holds here exactly as it holds for pages: this file
 * imports the database client and the block parser and nothing else.
 */

/** One news item, as an article page shows it. */
export interface SiteNewsArticle {
  slug: string;
  title: string;
  publishedAt: Date;
  content: PageContent;
}

/**
 * How much of the body a teaser shows.
 *
 * Long enough for the first sentence of a notice, short enough that the teaser
 * is an invitation to the article rather than a copy of it.
 */
const TEASER_LENGTH = 180;

/** What a shortened teaser ends in. Three periods, never one character. */
const ELLIPSIS = "...";

/**
 * How many items one page of the news index lists.
 *
 * The index is the one public address that grows with every item the board
 * publishes, and it is read by anybody, crawlers included, with no session. A
 * few years of weekly news read in full on every visit would make it the
 * cheapest way to load the database from the street.
 */
export const NEWS_INDEX_PAGE_SIZE = 20;

/**
 * The query parameter that names a page of the index, in Swedish because the
 * address is: /nyheter?sida=2. Only the older/newer anchors on the index write
 * it, as the calendar's month anchors write theirs.
 */
export const NEWS_PAGE_PARAM = "sida";

/** One page of the news index, and whether there is another either side. */
export interface SiteNewsIndexPage {
  items: SiteNewsArticle[];
  page: number;
  /** The page of newer items, or null on the first. */
  newer: number | null;
  /** The page of older items, or null on the last. */
  older: number | null;
}

const PAGE_NUMBER_PATTERN = /^[1-9]\d*$/;

/**
 * The most digits a page number is read as written with. A longer one is past
 * the end of any archive, and is read as that rather than as a number the
 * database would be asked to skip to.
 */
const PAGE_NUMBER_DIGITS = 6;

/**
 * The page an address asks for: its number, past every end when it is longer
 * than any page number, and the first page when it is not a number at all.
 */
function requestedPage(requested: string | undefined): number {
  if (requested === undefined || !PAGE_NUMBER_PATTERN.test(requested)) {
    return 1;
  }
  return requested.length > PAGE_NUMBER_DIGITS
    ? Number.POSITIVE_INFINITY
    : Number(requested);
}

@Injectable()
export class SiteNewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The published news this reader may see, newest first.
   *
   * Public items for everyone, and the member-only ones as well for anyone
   * signed in - the same rule a page follows, expressed once in readableBy so
   * the index and the teaser block cannot answer it two different ways.
   *
   * Always bounded. The callers are the index, one page at a time, and the
   * teaser block, which names its own count.
   */
  private async list(
    hasSession: boolean,
    window: { take: number; skip?: number },
  ): Promise<SiteNewsArticle[]> {
    const rows = await this.prisma.news.findMany({
      where: readableBy(hasSession),
      // The id last, so two items published in the same instant keep one order
      // and a page boundary between them cannot show one twice or skip one.
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }, { id: "asc" }],
      take: window.take,
      skip: window.skip ?? 0,
      select: {
        slug: true,
        title: true,
        content: true,
        publishedAt: true,
        createdAt: true,
      },
    });

    return rows.map((row) => toArticle(row));
  }

  /**
   * One page of the index, newest first.
   *
   * The parameter is taken as it arrived and read here, so what a page may be
   * is decided in one place - the calendar's rule for its month. Anything that
   * is not a page number reads as the first page, and a number past the last
   * page reads as the last: nothing a visitor puts in the address bar is an
   * error, and no request can make the database skip further than there are
   * items.
   */
  async index(
    hasSession: boolean,
    requested: string | undefined,
  ): Promise<SiteNewsIndexPage> {
    const total = await this.prisma.news.count({
      where: readableBy(hasSession),
    });
    const last = Math.max(1, Math.ceil(total / NEWS_INDEX_PAGE_SIZE));
    const page = Math.min(requestedPage(requested), last);

    return {
      items: await this.list(hasSession, {
        take: NEWS_INDEX_PAGE_SIZE,
        skip: (page - 1) * NEWS_INDEX_PAGE_SIZE,
      }),
      page,
      newer: page > 1 ? page - 1 : null,
      older: page < last ? page + 1 : null,
    };
  }

  /**
   * One news item by its address, or nothing.
   *
   * Null covers all three of: no such item, an item not published, and a
   * member-only item asked for without a session. One value, so the caller
   * cannot accidentally tell them apart and neither can the visitor - which is
   * what keeps a member-only article answered exactly as an address that was
   * never written.
   */
  async bySlug(
    slug: string,
    hasSession: boolean,
  ): Promise<SiteNewsArticle | null> {
    const row = await this.prisma.news.findUnique({
      where: { slug },
      select: {
        slug: true,
        title: true,
        content: true,
        published: true,
        visibility: true,
        publishedAt: true,
        createdAt: true,
      },
    });

    if (row === null || !row.published) {
      return null;
    }
    if (row.visibility === "MEMBER" && !hasSession) {
      return null;
    }

    return toArticle(row);
  }

  /** The most recent items, as a teaser block shows them. */
  async teasers(hasSession: boolean, limit: number): Promise<NewsTeaser[]> {
    const articles = await this.list(hasSession, { take: limit });
    return articles.map((article) => ({
      slug: article.slug,
      title: article.title,
      publishedAt: article.publishedAt,
      teaser: teaserOf(article.content),
    }));
  }
}

/**
 * The published items a reader may see: the public ones for everyone, and the
 * member-only ones as well for anyone signed in.
 */
function readableBy(hasSession: boolean) {
  return {
    published: true,
    ...(hasSession ? {} : { visibility: "PUBLIC" as const }),
  };
}

/**
 * The opening of a body, as one line of plain text.
 *
 * Built from the parsed blocks rather than from the stored JSON, so a teaser
 * shows what the article shows and never a run this renderer would have
 * refused. Cut on a word boundary where there is one within reach, because a
 * teaser that stops mid-word reads as a fault rather than as an abbreviation.
 */
export function teaserOf(content: PageContent): string {
  const paragraph = content.blocks.find((block) => block.type === "paragraph");
  if (paragraph === undefined) {
    return "";
  }

  const text = paragraph.runs
    .map((run) => run.text)
    .join("")
    .trim();
  if (text.length <= TEASER_LENGTH) {
    return text;
  }

  const cut = text.slice(0, TEASER_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  const kept = lastSpace > TEASER_LENGTH / 2 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}${ELLIPSIS}`;
}

function toArticle(row: {
  slug: string;
  title: string;
  content: unknown;
  publishedAt: Date | null;
  createdAt: Date;
}): SiteNewsArticle {
  return {
    slug: row.slug,
    title: row.title,
    // Narrowed to prose on the way out as well as on the way in. A body that
    // reached the column carrying a picture - written by a newer editor, or by
    // hand - shows its text rather than its picture, which is the same total
    // disposition the page parser has.
    content: textBlocksOnly(readPageContent(row.content)),
    // A published item always has the date; the fallback keeps the type honest
    // rather than describing a state the query can return.
    publishedAt: row.publishedAt ?? row.createdAt,
  };
}
