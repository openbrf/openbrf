import { describe, expect, it } from "vitest";

import {
  describePurgeRefusal,
  purgeRefusal,
  type PurgeRefusal,
  type PurgeRefusalFacts,
} from "./purge-refusal";

const NOW = new Date("2027-06-01T12:00:00Z");
const CUTOFF = new Date("2017-06-01T12:00:00Z");

/** Somebody who moved out long ago and holds nothing: nothing refuses them. */
const FORMER: PurgeRefusalFacts = {
  residencies: [{ movedOutOn: new Date("2015-01-31") }],
  boardPositions: [],
  systemRoles: [],
  legalHolds: [],
  processingRestrictedAt: null,
};

describe("what refuses a person's purge", () => {
  it("refuses nothing for a former resident past the window", () => {
    expect(purgeRefusal(FORMER, NOW, CUTOFF)).toBeNull();
  });

  it("names each rule by its code", () => {
    expect(
      purgeRefusal(
        { ...FORMER, processingRestrictedAt: new Date("2027-01-01") },
        NOW,
        CUTOFF,
      ),
    ).toBe("processing-restricted");
    expect(
      purgeRefusal(
        { ...FORMER, boardPositions: [{ endedOn: null }] },
        NOW,
        CUTOFF,
      ),
    ).toBe("board-position-current");
    expect(
      purgeRefusal({ ...FORMER, legalHolds: [{ id: "hold" }] }, NOW, CUTOFF),
    ).toBe("on-legal-hold");
    expect(
      purgeRefusal(
        { ...FORMER, systemRoles: [{ role: "ADMIN" }] },
        NOW,
        CUTOFF,
      ),
    ).toBe("system-role-current");
  });

  it("asks a restriction before anything else", () => {
    // The later request wins: a person who asked to be erased and then for a
    // restriction has changed their mind, whatever else stands.
    expect(
      purgeRefusal(
        {
          ...FORMER,
          processingRestrictedAt: new Date("2027-01-01"),
          legalHolds: [{ id: "hold" }],
        },
        NOW,
        CUTOFF,
      ),
    ).toBe("processing-restricted");
  });

  it("tells the scheduled run's residency rules from a request's", () => {
    const resident = { ...FORMER, residencies: [{ movedOutOn: null }] };
    expect(purgeRefusal(resident, NOW, CUTOFF)).toBe(
      "residency-within-retention",
    );
    expect(purgeRefusal(resident, NOW, NOW, true)).toBe("currently-resident");

    const neverLived = { ...FORMER, residencies: [] };
    expect(purgeRefusal(neverLived, NOW, CUTOFF)).toBe("no-residency");
    // A granted request names the person, residency or none.
    expect(purgeRefusal(neverLived, NOW, NOW, true)).toBeNull();
  });
});

describe("a refusal as the purge's log line says it", () => {
  it("keeps the words the run summary has always used", () => {
    // A line read against last month's has to say the same thing for the
    // same rule.
    const lines: Record<PurgeRefusal, string> = {
      "processing-restricted": "processing is restricted",
      "board-position-current": "a board seat is still held",
      "on-legal-hold": "a legal hold stands",
      "system-role-current": "a system role is still granted",
      "currently-resident": "a residency is still running",
      "no-residency": "no residency to anchor a purge date on",
      "residency-within-retention": "a residency has not ended long enough ago",
      "person-not-found": "the person row is gone",
    };
    for (const [refusal, line] of Object.entries(lines)) {
      expect(describePurgeRefusal(refusal as PurgeRefusal)).toBe(line);
    }
  });
});
