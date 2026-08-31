import { describe, expect, it } from "vitest";

import {
  isHeldOn,
  parseCalendarDate,
  RoleChangeError,
  revokingWouldLeaveNoAdministrator,
  toCalendarDate,
} from "./role-changes";

/**
 * The two rules that decide a role change, asserted without a database.
 *
 * Both are about combinations rather than about a single row - which seats are
 * open at a moment, which people hold a grant when one of them is being taken
 * away - and the cases that matter are exactly the ones a fixture would be
 * clumsy at reaching: a term that ends in the future, an administrator revoking
 * their own grant, a revoke aimed at somebody who never held the role.
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

  it("refuses when the instance has no administrator to lose but the target holds it", () => {
    // Unreachable through the service, which reads the holders of the role it
    // is changing, but stated so the rule reads the same in isolation: the
    // question is whether an administrator would be left.
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
