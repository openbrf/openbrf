import { describe, expect, it } from "vitest";

import { suggestMonthlyAmounts } from "./participation-share";

/**
 * The fee screen's aid.
 *
 * Three properties matter. The arithmetic is exact to the ore, because the
 * figures are the board's own and a suggestion that was nearly right would be
 * retyped rather than accepted. What the division cannot place is stated rather
 * than distributed onto somebody's fee. And an apartment with no participation
 * share recorded gets no suggestion at all, because the aid has nothing to say
 * about it and a zero would read as a decision.
 */

const APARTMENTS = [
  { apartmentId: "a", participationShare: "0.25000000" },
  { apartmentId: "b", participationShare: "0.25000000" },
  { apartmentId: "c", participationShare: "0.50000000" },
];

describe("suggestMonthlyAmounts", () => {
  it("apportions a yearly total across the shares, per month", () => {
    const result = suggestMonthlyAmounts("1200000.00", APARTMENTS);

    expect(result?.suggestions).toEqual([
      { apartmentId: "a", monthlyAmount: "25000.00" },
      { apartmentId: "b", monthlyAmount: "25000.00" },
      { apartmentId: "c", monthlyAmount: "50000.00" },
    ]);
    expect(result?.unallocated).toBe("0.00");
  });

  it("states what the division could not place rather than rounding it away", () => {
    /*
     * A hundred kronor across three equal thirds does not divide into ore. The
     * aid truncates and says what is left, because this product refuses a
     * malformed amount rather than rounding one and an aid that quietly rounded
     * would teach the opposite.
     */
    const result = suggestMonthlyAmounts("100.00", [
      { apartmentId: "a", participationShare: "0.33333333" },
      { apartmentId: "b", participationShare: "0.33333333" },
      { apartmentId: "c", participationShare: "0.33333334" },
    ]);

    // A third of a hundred kronor is 33.33 a year, which is 2.7775 a month.
    for (const suggestion of result?.suggestions ?? []) {
      expect(suggestion.monthlyAmount).toBe("2.77");
    }
    // Twelve months at 2.77 is 33.24 per apartment, 99.72 over three.
    expect(result?.unallocated).toBe("0.28");
  });

  it("reads shares recorded as percentages or whole numbers as parts of their sum", () => {
    /*
     * The stadgar decide how the andelstal is written. An association that
     * records 25 for a quarter, or 2 500 out of 10 000, is apportioning the
     * same total as one that records 0.25, and must be offered the same
     * figures rather than a hundred or ten thousand times them.
     */
    for (const [a, b, c] of [
      ["25", "25", "50"],
      ["2500", "2500", "5000"],
    ] as const) {
      const result = suggestMonthlyAmounts("1200000.00", [
        { apartmentId: "a", participationShare: a },
        { apartmentId: "b", participationShare: b },
        { apartmentId: "c", participationShare: c },
      ]);

      expect(result?.suggestions).toEqual([
        { apartmentId: "a", monthlyAmount: "25000.00" },
        { apartmentId: "b", monthlyAmount: "25000.00" },
        { apartmentId: "c", monthlyAmount: "50000.00" },
      ]);
      expect(result?.unallocated).toBe("0.00");
    }
  });

  it("reads a total typed the Swedish way", () => {
    // How the screen prints a sum, and what a Swedish phone's keypad offers.
    const result = suggestMonthlyAmounts("1 200 000,00", APARTMENTS);

    expect(result?.suggestions[0]?.monthlyAmount).toBe("25000.00");
  });

  it("offers nothing for an apartment with no share recorded", () => {
    const result = suggestMonthlyAmounts("1200000.00", [
      ...APARTMENTS,
      { apartmentId: "d", participationShare: null },
    ]);

    expect(
      result?.suggestions.find((suggestion) => suggestion.apartmentId === "d"),
    ).toEqual({ apartmentId: "d", monthlyAmount: null });
  });

  it("offers nothing for a share of zero", () => {
    // Recorded as zero is not the same as apportioning zero: an apartment the
    // stadgar give no share is one this aid cannot speak for either.
    const result = suggestMonthlyAmounts("1200.00", [
      { apartmentId: "a", participationShare: "0.00000000" },
    ]);

    expect(result?.suggestions[0]?.monthlyAmount).toBeNull();
    expect(result?.unallocated).toBe("1200.00");
  });

  it("counts an apartment with no share into what is unallocated", () => {
    const result = suggestMonthlyAmounts("1200.00", [
      { apartmentId: "a", participationShare: "0.50000000" },
      { apartmentId: "b", participationShare: null },
    ]);

    expect(result?.suggestions[0]?.monthlyAmount).toBe("50.00");
    expect(result?.unallocated).toBe("600.00");
  });

  it("is exact for a total larger than a double can hold", () => {
    // The reason the arithmetic is in BigInt. A double loses ore above 2^53.
    const result = suggestMonthlyAmounts("999999999999.99", [
      { apartmentId: "a", participationShare: "1.00000000" },
    ]);

    expect(result?.suggestions[0]?.monthlyAmount).toBe("83333333333.33");
    expect(result?.unallocated).toBe("0.03");
  });

  it("answers with nothing at all when the total is not a sum", () => {
    // The screen then keeps what the board typed and offers no figures rather
    // than offering wrong ones.
    for (const total of ["", "inte en summa", "-1200.00", "1200,005"]) {
      expect(suggestMonthlyAmounts(total, APARTMENTS)).toBeNull();
    }
  });

  it("divides by the share before the months, not after", () => {
    /*
     * Dividing by twelve first would throw away up to eleven ore of every
     * apartment's year before the share was applied. One apartment holding the
     * whole association shows it: a total of 11 ore is a whole year's money and
     * none of it survives a monthly figure, but what is unplaced has to be the
     * 11 ore and not a figure some other order of operations produced.
     */
    const result = suggestMonthlyAmounts("0.11", [
      { apartmentId: "a", participationShare: "1.00000000" },
    ]);

    expect(result?.suggestions[0]?.monthlyAmount).toBe("0.00");
    expect(result?.unallocated).toBe("0.11");
  });
});
