import { describe, expect, it } from "vitest";

import {
  DataPortabilityRateLimitedError,
  DataPortabilityRateLimiter,
  EXPORTS_PER_PERSON_PER_MINUTE,
  EXPORTS_PER_MINUTE_OVERALL,
} from "./data-portability-rate-limit";

/**
 * The two budgets on the export, and the order they are spent in.
 *
 * The order is the part that can go quietly wrong. If the overall budget were
 * spent first, one person pressing the button in a loop would use up what
 * everybody else exports from, which is the denial of service the limit exists
 * to prevent turned into a way of causing it.
 */

const T0 = 1_000_000;

function refusalOf(
  limiter: DataPortabilityRateLimiter,
  personId: string,
  now: number,
): DataPortabilityRateLimitedError | undefined {
  try {
    limiter.take(personId, now);
  } catch (cause) {
    if (cause instanceof DataPortabilityRateLimitedError) {
      return cause;
    }
    throw cause;
  }
  return undefined;
}

describe("the export budget", () => {
  it("lets a person ask up to their budget and refuses the next", () => {
    const limiter = new DataPortabilityRateLimiter();
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      expect(refusalOf(limiter, "anna", T0)).toBeUndefined();
    }

    const refusal = refusalOf(limiter, "anna", T0);

    expect(refusal?.reason).toBe("export-rate-limited");
    expect(refusal?.status).toBe(429);
    expect(Number(refusal?.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("gives the budget back as time passes", () => {
    const limiter = new DataPortabilityRateLimiter();
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      limiter.take("anna", T0);
    }

    expect(refusalOf(limiter, "anna", T0)).toBeDefined();
    expect(refusalOf(limiter, "anna", T0 + 60_000)).toBeUndefined();
  });

  it("keeps one person's spending from another's", () => {
    const limiter = new DataPortabilityRateLimiter();
    for (let ask = 0; ask <= EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      refusalOf(limiter, "anna", T0);
    }

    expect(refusalOf(limiter, "bo", T0)).toBeUndefined();
  });

  it("bounds the instance as a whole, and says it is busy rather than blaming the person", () => {
    const limiter = new DataPortabilityRateLimiter();
    for (let person = 0; person < EXPORTS_PER_MINUTE_OVERALL; person += 1) {
      expect(
        refusalOf(limiter, `person-${String(person)}`, T0),
      ).toBeUndefined();
    }

    const refusal = refusalOf(limiter, "latecomer", T0);

    expect(refusal?.reason).toBe("export-busy");
    expect(refusal?.status).toBe(429);
  });

  it("does not let a person who is refused spend the overall budget", () => {
    const limiter = new DataPortabilityRateLimiter();
    // Far more asks than the person's budget, all refused after the first few.
    for (let ask = 0; ask < EXPORTS_PER_MINUTE_OVERALL * 3; ask += 1) {
      refusalOf(limiter, "anna", T0);
    }

    // What is left is the overall budget less what anna was actually let
    // through with, so everybody else still has the rest of it.
    let admitted = 0;
    for (let person = 0; person < EXPORTS_PER_MINUTE_OVERALL; person += 1) {
      if (refusalOf(limiter, `person-${String(person)}`, T0) === undefined) {
        admitted += 1;
      }
    }

    expect(admitted).toBe(
      EXPORTS_PER_MINUTE_OVERALL - EXPORTS_PER_PERSON_PER_MINUTE,
    );
  });

  it("does not charge a person for a request refused as busy", () => {
    const limiter = new DataPortabilityRateLimiter();
    for (let person = 0; person < EXPORTS_PER_MINUTE_OVERALL; person += 1) {
      limiter.take(`person-${String(person)}`, T0);
    }

    // Asked more often than the person's own budget while the instance is busy.
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE * 2; ask += 1) {
      expect(refusalOf(limiter, "anna", T0)?.reason).toBe("export-busy");
    }

    // Once the instance has room again anna still has the whole of her own.
    const later = T0 + 60_000;
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      expect(refusalOf(limiter, "anna", later)).toBeUndefined();
    }
    expect(refusalOf(limiter, "anna", later)?.reason).toBe(
      "export-rate-limited",
    );
  });
});
