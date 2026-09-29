import { describe, expect, it } from "vitest";

import { decimalFromInput } from "./decimal-input";
import { formatAmount } from "./money";

describe("decimalFromInput", () => {
  it("reads a comma as the decimal separator", () => {
    expect(decimalFromInput("150000,50")).toBe("150000.50");
  });

  it("takes out the spaces a grouped figure carries", () => {
    expect(decimalFromInput(" 1 500 000,00 ")).toBe("1500000.00");
    expect(decimalFromInput("1 500 000,00")).toBe("1500000.00");
    expect(decimalFromInput("1 500,00")).toBe("1500.00");
  });

  it("reads back what the formatter prints in Swedish", () => {
    expect(decimalFromInput(formatAmount("1500000.50", "sv-SE"))).toBe(
      "1500000.50",
    );
  });

  it("leaves a figure already in the API's form as it is", () => {
    expect(decimalFromInput("0.0125")).toBe("0.0125");
    expect(decimalFromInput("")).toBe("");
  });
});
