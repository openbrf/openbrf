import { describe, expect, it } from "vitest";

import { boardSeatHeldOn, isResidencyHeldOn, residencyHeldOn } from "./held-on";

/**
 * Which residencies and seats are held on a day.
 *
 * The day is a calendar date and the columns are dates, so the cases are the
 * two ends of a period and the day either side of each. The association's
 * midnight is the caller's business - it hands in `localDayOf(now)` - and
 * `held-on.int-spec.ts` is where a clock set to the hour after it is exercised
 * against the readers.
 */

const DAY = { year: 2026, month: 6, day: 22 };

function column(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`);
}

describe("residencyHeldOn", () => {
  it("asks for a move-in on or before the day and a move-out after it", () => {
    expect(residencyHeldOn(DAY)).toEqual({
      movedInOn: { lte: column("2026-06-22") },
      OR: [{ movedOutOn: null }, { movedOutOn: { gt: column("2026-06-22") } }],
    });
  });

  it("compares against the date the day names, not an instant within it", () => {
    // Midnight UTC is what a `@db.Date` column is read back as, and the only
    // value a comparison against one can be made in.
    const where = residencyHeldOn({ year: 2026, month: 12, day: 31 });

    expect(where.movedInOn).toEqual({ lte: column("2026-12-31") });
  });
});

describe("boardSeatHeldOn", () => {
  it("asks for an election on or before the day and an end after it", () => {
    expect(boardSeatHeldOn(DAY)).toEqual({
      electedOn: { lte: column("2026-06-22") },
      OR: [{ endedOn: null }, { endedOn: { gt: column("2026-06-22") } }],
    });
  });
});

describe("isResidencyHeldOn", () => {
  const held = (movedInOn: string, movedOutOn: string | null): boolean =>
    isResidencyHeldOn(
      {
        movedInOn: column(movedInOn),
        movedOutOn: movedOutOn === null ? null : column(movedOutOn),
      },
      DAY,
    );

  it("holds a residency from its move-in date", () => {
    expect(held("2026-06-22", null)).toBe(true);
  });

  it("does not hold one whose move-in date is still to come", () => {
    // A buyer recorded before they take over the apartment.
    expect(held("2026-06-23", null)).toBe(false);
  });

  it("does not hold one on its move-out date", () => {
    // The first day it is not held, and the next household's first day.
    expect(held("2026-01-01", "2026-06-22")).toBe(false);
  });

  it("holds one on the day before its move-out date", () => {
    expect(held("2026-01-01", "2026-06-23")).toBe(true);
  });

  it("holds one with no move-out date", () => {
    expect(held("2026-01-01", null)).toBe(true);
  });

  it("holds a residency on no day when it moves out on the day it moved in", () => {
    expect(held("2026-06-22", "2026-06-22")).toBe(false);
  });
});
