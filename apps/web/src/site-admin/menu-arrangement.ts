/**
 * The arrangement of the website menu as the menu screen works on it.
 *
 * The menu is a top level and one level under it, so it is held as a list of
 * top-level entries each with the entries that hang under it, and never as a
 * tree with a depth. Every way of rearranging it - a drag with a pointer, the
 * move buttons, the indent and outdent buttons - is one function here from one
 * arrangement to the next, so the buttons that exist for the keyboard and the
 * screen reader reach exactly the arrangements a drag can, from the same code.
 * The screen sends the result to the server whole.
 *
 * Nothing here knows about the page, the browser or the network, which is what
 * makes the rule that matters - an entry that has entries of its own is never
 * put inside another, so the menu never gets a third level - something these
 * functions can be tested for rather than a thing every caller remembers.
 */

/** One top-level entry and the ids of the entries that hang under it. */
export interface MenuBranch {
  id: string;
  children: readonly string[];
}

/** The menu: its top level, in order. */
export type MenuTree = readonly MenuBranch[];

/** One entry's place, as the server's arrange route takes it. */
export interface MenuPlacement {
  id: string;
  parentId: string | null;
}

/** The fields of an entry the arrangement reads. */
interface Arranged {
  id: string;
  parentId: string | null;
}

/**
 * The tree the server's flat list describes.
 *
 * The list is in the order the website renders it in, so the order of the
 * entries within each level is the order they appear in. An entry naming a
 * parent that is not in the list has nothing to hang from and is left out
 * rather than promoted: the server's foreign key makes that a menu that cannot
 * exist, and guessing a level for it would put an entry where nobody chose.
 */
export function treeOf(items: readonly Arranged[]): MenuTree {
  const top = items.filter((item) => item.parentId === null);
  return top.map((entry) => ({
    id: entry.id,
    children: items
      .filter((item) => item.parentId === entry.id)
      .map((item) => item.id),
  }));
}

/** The tree as the flat list the server takes: reading order, parents named. */
export function placementsOf(tree: MenuTree): MenuPlacement[] {
  return tree.flatMap((branch) => [
    { id: branch.id, parentId: null },
    ...branch.children.map((child) => ({ id: child, parentId: branch.id })),
  ]);
}

/** Whether two arrangements are the same menu. */
export function sameArrangement(a: MenuTree, b: MenuTree): boolean {
  const left = placementsOf(a);
  const right = placementsOf(b);
  return (
    left.length === right.length &&
    left.every(
      (placement, index) =>
        placement.id === right[index]?.id &&
        placement.parentId === right[index]?.parentId,
    )
  );
}

/** Where an entry sits: which level, and its place among that level's entries. */
export interface MenuPosition {
  /** The top-level entry it hangs under, or null on the top level. */
  parentId: string | null;
  /** Zero-based, among the entries of its level. */
  index: number;
  /** How many entries its level has. */
  count: number;
}

export function positionOf(tree: MenuTree, id: string): MenuPosition | null {
  const top = tree.findIndex((branch) => branch.id === id);
  if (top >= 0) {
    return { parentId: null, index: top, count: tree.length };
  }
  for (const branch of tree) {
    const at = branch.children.indexOf(id);
    if (at >= 0) {
      return { parentId: branch.id, index: at, count: branch.children.length };
    }
  }
  return null;
}

/**
 * One place up or down within the entry's own level.
 *
 * A top-level entry takes what hangs under it along, as it is the entry the
 * dropdown hangs from. Null where there is nowhere to go.
 */
export function moveBy(
  tree: MenuTree,
  id: string,
  by: -1 | 1,
): MenuTree | null {
  const at = positionOf(tree, id);
  if (at === null) {
    return null;
  }
  const to = at.index + by;
  if (to < 0 || to >= at.count) {
    return null;
  }

  if (at.parentId === null) {
    const next = [...tree];
    const [moved] = next.splice(at.index, 1);
    next.splice(to, 0, moved as MenuBranch);
    return next;
  }

  return tree.map((branch) => {
    if (branch.id !== at.parentId) {
      return branch;
    }
    const children = [...branch.children];
    const [moved] = children.splice(at.index, 1);
    children.splice(to, 0, moved as string);
    return { ...branch, children };
  });
}

/** Whether the entry may be made a dropdown item under the entry above it. */
export function canIndent(tree: MenuTree, id: string): boolean {
  const at = positionOf(tree, id);
  if (at === null || at.parentId !== null || at.index === 0) {
    return false;
  }
  // Two levels and no more: what already hangs under it would be a third.
  return (tree[at.index]?.children.length ?? 0) === 0;
}

/**
 * Makes a top-level entry the last dropdown item of the entry above it.
 *
 * Null where that would break the two-level rule or there is no entry above.
 */
export function indent(tree: MenuTree, id: string): MenuTree | null {
  if (!canIndent(tree, id)) {
    return null;
  }
  const at = tree.findIndex((branch) => branch.id === id);
  return tree.flatMap((branch, index) => {
    if (index === at) {
      return [];
    }
    return index === at - 1
      ? [{ ...branch, children: [...branch.children, id] }]
      : [branch];
  });
}

