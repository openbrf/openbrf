import { describe, expect, it } from "vite-plus/test";

import type { AssociationFactsView } from "./association-facts.service";
import {
  factsCurrentUntil,
  isFactsStale,
  updatesRequestable,
} from "./facts-currency";

/**
 * The rule the broker page and the update request endpoint share, at its
 * edges.
 *
 * Instants are written in UTC, with the Stockholm wall clock beside each one
 * that matters: winter time is UTC+1 and summer time UTC+2, so 10:00 in
 * Stockholm is 09:00Z in January and 08:00Z in October.
 */

function facts(overrides: Partial<AssociationFactsView>): AssociationFactsView {
  return {
    propertyDesignation: null,
    buildYear: null,
    siteLeasehold: null,
    siteLeaseholdNote: null,
    feePolicy: "The fee was last raised in 2025.",
    feeIncludes: null,
    transferFeePolicy: null,
    pledgeFeePolicy: null,
    legalPersonOwners: null,
    legalPersonOwnersNote: null,
    parking: null,
    storage: null,
    renovations: null,
    updatedAt: "2026-01-19T09:00:00.000Z",
    // 10:00 in Stockholm on 19 January.
    confirmedAt: "2026-01-19T09:00:00.000Z",
    staleAfterMonths: 3,
    ...overrides,
  };
}

function plusMilliseconds(instant: Date, milliseconds: number): Date {
  return new Date(instant.getTime() + milliseconds);
}

describe("until when the facts count as current", () => {
  it("is the board's number of calendar months on, at the time of day confirmed", () => {
    // 10:00 on 19 October in summer time, to 10:00 on 19 January in winter
    // time: the wall clock's hour, not three months of hours.
    expect(
      factsCurrentUntil(new Date("2026-10-19T08:00:00.000Z"), 3),
    ).toStrictEqual(new Date("2027-01-19T09:00:00.000Z"));
  });

  it("keeps the seconds and milliseconds of the confirmation", () => {
    expect(
      factsCurrentUntil(new Date("2026-02-10T09:15:42.250Z"), 1),
    ).toStrictEqual(new Date("2026-03-10T09:15:42.250Z"));
  });

  it("falls on the target month's last day when it has no such day", () => {
    // 12:00 on 31 January.
    expect(
      factsCurrentUntil(new Date("2026-01-31T11:00:00.000Z"), 1),
    ).toStrictEqual(new Date("2026-02-28T11:00:00.000Z"));
    expect(
      factsCurrentUntil(new Date("2028-01-31T11:00:00.000Z"), 1),
    ).toStrictEqual(new Date("2028-02-29T11:00:00.000Z"));
    // 12:00 on 31 August, to 12:00 on 30 November.
    expect(
      factsCurrentUntil(new Date("2026-08-31T10:00:00.000Z"), 3),
    ).toStrictEqual(new Date("2026-11-30T11:00:00.000Z"));
  });

  it("crosses a year", () => {
    expect(
      factsCurrentUntil(new Date("2026-11-15T11:00:00.000Z"), 12),
    ).toStrictEqual(new Date("2027-11-15T11:00:00.000Z"));
  });

  it("counts from the Stockholm day, not the UTC one", () => {
    // 23:30 UTC on 30 April is 01:30 on 1 May in Stockholm, so the facts are
    // current until 01:30 on 1 June.
    expect(
      factsCurrentUntil(new Date("2026-04-30T23:30:00.000Z"), 1),
    ).toStrictEqual(new Date("2026-05-31T23:30:00.000Z"));
  });

  it("ends when the clocks go forward over the time confirmed", () => {
    // 02:30 on 29 January; 02:30 on 29 March 2026 never happens, because the
    // clocks go from 02:00 to 03:00 that night, which is 01:00Z.
    expect(
      factsCurrentUntil(new Date("2026-01-29T01:30:00.000Z"), 2),
    ).toStrictEqual(new Date("2026-03-29T01:00:00.000Z"));
  });

  it("ends the first time the clock reads it on the night it reads it twice", () => {
    // 02:30 on 25 July; on 25 October 2026 the clock reads 02:30 in summer
    // time, at 00:30Z, and again an hour later in winter time.
    expect(
      factsCurrentUntil(new Date("2026-07-25T00:30:00.000Z"), 3),
    ).toStrictEqual(new Date("2026-10-25T00:30:00.000Z"));
  });
});

