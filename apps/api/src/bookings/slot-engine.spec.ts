import { describe, expect, it } from "vitest";

import {
  daysIn,
  generateSlots,
  MAX_BOOKING_NIGHTS,
  periodFor,
  type SlotResource,
} from "./slot-engine";
import {
  addLocalDays,
  instantAt,
  type LocalDay,
  localMinuteOf,
  type Period,
} from "./stockholm-calendar";

/** A laundry room open 07:00 to 21:00 in two-hour slots: seven a day. */
const LAUNDRY: SlotResource = {
  mode: "TIME_SLOTS",
  slotMinutes: 120,
  opensAtMinute: 7 * 60,
  closesAtMinute: 21 * 60,
};

/** A sauna nobody has to sleep next to, open around the clock by the hour. */
const ROUND_THE_CLOCK: SlotResource = {
  mode: "TIME_SLOTS",
  slotMinutes: 60,
  opensAtMinute: 0,
  closesAtMinute: 24 * 60,
};

const COMMON_ROOM: SlotResource = {
  mode: "WHOLE_DAY",
  slotMinutes: null,
  opensAtMinute: null,
  closesAtMinute: null,
};

const GUEST_APARTMENT: SlotResource = {
  mode: "DATE_RANGE",
  slotMinutes: null,
  opensAtMinute: null,
  closesAtMinute: null,
};

/** In 2027 the clocks go forward on this Sunday, from 02:00 to 03:00. */
const MARCH_SUNDAY: LocalDay = { year: 2027, month: 3, day: 28 };
/** And back on this one, from 03:00 to 02:00. */
const OCTOBER_SUNDAY: LocalDay = { year: 2027, month: 10, day: 31 };
const ORDINARY_DAY: LocalDay = { year: 2027, month: 6, day: 10 };

const HOUR_MS = 60 * 60 * 1000;

function hoursIn(slots: Period[]): number {
  return slots.reduce(
    (total, slot) =>
      total + (slot.endsAt.getTime() - slot.startsAt.getTime()) / HOUR_MS,
    0,
  );
}

function openingMinutes(slots: Period[]): number[] {
  return slots.map((slot) => localMinuteOf(slot.startsAt));
}

/** The instant a local time of day names, for a fixture that needs one. */
function at(day: LocalDay, minuteOfDay: number): Date {
  const instant = instantAt(day, minuteOfDay);
  if (instant === null) {
    throw new Error("The fixture asked for a local time that does not exist.");
  }
  return instant;
}

describe("a resource booked in time slots", () => {
  it("cuts an ordinary day into whole slots", () => {
    const slots = generateSlots(LAUNDRY, ORDINARY_DAY, ORDINARY_DAY);

    expect(slots).toHaveLength(7);
    expect(openingMinutes(slots)).toEqual([
      420, 540, 660, 780, 900, 1020, 1140,
    ]);
    expect(hoursIn(slots)).toBe(14);
  });

  it("offers nothing outside the opening hours", () => {
    const slots = generateSlots(LAUNDRY, ORDINARY_DAY, ORDINARY_DAY);
    const last = slots.at(-1);

    // Twenty-one hundred is the closing time, so the last slot ends there and
    // no slot begins there. A resource that offered its closing time would let
    // somebody book the two hours after the room is locked.
    expect(localMinuteOf(at(ORDINARY_DAY, 21 * 60))).toBe(1260);
    expect(last?.endsAt.getTime()).toBe(at(ORDINARY_DAY, 21 * 60).getTime());
    expect(openingMinutes(slots)).not.toContain(1260);
  });

  it("runs a day to midnight when the board closes it there", () => {
    const slots = generateSlots(ROUND_THE_CLOCK, ORDINARY_DAY, ORDINARY_DAY);

    expect(slots).toHaveLength(24);
    expect(hoursIn(slots)).toBe(24);
  });

  it("keeps every day's slots inside that day", () => {
    const slots = generateSlots(LAUNDRY, ORDINARY_DAY, {
      year: 2027,
      month: 6,
      day: 11,
    });

    // Fourteen and not fifteen: nine in the evening to seven the next morning
    // is the room being shut, and pairing boundaries across the night would
    // have offered it as a ten-hour slot.
    expect(slots).toHaveLength(14);
    expect(hoursIn(slots)).toBe(28);
  });

  it("offers nothing for a range that ends before it begins", () => {
    expect(
      generateSlots(LAUNDRY, ORDINARY_DAY, { year: 2027, month: 6, day: 9 }),
    ).toEqual([]);
  });

  it("offers nothing for a schedule the catalogue would not have stored", () => {
    // Unreachable through the service, which refuses to save this. An empty
    // day is the safe answer for a read: the resource is unbookable, which is
    // visible, rather than a server error on every calendar the house loads.
    expect(
      generateSlots(
        { ...LAUNDRY, slotMinutes: 180 },
        ORDINARY_DAY,
        ORDINARY_DAY,
      ),
    ).toEqual([]);
  });
});

