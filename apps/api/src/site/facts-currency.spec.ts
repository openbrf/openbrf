import { describe, expect, it } from "vite-plus/test";

import type { AssociationFactsView } from "./association-facts.service";
import {
  factsCurrentThrough,
  isFactsStale,
  updatesRequestable,
} from "./facts-currency";

/**
 * The rule the broker page and the update request endpoint share, at its
 * edges.
 *
 * Instants are written in UTC and chosen at Stockholm noon, so the day each
 * one falls on is not in question; the zone itself is held by the cases that
 * sit beside midnight.
 */

/**
 * Late morning in Stockholm on a day: 10:00 UTC is 11:00 in winter and 12:00 in
 * summer, the same day either way.
 */
function noon(day: string): Date {
  return new Date(`${day}T10:00:00Z`);
}

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
    updatedAt: "2026-01-19T10:00:00.000Z",
    confirmedAt: "2026-01-19T10:00:00.000Z",
    staleAfterMonths: 3,
    ...overrides,
  };
}

describe("how long the facts count as current", () => {
  it("is the board's number of calendar months on from the day confirmed", () => {
    expect(factsCurrentThrough(noon("2026-10-19"), 3)).toEqual({
      year: 2027,
      month: 1,
      day: 19,
    });
  });

  it("falls on the target month's last day when it has no such day", () => {
    expect(factsCurrentThrough(noon("2026-01-31"), 1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
    expect(factsCurrentThrough(noon("2028-01-31"), 1)).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
    expect(factsCurrentThrough(noon("2026-08-31"), 3)).toEqual({
      year: 2026,
      month: 11,
      day: 30,
    });
  });

  it("crosses a year", () => {
    expect(factsCurrentThrough(noon("2026-11-15"), 12)).toEqual({
      year: 2027,
      month: 11,
      day: 15,
    });
  });

  it("counts from the Stockholm day, not the UTC one", () => {
    // 23:30 UTC on 30 April is 01:30 on 1 May in Stockholm.
    expect(factsCurrentThrough(new Date("2026-04-30T23:30:00Z"), 1)).toEqual({
      year: 2026,
      month: 6,
      day: 1,
    });
  });
});

describe("whether the facts are stale", () => {
  it.each([1, 3, 6, 12])(
    "is not on the last current day and is the day after, with %i months",
    (months) => {
      const confirmed = noon("2026-01-15");
      const last = factsCurrentThrough(confirmed, months);
      const lastDay = `${String(last.year)}-${String(last.month).padStart(2, "0")}-${String(last.day).padStart(2, "0")}`;

      expect(isFactsStale(confirmed, months, noon(lastDay))).toBe(false);
      expect(
        isFactsStale(
          confirmed,
          months,
          new Date(noon(lastDay).getTime() + 24 * 60 * 60 * 1000),
        ),
      ).toBe(true);
    },
  );

  it("turns at Stockholm midnight, not at UTC midnight", () => {
    const confirmed = noon("2026-10-19");
    // 22:59 UTC on 19 January is 23:59 in Stockholm: still the last day.
    expect(isFactsStale(confirmed, 3, new Date("2027-01-19T22:59:00Z"))).toBe(
      false,
    );
    // 23:00 UTC is midnight in Stockholm, and 20 January.
    expect(isFactsStale(confirmed, 3, new Date("2027-01-19T23:00:00Z"))).toBe(
      true,
    );
  });

  it("is never stale on the day of confirming", () => {
    expect(isFactsStale(noon("2026-10-19"), 1, noon("2026-10-19"))).toBe(false);
  });
});

describe("whether a broker may ask for updates", () => {
  const now = noon("2026-04-20");

  it("may with the default threshold once three months have passed", () => {
    // Confirmed 19 January, current through 19 April.
    expect(updatesRequestable(facts({}), noon("2026-04-19"))).toBe(false);
    expect(updatesRequestable(facts({}), now)).toBe(true);
  });

  it("follows the board's setting with nothing else changed", () => {
    // The same confirmation, read under three thresholds on one day.
    const confirmedAt = "2026-01-19T10:00:00.000Z";
    expect(
      updatesRequestable(facts({ confirmedAt, staleAfterMonths: 1 }), now),
    ).toBe(true);
    expect(
      updatesRequestable(facts({ confirmedAt, staleAfterMonths: 6 }), now),
    ).toBe(false);
    expect(
      updatesRequestable(facts({ confirmedAt, staleAfterMonths: 12 }), now),
    ).toBe(false);
  });

  it("may not while nothing is confirmed", () => {
    expect(updatesRequestable(facts({ confirmedAt: null }), now)).toBe(false);
  });

  it("may not over a row whose every fact has been cleared", () => {
    expect(updatesRequestable(facts({ feePolicy: null }), now)).toBe(false);
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
