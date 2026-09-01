import { describe, expect, it } from "vitest";

import { attendeeOf, placesLeftOf } from "./event-signup.service";

/**
 * The two rules the sign-up service applies without asking the database.
 *
 * How many places are left, which has one case a screen cannot render and one a
 * board can create by lowering a capacity below what is already taken. And who a
 * roll-call may name, which is where the protected-personal-data promise is
 * either kept or quietly broken - the register masks those people everywhere
 * else, and a list of who is coming to the cleaning day is exactly the kind of
 * page that leaks a name nobody meant to publish.
 *
 * What the claim does under contention is `event-signups.int-spec.ts`: a lock and
 * a race have no meaning against a fake.
 */

describe("placesLeftOf", () => {
  it("is the capacity less the places taken", () => {
    expect(placesLeftOf(20, 3)).toBe(17);
  });

  it("is nothing left when the places are gone", () => {
    expect(placesLeftOf(20, 20)).toBe(0);
  });

  it("is no answer at all when the board set no limit", () => {
    // Null and not a large number: "how many places are left" has no answer for
    // an event that takes everybody, and a screen saying a figure would be
    // inventing one.
    expect(placesLeftOf(null, 40)).toBeNull();
  });

  it("floors at nothing when a capacity was lowered under what is taken", () => {
    /*
     * A board that offered twenty places and then lowered it to five has five
     * places and eight people. Nothing gives a place back - the sign-ups stand -
     * and "minus three places left" is not something a screen can say.
     */
    expect(placesLeftOf(5, 8)).toBe(0);
  });
});

const persons = new Map([
  [
    "person-1",
    {
      id: "person-1",
      firstName: "Rune",
      lastName: "Boende",
      protectedPersonalData: false,
    },
  ],
  [
    "person-2",
    {
      id: "person-2",
      firstName: "Signe",
      lastName: "Skyddad",
      protectedPersonalData: true,
    },
  ],
]);

describe("attendeeOf", () => {
  it("names a resident", () => {
    expect(attendeeOf("person-1", persons)).toEqual({
      kind: "resident",
      personId: "person-1",
      name: "Rune Boende",
    });
  });

  it("names a person with protected personal data to nobody", () => {
    /*
     * The whole promise, and it is asserted as the absence of the name rather
     * than as the presence of the marker: a view carrying `kind: "protected"` and
     * the name beside it would satisfy a test that only looked at the kind.
     *
     * The board's own address book prints these names because the statutory
     * register has a reason to. A roll-call has none, and it is read on a screen
     * in a stairwell doorway on a cleaning-day morning.
     */
    const view = attendeeOf("person-2", persons);

    expect(view).toEqual({ kind: "protected", personId: "person-2" });
    expect(JSON.stringify(view)).not.toContain("Signe");
    expect(JSON.stringify(view)).not.toContain("Skyddad");
  });

  it("says so when the person is no longer in the register", () => {
    // Sign-ups are service tier and a person can be purged out from under one,
    // so the roll-call has to be able to say "we no longer know" rather than
    // break. The row is still a place taken.
    expect(attendeeOf("person-gone", persons)).toEqual({ kind: "unknown" });
  });
});