/**
 * Takes a dropdown item up to the top level, directly after the entry it hung
 * under and what hangs under that. Null for an entry that is on the top level.
 */
export function outdent(tree: MenuTree, id: string): MenuTree | null {
  const at = positionOf(tree, id);
  if (at === null || at.parentId === null) {
    return null;
  }
  const next: MenuBranch[] = [];
  for (const branch of tree) {
    if (branch.id === at.parentId) {
      next.push({
        ...branch,
        children: branch.children.filter((child) => child !== id),
      });
      next.push({ id, children: [] });
    } else {
      next.push(branch);
    }
  }
  return next;
}

/** One row of the menu in reading order, with how deep it sits. */
interface Row {
  id: string;
  depth: 0 | 1;
  parentId: string | null;
}

function rowsOf(tree: MenuTree): Row[] {
  return placementsOf(tree).map((placement) => ({
    id: placement.id,
    depth: placement.parentId === null ? 0 : 1,
    parentId: placement.parentId,
  }));
}

/**
 * Where a drag lands the entry, and on which level.
 *
 * `overId` is the row the dragged entry is over, `offsetX` how far sideways it
 * has been dragged from where it started and `step` how far sideways makes one
 * level. The answer is the arrangement the drop would give, or null when it
 * would change nothing.
 *
 * The place follows the row it is over: dropped on a row below where it
 * started it goes after that row (and after what hangs under it, for a
 * top-level entry), on a row above it goes before it. The level follows the
 * pointer sideways - one step right is a dropdown item of the entry above, one
 * step left is back on the top level - within what the place allows: an entry
 * with entries of its own never goes inside another, and an entry dropped
 * between two dropdown items of one entry stays one of them, as the entries
 * around it would otherwise be split from the one they hang from.
 *
 * A drag that stays on its own row is the sideways drag alone, and a drag left
 * of a dropdown item takes it out the way the outdent button does, after the
 * entry it hung under, whatever its brothers are.
 */
export function dropTo(
  tree: MenuTree,
  activeId: string,
  overId: string,
  offsetX: number,
  step: number,
): MenuTree | null {
  const active = positionOf(tree, activeId);
  if (active === null || positionOf(tree, overId) === null) {
    return null;
  }

  const levels = Math.round(offsetX / step);
  const startedAt = active.parentId === null ? 0 : 1;

  if (overId === activeId && startedAt + levels <= 0 && startedAt === 1) {
    return outdent(tree, activeId);
  }

  const original = rowsOf(tree);
  const from = original.findIndex((row) => row.id === activeId);
  const over = original.findIndex((row) => row.id === overId);

  // What is carried along: for a top-level entry, what hangs under it.
  const carried =
    active.parentId === null
      ? (tree.find((branch) => branch.id === activeId)?.children ?? [])
      : [];

  // Over what it carries, it is over itself: it goes nowhere, and as it has
  // entries of its own it cannot go inside another either.
  if (carried.includes(overId)) {
    return null;
  }

  const rest = original.filter(
    (row) => row.id !== activeId && !carried.includes(row.id),
  );

  // Where in `rest` the entry goes: the number of rows that stay above it.
  let at: number;
  if (overId === activeId) {
    // Everything above it stays above it, and what it carries was below.
    at = from;
  } else if (over < from) {
    at = rest.findIndex((row) => row.id === overId);
  } else {
    at = rest.findIndex((row) => row.id === overId) + 1;
    // Dropped on a top-level entry from above, it goes after that entry's
    // dropdown and not into it; sideways is how it is put into one.
    if (original[over]?.depth === 0) {
      while (rest[at]?.depth === 1) {
        at += 1;
      }
    }
  }

  // An entry with entries of its own cannot go inside a dropdown: it goes to
  // the edge of the group it landed in, on the side it was dragged towards.
  if (carried.length > 0 && rest[at]?.depth === 1) {
    if (over < from) {
      while (at > 0 && rest[at]?.depth === 1) {
        at -= 1;
      }
    } else {
      while (rest[at]?.depth === 1) {
        at += 1;
      }
    }
  }

  const before = rest[at - 1];
  const after = rest[at];
  const lowest = after?.depth === 1 ? 1 : 0;
  const highest = carried.length > 0 || before === undefined ? 0 : 1;
  const depth = Math.min(Math.max(startedAt + levels, lowest), highest);

  const next = rebuild(rest, at, activeId, carried, depth === 1 ? 1 : 0);
  return sameArrangement(tree, next) ? null : next;
}

/** The rows with the entry put back at `at`, as a tree. */
function rebuild(
  rest: readonly Row[],
  at: number,
  id: string,
  children: readonly string[],
  depth: 0 | 1,
): MenuTree {
  const rows = [...rest];
  rows.splice(at, 0, { id, depth, parentId: null });

  const tree: { id: string; children: string[] }[] = [];
  for (const row of rows) {
    if (row.depth === 0) {
      tree.push({ id: row.id, children: row.id === id ? [...children] : [] });
    } else {
      // A dropdown item hangs under the top-level entry above it.
      tree[tree.length - 1]?.children.push(row.id);
    }
  }
  return tree;
}
