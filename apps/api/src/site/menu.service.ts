import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import type {
  BuiltInPage,
  MenuItemKind,
  PageStatus,
} from "../generated/prisma/enums";
import { isPublishableUrl } from "./page-content";

/**
 * The menu the board arranged, as the website reads it.
 *
 * Reads only, and reads with one rule: an entry is rendered only if the
 * visitor could open what it points at. A member-only page's entry is not in
 * the menu an anonymous visitor is served, so the navigation cannot become the
 * thing that tells them the page exists. The board can narrow that further,
 * and keep an entry for a public page for signed-in visitors alone; it can
 * never widen it. That is the same guarantee the
 * byte-identical not-found document makes, extended to the one part of the
 * chrome that would otherwise list every address the association has.
 *
 * Nothing here decides access. The pages service already answers a member-only
 * address with the same null a missing one gets, whatever the menu says; this
 * only decides what is offered, so a menu row that somehow survived a page's
 * removal would be a broken link and never an open door.
 */

/**
 * What the website knows about the visitor and the instance when it builds
 * the menu.
 *
 * Both are handed in rather than read here: the renderer already asks the
 * association for its name, its mark and its accent in one query, and a second
 * one for a single boolean would be a second place for the two answers to
 * disagree about the same request.
 */
export interface MenuAudience {
  /** Whether the visitor carries a session. */
  hasSession: boolean;
  /** Whether the association takes account requests from its website. */
  selfSignupEnabled: boolean;
}

/** One thing in the menu that can be followed. */
export interface SiteMenuLink {
  /** What the menu says. The board's own words, never translated. */
  label: string;
  href: string;
  /** Whether following it leaves this instance. */
  external: boolean;
}

/** A top-level entry, and whatever hangs under it. */
export interface SiteMenuEntry extends SiteMenuLink {
  children: readonly SiteMenuLink[];
}

export type SiteMenu = readonly SiteMenuEntry[];

/**
 * Whether a built-in page's entry is offered to this visitor.
 *
 * Every built-in page is public, so for three of them the answer is the
 * page's. The news index and the calendar answer a visitor with no session
 * with the items anybody may read - never with a refusal, and never with a
 * count that would say how much the members are being told - and the broker
 * information page stands before the board has recorded a single fact, with
 * the association's name and organisation number on it.
 *
 * The account request form is the exception. It is part of the application
 * rather than the website, offered only while the board takes requests at all,
 * and only to a visitor with no session: somebody already signed in is sent
 * away from that screen, and a menu entry that bounces whoever follows it is a
 * broken one.
 */
function builtInOffered(builtIn: BuiltInPage, audience: MenuAudience): boolean {
  return builtIn === "REQUEST_ACCOUNT"
    ? audience.selfSignupEnabled && !audience.hasSession
    : true;
}

/**
 * Whether an address may be a menu entry's target.
 *
 * https and nothing else. A menu entry is a standing invitation printed on
 * every page of the association's website, and sending a reader over plain
 * http would be the association handing their traffic to whoever is between
 * them - unlike a link inside a page's prose, which is a citation of whatever
 * the board was writing about. The rest of the rule - no backslashes, no
 * control characters, a sane length - is the page parser's, reused so the two
 * cannot drift apart.
 */
