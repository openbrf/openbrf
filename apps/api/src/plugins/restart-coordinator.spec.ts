import { describe, expect, it } from "vitest";

import { drain } from "./restart-coordinator.service";

/**
 * The drain before the process is replaced.
 *
 * Installing a plugin ends by exiting so a supervisor starts a fresh process
 * with the new code loaded. `close()` waits for in-flight HTTP first, which is
 * what keeps a request from being cut off mid-answer - but it has no bound of
 * its own, and a keep-alive or a slow connection can hold it open indefinitely.
 *
 * A hang is not a rejection, so it is not something a try/catch reaches: the
 * exit would simply never run. The board would be left watching a restart
 * notice with no end state, the replacement process would never start, and the
 * plugin it just installed would never load - the exact failure the restart
 * contract exists to prevent. So the deadline has to win, and the caller has to
 * exit either way.
 */

describe("drain", () => {
  it("reports a clean close", async () => {
    const outcome = await drain({ close: async () => undefined }, 50);

    expect(outcome).toEqual({ kind: "closed" });
  });

  it("gives up on a close that never settles", async () => {
    // The decisive case. Without a deadline this call never returns, and the
    // install silently never takes effect.
    const outcome = await drain(
      { close: () => new Promise<void>(() => undefined) },
      20,
    );

    expect(outcome).toEqual({ kind: "timed-out" });
  });

  it("reports a rejected close rather than propagating it", async () => {
    // The install is already on the volume at this point, so a shutdown that
    // failed is something to log and exit past, not to unwind.
    const outcome = await drain(
      {
        close: async () => {
          throw new TypeError("socket already gone");
        },
      },
      50,
    );

    expect(outcome).toEqual({ kind: "failed", detail: "TypeError" });
  });

  /**
   * Closing runs every module's shutdown hook, and a loaded plugin's is one of
   * them - so what a rejection says here is text the plugin composed, out of
   * whatever it had in hand. The caller writes this to the log, which is
   * outside the masking and audit rules that cover a resident's details
   * everywhere else.
   */
  it("does not carry what the close said into what the caller logs", async () => {
    const revealing = "flush failed for anna.andersson@exempel.se";

    const outcome = await drain(
      {
        close: async () => {
          throw new Error(revealing);
        },
      },
      50,
    );

    expect(JSON.stringify(outcome)).not.toContain("anna.andersson");
    expect(outcome).toEqual({ kind: "failed", detail: "Error" });
  });

  it("treats a missing application as already closed", async () => {
    expect(await drain(null, 50)).toEqual({ kind: "closed" });
  });

  it("returns as soon as the close settles rather than waiting out the deadline", async () => {
    const started = Date.now();

    await drain({ close: async () => undefined }, 5_000);

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
