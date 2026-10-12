import { describe, expect, it } from "vitest";

import { erasureSourceFacts } from "../testing/erasure-source-facts";

/**
 * Every nightly job wakes at a minute of its own.
 *
 * Each purge says its minutes are spread across the band so that jobs waking
 * together on one small connection pool do not contend. That is a property of
 * the whole set rather than of any one file, so it is asserted here over every
 * schedule the source registers, found by the same walk the erasure order uses.
 */
// Walked once, at load, as `erasure-request-order.spec.ts` does: the walk
// parses the whole source tree and is the slow part of the file.
const facts = erasureSourceFacts();

describe("the night's schedule", () => {
  it("gives every daily job a minute no other job wakes at", () => {
    const owners = new Map<string, string[]>();
    for (const file of facts) {
      for (const { cron } of file.schedules) {
        // Only a job run once a day at a fixed minute has a minute to share.
        if (cron === undefined || !/^\d{1,2} \d{1,2} \* \* \*$/.test(cron)) {
          continue;
        }
        const [minute, hour] = cron.split(" ").map(Number);
        const at = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        owners.set(at, [...(owners.get(at) ?? []), file.path]);
      }
    }

    // Without this, a moved directory would turn the assertion below into one
    // that passes because it found nothing.
    expect(owners.size).toBeGreaterThan(5);
    const shared = [...owners].filter(([, paths]) => paths.length > 1);
    expect(shared).toEqual([]);
  });
});
