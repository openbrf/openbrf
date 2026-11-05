import { describe, expect, it } from "vite-plus/test";

import {
  ISSUE_REOPEN_WINDOW_DAYS,
  replyReopensIssue,
} from "./issue-lifecycle.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const closedAt = new Date("2027-02-26T14:30:00.000Z");

function after(ms: number): Date {
  return new Date(closedAt.getTime() + ms);
}

/**
 * The reopening window (återöppning) at its edges. The integration suite moves
 * a running clock and cannot land on the exact instant, so the boundary itself
 * is held here.
 */
describe("replyReopensIssue", () => {
  it("reopens at the instant of closing and through the window", () => {
    expect(replyReopensIssue(closedAt, closedAt)).toBe(true);
    expect(replyReopensIssue(closedAt, after(29 * DAY_MS))).toBe(true);
  });

  it("reopens at the very end of the thirtieth day", () => {
    expect(
      replyReopensIssue(closedAt, after(ISSUE_REOPEN_WINDOW_DAYS * DAY_MS)),
    ).toBe(true);
  });

  it("refuses a millisecond after the window", () => {
    expect(
      replyReopensIssue(closedAt, after(ISSUE_REOPEN_WINDOW_DAYS * DAY_MS + 1)),
    ).toBe(false);
    expect(replyReopensIssue(closedAt, after(31 * DAY_MS))).toBe(false);
  });

  it("counts instants, not calendar days, across 29 February", () => {
    const leap = new Date("2028-02-15T23:59:00.000Z");
    expect(replyReopensIssue(leap, new Date("2028-03-16T23:59:00.000Z"))).toBe(
      true,
    );
    expect(replyReopensIssue(leap, new Date("2028-03-17T00:00:00.000Z"))).toBe(
      false,
    );
  });

  it("refuses an issue with no closing date", () => {
    expect(replyReopensIssue(null, closedAt)).toBe(false);
  });
});
