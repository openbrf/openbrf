import { HttpStatus, Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import type { MenuItemKind, PageVisibility } from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";
import { isMenuExternalUrl, isMenuGeneratedKey } from "./menu.service";

/**
 * The board's side of the site menu: adding entries, naming them, arranging
 * them, and taking them away.
 *
 * Every rule that decides what a menu may be is here, because a second write
 * path would be a second place to forget one. There are three of them:
 *
 *   An entry points at exactly one thing. Its kind says which, and the fields
 *   belonging to the other two kinds are cleared on every write - so an entry
 *   changed from a page to a link cannot keep a stale page reference that a
 *   later reader might follow.
 *
 *   Two levels and no more. A dropdown that opens a dropdown needs a script to
 *   be usable, and the website has none.
 *
 *   An external address is https. It is the one target on the website that
 *   leaves the instance, printed on every page, and http would be the
 *   association sending its readers somewhere over the open wire.
 *
 * There is deliberately no audit entry here. The menu decides what is offered
 * and never what may be read: an entry is rendered only to a visitor who could
 * open its target anyway, so rearranging the menu publishes nothing and
 * conceals nothing. Publication itself is recorded where it happens, on the
 * page.
 */

export type MenuWriteReason =
  | "not-found"
  | "parent-not-found"
  | "page-not-found"
  | "unknown-generated-key"
  | "invalid-url"
  | "label-required"
  | "label-too-long"
  | "target-required"
  | "nesting-too-deep";

export class MenuWriteError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: MenuWriteReason,
  ) {
    super(message);
    this.status =
      reason === "not-found" || reason === "parent-not-found"
        ? HttpStatus.NOT_FOUND
        : reason === "page-not-found"
          ? HttpStatus.NOT_FOUND
          : // The request was understood and refused on its merits: this is
            // not a menu the website can render.
            HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

/** An entry as the board's own screen shows it. */
export interface MenuItemView {
  id: string;
  label: string;
  kind: MenuItemKind;
  parentId: string | null;
  sortOrder: number;
  pageId: string | null;
  generatedKey: string | null;
  url: string | null;
  /**
   * The state of the page this entry points at, when it points at one.
   *
   * The editor shows it so the board can see why an entry is not on the site:
   * a draft and a member-only page are both perfectly good menu entries, and
   * both are invisible to a visitor with no session.
   */
  page: {
    slug: string;
    title: string;
    published: boolean;
    visibility: PageVisibility;
  } | null;
}

export interface MenuItemInput {
  kind: MenuItemKind;
  /** Empty defaults from the page's own title, for a page entry. */
  label: string;
  pageId?: string | undefined;
  generatedKey?: string | undefined;
  url?: string | undefined;
  parentId?: string | null | undefined;
}

const ITEM_COLUMNS = {
  id: true,
  label: true,
  kind: true,
  parentId: true,
  sortOrder: true,
  pageId: true,
  generatedKey: true,
  url: true,
  page: {
    select: {
      slug: true,
      title: true,
      published: true,
      visibility: true,
    },
  },
} as const;

/**
 * As long a label as fits a menu on a telephone, and no longer.
 *
 * A label the board typed is refused past it rather than cut, because a cut
 * one is the server answering "saved" with words nobody wrote. A title
 * borrowed from a page is cut, because the board did not type it here and a
 * page may perfectly well be titled in a sentence.
 */
const LABEL_LIMIT = 60;

@Injectable()
export class MenuWriteService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The whole menu, both levels, in the order it is rendered in.
   *
   * Flat rather than nested: the parent is named on each row, the screen
   * builds the two levels from that, and one shape means the reorder and the
   * move-between-levels calls talk about the same rows the list did.
   */
  async list(): Promise<MenuItemView[]> {
    const rows = await this.prisma.menuItem.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: ITEM_COLUMNS,
    });
    return rows.map((row) => toView(row));
  }

  /** Adds an entry at the end of its level. */
  async create(input: MenuItemInput): Promise<MenuItemView> {
    const parentId = await this.requirePlaceableParent(
      input.parentId ?? null,
      null,
    );
    const target = await this.resolveTarget(input);

    const highest = await this.prisma.menuItem.aggregate({
      where: { parentId },
      _max: { sortOrder: true },
    });

    const row = await this.prisma.menuItem.create({
      data: {
        label: target.label,
        kind: input.kind,
        pageId: target.pageId,
        generatedKey: target.generatedKey,
        url: target.url,
        parentId,
        sortOrder: (highest._max.sortOrder ?? -1) + 1,
      },
      select: ITEM_COLUMNS,
    });

    return toView(row);
  }

  /**
   * Rewrites an entry: what it says, what it points at, and where it hangs.
   *
   * The three target columns are always written, two of them to null. An entry
   * that was a page and becomes a link must not keep the page it used to name,
   * because the reader decides what to follow from the kind and would then be
   * one bug away from following the wrong one.
   *
   * Where it hangs is written from the same reading: the body is the whole
   * entry rather than the part of it that changed, so an entry sent without a
   * parent is an entry at the top level. That is the difference between this
   * call and the reorder below - a reorder is scoped to one level so that
   * arranging a dropdown can never take an entry out of it, while saying where
   * an entry hangs is exactly what this call is for.
   */
  async update(id: string, input: MenuItemInput): Promise<MenuItemView> {
    const existing = await this.require(id);
    const parentId = await this.requirePlaceableParent(
      input.parentId ?? null,
      existing.id,
    );
    const target = await this.resolveTarget(input);

    const row = await this.prisma.menuItem.update({
      where: { id },
      data: {
        label: target.label,
        kind: input.kind,
        pageId: target.pageId,
        generatedKey: target.generatedKey,
        url: target.url,
        parentId,
        // Moving between levels puts the entry at the end of the level it
        // arrives in, rather than at whatever position it held in the one it
        // left - which would otherwise land it in the middle of its new
        // siblings for no reason the board could see.
        ...(parentId === existing.parentId
          ? {}
          : { sortOrder: await this.nextSortOrder(parentId) }),
      },
      select: ITEM_COLUMNS,
    });

    return toView(row);
  }

  /**
   * Puts one level in the order the ids arrive in.
   *
   * Scoped to a parent - null for the top level - so a reorder cannot move an
   * entry between levels by accident. Ids that are not in that level are
   * ignored rather than refused: this is the answer to a button on a list, and
   * a browser holding a row somebody else has since moved must not lose the
   * whole arrangement over it.
   */
  async reorder(
    parentId: string | null,
    ids: readonly string[],
  ): Promise<MenuItemView[]> {
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.menuItem.updateMany({
          where: { id, parentId },
          data: { sortOrder: index },
        }),
      ),
    );
    return this.list();
  }

  /**
   * Removes an entry, and whatever hung under it.
   *
   * The children go with it because the database cascades, and that is the
   * honest reading of the act: a dropdown is the entry it hangs from, and
   * keeping its items as orphaned top-level entries would silently promote
   * things the board had put away.
   */
  async remove(id: string): Promise<void> {
    await this.require(id);
    await this.prisma.menuItem.delete({ where: { id } });
  }

  /** The position at the end of one level. */
  private async nextSortOrder(parentId: string | null): Promise<number> {
    const highest = await this.prisma.menuItem.aggregate({
      where: { parentId },
      _max: { sortOrder: true },
    });
    return (highest._max.sortOrder ?? -1) + 1;
  }

  /**
   * The parent an entry may hang from, or nothing for the top level.
   *
   * Three refusals, and each of them is the two-level rule seen from a
   * different side: the parent has to exist, it may not already hang from
   * something itself, and an entry that has children of its own may not be
   * moved under another.
   */
  private async requirePlaceableParent(
    parentId: string | null,
    movingId: string | null,
  ): Promise<string | null> {
    if (parentId === null) {
      return null;
    }

    if (parentId === movingId) {
      throw new MenuWriteError(
        "A menu entry cannot hang from itself.",
        "nesting-too-deep",
      );
    }

    const parent = await this.prisma.menuItem.findUnique({
      where: { id: parentId },
      select: { id: true, parentId: true },
    });
    if (parent === null) {
      throw new MenuWriteError(
        "There is no such menu entry to hang this one from.",
        "parent-not-found",
      );
    }
    if (parent.parentId !== null) {
      throw new MenuWriteError(
        "The menu has a top level and one dropdown level, and no more.",
        "nesting-too-deep",
      );
    }

    if (movingId !== null) {
      const children = await this.prisma.menuItem.count({
        where: { parentId: movingId },
      });
      if (children > 0) {
        throw new MenuWriteError(
          "This entry has entries of its own, so it cannot be put inside another.",
          "nesting-too-deep",
        );
      }
    }

    return parentId;
  }

  /**
   * What the entry points at, and what it is called.
   *
   * The kind decides which field is read and the other two are cleared, so the
   * stored row can only ever describe one destination. A page entry with no
   * label of its own takes the page's title, which is what the board wrote
   * when they made the page; the two that have no title to borrow - a
   * generated page and an address elsewhere - have to be named.
   */
  private async resolveTarget(input: MenuItemInput): Promise<{
    label: string;
    pageId: string | null;
    generatedKey: string | null;
    url: string | null;
  }> {
    const label = requireFittingLabel(input.label.trim());

    switch (input.kind) {
      case "PAGE": {
        const pageId = input.pageId ?? "";
        if (pageId === "") {
          throw new MenuWriteError(
            "A page entry has to name a page.",
            "target-required",
          );
        }
        const page = await this.prisma.page.findUnique({
          where: { id: pageId },
          select: { id: true, title: true },
        });
        if (page === null) {
          throw new MenuWriteError("There is no such page.", "page-not-found");
        }
        return {
          // Cut, unlike a typed one: the page's title is borrowed rather
          // than written here, and the migration that backfilled this menu
          // cut it at the same length.
          label: label === "" ? page.title.slice(0, LABEL_LIMIT) : label,
          pageId: page.id,
          generatedKey: null,
          url: null,
        };
      }
      case "GENERATED": {
        const key = input.generatedKey ?? "";
        if (!isMenuGeneratedKey(key)) {
          throw new MenuWriteError(
            "This instance has no such generated page.",
            "unknown-generated-key",
          );
        }
        return {
          label: requireLabel(label),
          pageId: null,
          generatedKey: key,
          url: null,
        };
      }
      case "EXTERNAL": {
        const url = (input.url ?? "").trim();
        if (!isMenuExternalUrl(url)) {
          throw new MenuWriteError(
            "A menu entry may only link to an https address.",
            "invalid-url",
          );
        }
        return {
          label: requireLabel(label),
          pageId: null,
          generatedKey: null,
          url,
        };
      }
      default:
        throw new MenuWriteError(
          "A menu entry has to point at something.",
          "target-required",
        );
    }
  }

  private async require(id: string) {
    const row = await this.prisma.menuItem.findUnique({
      where: { id },
      select: { id: true, parentId: true },
    });
    if (row === null) {
      throw new MenuWriteError("There is no such menu entry.", "not-found");
    }
    return row;
  }
}

function requireFittingLabel(label: string): string {
  if (label.length > LABEL_LIMIT) {
    throw new MenuWriteError(
      "A menu label has to fit a menu on a telephone.",
      "label-too-long",
    );
  }
  return label;
}

function requireLabel(label: string): string {
  if (label === "") {
    throw new MenuWriteError(
      "This menu entry has no title to borrow, so it needs one of its own.",
      "label-required",
    );
  }
  return label;
}

function toView(row: {
  id: string;
  label: string;
  kind: MenuItemKind;
  parentId: string | null;
  sortOrder: number;
  pageId: string | null;
  generatedKey: string | null;
  url: string | null;
  page: {
    slug: string;
    title: string;
    published: boolean;
    visibility: PageVisibility;
  } | null;
}): MenuItemView {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    pageId: row.pageId,
    generatedKey: row.generatedKey,
    url: row.url,
    page: row.page,
  };
}
