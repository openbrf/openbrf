import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ChargeablePerson,
  loadChargeParties,
  markAmbiguous,
} from "./charge-parties";

const fetchBoardRegister = vi.fn();
const fetchAddresses = vi.fn();
const fetchApartments = vi.fn();

vi.mock("../register/register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../register/register-api")>()),
  fetchBoardRegister: (query: unknown, signal: AbortSignal) =>
    fetchBoardRegister(query, signal),
}));

vi.mock("../api/instance", () => ({
  fetchAddresses: () => fetchAddresses(),
  fetchApartments: (addressId: string) => fetchApartments(addressId),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fetchAddresses.mockResolvedValue({ ok: true, value: [] });
  fetchApartments.mockResolvedValue({ ok: true, value: [] });
});

/**
 * Which people an option cannot tell apart.
 *
 * A register can hold two people of one name in one flat - a father and a son -
 * and an option that read the same for both would ask a board to choose between
 * two identical rows. Charging the wrong one puts a sum on a member it was not
 * for, so what this decides is not cosmetic.
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

describe("loadChargeParties", () => {
  it("fails rather than offering a register that did not fit", async () => {
    /*
     * The page bound is a guard against an endpoint that keeps answering, not a
     * ceiling on the association. Reaching it with rows still outstanding used
     * to answer the pages that had arrived, and the people left out are people
     * the form then cannot charge - with nothing on the screen saying which.
     */
    let page = 0;
    fetchBoardRegister.mockImplementation(() => {
      page += 1;
      return Promise.resolve({
        rows: [
          {
            personId: `person-${String(page)}`,
            name: `Bo Ekwall ${String(page)}`,
            apartment: null,
            movedInOn: null,
          },
        ],
        addresses: [],
        total: 5000,
      });
    });

    await expect(
      loadChargeParties(new AbortController().signal),
    ).rejects.toThrow();
  });

  it("does not walk the address list once the load is abandoned", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchBoardRegister.mockResolvedValue({
      rows: [],
      addresses: [],
      total: 0,
    });

    await expect(loadChargeParties(controller.signal)).rejects.toThrow();
    expect(fetchAddresses).not.toHaveBeenCalled();
  });
});
