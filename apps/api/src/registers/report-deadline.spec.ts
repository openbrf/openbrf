import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPORT_WINDOW_DAYS, reportDueOn } from "./report-deadline";

/**
 * The deadline a register event opens, on the days the answer is not obvious.
 *
 * Lag (2026:484) 3 kap. gives the association two weeks, and a deadline stated
 * one day out is a deadline that looks right: nothing on the screen says whether
 * the fourteen days were counted as calendar days, as instants, or across a
 * daylight saving transition. So the cases below are the ones that separate
 * those - a window opened the day before the clocks change in either direction,
 * and one that crosses a month, a year and a leap day.
 */

/** The value a `@db.Date` column holds, as an ISO calendar date. */
const column = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const stored = (value: Date): string => value.toISOString().slice(0, 10);

describe("reportDueOn", () => {
  it("is fourteen days after the day the window opened", () => {
    expect(stored(reportDueOn(column("2027-06-01")))).toBe("2027-06-15");
  });

  it("keeps midnight UTC, which is what a date column holds", () => {
    // Not 23:00 or 22:00 the evening before, which is what shifting the instant
    // in the association's own zone would produce. A date column carries no
    // zone, and a deadline written an hour early is a deadline on the previous
    // day.
    expect(reportDueOn(column("2027-06-01")).toISOString()).toBe(
      "2027-06-15T00:00:00.000Z",
    );
  });

  it("counts calendar days across the spring transition", () => {
    // Sunday the 28th of March 2027 is 23 hours long in Stockholm. Fourteen
    // days from the 20th is the 3rd of April whether or not one of them is
    // short, and instant arithmetic in a local zone would answer the 2nd.
    expect(stored(reportDueOn(column("2027-03-20")))).toBe("2027-04-03");
  });

  it("counts calendar days across the autumn transition", () => {
    // And Sunday the 31st of October 2027 is 25 hours long, which is the same
    // error in the other direction.
    expect(stored(reportDueOn(column("2027-10-20")))).toBe("2027-11-03");
  });

  it("crosses a month, and a year", () => {
    expect(stored(reportDueOn(column("2027-12-24")))).toBe("2028-01-07");
  });

  it("crosses a leap day", () => {
    // 2028 has a 29th of February. Fourteen days from the 20th is the 5th of
    // March, not the 6th, and the platform's own calendar is what says so
    // rather than a table here.
    expect(stored(reportDueOn(column("2028-02-20")))).toBe("2028-03-05");
  });

  it("states the window the database enforces, read out of the migration", () => {
    /*
     * The same rule is a CHECK on the table, so the two have to agree: a
     * constant changed here alone would have the database refuse every insert,
     * and a CHECK changed alone would let a wrong deadline through this module.
     *
     * The constraint is read out of the migration rather than restated, on the
     * reading statutory-guards.int-spec.ts takes of the REVOKE lines: a CHECK
     * that was dropped has no text to find. The directory name is a fixed
     * string because migrations are forward-only and never renamed.
     */
    const sql = readFileSync(
      join(
        process.cwd(),
        "prisma",
        "migrations",
        "20260910100000_register_report_obligation",
        "migration.sql",
      ),
      "utf8",
    );

    expect(sql).toContain(
      `CHECK ("dueOn" = "triggeredOn" + ${String(REPORT_WINDOW_DAYS)})`,
    );
  });
});
