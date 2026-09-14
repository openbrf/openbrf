import { HttpStatus, Injectable } from "@nestjs/common";

import type { ActorContext } from "../audit/actor-context";
import { auditActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
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
 * Every write here is recorded in the audit log, in the same transaction as the
 * write itself.
 *
 * The argument for not recording them was about disclosure and it still holds:
 * the menu decides what is offered and never what may be read, an entry is
 * rendered only to a visitor who could open its target anyway, and publication
 * itself is recorded where it happens, on the page. Attribution is a separate
 * question, and it is a real one once something other than a board member in a
 * browser can write here. The menu is the one place on a public page where an
 * address leaving the instance can be planted, every visitor sees it, and
 * nobody reads it closely.
 *
 * So the entry records what the entry points at, including the address for an
 * external target: a menu target is published site content rather than personal
 * data, and a record that could not say where a planted link pointed would not
 * answer the question it exists for. The label is never recorded - it is text a
 * board member wrote, it has a home of its own on the row, and rule 3 on
 * AuditLogService keeps copies of such text out of a table that outlives it.
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

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
  async create(
    input: MenuItemInput,
    actor: ActorContext,
  ): Promise<MenuItemView> {
    const parentId = await this.requirePlaceableParent(
      input.parentId ?? null,
      null,
    );
    const target = await this.resolveTarget(input);

    const row = await this.prisma.$transaction(async (tx) => {
      // Read inside the transaction, with the insert it decides the position
      // for: the two are one act, and the entry below records that act.
      const highest = await tx.menuItem.aggregate({
        where: { parentId },
        _max: { sortOrder: true },
      });

      const created = await tx.menuItem.create({
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

      await this.audit.record(
        {
          action: "MENU_ITEM_ADDED",
          ...auditActor(actor),
          targetKind: "menuItem",
          targetId: created.id,
          context: menuEntryFacts(input.kind, parentId, target),
        },
        tx,
      );

      return created;
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
  async update(
    id: string,
    input: MenuItemInput,
    actor: ActorContext,
  ): Promise<MenuItemView> {
    const existing = await this.require(id);
    const parentId = await this.requirePlaceableParent(
      input.parentId ?? null,
      existing.id,
    );
    const target = await this.resolveTarget(input);

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.menuItem.update({
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

      await this.audit.record(
        {
          action: "MENU_ITEM_CHANGED",
          ...auditActor(actor),
          targetKind: "menuItem",
          targetId: id,
          context: menuEntryFacts(input.kind, parentId, target),
        },
        tx,
      );

      return updated;
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
    actor: ActorContext,
  ): Promise<MenuItemView[]> {
    /*
     * Interactive rather than the array form, which cannot carry the audit
     * entry: the entry has to commit or roll back with the arrangement it
     * records, and the array form has no place to put a write that depends on
     * the ones before it.
     */
    await this.prisma.$transaction(async (tx) => {
      for (const [index, id] of ids.entries()) {
        await tx.menuItem.updateMany({
          where: { id, parentId },
          data: { sortOrder: index },
        });
      }

      /*
       * Written for every reorder, a no-op included. Ids outside the level are
       * silently ignored above, so how many rows actually moved is not a
       * number this call knows; the count of ids the board sent is the honest
       * record of what was asked for.
       */
      await this.audit.record(
        {
          action: "MENU_ITEM_REORDERED",
          ...auditActor(actor),
          // The act is on a level of the menu rather than on one entry: the
          // parent names the level, and null is the top one.
          targetKind: "menuLevel",
          targetId: parentId,
          context: { parentId, count: ids.length },
        },
        tx,
      );
    });
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
  async remove(id: string, actor: ActorContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.menuItem.findUnique({
        where: { id },
        select: { id: true, kind: true },
      });
      if (existing === null) {
        throw new MenuWriteError("There is no such menu entry.", "not-found");
      }

      // Counted before the delete, because the cascade is what takes them and
      // afterwards there is nothing left to count.
      const childrenRemoved = await tx.menuItem.count({
        where: { parentId: id },
      });

      await tx.menuItem.delete({ where: { id } });

      await this.audit.record(
        {
          action: "MENU_ITEM_REMOVED",
          ...auditActor(actor),
          targetKind: "menuItem",
          targetId: id,
          context: { kind: existing.kind, childrenRemoved },
        },
        tx,
      );
    });
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

/**
 * What the log keeps about an entry that was added or changed.
 *
 * Facts about the destination and the level, and no label: see the note at the
 * top of this file for which of the two is text with a home of its own. The
 * address is recorded for an external target and only for one, because that is
 * the target that leaves the instance and the only one an id could not identify
 * later.
 */
function menuEntryFacts(
  kind: MenuItemKind,
  parentId: string | null,
  target: {
    pageId: string | null;
    generatedKey: string | null;
    url: string | null;
  },
): Record<string, unknown> {
  return {
    kind,
    parentId,
    target: target.pageId ?? target.generatedKey,
    ...(target.url === null ? {} : { href: target.url }),
  };
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