describe("the Sunday the clocks go forward", () => {
  it("still opens the laundry room at seven", () => {
    const saturday = generateSlots(
      LAUNDRY,
      { year: 2027, month: 3, day: 27 },
      {
        year: 2027,
        month: 3,
        day: 27,
      },
    );
    const sunday = generateSlots(LAUNDRY, MARCH_SUNDAY, MARCH_SUNDAY);

    expect(openingMinutes(saturday)).toEqual(openingMinutes(sunday));
    expect(openingMinutes(sunday)[0]).toBe(7 * 60);
    // The same wall clock, an hour apart as instants: 06:00 UTC on the
    // Saturday and 05:00 on the Sunday. A generator that added 24 hours to the
    // previous day's slot would have put this at eight in the morning.
    expect(saturday[0]?.startsAt.toISOString()).toBe(
      "2027-03-27T06:00:00.000Z",
    );
    expect(sunday[0]?.startsAt.toISOString()).toBe("2027-03-28T05:00:00.000Z");
  });

  it("gives a round-the-clock resource 23 hours in 23 slots", () => {
    const slots = generateSlots(ROUND_THE_CLOCK, MARCH_SUNDAY, MARCH_SUNDAY);

    // Two o'clock does not happen that day, so it is not offered; the slot
    // before it runs on to three, which is one real hour.
    expect(slots).toHaveLength(23);
    expect(openingMinutes(slots)).not.toContain(2 * 60);
    expect(openingMinutes(slots)).toContain(60);
    expect(hoursIn(slots)).toBe(23);
  });
});

describe("the Sunday the clocks go back", () => {
  it("still opens the laundry room at seven", () => {
    const saturday = generateSlots(
      LAUNDRY,
      { year: 2027, month: 10, day: 30 },
      { year: 2027, month: 10, day: 30 },
    );
    const sunday = generateSlots(LAUNDRY, OCTOBER_SUNDAY, OCTOBER_SUNDAY);

    expect(openingMinutes(saturday)).toEqual(openingMinutes(sunday));
    expect(openingMinutes(sunday)[0]).toBe(7 * 60);
    expect(saturday[0]?.startsAt.toISOString()).toBe(
      "2027-10-30T05:00:00.000Z",
    );
    expect(sunday[0]?.startsAt.toISOString()).toBe("2027-10-31T06:00:00.000Z");
  });

  it("gives a round-the-clock resource 25 hours in 24 slots", () => {
    const slots = generateSlots(
      ROUND_THE_CLOCK,
      OCTOBER_SUNDAY,
      OCTOBER_SUNDAY,
    );

    /*
     * The wall clock reads two o'clock for two hours that day, so the slot
     * labelled two o'clock is two hours long. Offering it twice instead would
     * put two rows reading 02:00 on the screen with nothing to tell them apart.
     */
    expect(slots).toHaveLength(24);
    expect(hoursIn(slots)).toBe(25);
    const repeated = slots.find(
      (slot) => localMinuteOf(slot.startsAt) === 2 * 60,
    );
    expect(
      (Number(repeated?.endsAt) - Number(repeated?.startsAt)) / HOUR_MS,
    ).toBe(2);
  });
});

describe("a resource booked a whole day at a time", () => {
  it("offers one slot per day, midnight to midnight", () => {
    const slots = generateSlots(COMMON_ROOM, ORDINARY_DAY, {
      year: 2027,
      month: 6,
      day: 12,
    });

    expect(slots).toHaveLength(3);
    expect(openingMinutes(slots)).toEqual([0, 0, 0]);
    expect(hoursIn(slots)).toBe(72);
  });

  it("gives the Sunday the clocks go back its 25 hours", () => {
    const slots = generateSlots(COMMON_ROOM, OCTOBER_SUNDAY, OCTOBER_SUNDAY);

    expect(hoursIn(slots)).toBe(25);
    expect(openingMinutes(slots)).toEqual([0]);
  });
});

describe("a resource booked by the night", () => {
  it("offers one night per day", () => {
    const nights = generateSlots(GUEST_APARTMENT, ORDINARY_DAY, {
      year: 2027,
      month: 6,
      day: 13,
    });

    expect(nights).toHaveLength(4);
    expect(openingMinutes(nights)).toEqual([0, 0, 0, 0]);
  });
});

