import { describe, expect, it } from "vitest";

import {
  isHeldOn,
  latestTermEnd,
  parseCalendarDate,
  refuseTermEnd,
  RoleChangeError,
  revokingWouldLeaveNoAdministrator,
  toCalendarDate,
} from "./role-changes";

/**
 * The rules that decide a role change, asserted without a database.
 *
 * Each is about a combination rather than about a single column - which seats
 * are held at a moment, which date a seat can be given against the dates it
 * carries already, which people hold a grant when one of them is being taken
 * away - and the cases that matter are exactly the ones a fixture would be
 * clumsy at reaching: a term that ends in the future, a year typed with the
 * wrong century, an administrator revoking their own grant, a revoke aimed at
 * somebody who never held the role.
 */

const NOW = new Date("2026-06-01T12:00:00Z");

describe("whether a seat is held", () => {
  it("counts an open term as held", () => {
    expect(isHeldOn({ endedOn: null }, NOW)).toBe(true);
  });

  it("counts a term that has run out as not held", () => {
    expect(isHeldOn({ endedOn: new Date("2026-05-31T00:00:00Z") }, NOW)).toBe(
      false,
    );
  });

  it("counts a term ending in the future as still held", () => {
    /*
     * The rule the principal applies, and it has to be the same one. A board
     * recording in April that a term runs to the annual meeting keeps that
     * person's access until the date arrives; a register that treated the row
     * as spent the moment the date was written would take the access away on
     * the day the board wrote down when it should end.
     */
    expect(isHeldOn({ endedOn: new Date("2026-12-31T00:00:00Z") }, NOW)).toBe(
      true,
    );
  });
});

describe("the date a term is recorded as ending on", () => {
  const ELECTED_ON = new Date("2026-04-14T00:00:00Z");

  const refuse = (endedOn: string, currentEndedOn: Date | null = null) =>
    refuseTermEnd({
      electedOn: ELECTED_ON,
      currentEndedOn,
      endedOn: new Date(`${endedOn}T00:00:00Z`),
      now: NOW,
    });

  it("takes the day of the election itself", () => {
    // A term of one day is odd and not impossible: a person elected and
    // standing down at the same meeting sat, and the register says so.
    expect(refuse("2026-04-14")).toBeNull();
  });

  it("takes a date in the past, which closes the term at once", () => {
    expect(refuse("2026-05-01")).toBeNull();
  });

  it("takes a date running to next year's annual meeting", () => {
    expect(refuse("2027-04-14")).toBeNull();
  });

  it("refuses a term ending before the election that began it", () => {
    expect(refuse("2026-04-13")).toBe("ended-before-elected");
  });

  it("refuses a year typed with the wrong century", () => {
    /*
     * The mistake this bound exists for. A seat goes on conferring what a
     * board member holds - the protected data reveal, the member register,
     * the apartment register - until its end date arrives, so 2206 for 2026
     * is not a wrong date on a screen but 180 years of access.
     */
    expect(refuse("2206-04-14")).toBe("ended-too-far-ahead");
  });

  it("takes the last day inside the horizon and refuses the next one", () => {
    const horizon = latestTermEnd(NOW);
    expect(horizon.toISOString()).toBe("2031-06-01T00:00:00.000Z");
    expect(refuse("2031-06-01")).toBeNull();
    expect(refuse("2031-06-02")).toBe("ended-too-far-ahead");
  });

  it("lets a term still running be given a different end date", () => {
    /*
     * The correction path. A date mistyped into the future is refused by the
     * bound above, but a plausible wrong one - next April instead of this one
     * - is not, and it has to be correctable from the application: the seat is
     * conferring the board's capabilities for as long as the date stands, and
     * an uncorrectable date means a hand in the database.
     */
    expect(refuse("2026-06-30", new Date("2027-04-14T00:00:00Z"))).toBeNull();
  });

  it("still refuses an impossible date on a term still running", () => {
    expect(refuse("2206-04-14", new Date("2027-04-14T00:00:00Z"))).toBe(
      "ended-too-far-ahead",
    );
    expect(refuse("2026-04-13", new Date("2027-04-14T00:00:00Z"))).toBe(
      "ended-before-elected",
    );
  });

  it("refuses a term whose end date has passed", () => {
    // Settled rather than amendable: the seat stopped conferring on that day,
    // and the period it covered is the answer to who answered for the
    // association while it ran.
    expect(refuse("2026-06-30", new Date("2026-05-31T00:00:00Z"))).toBe(
      "term-already-ended",
    );
  });

  it("treats the day the term ends as past, like the principal does", () => {
    // isHeldOn is strict: a seat ending today stopped granting at midnight.
    // The two rules read the same row the same way, which is the point of
    // deciding both here.
    expect(refuse("2026-07-01", new Date("2026-06-01T00:00:00Z"))).toBe(
      "term-already-ended",
    );
  });
});

