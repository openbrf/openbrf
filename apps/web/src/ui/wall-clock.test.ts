import { describe, expect, it } from "vite-plus/test";

import { toInstant, toWallClock } from "./wall-clock";

describe("a datetime-local value", () => {
  it("is the instant it means on the reader's own clock, and back", () => {
    const instant = new Date(2026, 8, 6, 13, 5);
    expect(toWallClock(instant)).toBe("2026-09-06T13:05");
    expect(toInstant("2026-09-06T13:05")).toBe(instant.toISOString());
  });

  it("is no instant when it is empty or unreadable", () => {
    expect(toInstant("")).toBeNull();
    expect(toInstant("not a time")).toBeNull();
  });
});
