import { describe, expect, it } from "vitest";

import { groupByFloor, UNKNOWN_FLOOR } from "./floor-groups";
import type { DirectoryRow } from "./register-api";

/**
 * Floor grouping, the way a physical porttavla is organised.
 *
 * The cases that matter are data cases: a person with no apartment, two
 * addresses whose ground floors both number 10XX, and numbering that does not
 * follow Lantmateriet's convention.
 */

function row(
  overrides: {
    personId?: string;
    number?: string | null;
    floor?: number | null;
    addressId?: string;
  } = {},
): DirectoryRow {
  const number = overrides.number ?? "1001";
  return {
    key: `${overrides.personId ?? "person"}-${number}`,
    personId: overrides.personId ?? "person",
    name: "Anna Lindqvist",
    apartment:
      overrides.number === null
        ? null
        : {
            id: `apartment-${number}`,
            addressId: overrides.addressId ?? "address-1",
            number,
            floor: overrides.floor ?? null,
          },
    signs: ["MEMBER"],
    movedInOn: "2019-06-01",
    movedOutOn: null,
  };
}

describe("groupByFloor", () => {
  it("groups consecutive rows on the same floor", () => {
    const groups = groupByFloor(
      [
        row({ personId: "a", number: "1001", floor: 0 }),
        row({ personId: "b", number: "1002", floor: 0 }),
        row({ personId: "c", number: "1101", floor: 1 }),
      ],
      { multipleAddresses: false },
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.floor).toBe(0);
    expect(groups[0]?.rows).toHaveLength(2);
    expect(groups[1]?.floor).toBe(1);
  });

  it("labels each group with the number range it covers", () => {
    const groups = groupByFloor(
      [
        row({ personId: "a", number: "1001", floor: 0 }),
        row({ personId: "b", number: "1102", floor: 1 }),
      ],
      { multipleAddresses: false },
    );

    expect(groups[0]?.numberPrefix).toBe("10XX");
    expect(groups[1]?.numberPrefix).toBe("11XX");
  });

  it("omits the range when the numbers do not share one", () => {
    // A cooperative whose numbering predates the convention still has floors,
    // and inventing a range for it would be a false label on a statutory view.
    const groups = groupByFloor(
      [
        row({ personId: "a", number: "1001", floor: 0 }),
        row({ personId: "b", number: "7", floor: 0 }),
      ],
      { multipleAddresses: false },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.numberPrefix).toBeNull();
  });

  it("falls back to the apartment number when no floor is stored", () => {
    const groups = groupByFloor([row({ number: "1203", floor: null })], {
      multipleAddresses: false,
    });

    expect(groups[0]?.floor).toBe(2);
  });

  it("keeps two addresses apart even on the same floor", () => {
    // Both buildings number their ground floor 10XX, so grouping on the floor
    // alone would merge two stairwells into one board.
    const groups = groupByFloor(
      [
        row({ personId: "a", number: "1001", floor: 0, addressId: "one" }),
        row({ personId: "b", number: "1001", floor: 0, addressId: "two" }),
      ],
      { multipleAddresses: true },
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.addressId).toBe("one");
    expect(groups[1]?.addressId).toBe("two");
    expect(groups[0]?.showAddress).toBe(true);
  });

  it("does not name the address when only one is being shown", () => {
    const groups = groupByFloor([row()], { multipleAddresses: false });

    expect(groups[0]?.showAddress).toBe(false);
  });

  it("collects persons with no apartment into one trailing group", () => {
    // External board members and admins hold no apartment, so they cannot sit
    // on a floor - but they are in the register and must be findable.
    const groups = groupByFloor(
      [
        row({ personId: "a", number: "1001", floor: 0 }),
        row({ personId: "external", number: null }),
      ],
      { multipleAddresses: false },
    );

    expect(groups).toHaveLength(2);
    expect(groups[1]?.floor).toBeNull();
    expect(groups[1]?.rows[0]?.personId).toBe("external");
  });

  it("marks an apartment whose floor cannot be determined as unknown", () => {
    // Not the same as holding no apartment: the row prints an apartment number,
    // so a header reading "Without apartment" above it would be a false label
    // on a register view. This is the legacy-numbering case the module supports.
    const groups = groupByFloor([row({ number: "1A", floor: null })], {
      multipleAddresses: false,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.floor).toBe(UNKNOWN_FLOOR);
    expect(groups[0]?.addressId).toBe("address-1");
  });

  it("keeps two unknown-floor runs apart with distinct keys", () => {
    // Two non-consecutive unknown runs under one address used to share the key
    // `${addressId}:null`, which React renders as duplicate keys in one table.
    const groups = groupByFloor(
      [
        row({ personId: "a", number: "1A", floor: null }),
        row({ personId: "b", number: "1101", floor: 1 }),
        row({ personId: "c", number: "1B", floor: null }),
      ],
      { multipleAddresses: false },
    );

    expect(groups.map((group) => group.floor)).toEqual([
      UNKNOWN_FLOOR,
      1,
      UNKNOWN_FLOOR,
    ]);
    expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
  });

  it("preserves the order the server sent", () => {
    // The server paginates and orders; re-sorting here would silently disagree
    // with the page boundary it applied.
    const groups = groupByFloor(
      [
        row({ personId: "a", number: "1102", floor: 1 }),
        row({ personId: "b", number: "1101", floor: 1 }),
      ],
      { multipleAddresses: false },
    );

    expect(groups[0]?.rows.map((entry) => entry.personId)).toEqual(["a", "b"]);
  });

  it("returns nothing for an empty page", () => {
    expect(groupByFloor([], { multipleAddresses: false })).toEqual([]);
  });
});
