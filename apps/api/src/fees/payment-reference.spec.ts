import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_NOTICES_PER_RUN,
  paymentReferenceFor,
  paymentReferenceIsWellFormed,
} from "./payment-reference";

/**
 * The payment reference rule, asserted as the contract document states it.
 *
 * The check digit is worked by hand in the first case rather than compared
 * against a second implementation of the same arithmetic, because an assertion
 * computed the way the code computes proves only that the code is consistent
 * with itself.
 */

describe("paymentReferenceFor", () => {
  it("is the period, the position and a check digit", () => {
    /*
     * Payload 26010007. Doubling from the right, the digits nearest the check
     * digit first: 7 doubles to 14 and contributes 1 + 4 = 5; 0 stays 0; 0
     * doubles to 0; 0 stays 0; 1 doubles to 2; 0 stays 0; 6 doubles to 12 and
     * contributes 3; 2 stays 2. Total 5 + 2 + 3 + 2 = 12, so the check digit is
     * 8, the amount that brings 12 to 20.
     */
    expect(paymentReferenceFor("2026-01-01", 7)).toBe("260100078");
  });

  it("agrees with its own check", () => {
    expect(
      paymentReferenceIsWellFormed(paymentReferenceFor("2026-01-01", 7)),
    ).toBe(true);
  });

  it("gives every notice in a run its own number", () => {
    const references = new Set(
      Array.from({ length: 200 }, (_ignored, index) =>
        paymentReferenceFor("2026-04-01", index + 1),
      ),
    );
    expect(references.size).toBe(200);
  });

  it("separates two runs by the month their period opens in", () => {
    expect(paymentReferenceFor("2026-01-01", 1)).not.toBe(
      paymentReferenceFor("2026-02-01", 1),
    );
    // A period may be issued once and two may not overlap, so no two runs open
    // in the same month - which is what makes the month enough here.
    expect(paymentReferenceFor("2026-01-01", 1).slice(0, 4)).toBe("2601");
    expect(paymentReferenceFor("2027-01-01", 1).slice(0, 4)).toBe("2701");
  });

  it("catches every single mistyped digit", () => {
    const reference = paymentReferenceFor("2026-09-01", 42);

    for (let index = 0; index < reference.length; index++) {
      for (let digit = 0; digit <= 9; digit++) {
        const replacement = String(digit);
        if (replacement === reference[index]) {
          continue;
        }
        const mistyped = `${reference.slice(0, index)}${replacement}${reference.slice(
          index + 1,
        )}`;
        expect(paymentReferenceIsWellFormed(mistyped)).toBe(false);
      }
    }
  });

  it("catches an adjacent transposition, except a 0 swapped with a 9", () => {
    /*
     * The known gap in modulus 10 rather than a fault in this use of it: the
     * doubling makes 0 and 9 contribute the same amount whichever position they
     * fall in, so swapping them is invisible. Stated here so the limitation is
     * a documented property of the format and not a surprise on the telephone.
     */
    const reference = paymentReferenceFor("2026-11-01", 1234);

    for (let index = 0; index + 1 < reference.length; index++) {
      const first = reference[index] ?? "";
      const second = reference[index + 1] ?? "";
      if (first === second) {
        continue;
      }
      const transposed = `${reference.slice(0, index)}${second}${first}${reference.slice(
        index + 2,
      )}`;
      const blindSpot =
        new Set([first, second]).size === 2 &&
        ((first === "0" && second === "9") ||
          (first === "9" && second === "0"));
      expect(paymentReferenceIsWellFormed(transposed)).toBe(blindSpot);
    }
  });

  it("refuses a run larger than the format can carry", () => {
    // Refused rather than wrapped: a position quietly wrapped to four digits
    // would produce a reference the database has already given to another
    // notice, and the collision would surface with no reason attached.
    expect(() =>
      paymentReferenceFor("2026-01-01", MAX_NOTICES_PER_RUN),
    ).not.toThrow();
    expect(() =>
      paymentReferenceFor("2026-01-01", MAX_NOTICES_PER_RUN + 1),
    ).toThrow(RangeError);
  });

  it("refuses a position that is not a place in a run", () => {
    expect(() => paymentReferenceFor("2026-01-01", 0)).toThrow(RangeError);
    expect(() => paymentReferenceFor("2026-01-01", -1)).toThrow(RangeError);
    expect(() => paymentReferenceFor("2026-01-01", 1.5)).toThrow(RangeError);
  });

  it("refuses a period that is not a calendar date", () => {
    expect(() => paymentReferenceFor("2026-01", 1)).toThrow(RangeError);
    expect(() => paymentReferenceFor("den 1 januari", 1)).toThrow(RangeError);
  });
});

describe("paymentReferenceIsWellFormed", () => {
  it("refuses anything that is not digits", () => {
    expect(paymentReferenceIsWellFormed("")).toBe(false);
    expect(paymentReferenceIsWellFormed("2")).toBe(false);
    expect(paymentReferenceIsWellFormed("26010007 8")).toBe(false);
    expect(paymentReferenceIsWellFormed("26-0100078")).toBe(false);
  });
});

describe("the contract document", () => {
  /*
   * `docs/fee-notice-contract.md` is what an association checks its bank's OCR
   * specification against, and what another implementation of this rule would
   * be written from. Read from the repository root through the working
   * directory, because the package compiles to CommonJS, where import.meta is
   * not available - the runner starts in the package, as the other specs that
   * read repository files rely on.
   */
  const contract = readFileSync(
    join(process.cwd(), "..", "..", "docs", "fee-notice-contract.md"),
    "utf8",
  );

  it("states a worked example the code agrees with", () => {
    // Read out of the document rather than restated here, so the example a
    // reader checks by hand and the rule the code computes by cannot drift.
    const example = /payload `(\d{8})` gives check digit `(\d)`/u.exec(
      contract,
    );
    const payload = example?.[1];
    const digit = example?.[2];
    expect(payload).toBeDefined();
    expect(digit).toBeDefined();
    expect(paymentReferenceIsWellFormed(`${payload ?? ""}${digit ?? ""}`)).toBe(
      true,
    );

    // And the reference the document spells out in full is the one the code
    // issues for that period and position.
    expect(contract).toContain(`\`${paymentReferenceFor("2026-01-01", 7)}\``);
  });

  it("says which digit the doubling starts from", () => {
    /*
     * "Every second digit from the right" reads as the second, fourth and sixth
     * from the right, which on this payload gives 2 and not 8 - a different
     * reference from the one the code issues. The document names the rightmost
     * digit as the first one doubled, which is what the code does.
     */
    // Whitespace folded, so rewrapping the paragraph cannot fail the check.
    const prose = contract.replace(/\s+/gu, " ");
    expect(prose).not.toMatch(/every second digit from the right/iu);
    expect(prose).toContain(
      "Starting with the rightmost digit of the payload and moving left, every other digit is doubled",
    );
  });
});
