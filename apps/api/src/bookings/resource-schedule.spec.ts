import { describe, expect, it } from "vitest";

import {
  checkResourceSchedule,
  type ResourceSchedule,
} from "./resource-schedule";

/** A laundry room open 07:00 to 21:00 in two-hour slots: seven whole slots. */
const LAUNDRY: ResourceSchedule = {
  mode: "TIME_SLOTS",
  slotMinutes: 120,
  opensAtMinute: 7 * 60,
  closesAtMinute: 21 * 60,
};

/** A common room, booked a whole day at a time and carrying no hours. */
const COMMON_ROOM: ResourceSchedule = {
  mode: "WHOLE_DAY",
  slotMinutes: null,
  opensAtMinute: null,
  closesAtMinute: null,
};

describe("time slots", () => {
  it("accepts a day that divides into whole slots", () => {
    expect(checkResourceSchedule(LAUNDRY)).toBeNull();
  });

  it("accepts a single slot filling the whole opening", () => {
    expect(
      checkResourceSchedule({ ...LAUNDRY, slotMinutes: 14 * 60 }),
    ).toBeNull();
  });

  it("accepts a day running to midnight", () => {
    // 1440 is the closing bound: a sauna open until midnight is an ordinary
    // configuration, and rejecting it would push the board to 23:59.
    expect(
      checkResourceSchedule({
        ...LAUNDRY,
        opensAtMinute: 0,
        closesAtMinute: 1440,
        slotMinutes: 60,
      }),
    ).toBeNull();
  });

  it.each([
    ["slotMinutes", { slotMinutes: null }],
    ["opensAtMinute", { opensAtMinute: null }],
    ["closesAtMinute", { closesAtMinute: null }],
  ])("refuses a schedule missing %s", (_field, missing) => {
    expect(checkResourceSchedule({ ...LAUNDRY, ...missing })).toBe(
      "schedule-required",
    );
  });

  it("refuses a slot length of zero", () => {
    expect(checkResourceSchedule({ ...LAUNDRY, slotMinutes: 0 })).toBe(
      "schedule-required",
    );
  });

  it("refuses a slot longer than a day", () => {
    expect(checkResourceSchedule({ ...LAUNDRY, slotMinutes: 1441 })).toBe(
      "schedule-required",
    );
  });

  it("refuses a fractional slot length", () => {
    // Minutes are whole minutes. A slot of 90.5 would generate times no clock
    // in the building shows.
    expect(checkResourceSchedule({ ...LAUNDRY, slotMinutes: 90.5 })).toBe(
      "schedule-required",
    );
  });

  it("refuses an opening time past the end of the day", () => {
    expect(checkResourceSchedule({ ...LAUNDRY, opensAtMinute: 1440 })).toBe(
      "schedule-required",
    );
  });

  it("refuses a closing time before the opening", () => {
    expect(
      checkResourceSchedule({
        ...LAUNDRY,
        opensAtMinute: 21 * 60,
        closesAtMinute: 7 * 60,
      }),
    ).toBe("closes-before-opens");
  });

  it("refuses a closing time equal to the opening", () => {
    // A day that opens and closes at the same minute holds no slots, which is
    // a resource nobody can book rather than one that is closed.
    expect(checkResourceSchedule({ ...LAUNDRY, closesAtMinute: 7 * 60 })).toBe(
      "closes-before-opens",
    );
  });

  it("refuses a slot length that leaves a remainder", () => {
    // 07:00 to 21:00 is 840 minutes, which three-hour slots do not divide. The
    // remainder has to be the board's decision rather than something slot
    // generation quietly discards or offers as a short booking.
    expect(checkResourceSchedule({ ...LAUNDRY, slotMinutes: 180 })).toBe(
      "slot-does-not-fit",
    );
  });

  it("refuses a slot longer than the opening hours", () => {
    expect(checkResourceSchedule({ ...LAUNDRY, slotMinutes: 15 * 60 })).toBe(
      "slot-does-not-fit",
    );
  });
});

describe("whole day and date range", () => {
  it.each<ResourceSchedule["mode"]>(["WHOLE_DAY", "DATE_RANGE"])(
    "accepts %s with no hours at all",
    (mode) => {
      expect(checkResourceSchedule({ ...COMMON_ROOM, mode })).toBeNull();
    },
  );

  it.each([
    ["a slot length", { slotMinutes: 120 }],
    ["an opening time", { opensAtMinute: 420 }],
    ["a closing time", { closesAtMinute: 1260 }],
  ])("refuses a whole-day resource carrying %s", (_what, extra) => {
    // Dead configuration is the worst kind: the board could change it and
    // nothing would happen, while the screen reads as though it did.
    expect(checkResourceSchedule({ ...COMMON_ROOM, ...extra })).toBe(
      "schedule-not-applicable",
    );
  });

  it("refuses a guest apartment carrying opening hours", () => {
    expect(
      checkResourceSchedule({
        mode: "DATE_RANGE",
        slotMinutes: null,
        opensAtMinute: 15 * 60,
        closesAtMinute: 11 * 60,
      }),
    ).toBe("schedule-not-applicable");
  });
});
