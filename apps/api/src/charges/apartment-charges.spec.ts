import { describe, expect, it } from "vitest";

import { dateColumnOf } from "../bookings/stockholm-calendar";
import {
  chargesDuringResidency,
  type DatedApartmentCharge,
  type ResidencyPeriod,
} from "./apartment-charges";

/**
 * Which apartment-keyed charges are one person's.
 *
 * The rule the data subject access report leans on, and the mistake it exists to
 * prevent is disclosure rather than omission: a charge from before the household
 * moved in is the previous household's finances, put on a document the
 * association hands over. So the boundaries are asserted from both sides.
 */

function day(text: string): Date {
  const [year, month, date] = text.split("-").map(Number);
  return dateColumnOf({ year: year ?? 0, month: month ?? 0, day: date ?? 0 });
}

function charge(
  apartmentId: string | null,
  chargedOn: string,
): DatedApartmentCharge & { id: string } {
  return {
    id: `${apartmentId ?? "none"}-${chargedOn}`,
    apartmentId,
    chargedOn: day(chargedOn),
  };
}

const ENDED: ResidencyPeriod = {
  apartmentId: "apartment-1",
  from: day("2026-03-01"),
  until: day("2026-09-30"),
};

const CURRENT: ResidencyPeriod = {
  apartmentId: "apartment-2",
  from: day("2027-01-15"),
  until: null,
};

describe("chargesDuringResidency", () => {
  it("takes a charge dated inside the residency", () => {
    expect(
      chargesDuringResidency([charge("apartment-1", "2026-05-04")], [ENDED]),
    ).toHaveLength(1);
  });

  it("takes a charge dated on the day they moved in or out", () => {
    // Both boundaries closed. A move-out date is the last day of the residency
    // rather than the first day after it, which is how every other read of that
    // column in this product treats it.
    expect(
      chargesDuringResidency(
        [
          charge("apartment-1", "2026-03-01"),
          charge("apartment-1", "2026-09-30"),
        ],
        [ENDED],
      ),
    ).toHaveLength(2);
  });

  it("leaves out a charge dated a day either side", () => {
    // The previous household's, and the next one's. Both are a third party's
    // finances on a document handed to somebody who asked about themselves.
    expect(
      chargesDuringResidency(
        [
          charge("apartment-1", "2026-02-28"),
          charge("apartment-1", "2026-10-01"),
        ],
        [ENDED],
      ),
    ).toEqual([]);
  });

  it("keeps a current residency open at the far end", () => {
    expect(
      chargesDuringResidency(
        [
          charge("apartment-2", "2030-11-11"),
          charge("apartment-2", "2027-01-14"),
        ],
        [CURRENT],
      ).map((entry) => entry.id),
    ).toEqual(["apartment-2-2030-11-11"]);
  });

  it("leaves out another apartment's charges", () => {
    expect(
      chargesDuringResidency([charge("apartment-3", "2026-05-04")], [ENDED]),
    ).toEqual([]);
  });

  it("drops a charge with no apartment", () => {
    // That is a charge on a named person, which the report reads through its own
    // column. Attributing it here would put it on whoever's report this ran for.
    expect(
      chargesDuringResidency([charge(null, "2026-05-04")], [ENDED]),
    ).toEqual([]);
  });

  it("takes a charge from any of several residencies", () => {
    expect(
      chargesDuringResidency(
        [
          charge("apartment-1", "2026-05-04"),
          charge("apartment-2", "2027-02-01"),
        ],
        [ENDED, CURRENT],
      ),
    ).toHaveLength(2);
  });

  it("answers nothing for a person who has never lived anywhere", () => {
    expect(
      chargesDuringResidency([charge("apartment-1", "2026-05-04")], []),
    ).toEqual([]);
  });
});
