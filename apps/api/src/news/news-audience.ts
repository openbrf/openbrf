import type { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { APP_BASE_PATH } from "../http/app-base-path";

/**
 * Which news items are the house's, and which are confined to an audience in
 * the feed.
 *
 * A post the board writes as Styrelsen is a news item (ADR 0026), and it can go
 * to Styrelsen or Administratörer as well as to Alla. Written to Alla, the item
 * is what the association says to the house: the website, the members' news
 * screen, the news screen's thread, the connected apps' actions and the
 * members' mailing all read it, as they read any item. Written to Styrelsen or
 * Administratörer, it is that audience's and nobody else's: the feed is the
 * only place it is read, on the feed's own audience check, and its mailing goes
 * to the audience's members alone. The item says who it is for through its
 * post, which is the one place a board post's audience is written.
 *
 * Every path that reads news for anybody but the feed asks {@link HOUSE_NEWS}.
 * An item confined to an audience is answered there exactly as one that does
 * not exist, for the reason a group's post is (ADR 0012): the administrator
 * holds `site:manage` and `news:comment` and is not in Styrelsen, and an
 * answer that told them a Styrelsen item was there would tell them what it was
 * called.
 */

/** News items for the house: every item but one confined to an audience. */
export const HOUSE_NEWS = {
  NOT: { post: { is: { audience: { kind: { not: "ALL" } } } } },
} satisfies Prisma.NewsWhereInput;

/** The audience a confined item is for. */
export type ConfinedAudience = "BOARD" | "ADMIN";

/**
 * Who an item is confined to, read from its post: Styrelsen, Administratörer,
 * or null for an item for the house - one written on the news screen, or by the
 * board to Alla.
 */
export async function confinementOf(
  db: PrismaService | Prisma.TransactionClient,
  newsId: string,
): Promise<{ audience: ConfinedAudience; postId: string } | null> {
  const post = await db.post.findUnique({
    where: { newsId },
    select: { id: true, audience: { select: { kind: true } } },
  });
  if (post === null) {
    return null;
  }
  switch (post.audience.kind) {
    case "BOARD":
    case "ADMIN":
      return { audience: post.audience.kind, postId: post.id };
    case "ALL":
      return null;
    case "GROUP":
      // A group is not the board's to speak in, so no item is posted there;
      // were one ever, it would be the group's and nobody else's.
      throw new Error(`News item ${newsId} is posted into a group.`);
  }
}

/**
 * Where a mailing about an item sends its reader: the article on the website
 * for an item for the house, and the post in the feed for one confined to an
 * audience, which the website does not have - and which the feed answers to
 * its audience alone, so the address tells anybody else nothing.
 */
export async function newsAddressOf(
  db: PrismaService | Prisma.TransactionClient,
  news: { id: string; slug: string },
  appUrl: string,
): Promise<string> {
  const confined = await confinementOf(db, news.id);
  const path =
    confined === null
      ? `/nyheter/${news.slug}`
      : `${APP_BASE_PATH}/feed/${confined.postId}`;
  return new URL(path, appUrl).toString();
}