export function isMenuExternalUrl(value: string): boolean {
  if (!isPublishableUrl(value)) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** One stored row, as this service reads it. */
interface MenuRow {
  id: string;
  label: string;
  kind: MenuItemKind;
  url: string | null;
  parentId: string | null;
  membersOnly: boolean;
  page: {
    slug: string;
    status: PageStatus;
    builtIn: BuiltInPage | null;
  } | null;
}

/** The rows hanging under each entry, in the order the board put them in. */
function childrenOf(rows: readonly MenuRow[]): Map<string, MenuRow[]> {
  const children = new Map<string, MenuRow[]>();
  for (const row of rows) {
    if (row.parentId === null) {
      continue;
    }
    const siblings = children.get(row.parentId);
    if (siblings === undefined) {
      children.set(row.parentId, [row]);
    } else {
      siblings.push(row);
    }
  }
  return children;
}

@Injectable()
export class MenuService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The menu, as this visitor is allowed to see it.
   *
   * Two levels, and the second one only under an entry that is itself shown: a
   * dropdown hanging off an entry the visitor may not open would be a group
   * with no name. An entry whose target has gone - a page unpublished, the
   * account request form while the board takes no requests - is left out
   * rather than rendered as something unfollowable, which is what lets the
   * board rearrange the site without the menu ever pointing at nothing.
   */
  async siteMenu(audience: MenuAudience): Promise<SiteMenu> {
    const rows = await this.readRows();
    const children = childrenOf(rows);

    const menu: SiteMenuEntry[] = [];
    for (const row of rows) {
      if (row.parentId !== null) {
        continue;
      }
      const link = this.linkFor(row, audience);
      if (link === null) {
        continue;
      }
      menu.push({
        ...link,
        /*
         * A grandchild is dropped rather than flattened. The rule is one
         * dropdown level and the write path enforces it; if a row ever arrived
         * with a deeper parent, rendering it a level up would quietly show the
         * board a menu it did not arrange.
         */
        children: (children.get(row.id) ?? []).flatMap((child) => {
          const childLink = this.linkFor(child, audience);
          return childLink === null ? [] : [childLink];
        }),
      });
    }

    return menu;
  }

  /**
   * The address the root falls back to while no front page is chosen, or
   * nothing.
   *
   * The menu's first page entry, read in the order a visitor reads the menu -
   * a top-level entry, then whatever hangs under it, then the next. Only a
   * fallback: a front page the board has chosen is served whatever the menu
   * says, so dragging an entry never moves the front door.
   *
   * Anonymous, always. The front door of a housing cooperative's website is
   * not a page half its visitors are answered with a not-found for, so a
   * member-only page is passed over here even for a visitor who could read it.
   */
  async homePageSlug(): Promise<string | null> {
    const rows = await this.readRows();
    const children = childrenOf(rows);

    for (const row of rows) {
      if (row.parentId !== null) {
        continue;
      }
      for (const candidate of [row, ...(children.get(row.id) ?? [])]) {
        const slug = publicPageSlug(candidate);
        if (slug !== null) {
          return slug;
        }
      }
    }

    return null;
  }

  /**
   * Every row, in the order the board put them in.
   *
   * One query for the whole menu rather than one per level: the menu is on
   * every page of the website, so it is the one read that happens on every
   * request a visitor makes, and a menu of a dozen entries is not worth two
   * round trips.
   */
  private async readRows(): Promise<MenuRow[]> {
    return this.prisma.menuItem.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        label: true,
        kind: true,
        url: true,
        parentId: true,
        membersOnly: true,
        // Exactly what a page decides about its own entry: where it is,
        // whether it is served and to whom, and whether it is a built-in page
        // whose entry follows the feature behind it.
        page: { select: { slug: true, status: true, builtIn: true } },
      },
    });
  }

  /** What one row becomes for this visitor, or nothing at all. */
  private linkFor(row: MenuRow, audience: MenuAudience): SiteMenuLink | null {
    // Before the target is asked anything: whatever it would answer, the
    // board has kept this entry for signed-in visitors.
    if (row.membersOnly && !audience.hasSession) {
      return null;
    }
    switch (row.kind) {
      case "PAGE": {
        const page = row.page;
        if (page === null || page.status === "DRAFT") {
          return null;
        }
        if (page.status === "MEMBERS_ONLY" && !audience.hasSession) {
          return null;
        }
        if (page.builtIn !== null && !builtInOffered(page.builtIn, audience)) {
          return null;
        }
        // A built-in page's address is the one the product serves it at,
        // stored on its row like any page's - the account request form's
        // included, which is the application's and therefore under /app.
        return { label: row.label, href: `/${page.slug}`, external: false };
      }
      case "EXTERNAL": {
        // Checked again on the way out, as the page parser checks a link:
        // what was stored was validated by the version that stored it, and
        // this is the version that is about to print it into an anchor.
        return row.url !== null && isMenuExternalUrl(row.url)
          ? { label: row.label, href: row.url, external: true }
          : null;
      }
      default:
        return null;
    }
  }
}

/**
 * The slug of the page a row points at, when anyone at all may read it and the
 * root could serve it. An entry the board keeps for members is passed over
 * like an entry for a member-only page: the root reads the menu anonymously.
 *
 * Never a built-in page's. The root serves a page the board wrote, and a
 * built-in page's row has no body to serve: what stands on it is rendered by
 * its own route. Before built-in pages were pages their entries were a kind of
 * their own and were passed over here for the same reason, so a menu that
 * starts with the news index falls back to the same page it always did.
 */
function publicPageSlug(row: MenuRow): string | null {
  if (
    row.kind !== "PAGE" ||
    row.membersOnly ||
    row.page === null ||
    row.page.builtIn !== null
  ) {
    return null;
  }
  return row.page.status === "PUBLIC" ? row.page.slug : null;
}
