import { describe, expect, it } from "vitest";

import { formatAmount } from "./money";

/**
 * The money formatter.
 *
 * What is asserted is the property the whole file exists for: the figure that
 * comes out states exactly the ore that went in, at any size, because nothing
 * about it passed through a double. The grouping and the separators are the
 * platform's and are asserted against the locale rather than against a written
 * table.
 */

/** The separator this environment's Swedish locale groups with. */
function swedishGroupSeparator(): string {
  return (
    new Intl.NumberFormat("sv-SE")
      .formatToParts(1000)
      .find((part) => part.type === "group")?.value ?? " "
  );
}

describe("formatAmount", () => {
  it("states two decimals in Swedish", () => {
    expect(formatAmount("3450.50", "sv-SE")).toBe(
      "3" + swedishGroupSeparator() + "450,50",
    );
  });

  it("states two decimals in English", () => {
    expect(formatAmount("3450.50", "en-GB")).toBe("3,450.50");
  });

  it("pads a whole sum to ore", () => {
    // A DECIMAL(14, 2) holding 450 renders as "450" through toString, and this
    // is a document a member checks against their bank statement.
    expect(formatAmount("450", "sv-SE")).toBe("450,00");
    expect(formatAmount("450.5", "sv-SE")).toBe("450,50");
  });

  it("keeps every ore of a sum larger than a double can hold exactly", () => {
    /*
     * The reason the whole part goes through BigInt. A double loses precision
     * above 2^53, and DECIMAL(14, 2) reaches twelve whole digits - so a
     * formatter that parsed the string would render a figure nobody stated.
     */
    const grouped = formatAmount("999999999999.99", "sv-SE");
    expect(grouped.replaceAll(/\D/gu, "")).toBe("99999999999999");
    expect(grouped.endsWith(",99")).toBe(true);
  });

  it("carries no unit of its own", () => {
    // "kr" is a word and words live in the locale files, so the caller puts
    // this figure into a key that carries the unit.
    expect(formatAmount("450.00", "sv-SE")).not.toContain("kr");
  });

  it("returns anything that is not a sum unchanged", () => {
    /*
     * A display helper. The server is where a malformed amount is refused, and
     * a figure printed raw is more use to whoever has to report it than a blank
     * cell or a thrown error on a screen somebody is working in.
     */
    expect(formatAmount("", "sv-SE")).toBe("");
    expect(formatAmount("-450.00", "sv-SE")).toBe("-450.00");
    expect(formatAmount("450,00", "sv-SE")).toBe("450,00");
    expect(formatAmount("450.005", "sv-SE")).toBe("450.005");
  });

  it("is zero for zero", () => {
    expect(formatAmount("0.00", "sv-SE")).toBe("0,00");
  });
});
