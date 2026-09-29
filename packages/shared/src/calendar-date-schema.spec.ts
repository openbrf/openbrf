import { describe, expect, it } from "vitest";

import { calendarDateSchema } from "./calendar-date-schema.ts";

describe("calendarDateSchema", () => {
  it.each([
    // 2026 is not a leap year.
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
  ])("refuses %s, which is not on the calendar", (text) => {
    expect(calendarDateSchema.safeParse(text).success).toBe(false);
  });

  it.each(["2028-02-29", "2026-02-28", "2026-12-31", "2000-02-29"])(
    "accepts %s",
    (text) => {
      expect(calendarDateSchema.parse(text)).toBe(text);
    },
  );

  it.each(["2026-2-28", "2026-02-28T00:00:00Z", " 2026-02-28", "28/02/2026"])(
    "refuses %j, which is not written YYYY-MM-DD",
    (text) => {
      expect(calendarDateSchema.safeParse(text).success).toBe(false);
    },
  );

  it("refuses a value that is not text", () => {
    expect(calendarDateSchema.safeParse(20260228).success).toBe(false);
  });
});
