import { describe, expect, it } from "vite-plus/test";

import {
  canIndent,
  dropTo,
  indent,
  moveBy,
  outdent,
  placementsOf,
  positionOf,
  treeOf,
  type MenuTree,
} from "./menu-arrangement";

const STEP = 32;

/** Shorthand: `a` with children `a1` and `a2` is `["a", "a1", "a2"]`. */
function menu(...branches: string[][]): MenuTree {
  return branches.map(([id, ...children]) => ({
    id: id as string,
    children,
  }));
}

function ids(tree: MenuTree | null): string[][] | null {
  return tree === null
    ? null
    : tree.map((branch) => [branch.id, ...branch.children]);
}

describe("the tree of a flat menu", () => {
  it("groups each top-level entry with what hangs under it", () => {
    const tree = treeOf([
      { id: "a", parentId: null },
      { id: "a1", parentId: "a" },
      { id: "b", parentId: null },
      { id: "a2", parentId: "a" },
    ]);
    expect(ids(tree)).toEqual([["a", "a1", "a2"], ["b"]]);
  });

  it("is written back in reading order with the parents named", () => {
    expect(placementsOf(menu(["a", "a1"], ["b"]))).toEqual([
      { id: "a", parentId: null },
      { id: "a1", parentId: "a" },
      { id: "b", parentId: null },
    ]);
  });

  it("finds where an entry sits among its level", () => {
    const tree = menu(["a", "a1", "a2"], ["b"]);
    expect(positionOf(tree, "b")).toEqual({
      parentId: null,
      index: 1,
      count: 2,
    });
    expect(positionOf(tree, "a2")).toEqual({
      parentId: "a",
      index: 1,
      count: 2,
    });
    expect(positionOf(tree, "missing")).toBeNull();
  });
});

describe("moving one place", () => {
  it("takes a top-level entry up with what hangs under it", () => {
    expect(ids(moveBy(menu(["a"], ["b", "b1"]), "b", -1))).toEqual([
      ["b", "b1"],
      ["a"],
    ]);
  });

  it("moves a dropdown item within its own dropdown", () => {
    expect(ids(moveBy(menu(["a", "a1", "a2"], ["b"]), "a1", 1))).toEqual([
      ["a", "a2", "a1"],
      ["b"],
    ]);
  });

  it("goes nowhere past either end", () => {
    const tree = menu(["a", "a1"], ["b"]);
    expect(moveBy(tree, "a", -1)).toBeNull();
    expect(moveBy(tree, "b", 1)).toBeNull();
    expect(moveBy(tree, "a1", -1)).toBeNull();
  });
});

describe("indenting and outdenting", () => {
  it("makes an entry the last dropdown item of the entry above", () => {
    expect(ids(indent(menu(["a", "a1"], ["b"]), "b"))).toEqual([
      ["a", "a1", "b"],
    ]);
  });

  it("does not indent the first entry", () => {
    expect(canIndent(menu(["a"], ["b"]), "a")).toBe(false);
    expect(indent(menu(["a"], ["b"]), "a")).toBeNull();
  });

  it("does not put an entry with a dropdown of its own inside another", () => {
    const tree = menu(["a"], ["b", "b1"]);
    expect(canIndent(tree, "b")).toBe(false);
    expect(indent(tree, "b")).toBeNull();
  });

  it("does not indent what is already a dropdown item", () => {
    expect(indent(menu(["a", "a1"]), "a1")).toBeNull();
  });

  it("takes a dropdown item up to the top level after its entry", () => {
    expect(ids(outdent(menu(["a", "a1", "a2"], ["b"]), "a1"))).toEqual([
      ["a", "a2"],
      ["a1"],
      ["b"],
    ]);
  });

  it("does not outdent a top-level entry", () => {
    expect(outdent(menu(["a"], ["b"]), "b")).toBeNull();
  });
});