describe("the lockout guard", () => {
  const guard = (
    administratorPersonIds: readonly string[],
    targetPersonId: string,
  ): boolean =>
    revokingWouldLeaveNoAdministrator({
      role: "ADMIN",
      administratorPersonIds,
      targetPersonId,
    });

  it("refuses the last administrator", () => {
    expect(guard(["anna"], "anna")).toBe(true);
  });

  it("refuses an administrator revoking their own last grant", () => {
    // The way an instance actually loses its last administrator: somebody
    // tidying up their own account, not somebody removing a colleague. The
    // rule cannot tell the two apart, and must not need to.
    expect(guard(["anna"], "anna")).toBe(true);
  });

  it("allows one of two administrators to be revoked", () => {
    expect(guard(["anna", "bo"], "anna")).toBe(false);
    expect(guard(["anna", "bo"], "bo")).toBe(false);
  });

  it("allows a revoke aimed at somebody who is not an administrator", () => {
    // Not a lockout: it changes nothing. Answering otherwise would refuse a
    // no-op merely because exactly one administrator happens to exist, which
    // is why the rule takes the ids rather than a count.
    expect(guard(["anna"], "bo")).toBe(false);
  });

  it("allows the property manager grant to be revoked from its only holder", () => {
    // The guard is about the way back in, and the property manager grant is
    // not one: it opens the issue queue and nothing else.
    expect(
      revokingWouldLeaveNoAdministrator({
        role: "PROPERTY_MANAGER",
        administratorPersonIds: ["anna"],
        targetPersonId: "anna",
      }),
    ).toBe(false);
  });

  it("allows a revoke when the instance holds no administrator at all", () => {
    /*
     * Unreachable through the service, which reads the holders of the role it
     * is changing in the same transaction, but stated so the rule reads the
     * same in isolation. Nobody holds the grant here, the target included, so
     * the revoke takes nothing away and there is no last administrator to
     * keep: the guard is about the way back in, and this instance has already
     * lost it by some other route.
     */
    expect(guard([], "anna")).toBe(false);
  });
});

describe("a refused role change", () => {
  it("answers 404 for something the register does not hold", () => {
    expect(new RoleChangeError("gone", "person-not-found").status).toBe(404);
    expect(new RoleChangeError("gone", "board-position-not-found").status).toBe(
      404,
    );
  });

  it("answers 409 for a state the register is not in", () => {
    for (const reason of [
      "position-already-held",
      "term-already-ended",
      "ended-before-elected",
      "ended-too-far-ahead",
      "last-administrator",
    ] as const) {
      expect(new RoleChangeError("no", reason).status).toBe(409);
    }
  });

  it("carries the reason a client reacts to rather than the prose", () => {
    // The interface renders its own sentence in its own language; the message
    // is for the server log and for whoever is reading a response by hand.
    expect(new RoleChangeError("no", "last-administrator").reason).toBe(
      "last-administrator",
    );
  });
});

describe("register dates", () => {
  it("reads a calendar date as the day it names", () => {
    expect(parseCalendarDate("2026-04-14").toISOString()).toBe(
      "2026-04-14T00:00:00.000Z",
    );
  });

  it("writes a date back as the day and not the instant", () => {
    expect(toCalendarDate(new Date("2026-04-14T23:59:00.000Z"))).toBe(
      "2026-04-14",
    );
  });

  it("round-trips", () => {
    expect(toCalendarDate(parseCalendarDate("2026-04-14"))).toBe("2026-04-14");
  });
});