describe("whether the facts are stale", () => {
  // 11:00 in Stockholm on 15 January.
  const confirmed = new Date("2026-01-15T10:00:00.000Z");

  it.each([
    // Winter time to winter time.
    [1, "2026-02-15T10:00:00.000Z"],
    // Winter time to summer time: 11:00 is an hour earlier in UTC.
    [3, "2026-04-15T09:00:00.000Z"],
    [6, "2026-07-15T09:00:00.000Z"],
    [12, "2027-01-15T10:00:00.000Z"],
  ])(
    "is not exactly %i months on, and is a millisecond after",
    (months, deadline) => {
      const at = new Date(deadline);

      expect(factsCurrentUntil(confirmed, months)).toStrictEqual(at);
      expect(isFactsStale(confirmed, months, plusMilliseconds(at, -1))).toBe(
        false,
      );
      expect(isFactsStale(confirmed, months, at)).toBe(false);
      expect(isFactsStale(confirmed, months, plusMilliseconds(at, 1))).toBe(
        true,
      );
    },
  );

  it("turns at the time of day confirmed, not at the next midnight", () => {
    // Confirmed at 10:00 on 19 October; stale from just after 10:00 on 19
    // January, the same afternoon and not the next day.
    const morning = new Date("2026-10-19T08:00:00.000Z");
    expect(isFactsStale(morning, 3, new Date("2027-01-19T09:00:00.000Z"))).toBe(
      false,
    );
    expect(isFactsStale(morning, 3, new Date("2027-01-19T09:00:01.000Z"))).toBe(
      true,
    );
    expect(isFactsStale(morning, 3, new Date("2027-01-19T14:00:00.000Z"))).toBe(
      true,
    );
  });

  it("is never stale on the day of confirming", () => {
    expect(
      isFactsStale(confirmed, 1, new Date("2026-01-15T22:59:59.999Z")),
    ).toBe(false);
  });
});

describe("whether a broker may ask for updates", () => {
  // 10:00 in Stockholm on 19 April, summer time: three months to the instant.
  const deadline = new Date("2026-04-19T08:00:00.000Z");
  const now = new Date("2026-04-20T08:00:00.000Z");

  it("may with the default threshold once three months have passed", () => {
    expect(updatesRequestable(facts({}), deadline)).toBe(false);
    expect(updatesRequestable(facts({}), plusMilliseconds(deadline, 1))).toBe(
      true,
    );
    expect(updatesRequestable(facts({}), now)).toBe(true);
  });

  it("follows the board's setting with nothing else changed", () => {
    // The same confirmation, read under four thresholds at one moment.
    const confirmedAt = "2026-01-19T09:00:00.000Z";
    expect(
      updatesRequestable(facts({ confirmedAt, staleAfterMonths: 1 }), now),
    ).toBe(true);
    expect(
      updatesRequestable(facts({ confirmedAt, staleAfterMonths: 3 }), now),
    ).toBe(true);
    expect(
      updatesRequestable(facts({ confirmedAt, staleAfterMonths: 6 }), now),
    ).toBe(false);
    expect(
      updatesRequestable(facts({ confirmedAt, staleAfterMonths: 12 }), now),
    ).toBe(false);
  });

  it("may over recorded facts that were never confirmed", () => {
    expect(updatesRequestable(facts({ confirmedAt: null }), now)).toBe(true);
    // Whatever the threshold: there is nothing to count it from.
    expect(
      updatesRequestable(
        facts({ confirmedAt: null, staleAfterMonths: 12 }),
        now,
      ),
    ).toBe(true);
  });

  it("may not over a row whose every fact has been cleared", () => {
    expect(updatesRequestable(facts({ feePolicy: null }), now)).toBe(false);
    expect(
      updatesRequestable(facts({ feePolicy: null, confirmedAt: null }), now),
    ).toBe(false);
  });

  it("reads a flag or the year built as a recorded fact", () => {
    expect(
      updatesRequestable(facts({ feePolicy: null, siteLeasehold: false }), now),
    ).toBe(true);
    expect(
      updatesRequestable(facts({ feePolicy: null, buildYear: 1931 }), now),
    ).toBe(true);
  });
});
