import { describe, expect, it } from "vitest";

import { type ChargeablePerson, markAmbiguous } from "./charge-parties";

/**
 * Which people an option cannot tell apart.
 *
 * A register can hold two people of one name in one flat - a father and a son -
 * and an option that read the same for both would ask a board to choose between
 * two identical rows. Charging the wrong one is a charge on somebody who owes
 * nothing, so what this decides is not cosmetic.
 */

function person(
  overrides: Partial<ChargeablePerson> & { personId: string },
): ChargeablePerson {
  return {
    name: "Bo Ekwall",
    apartment: "Storgatan 12 1602",
    movedInOn: "2026-01-15",
    ambiguous: false,
    ...overrides,
  };
}

describe("markAmbiguous", () => {
  it("flags both of two people who render the same way", () => {
    const marked = markAmbiguous([
      person({ personId: "elder", movedInOn: "2019-03-01" }),
      person({ personId: "younger" }),
    ]);

    // Both, not just the second: being ambiguous is a fact about a pair.
    expect(marked.map((entry) => entry.ambiguous)).toEqual([true, true]);
  });

  it("leaves one person of a name alone", () => {
    expect(markAmbiguous([person({ personId: "only" })])[0]?.ambiguous).toBe(
      false,
    );
  });

  it("does not flag one name in two different flats", () => {
    // The apartment already tells these two apart, which is what it is on the
    // option for.
    const marked = markAmbiguous([
      person({ personId: "here" }),
      person({ personId: "there", apartment: "Storgatan 14 1001" }),
    ]);

    expect(marked.map((entry) => entry.ambiguous)).toEqual([false, false]);
  });

  it("flags two people the register holds no apartment for", () => {
    // Both render as the bare name, so both are ambiguous - and neither has a
    // move-in date to be told apart by, which the option has to survive.
    const marked = markAmbiguous([
      person({ personId: "one", apartment: null, movedInOn: null }),
      person({ personId: "two", apartment: null, movedInOn: null }),
    ]);

    expect(marked.map((entry) => entry.ambiguous)).toEqual([true, true]);
  });

  it("does not confuse a name that ends where an apartment begins", () => {
    /*
     * The key is built by joining the two, so a separator that could occur in
     * either would let "Bo" in "Ekwall 12" collide with "Bo Ekwall" in "12".
     */
    const marked = markAmbiguous([
      person({ personId: "one", name: "Bo", apartment: "Ekwall1602" }),
      person({ personId: "two", name: "BoEkwall", apartment: "1602" }),
    ]);

    expect(marked.map((entry) => entry.ambiguous)).toEqual([false, false]);
  });
});
