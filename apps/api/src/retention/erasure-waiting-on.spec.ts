import { describe, expect, it } from "vitest";

import { erasureRequestStatus } from "./erasure-waiting-on";

const KEPT_MOTION = {
  domain: "motions",
  owed: 0,
  kept: 1,
  keptBecause: "an open motion is still with the association",
};
const OWED_BOOKINGS = { domain: "bookings", owed: 2, kept: 0 };

describe("whether an open granted erasure request is blocked or incomplete", () => {
  it("is blocked by a refusal, whatever else stands", () => {
    // The purge takes nothing while a rule refuses it, so no domain job can
    // close the request: the board is waiting on the rule, not on a run.
    expect(erasureRequestStatus("on-legal-hold", [])).toBe("blocked");
    expect(erasureRequestStatus("on-legal-hold", [OWED_BOOKINGS])).toBe(
      "blocked",
    );
  });

  it("is incomplete while a domain owes rows", () => {
    expect(erasureRequestStatus(null, [OWED_BOOKINGS])).toBe("incomplete");
    expect(erasureRequestStatus(null, [KEPT_MOTION, OWED_BOOKINGS])).toBe(
      "incomplete",
    );
  });

  it("is blocked where only kept rows are left", () => {
    expect(erasureRequestStatus(null, [KEPT_MOTION])).toBe("blocked");
  });

  it("is incomplete where nothing is left and the purge has not reached them", () => {
    // The next run closes it; until then it is owed, not held.
    expect(erasureRequestStatus(null, [])).toBe("incomplete");
  });
});
