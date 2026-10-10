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

  it("does not turn a malformed grouping into a different figure", () => {
    // Left as typed, so the server refuses it. Closing the gap would send 1234.
    expect(decimalFromInput("12 34")).toBe("12 34");
    expect(decimalFromInput("1 50")).toBe("1 50");
    expect(decimalFromInput("1 5000")).toBe("1 5000");
    expect(decimalFromInput("1500 000")).toBe("1500 000");
    expect(decimalFromInput("1  500")).toBe("1  500");
    expect(decimalFromInput("1 500,0 0")).toBe("1500.0 0");
  });

  it("still accepts an ungrouped figure and a grouped one with decimals", () => {
    expect(decimalFromInput("1500000")).toBe("1500000");
    expect(decimalFromInput("1 500 000.50")).toBe("1500000.50");
    expect(decimalFromInput("1\u00a0500\u00a0000,50")).toBe("1500000.50");
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
