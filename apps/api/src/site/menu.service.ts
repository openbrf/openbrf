import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import type { MenuItemKind, PageVisibility } from "../generated/prisma/enums";
import { APP_BASE_PATH } from "../http/app-base-path";
import { isPublishableUrl } from "./page-content";

/**
 * The menu the board arranged, as the website reads it.
 *
 * Reads only, and reads with one rule: an entry is rendered if - and only if -
 * the visitor could open what it points at. A member-only page's entry is not
 * in the menu an anonymous visitor is served, so the navigation cannot become
 * the thing that tells them the page exists. That is the same guarantee the
 * byte-identical not-found document makes, extended to the one part of the
 * chrome that would otherwise list every address the association has.
 *
 * Nothing here decides access. The pages service already answers a member-only
 * address with the same null a missing one gets, whatever the menu says; this
 * only decides what is offered, so a menu row that somehow survived a page's
 * removal would be a broken link and never an open door.
 */

/**
 * A page the product generates rather than the board writes.
 *
 * Each one exists only while the feature behind it does, which is why the
 * menu stores the key and the renderer decides. A cooperative that switches
 * self-signup off should not have to remember to take the account-request
 * entry out of its menu, and one that has not built a news page yet should not
 * have an entry leading to the not-found document.
 */
export type MenuGeneratedKey =
  "news" | "calendar" | "broker" | "requestAccount";

/** Every generated destination, in the order the editor offers them. */
export const MENU_GENERATED_KEYS: readonly MenuGeneratedKey[] = [
  "news",
  "calendar",
  "broker",
  "requestAccount",
];

/** Whether a stored string names a destination this instance knows. */
export function isMenuGeneratedKey(value: string): value is MenuGeneratedKey {
  return (MENU_GENERATED_KEYS as readonly string[]).includes(value);
}

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
 * Where each generated destination lives.
 *
 * The path is written here and the feature that serves it is built elsewhere,
 * so the two have to be kept in step by whoever builds the feature - which is
 * why `available` is false for the one that does not exist yet rather than the
 * entry being absent: the editor can offer the destination the day the page
 * lands, and until then the item is silently left out of the rendered menu.
 */
const GENERATED_DESTINATIONS: Readonly<
  Record<
    MenuGeneratedKey,
    { path: string; available: (audience: MenuAudience) => boolean }
  >
> = {
  /*
   * The news index, served by the news module at the slug that module
   * reserves. Available to everybody: the index is public in the same sense a
   * page is, and it answers a visitor with no session with the items anybody
   * may read - never with a refusal, and never with a count that would say how
   * much the members are being told.
   */
  news: { path: "/nyheter", available: () => true },
  /*
   * The association's calendar, served at the slug the calendar route reserves.
   * Available to everybody, on the news index's argument: the page is public in
   * the same sense a page is and answers a visitor with no session with the
   * dates anybody may see - never with a refusal, and never with a count of the
   * ones it is leaving out, which would say how much the members are being
   * told.
   */
  calendar: { path: "/kalender", available: () => true },
  /*
   * The generated broker information page. Available on any claimed instance:
   * it is public, no setting turns it on, and it stands before the board has
   * recorded a single fact - it then carries the association's name and its
   * organisation number, which is what a broker gets from it on day one. There
   * is nothing here for the menu to wait for, so the entry a board adds is the
   * entry a visitor is shown.
   */
  broker: { path: "/maklarinfo", available: () => true },
  /*
   * The account request form, which is part of the application rather than the
   * website. Offered only while the board takes requests at all, and only to a
   * visitor with no session: somebody already signed in is sent away from that
   * screen, and a menu entry that bounces whoever follows it is a broken one.
   */
  requestAccount: {
    path: `${APP_BASE_PATH}/request-account`,
    available: (audience) => audience.selfSignupEnabled && !audience.hasSession,
  },
};

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
  generatedKey: string | null;
  url: string | null;
  parentId: string | null;
  page: {
    slug: string;
    published: boolean;
    visibility: PageVisibility;
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
   * with no name. An entry whose target has gone - a page unpublished, a
   * feature switched off, a key this version does not recognise - is left out
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
   * The address of the front page, or nothing.
   *
   * The menu's first page entry, read in the order a visitor reads the menu -
   * a top-level entry, then whatever hangs under it, then the next. There is
   * no isHome flag anywhere: the board arranges one menu, and the first of the
   * association's own pages in it is the one the root serves.
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
        generatedKey: true,
        url: true,
        parentId: true,
        // Exactly the three things a page decides about its own entry: where
        // it is, whether it is served at all, and who may read it.
        page: { select: { slug: true, published: true, visibility: true } },
      },
    });
  }

  /** What one row becomes for this visitor, or nothing at all. */
  private linkFor(row: MenuRow, audience: MenuAudience): SiteMenuLink | null {
    switch (row.kind) {
      case "PAGE": {
        const page = row.page;
        if (page === null || !page.published) {
          return null;
        }
        if (page.visibility === "MEMBER" && !audience.hasSession) {
          return null;
        }
        return { label: row.label, href: `/${page.slug}`, external: false };
      }
      case "GENERATED": {
        const key = row.generatedKey;
        if (key === null || !isMenuGeneratedKey(key)) {
          return null;
        }
        const destination = GENERATED_DESTINATIONS[key];
        return destination.available(audience)
          ? { label: row.label, href: destination.path, external: false }
          : null;
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

/** The slug of the page a row points at, when anyone at all may read it. */
function publicPageSlug(row: MenuRow): string | null {
  if (row.kind !== "PAGE" || row.page === null) {
    return null;
  }
  return row.page.published && row.page.visibility === "PUBLIC"
    ? row.page.slug
    : null;
}
