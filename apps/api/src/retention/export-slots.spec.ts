import { describe, expect, it, vi } from "vitest";

import {
  BUSY_RETRY_AFTER_SECONDS,
  ExportSlots,
  ExportsBusyError,
  MAX_CONCURRENT_EXPORTS,
} from "./export-slots";

/**
 * The cap on reports gathered at once.
 *
 * The rate budgets on the member's export bound how often; a budget starts
 * full, so on its own it lets a whole minute's exports begin in the same
 * instant, and the board's access report has no budget at all. The slots are
 * what bound the connections the two hold.
 */

/** A report still being gathered, until it is told to finish or to fail. */
function gathering(slots: ExportSlots) {
  let finish!: () => void;
  let fail!: (cause: Error) => void;
  const report = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { done: slots.run(() => report), finish, fail };
}

function everySlotTaken(slots: ExportSlots) {
  return Array.from({ length: MAX_CONCURRENT_EXPORTS }, () => gathering(slots));
}

async function finishAll(
  reports: readonly ReturnType<typeof gathering>[],
): Promise<void> {
  for (const report of reports) {
    report.finish();
  }
  await Promise.all(reports.map((report) => report.done));
}

async function refusalOf(
  slots: ExportSlots,
): Promise<ExportsBusyError | undefined> {
  try {
    await slots.run(() => Promise.resolve());
  } catch (cause) {
    if (cause instanceof ExportsBusyError) {
      return cause;
    }
    throw cause;
  }
  return undefined;
}

describe("reports gathered at once", () => {
  it("refuses a report as busy while every slot is taken, and admits it once one is free", async () => {
    const slots = new ExportSlots();
    const running = everySlotTaken(slots);

    const refusal = await refusalOf(slots);

    expect(refusal?.reason).toBe("export-busy");
    expect(refusal?.status).toBe(429);
    expect(refusal?.headers()["retry-after"]).toBe(
      String(BUSY_RETRY_AFTER_SECONDS),
    );

    await finishAll(running);
    expect(await refusalOf(slots)).toBeUndefined();
  });

  it("does not start gathering a report it refuses", async () => {
    const slots = new ExportSlots();
    const running = everySlotTaken(slots);
    const gather = vi.fn(() => Promise.resolve());

    await expect(slots.run(gather)).rejects.toBeInstanceOf(ExportsBusyError);

    expect(gather).not.toHaveBeenCalled();
    await finishAll(running);
  });

  it("gives the slot back when a report fails", async () => {
    const slots = new ExportSlots();
    const [failing, ...others] = everySlotTaken(slots);
    if (failing === undefined) {
      throw new Error("There is no slot to fail.");
    }

    failing.fail(new Error("Transaction already closed"));

    // The failure reaches the caller as itself, not as a refusal.
    await expect(failing.done).rejects.toThrow("Transaction already closed");
    const another = gathering(slots);
    // One slot came back, not more: the report just started took it.
    expect((await refusalOf(slots))?.reason).toBe("export-busy");

    await finishAll([...others, another]);
  });
});