describe("a drag", () => {
  it("moves an entry down onto the entry below it", () => {
    expect(ids(dropTo(menu(["a"], ["b"], ["c"]), "a", "b", 0, STEP))).toEqual([
      ["b"],
      ["a"],
      ["c"],
    ]);
  });

  it("moves an entry up onto the entry above it", () => {
    expect(ids(dropTo(menu(["a"], ["b"], ["c"]), "c", "a", 0, STEP))).toEqual([
      ["c"],
      ["a"],
      ["b"],
    ]);
  });

  it("changes nothing when dropped where it was", () => {
    expect(dropTo(menu(["a"], ["b"]), "b", "b", 0, STEP)).toBeNull();
    // A nudge short of half a step is no step.
    expect(dropTo(menu(["a"], ["b"]), "b", "b", STEP / 3, STEP)).toBeNull();
  });

  it("nests an entry dragged sideways under the one above", () => {
    expect(ids(dropTo(menu(["a"], ["b"]), "b", "b", STEP, STEP))).toEqual([
      ["a", "b"],
    ]);
  });

  it("nests under the entry above even when dragged past a second one", () => {
    expect(
      ids(dropTo(menu(["a"], ["b"], ["c"]), "c", "c", STEP, STEP)),
    ).toEqual([["a"], ["b", "c"]]);
  });

  it("does not nest the first entry, however far it is dragged", () => {
    expect(dropTo(menu(["a"], ["b"]), "a", "a", STEP * 2, STEP)).toBeNull();
  });

  it("does not nest an entry that has a dropdown of its own", () => {
    expect(dropTo(menu(["a"], ["b", "b1"]), "b", "b", STEP, STEP)).toBeNull();
  });

  it("takes a dropdown item out to the top level when dragged left", () => {
    expect(
      ids(dropTo(menu(["a", "a1"], ["b"]), "a1", "a1", -STEP, STEP)),
    ).toEqual([["a"], ["a1"], ["b"]]);
  });

  it("takes a dropdown item out after its entry even from the middle", () => {
    expect(
      ids(dropTo(menu(["a", "a1", "a2"]), "a1", "a1", -STEP, STEP)),
    ).toEqual([["a", "a2"], ["a1"]]);
  });

  it("moves a dropdown item within its dropdown", () => {
    expect(ids(dropTo(menu(["a", "a1", "a2"]), "a1", "a2", 0, STEP))).toEqual([
      ["a", "a2", "a1"],
    ]);
  });

  it("moves an entry into a dropdown when dropped between its items", () => {
    expect(
      ids(dropTo(menu(["a", "a1", "a2"], ["b"]), "b", "a1", 0, STEP)),
    ).toEqual([["a", "b", "a1", "a2"]]);
  });

  it("puts an entry dropped on an entry with a dropdown after the dropdown", () => {
    expect(
      ids(dropTo(menu(["a"], ["b", "b1"], ["c"]), "a", "b", 0, STEP)),
    ).toEqual([["b", "b1"], ["a"], ["c"]]);
  });

  it("carries a dropdown along with its entry", () => {
    expect(
      ids(dropTo(menu(["a", "a1"], ["b"], ["c"]), "a", "c", 0, STEP)),
    ).toEqual([["b"], ["c"], ["a", "a1"]]);
  });

  it("changes nothing when an entry is dropped on what hangs under it", () => {
    const tree = menu(["a"], ["b", "b1", "b2"], ["c"]);
    expect(dropTo(tree, "b", "b1", 0, STEP)).toBeNull();
    expect(dropTo(tree, "b", "b2", 0, STEP)).toBeNull();
    expect(dropTo(tree, "b", "b1", -STEP, STEP)).toBeNull();
    expect(dropTo(tree, "b", "b2", STEP, STEP)).toBeNull();
  });

  it("never puts an entry with a dropdown inside another dropdown", () => {
    const tree = dropTo(
      menu(["a", "a1", "a2"], ["b", "b1"]),
      "b",
      "a1",
      STEP,
      STEP,
    );
    // Before the whole of a's group, since it was dragged upwards.
    expect(ids(tree)).toEqual([
      ["b", "b1"],
      ["a", "a1", "a2"],
    ]);
    for (const branch of tree ?? []) {
      expect(placementsOf([branch]).length).toBeLessThanOrEqual(3);
    }
  });

  it("keeps an entry dropped inside a dropdown in it, whatever the pointer says", () => {
    expect(
      ids(dropTo(menu(["a", "a1", "a2"], ["b"]), "b", "a1", -STEP, STEP)),
    ).toEqual([["a", "b", "a1", "a2"]]);
  });
});
