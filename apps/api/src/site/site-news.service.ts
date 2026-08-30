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

@Injectable()
export class SiteNewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The published news this reader may see, newest first.
   *
   * Public items for everyone, and the member-only ones as well for anyone
   * signed in - the same rule a page follows, expressed once here so the index,
   * the teaser block and an article cannot answer it three different ways.
   */
  async list(hasSession: boolean, limit?: number): Promise<SiteNewsArticle[]> {
    const rows = await this.prisma.news.findMany({
      where: {
        published: true,
        ...(hasSession ? {} : { visibility: "PUBLIC" }),
      },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
      ...(limit === undefined ? {} : { take: limit }),
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
    const articles = await this.list(hasSession, limit);
    return articles.map((article) => ({
      slug: article.slug,
      title: article.title,
      publishedAt: article.publishedAt,
      teaser: teaserOf(article.content),
    }));
  }
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