describe("the period a request names", () => {
  it("accepts a slot the resource offers", () => {
    const period = periodFor(LAUNDRY, {
      startsAt: at(ORDINARY_DAY, 9 * 60),
      endsAt: null,
    });

    expect(period?.startsAt.toISOString()).toBe(
      at(ORDINARY_DAY, 9 * 60).toISOString(),
    );
    expect(period?.endsAt.toISOString()).toBe(
      at(ORDINARY_DAY, 11 * 60).toISOString(),
    );
  });

  it.each([
    ["half an hour late", 9 * 60 + 30],
    ["before the room opens", 6 * 60],
    ["after it closes", 22 * 60],
  ])("refuses a period starting %s", (_when, minute) => {
    // The request carries instants copied off the calendar, so anything that
    // is not a slot start was either typed or guessed.
    expect(
      periodFor(LAUNDRY, { startsAt: at(ORDINARY_DAY, minute), endsAt: null }),
    ).toBeNull();
  });

  it("refuses two slots as one booking", () => {
    // Two hours is one claim on the laundry room and four is two. The quota
    // counts claims, so a booking that spanned slots would spend one allowance
    // on twice the room.
    expect(
      periodFor(LAUNDRY, {
        startsAt: at(ORDINARY_DAY, 9 * 60),
        endsAt: at(ORDINARY_DAY, 13 * 60),
      }),
    ).toBeNull();
  });

  it("refuses a local time the clocks jumped over", () => {
    const asIfItExisted = new Date("2027-03-28T01:00:00.000Z");
    // 01:00 UTC that day is three in the morning locally, which is a slot the
    // round-the-clock resource does offer; half past two is not.
    expect(
      periodFor(ROUND_THE_CLOCK, { startsAt: asIfItExisted, endsAt: null }),
    ).not.toBeNull();
    expect(
      periodFor(ROUND_THE_CLOCK, {
        startsAt: new Date("2027-03-28T00:30:00.000Z"),
        endsAt: null,
      }),
    ).toBeNull();
  });

  it("accepts a stay of several nights", () => {
    const checkIn = at({ year: 2027, month: 6, day: 10 }, 0);
    const checkOut = at({ year: 2027, month: 6, day: 13 }, 0);

    const period = periodFor(GUEST_APARTMENT, {
      startsAt: checkIn,
      endsAt: checkOut,
    });

    expect(period?.startsAt.toISOString()).toBe(checkIn.toISOString());
    expect(period?.endsAt.toISOString()).toBe(checkOut.toISOString());
    expect(daysIn({ startsAt: checkIn, endsAt: checkOut })).toBe(3);
  });

  it("counts a stay across either clock change in nights", () => {
    const autumn = {
      startsAt: at({ year: 2027, month: 10, day: 30 }, 0),
      endsAt: at({ year: 2027, month: 11, day: 1 }, 0),
    };
    const spring = {
      startsAt: at({ year: 2027, month: 3, day: 27 }, 0),
      endsAt: at({ year: 2027, month: 3, day: 29 }, 0),
    };

    // Two nights each, and 49 and 47 hours. Anything dividing milliseconds by
    // 24 hours gets one of the two wrong whichever way it rounds.
    expect(daysIn(autumn)).toBe(2);
    expect(daysIn(spring)).toBe(2);
  });

  it("refuses a check-out that is not the end of a night", () => {
    expect(
      periodFor(GUEST_APARTMENT, {
        startsAt: at({ year: 2027, month: 6, day: 10 }, 0),
        endsAt: at({ year: 2027, month: 6, day: 13 }, 12 * 60),
      }),
    ).toBeNull();
  });

  it("refuses a stay longer than a month", () => {
    const checkIn: LocalDay = { year: 2027, month: 6, day: 1 };
    const withinTheCap = periodFor(GUEST_APARTMENT, {
      startsAt: at(checkIn, 0),
      endsAt: at(addLocalDays(checkIn, MAX_BOOKING_NIGHTS), 0),
    });
    const past = periodFor(GUEST_APARTMENT, {
      startsAt: at(checkIn, 0),
      endsAt: at(addLocalDays(checkIn, MAX_BOOKING_NIGHTS + 1), 0),
    });

    // A guest apartment held for months is a tenancy, which a board decides on
    // in writing rather than through a booking form.
    expect(withinTheCap).not.toBeNull();
    expect(past).toBeNull();
  });

  it("counts one day for a time slot", () => {
    expect(
      daysIn({
        startsAt: at(ORDINARY_DAY, 9 * 60),
        endsAt: at(ORDINARY_DAY, 11 * 60),
      }),
    ).toBe(1);
  });
});
