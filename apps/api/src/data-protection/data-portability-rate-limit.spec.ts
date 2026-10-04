import { describe, expect, it } from "vitest";

import {
  BUSY_RETRY_AFTER_SECONDS,
  DataPortabilityRateLimitedError,
  DataPortabilityRateLimiter,
  EXPORTS_PER_PERSON_PER_MINUTE,
  EXPORTS_PER_MINUTE_OVERALL,
  MAX_CONCURRENT_EXPORTS,
} from "./data-portability-rate-limit";

/**
 * The two budgets on the export, the order they are spent in, and the cap on
 * exports prepared at once.
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

/** An export still being prepared, until it is told to finish or to fail. */
function preparing(
  limiter: DataPortabilityRateLimiter,
  personId: string,
  now: number,
) {
  let finish!: () => void;
  let fail!: (cause: Error) => void;
  const gathering = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { done: limiter.run(personId, () => gathering, now), finish, fail };
}

/** Every slot taken, by people other than the ones a test asks for. */
function everySlotTaken(limiter: DataPortabilityRateLimiter, now: number) {
  return Array.from({ length: MAX_CONCURRENT_EXPORTS }, (_, slot) =>
    preparing(limiter, `holder-${String(slot)}`, now),
  );
}

async function finishAll(
  exports: readonly ReturnType<typeof preparing>[],
): Promise<void> {
  for (const running of exports) {
    running.finish();
  }
  await Promise.all(exports.map((running) => running.done));
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

  it("does not charge a person for a request refused as busy", async () => {
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
 * The cap on exports prepared at once.
 *
 * The budgets above bound how often; a budget starts full, so on their own they
 * let a whole minute's exports begin in the same instant and hold that many
 * connections. The cap is what bounds the connections.
 */
describe("exports prepared at once", () => {
  it("refuses an export as busy while every slot is taken, and admits it once one is free", async () => {
    const limiter = new DataPortabilityRateLimiter();
    const running = everySlotTaken(limiter, T0);

    const refusal = await refusalOf(limiter, "anna", T0);

    expect(refusal?.reason).toBe("export-busy");
    expect(refusal?.status).toBe(429);
    expect(refusal?.headers()["retry-after"]).toBe(
      String(BUSY_RETRY_AFTER_SECONDS),
    );

    await finishAll(running);
    expect(await refusalOf(limiter, "anna", T0)).toBeUndefined();
  });

  it("gives the slot back when an export fails", async () => {
    const limiter = new DataPortabilityRateLimiter();
    const [failing, ...others] = everySlotTaken(limiter, T0);
    if (failing === undefined) {
      throw new Error("There is no slot to fail.");
    }

    failing.fail(new Error("Transaction already closed"));

    // The failure reaches the caller as itself, not as a refusal.
    await expect(failing.done).rejects.toThrow("Transaction already closed");
    const anna = preparing(limiter, "anna", T0);
    // One slot came back, not more: anna's took it.
    expect((await refusalOf(limiter, "bo", T0))?.reason).toBe("export-busy");

    await finishAll([...others, anna]);
  });

  it("does not charge a person for a request refused because every slot is taken", async () => {
    const limiter = new DataPortabilityRateLimiter();
    const running = everySlotTaken(limiter, T0);

    // Asked more often than the person's own budget while every slot is taken.
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE * 2; ask += 1) {
      expect((await refusalOf(limiter, "anna", T0))?.reason).toBe(
        "export-busy",
      );
    }
    await finishAll(running);

    // In the same minute, anna still has the whole of her own.
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      expect(await refusalOf(limiter, "anna", T0)).toBeUndefined();
    }
    expect((await refusalOf(limiter, "anna", T0))?.reason).toBe(
      "export-rate-limited",
    );
  });

  it("does not spend the overall budget on a request refused because every slot is taken", async () => {
    const limiter = new DataPortabilityRateLimiter();
    const running = everySlotTaken(limiter, T0);
    for (let person = 0; person < EXPORTS_PER_MINUTE_OVERALL * 3; person += 1) {
      expect(
        (await refusalOf(limiter, `refused-${String(person)}`, T0))?.reason,
      ).toBe("export-busy");
    }
    await finishAll(running);

    // What is left is the overall budget less the exports that held the slots.
    let admitted = 0;
    for (let person = 0; person < EXPORTS_PER_MINUTE_OVERALL; person += 1) {
      if (
        (await refusalOf(limiter, `later-${String(person)}`, T0)) === undefined
      ) {
        admitted += 1;
      }
    }

    expect(admitted).toBe(EXPORTS_PER_MINUTE_OVERALL - MAX_CONCURRENT_EXPORTS);
  });

  it("tells a request the slots turn away to wait for the instance's budget too, when that is longer", async () => {
    const limiter = new DataPortabilityRateLimiter();
    // The budget spent down so that the exports holding the slots take its last
    // tokens.
    for (
      let person = 0;
      person < EXPORTS_PER_MINUTE_OVERALL - MAX_CONCURRENT_EXPORTS;
      person += 1
    ) {
      await limiter.run(`early-${String(person)}`, () => Promise.resolve(), T0);
    }
    const running = everySlotTaken(limiter, T0);

    const refusal = await refusalOf(limiter, "anna", T0);

    // A token comes back every sixty seconds over the budget, not in a second.
    const tokenSeconds = 60 / EXPORTS_PER_MINUTE_OVERALL;
    expect(refusal?.reason).toBe("export-busy");
    expect(refusal?.headers()["retry-after"]).toBe(String(tokenSeconds));

    // And the wait it was told is enough, once the slots are free.
    await finishAll(running);
    expect(
      await refusalOf(limiter, "anna", T0 + (tokenSeconds - 1) * 1000),
    ).toBeDefined();
    expect(
      await refusalOf(limiter, "anna", T0 + tokenSeconds * 1000),
    ).toBeUndefined();
  });
});

/**
 * One export at a time for each person.
 *
 * Without it one account could ask for its whole budget at once and hold every
 * slot, and everybody else would be refused as busy until those exports were
 * done.
 */
describe("a person's own export being prepared", () => {
  it("refuses a second export by the same person as busy, and charges nothing for it", async () => {
    const limiter = new DataPortabilityRateLimiter();
    const first = preparing(limiter, "anna", T0);

    const refusal = await refusalOf(limiter, "anna", T0);

    expect(refusal?.reason).toBe("export-busy");
    expect(refusal?.status).toBe(429);
    expect(refusal?.message).toContain("already being prepared");
    expect(refusal?.headers()["retry-after"]).toBe(
      String(BUSY_RETRY_AFTER_SECONDS),
    );

    // Asked again and again while the first is under way, all refused.
    for (let ask = 0; ask < EXPORTS_PER_PERSON_PER_MINUTE * 2; ask += 1) {
      expect((await refusalOf(limiter, "anna", T0))?.reason).toBe(
        "export-busy",
      );
    }
    await finishAll([first]);

    // In the same minute anna has her budget less the one export she got.
    for (let ask = 1; ask < EXPORTS_PER_PERSON_PER_MINUTE; ask += 1) {
      expect(await refusalOf(limiter, "anna", T0)).toBeUndefined();
    }
    expect((await refusalOf(limiter, "anna", T0))?.reason).toBe(
      "export-rate-limited",
    );
  });

  it("leaves the other slots to everybody else", async () => {
    const limiter = new DataPortabilityRateLimiter();
    const annas = preparing(limiter, "anna", T0);
    expect((await refusalOf(limiter, "anna", T0))?.reason).toBe("export-busy");

    // Every slot but anna's goes to somebody else, and then the instance is full.
    const others = Array.from(
      { length: MAX_CONCURRENT_EXPORTS - 1 },
      (_, slot) => preparing(limiter, `other-${String(slot)}`, T0),
    );
    expect((await refusalOf(limiter, "bo", T0))?.reason).toBe("export-busy");

    await finishAll([annas, ...others]);
  });

  it("lets the person ask again once their export has finished or failed", async () => {
    const limiter = new DataPortabilityRateLimiter();
    const failing = preparing(limiter, "anna", T0);
    failing.fail(new Error("Transaction already closed"));
    await expect(failing.done).rejects.toThrow("Transaction already closed");

    const finishing = preparing(limiter, "anna", T0);
    expect((await refusalOf(limiter, "anna", T0))?.reason).toBe("export-busy");
    await finishAll([finishing]);

    expect(await refusalOf(limiter, "anna", T0)).toBeUndefined();
  });
});
