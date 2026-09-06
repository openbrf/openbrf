import { describe, expect, it } from "vitest";

import {
  computeKeyOrderPurgeDate,
  KEY_ORDER_RETENTION_DAYS,
  keyOrderPurgeCutoff,
} from "./key-order-retention";

const CLOSED = new Date("2027-04-15T12:00:00.000Z");

describe("computeKeyOrderPurgeDate", () => {
  it("anchors on the closing date plus the retention window", () => {
    expect(computeKeyOrderPurgeDate(CLOSED, 365)?.toISOString()).toBe(
      "2028-04-14T12:00:00.000Z",
    );
  });

  it("states no date for an order still with the board", () => {
    /*
     * The load-bearing case of this file. An open order has no closing date to
     * count from, and the association is still processing it, so no purge date
     * exists - and a function that answered "now plus the window" here would put
     * an erasure date on a resident's access report for an order nobody has
     * dealt with yet, and the purge would then be entitled to erase it.
     */
    expect(computeKeyOrderPurgeDate(null, 365)).toBeNull();
  });

  it("defaults to the module's retention window", () => {
    expect(computeKeyOrderPurgeDate(CLOSED)?.toISOString()).toBe(
      computeKeyOrderPurgeDate(CLOSED, KEY_ORDER_RETENTION_DAYS)?.toISOString(),
    );
  });

  it("keeps a closed order for less time than a motion or a sublet consent", () => {
    /*
     * The window is a decision per feature rather than a house default, and this
     * is where that decision is written down. An order for a key is settled when
     * the key is in somebody's hand; a motion is asked about at the next annual
     * meeting and a consent to let is what a forfeiture dispute turns on after
     * the letting ends.
     */
    expect(KEY_ORDER_RETENTION_DAYS).toBeLessThan(730);
  });

  it("recomputes when the window is shortened", () => {
    // The date is derived and never stored, so a shorter window moves every
    // pending purge date by that act alone - no migration and no recomputation
    // job, and the access report states the date that will actually apply.
    expect(computeKeyOrderPurgeDate(CLOSED, 30)?.toISOString()).toBe(
      "2027-05-15T12:00:00.000Z",
    );
  });

  it("crosses a daylight saving boundary without losing a day", () => {
    // Sweden leaves summer time on the last Sunday of October. Calendar-field
    // arithmetic in local time drops or gains an hour here, and a purge date a
    // day early is an erasure before the date the report stated.
    expect(
      computeKeyOrderPurgeDate(
        new Date("2027-10-01T00:00:00.000Z"),
        30,
      )?.toISOString(),
    ).toBe("2027-10-31T00:00:00.000Z");
  });

  it("refuses a negative window rather than computing a date in the past", () => {
    expect(() => computeKeyOrderPurgeDate(CLOSED, -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => computeKeyOrderPurgeDate(CLOSED, Number.NaN)).toThrow(
      RangeError,
    );
  });

  it("refuses a bad window even for an open order", () => {
    // The null branch must not be a way past the guard: a caller passing a
    // nonsense window would otherwise be told nothing is wrong.
    expect(() => computeKeyOrderPurgeDate(null, -1)).toThrow(RangeError);
  });
});

/**
 * The cutoff and the stated purge date are one decision read from two ends.
 *
 * The access report computes a date per order and hands it to the person the
 * order is about. The job compares every closing date against one cutoff. If the
 * two ever disagree the product erases on a day other than the one it stated, so
 * the agreement is asserted here rather than assumed from the arithmetic looking
 * symmetrical.
 */
describe("keyOrderPurgeCutoff", () => {
  it("is the closing time whose purge date is exactly now", () => {
    const now = new Date("2028-04-14T12:00:00.000Z");

    const cutoff = keyOrderPurgeCutoff(now, 365);

    expect(computeKeyOrderPurgeDate(cutoff, 365)?.toISOString()).toBe(
      now.toISOString(),
    );
  });

  it("agrees with the stated purge date on both sides of the line", () => {
    const now = new Date("2028-04-14T12:00:00.000Z");
    const cutoff = keyOrderPurgeCutoff(now, 365);

    const dueYesterday = new Date("2027-04-14T12:00:00.000Z");
    const dueTomorrow = new Date("2027-04-16T12:00:00.000Z");

    expect(dueYesterday.getTime() <= cutoff.getTime()).toBe(true);
    expect(
      (computeKeyOrderPurgeDate(dueYesterday, 365)?.getTime() ?? 0) <=
        now.getTime(),
    ).toBe(true);

    expect(dueTomorrow.getTime() <= cutoff.getTime()).toBe(false);
    expect(
      (computeKeyOrderPurgeDate(dueTomorrow, 365)?.getTime() ?? 0) <=
        now.getTime(),
    ).toBe(false);
  });

  it("defaults to the module's retention window", () => {
    const now = new Date("2028-04-14T12:00:00.000Z");

    expect(keyOrderPurgeCutoff(now).toISOString()).toBe(
      keyOrderPurgeCutoff(now, KEY_ORDER_RETENTION_DAYS).toISOString(),
    );
  });

  it("outlives the accounting year the key was charged in", () => {
    /*
     * The reason the window is a year rather than a season. The cost of the key
     * is a charge recorded elsewhere and reconciled with whoever keeps the
     * association's books, and a handover in January has to still be there when
     * the previous year is closed off in the spring.
     */
    const handedOverInJanuary = new Date("2027-01-20T10:00:00.000Z");
    const theBooksClosedInMay = new Date("2027-05-15T10:00:00.000Z");

    expect(
      handedOverInJanuary.getTime() <=
        keyOrderPurgeCutoff(
          theBooksClosedInMay,
          KEY_ORDER_RETENTION_DAYS,
        ).getTime(),
    ).toBe(false);
  });

  it("moves every pending eligibility when the window is shortened", () => {
    const now = new Date("2029-01-01T00:00:00.000Z");

    const strict = keyOrderPurgeCutoff(now, 30);
    const generous = keyOrderPurgeCutoff(now, 3650);

    // A shorter window reaches orders closed closer to today; a longer one only
    // reaches older ones.
    expect(strict.getTime()).toBeGreaterThan(generous.getTime());
  });

  it("refuses a negative window rather than reaching into the future", () => {
    // A negative window would put the cutoff after now and erase orders whose
    // retention had not run out.
    expect(() => keyOrderPurgeCutoff(new Date(), -1)).toThrow(RangeError);
  });

  it("refuses a window that is not a number of days", () => {
    expect(() => keyOrderPurgeCutoff(new Date(), Number.NaN)).toThrow(
      RangeError,
    );
  });
});
