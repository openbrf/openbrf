import { describe, expect, it } from "vitest";

import {
  isValidPersonalIdentityNumber,
  normalizePersonalIdentityNumber,
} from "../personal-identity-number.ts";
import { testPersonalIdentityNumber } from "./personal-identity-number.ts";

// The first and last draw of the range, one on each boundary of every field,
// and the largest a 32-bit hash or a safe integer can hand over.
const DRAWS = [
  0,
  39,
  40,
  479,
  480,
  13_439,
  13_440,
  13_439_999,
  13_440_000,
  99_999_999,
  0xff_ff_ff_ff,
  Number.MAX_SAFE_INTEGER,
];

describe("testPersonalIdentityNumber", () => {
  it("passes the checksum the register validates with", () => {
    for (const draw of DRAWS) {
      expect(
        isValidPersonalIdentityNumber(testPersonalIdentityNumber(draw)),
      ).toBe(true);
    }
  });

  it("stores and indexes as the same string", () => {
    for (const draw of DRAWS) {
      const number = testPersonalIdentityNumber(draw);
      expect(normalizePersonalIdentityNumber(number)).toBe(number);
    }
  });

  it("stays inside the reserved years, real days and issued birth numbers", () => {
    // The range is what keeps a generated number away from every literal in
    // the repository, so it is asserted rather than left to the comment.
    for (const draw of DRAWS) {
      const number = testPersonalIdentityNumber(draw);
      const year = Number(number.slice(0, 4));
      const month = Number(number.slice(4, 6));
      const day = Number(number.slice(6, 8));
      const birthNumber = Number(number.slice(8, 11));
      expect(year).toBeGreaterThanOrEqual(1940);
      expect(year).toBeLessThanOrEqual(1979);
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(28);
      expect(birthNumber).toBeGreaterThanOrEqual(1);
      expect(birthNumber).toBeLessThanOrEqual(999);
    }
  });

  it("spends the draw from the year up", () => {
    expect(testPersonalIdentityNumber(0).slice(0, 11)).toBe("19400101001");
    expect(testPersonalIdentityNumber(1).slice(0, 11)).toBe("19410101001");
    expect(testPersonalIdentityNumber(40).slice(0, 11)).toBe("19400201001");
    expect(testPersonalIdentityNumber(480).slice(0, 11)).toBe("19400102001");
    expect(testPersonalIdentityNumber(13_440).slice(0, 11)).toBe("19400101002");
  });

  it("refuses a draw it cannot spend", () => {
    for (const draw of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => testPersonalIdentityNumber(draw)).toThrow(RangeError);
    }
  });
});
