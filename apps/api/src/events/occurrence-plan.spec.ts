import { describe, expect, it } from "vitest";

import type { Period } from "../bookings/stockholm-calendar";
import {
  displacedBy,
  planOccurrences,
  type StoredOccurrence,
} from "./occurrence-plan";

/**
 * What an edit does to the dates a series already has.
 *
 * The instants below are written out by hand. Stockholm is UTC+2 in summer and
 * UTC+1 in winter, so 10:00 on the 18th of April 2027 is 08:00 UTC and 00:30 on
 * the 19th is 22:30 UTC on the 18th - which is the case that decides whether
 * dates are matched on the association's calendar or on the reader's.
 */

/** An occurrence as it stands, at the ISO instants given. */
function stored(
  id: string,
  startsAt: string,
  endsAt: string,
  cancelledAt: string | null = null,
): StoredOccurrence {
  return {
    id,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    cancelledAt: cancelledAt === null ? null : new Date(cancelledAt),
  };
}

/** A planned period, at the ISO instants given. */
function period(startsAt: string, endsAt: string): Period {
  return { startsAt: new Date(startsAt), endsAt: new Date(endsAt) };
}

const NOW = new Date("2027-04-01T12:00:00.000Z");

/** The ids in a list of occurrences, for a readable assertion. */
function ids(occurrences: readonly StoredOccurrence[]): string[] {
  return occurrences.map((occurrence) => occurrence.id);
}

describe("a series being created", () => {
  it("adds every period, past ones included", () => {
    const plan = planOccurrences(
      [],
      [
        period("2027-01-17T09:00:00.000Z", "2027-01-17T10:00:00.000Z"),
        period("2027-04-18T08:00:00.000Z", "2027-04-18T09:00:00.000Z"),
      ],
      NOW,
    );

    expect(plan.added).toHaveLength(2);
    expect(plan.kept).toEqual([]);
    expect(plan.moved).toEqual([]);
    expect(plan.dropped).toEqual([]);
  });
});

describe("a date the new schedule names identically", () => {
  it("is kept, and is not displaced", () => {
    const standing = stored(
      "one",
      "2027-04-18T08:00:00.000Z",
      "2027-04-18T09:00:00.000Z",
    );
    const plan = planOccurrences(
      [standing],
      [period("2027-04-18T08:00:00.000Z", "2027-04-18T09:00:00.000Z")],
      NOW,
    );

    expect(ids(plan.kept)).toEqual(["one"]);
    expect(plan.added).toEqual([]);
    expect(displacedBy(plan)).toEqual([]);
  });
});

describe("a date whose time of day changes", () => {
  const standing = stored(
    "one",
    "2027-04-18T08:00:00.000Z",
    "2027-04-18T09:00:00.000Z",
    "2027-03-30T07:00:00.000Z",
  );

  /*
   * The cleaning day on the 18th is the same cleaning day at nine as at ten, so
   * the row survives with its id and with the board's decision to call that one
   * off. Matching by instant instead would drop the row and add a new one,
   * taking every sign-up and the cancellation with it.
   */
  it("keeps its row and moves it", () => {
    const plan = planOccurrences(
      [standing],
      [period("2027-04-18T07:00:00.000Z", "2027-04-18T08:00:00.000Z")],
      NOW,
    );

    expect(plan.dropped).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.moved).toHaveLength(1);
    expect(plan.moved[0]?.occurrence.id).toBe("one");
    expect(plan.moved[0]?.occurrence.cancelledAt).toEqual(
      new Date("2027-03-30T07:00:00.000Z"),
    );
    expect(plan.moved[0]?.period.startsAt).toEqual(
      new Date("2027-04-18T07:00:00.000Z"),
    );
  });

  it("counts as displaced, because the time people were told has changed", () => {
    const plan = planOccurrences(
      [standing],
      [period("2027-04-18T07:00:00.000Z", "2027-04-18T08:00:00.000Z")],
      NOW,
    );
    expect(ids(displacedBy(plan))).toEqual(["one"]);
  });

  it("is displaced by a change to its length alone", () => {
    const plan = planOccurrences(
      [standing],
      [period("2027-04-18T08:00:00.000Z", "2027-04-18T12:00:00.000Z")],
      NOW,
    );
    expect(ids(plan.moved.map((entry) => entry.occurrence))).toEqual(["one"]);
    expect(ids(displacedBy(plan))).toEqual(["one"]);
  });
});

describe("a date the new schedule does not name", () => {
  it("is dropped, and is displaced", () => {
    const plan = planOccurrences(
      [
        stored("keep", "2027-04-18T08:00:00.000Z", "2027-04-18T09:00:00.000Z"),
        stored("gone", "2027-04-25T08:00:00.000Z", "2027-04-25T09:00:00.000Z"),
      ],
      [period("2027-04-18T08:00:00.000Z", "2027-04-18T09:00:00.000Z")],
      NOW,
    );

    expect(ids(plan.kept)).toEqual(["keep"]);
    expect(ids(plan.dropped)).toEqual(["gone"]);
    expect(ids(displacedBy(plan))).toEqual(["gone"]);
  });
});

