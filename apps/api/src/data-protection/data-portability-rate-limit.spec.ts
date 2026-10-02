import { describe, expect, it } from "vitest";

import {
  BUSY_RETRY_AFTER_SECONDS,
  ExportsBusyError,
} from "../retention/export-slots";
import {
  DataPortabilityRateLimitedError,
  DataPortabilityRateLimiter,
  EXPORTS_PER_PERSON_PER_MINUTE,
  EXPORTS_PER_MINUTE_OVERALL,
} from "./data-portability-rate-limit";

/**
 * The two budgets on the export, the order they are spent in, and what an
 * export the report service turns away as busy is charged.
 *
 * The order is the part that can go quietly wrong. If the overall budget were
 * spent first, one person pressing the button in a loop would use up what
 * everybody else exports from, which is the denial of service the limit exists
 * to prevent turned into a way of causing it.
 */

const T0 = 1_000_000;

/** Asks for an export that is prepared at once, and returns the refusal if any. */
async function refusalOf(
  limiter: DataPortabilityRateLimiter,
  personId: string,
  now: number,
): Promise<DataPortabilityRateLimitedError | undefined> {
  try {
    await limiter.run(personId, () => Promise.resolve(), now);
  } catch (cause) {
    if (cause instanceof DataPortabilityRateLimitedError) {
      return cause;
    }
    throw cause;
  }
  return undefined;
}

describe("the export budget", () => {
  it("lets a person ask up to their budget and refuses the next", async () => {
    const limiter = new DataPortabilityRateLimiter();
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      expect(await refusalOf(limiter, "anna", T0)).toBeUndefined();
    }

    const refusal = await refusalOf(limiter, "anna", T0);

    expect(refusal?.reason).toBe("export-rate-limited");
    expect(refusal?.status).toBe(429);
    expect(Number(refusal?.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("gives the budget back as time passes", async () => {
    const limiter = new DataPortabilityRateLimiter();
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      await limiter.run("anna", () => Promise.resolve(), T0);
    }

    expect(await refusalOf(limiter, "anna", T0)).toBeDefined();
    expect(await refusalOf(limiter, "anna", T0 + 60_000)).toBeUndefined();
  });

  it("keeps one person's spending from another's", async () => {
    const limiter = new DataPortabilityRateLimiter();
    for (let ask = 0; ask <= EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      await refusalOf(limiter, "anna", T0);
    }

    expect(await refusalOf(limiter, "bo", T0)).toBeUndefined();
  });

  it("bounds the instance as a whole, and says it is busy rather than blaming the person", async () => {
    const limiter = new DataPortabilityRateLimiter();
    for (let person = 0; person < EXPORTS_PER_MINUTE_OVERALL; person += 1) {
      expect(
        await refusalOf(limiter, `person-${String(person)}`, T0),
      ).toBeUndefined();
    }

    const refusal = await refusalOf(limiter, "latecomer", T0);

    expect(refusal?.reason).toBe("export-busy");
    expect(refusal?.status).toBe(429);
  });

  it("does not let a person who is refused spend the overall budget", async () => {
    const limiter = new DataPortabilityRateLimiter();
    // Far more asks than the person's budget, all refused after the first few.
    for (let ask = 0; ask < EXPORTS_PER_MINUTE_OVERALL * 3; ask += 1) {
      await refusalOf(limiter, "anna", T0);
    }

    // What is left is the overall budget less what anna was actually let
    // through with, so everybody else still has the rest of it.
    let admitted = 0;
    for (let person = 0; person < EXPORTS_PER_MINUTE_OVERALL; person += 1) {
      if (
        (await refusalOf(limiter, `person-${String(person)}`, T0)) === undefined
      ) {
        admitted += 1;
      }
    }

    expect(admitted).toBe(
      EXPORTS_PER_MINUTE_OVERALL - EXPORTS_PER_PERSON_PER_MINUTE,
    );
  });

  it("does not charge a person for a request refused because the instance's budget is spent", async () => {
    const limiter = new DataPortabilityRateLimiter();
    for (let person = 0; person < EXPORTS_PER_MINUTE_OVERALL; person += 1) {
      await limiter.run(
        `person-${String(person)}`,
        () => Promise.resolve(),
        T0,
      );
    }

    // Asked more often than the person's own budget while the instance is busy.
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE * 2; ask += 1) {
      expect((await refusalOf(limiter, "anna", T0))?.reason).toBe(
        "export-busy",
      );
    }

    // Once the instance has room again anna still has the whole of her own.
    const later = T0 + 60_000;
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      expect(await refusalOf(limiter, "anna", later)).toBeUndefined();
    }
    expect((await refusalOf(limiter, "anna", later))?.reason).toBe(
      "export-rate-limited",
    );
  });
});

/**
 * An export the report service turns away because every slot it gathers in is
 * taken - by other members' exports or by the board's access reports.
 *
 * The slots themselves are the service's and are tested beside it. What is
 * tested here is that a person is not charged for the instance being busy.
 */
describe("an export turned away as busy by the report service", () => {
  const busy = () => Promise.reject(new ExportsBusyError());

  async function refusedAsBusy(
    limiter: DataPortabilityRateLimiter,
    personId: string,
    now: number,
  ): Promise<void> {
    await expect(limiter.run(personId, busy, now)).rejects.toBeInstanceOf(
      ExportsBusyError,
    );
  }

  it("reaches the caller as itself, with its reason and its delay", async () => {
    const limiter = new DataPortabilityRateLimiter();

    const refusal = await limiter
      .run("anna", busy, T0)
      .catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(ExportsBusyError);
    expect((refusal as ExportsBusyError).reason).toBe("export-busy");
    expect((refusal as ExportsBusyError).headers()["retry-after"]).toBe(
      String(BUSY_RETRY_AFTER_SECONDS),
    );
  });

  it("does not charge the person", async () => {
    const limiter = new DataPortabilityRateLimiter();

    // Asked more often than the person's own budget while every slot is taken.
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE * 2; ask += 1) {
      await refusedAsBusy(limiter, "anna", T0);
    }

    // In the same minute, anna still has the whole of her own.
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      expect(await refusalOf(limiter, "anna", T0)).toBeUndefined();
    }
    expect((await refusalOf(limiter, "anna", T0))?.reason).toBe(
      "export-rate-limited",
    );
  });

  it("does not spend the overall budget", async () => {
    const limiter = new DataPortabilityRateLimiter();
    for (let person = 0; person < EXPORTS_PER_MINUTE_OVERALL * 3; person += 1) {
      await refusedAsBusy(limiter, `refused-${String(person)}`, T0);
    }

    let admitted = 0;
    for (let person = 0; person < EXPORTS_PER_MINUTE_OVERALL; person += 1) {
      if (
        (await refusalOf(limiter, `later-${String(person)}`, T0)) === undefined
      ) {
        admitted += 1;
      }
    }

    expect(admitted).toBe(EXPORTS_PER_MINUTE_OVERALL);
  });

  it("keeps the charge for an export that failed for any other reason", async () => {
    // It was gathered, or begun: the transaction ran and held a connection.
    const limiter = new DataPortabilityRateLimiter();
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      await expect(
        limiter.run(
          "anna",
          () => Promise.reject(new Error("Transaction already closed")),
          T0,
        ),
      ).rejects.toThrow("Transaction already closed");
    }

    expect((await refusalOf(limiter, "anna", T0))?.reason).toBe(
      "export-rate-limited",
    );
  });
});
