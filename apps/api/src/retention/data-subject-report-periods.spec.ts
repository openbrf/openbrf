import { describe, expect, it } from "vitest";

import { overlapsResidency } from "./data-subject-report.service";

/**
 * Which fees and fee notices land on a person's access report: those for a
 * period that overlaps a residency of theirs on the apartment.
 *
 * The case that matters is a sale. The seller moves out on the day the buyer
 * moves in, and the move-out date is the first day the seller no longer holds
 * the apartment (ADR 0014) - so the month that opens on it is the buyer's, and
 * the seller's report must not carry its amount or payment reference.
 */

const APARTMENT = "apartment-1";
const day = (text: string): Date => new Date(`${text}T00:00:00.000Z`);

/** The seller: lived there from 2020 until moving out on 1 March 2026. */
const seller = [
  { apartmentId: APARTMENT, from: day("2020-01-01"), until: day("2026-03-01") },
];
/** The buyer: moved in on 1 March 2026. */
const buyer = [
  { apartmentId: APARTMENT, from: day("2026-03-01"), until: null },
];

describe("a period on the apartment and a residency there", () => {
  it("leaves the month that opens on the move-out date to the next holder", () => {
    expect(
      overlapsResidency(
        seller,
        APARTMENT,
        day("2026-03-01"),
        day("2026-03-31"),
      ),
    ).toBe(false);
    // And so does a rate that takes effect on that day.
    expect(overlapsResidency(seller, APARTMENT, day("2026-03-01"), null)).toBe(
      false,
    );
  });

  it("gives the seller the month that ends the day before they moved out", () => {
    expect(
      overlapsResidency(
        seller,
        APARTMENT,
        day("2026-02-01"),
        day("2026-02-28"),
      ),
    ).toBe(true);
  });

  it("gives the buyer a period that closes on the day they moved in", () => {
    // `periodTo` and `appliesUntil` are inclusive, so that day was theirs.
    expect(
      overlapsResidency(buyer, APARTMENT, day("2026-02-01"), day("2026-03-01")),
    ).toBe(true);
    expect(
      overlapsResidency(buyer, APARTMENT, day("2026-02-01"), day("2026-02-28")),
    ).toBe(false);
  });

  it("never reaches a period on another apartment", () => {
    expect(
      overlapsResidency(seller, "apartment-2", day("2025-01-01"), null),
    ).toBe(false);
  });
});