describe("what has already started", () => {
  const past = stored(
    "past",
    "2027-03-21T09:00:00.000Z",
    "2027-03-21T10:00:00.000Z",
  );

  it("is kept whatever the new schedule says about that date", () => {
    const plan = planOccurrences(
      [past],
      // The new schedule names the same date an hour later, and a new one.
      [
        period("2027-03-21T10:00:00.000Z", "2027-03-21T11:00:00.000Z"),
        period("2027-04-18T08:00:00.000Z", "2027-04-18T09:00:00.000Z"),
      ],
      NOW,
    );

    expect(ids(plan.kept)).toEqual(["past"]);
    expect(plan.moved).toEqual([]);
    expect(plan.dropped).toEqual([]);
    // The period on the frozen date is not written beside the row that stands.
    expect(plan.added).toEqual([
      period("2027-04-18T08:00:00.000Z", "2027-04-18T09:00:00.000Z"),
    ]);
  });

  it("is kept even when the new schedule drops that date entirely", () => {
    const plan = planOccurrences(
      [past],
      [period("2027-04-18T08:00:00.000Z", "2027-04-18T09:00:00.000Z")],
      NOW,
    );

    expect(ids(plan.kept)).toEqual(["past"]);
    expect(plan.dropped).toEqual([]);
    expect(displacedBy(plan)).toEqual([]);
  });

  it("counts an occurrence that started a moment ago as history", () => {
    const plan = planOccurrences(
      [stored("just-begun", NOW.toISOString(), "2027-04-01T13:00:00.000Z")],
      [],
      NOW,
    );
    expect(ids(plan.kept)).toEqual(["just-begun"]);
    expect(plan.dropped).toEqual([]);
  });
});

describe("the calendar the dates are matched on", () => {
  /*
   * An occurrence at half past midnight on the 19th of April is 22:30 UTC on the
   * 18th, because Stockholm is two hours ahead in April. Matching on the UTC
   * date would file it under the 18th, and an edit that moved the series to ten
   * in the morning would then see two rows on the 18th - dropping the one people
   * had signed up to and adding a new one - while the 19th quietly lost its
   * date altogether.
   */
  it("is the association's own, not UTC", () => {
    const plan = planOccurrences(
      [
        stored(
          "eighteenth",
          "2027-04-18T08:00:00.000Z",
          "2027-04-18T09:00:00.000Z",
        ),
        stored(
          "nineteenth",
          "2027-04-18T22:30:00.000Z",
          "2027-04-18T23:30:00.000Z",
        ),
      ],
      [
        period("2027-04-18T08:00:00.000Z", "2027-04-18T09:00:00.000Z"),
        period("2027-04-19T08:00:00.000Z", "2027-04-19T09:00:00.000Z"),
      ],
      NOW,
    );

    expect(ids(plan.kept)).toEqual(["eighteenth"]);
    expect(ids(plan.moved.map((entry) => entry.occurrence))).toEqual([
      "nineteenth",
    ]);
    expect(plan.dropped).toEqual([]);
    expect(plan.added).toEqual([]);
  });
});

describe("a whole schedule being rewritten", () => {
  it("keeps, moves, drops and adds in one pass", () => {
    const plan = planOccurrences(
      [
        stored("past", "2027-03-21T09:00:00.000Z", "2027-03-21T10:00:00.000Z"),
        stored("same", "2027-04-18T08:00:00.000Z", "2027-04-18T09:00:00.000Z"),
        stored("later", "2027-04-25T08:00:00.000Z", "2027-04-25T09:00:00.000Z"),
        stored("gone", "2027-05-02T08:00:00.000Z", "2027-05-02T09:00:00.000Z"),
      ],
      [
        period("2027-04-18T08:00:00.000Z", "2027-04-18T09:00:00.000Z"),
        period("2027-04-25T10:00:00.000Z", "2027-04-25T11:00:00.000Z"),
        period("2027-05-09T08:00:00.000Z", "2027-05-09T09:00:00.000Z"),
      ],
      NOW,
    );

    expect(ids(plan.kept).sort()).toEqual(["past", "same"]);
    expect(ids(plan.moved.map((entry) => entry.occurrence))).toEqual(["later"]);
    expect(ids(plan.dropped)).toEqual(["gone"]);
    expect(plan.added).toEqual([
      period("2027-05-09T08:00:00.000Z", "2027-05-09T09:00:00.000Z"),
    ]);
    expect(ids(displacedBy(plan)).sort()).toEqual(["gone", "later"]);
  });
});
