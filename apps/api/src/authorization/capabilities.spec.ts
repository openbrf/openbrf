import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  type Capability,
  capabilitiesFor,
  type PrincipalRoles,
} from "./capabilities";

/**
 * The authorization matrix from plan section 4.4, as a test.
 *
 * These assertions encode promises the product makes in writing, so a change
 * that breaks one is a change to the product, not to a detail: the property
 * manager never reaching the address book (decision 11), the confidential
 * apartment register staying with the board, and a board seat alone not being
 * able to reconfigure the instance.
 */

const NOBODY: PrincipalRoles = {
  isAdmin: false,
  isBoardMember: false,
  isPropertyManager: false,
  isResident: false,
  isMember: false,
};

const roles = (overrides: Partial<PrincipalRoles>): PrincipalRoles => ({
  ...NOBODY,
  ...overrides,
});

const can = (r: Partial<PrincipalRoles>, capability: Capability): boolean =>
  capabilitiesFor(roles(r)).has(capability);

describe("admin", () => {
  it("holds every capability", () => {
    const granted = capabilitiesFor(roles({ isAdmin: true }));
    for (const capability of CAPABILITIES) {
      expect(granted.has(capability)).toBe(true);
    }
  });
});

describe("board member", () => {
  it.each<Capability>([
    "association:read",
    "addressBook:read",
    "addressBook:write",
    "memberRegister:read",
    "apartmentRegister:read",
    "protectedData:reveal",
    "invitation:send",
    "signupRequest:decide",
    "bookings:book",
    "bookings:manage",
    "bookings:configure",
    "events:manage",
    "events:attend",
    // Answering a notice about the house is part of living in it, and a board
    // member lives here too. Moderating one of those answers is site:manage,
    // which the board already holds for publishing in the cooperative's name.
    "news:comment",
    "site:manage",
  ])("can %s", (capability) => {
    expect(can({ isBoardMember: true }, capability)).toBe(true);
  });

  it("can read the settings without being able to change them", () => {
    // The board answers for the retention policy and the self-signup toggle,
    // so it must be able to see them. Settings, plugins and themes stay with
    // an admin, so a board seat alone cannot reconfigure the instance.
    expect(can({ isBoardMember: true }, "association:read")).toBe(true);
    expect(can({ isBoardMember: true }, "association:manage")).toBe(false);
  });

  it("records its own election", () => {
    // A board is elected by the general meeting and the minute of that
    // election is the board's own to write down. An instance whose board could
    // only be recorded by an administrator would make the administrator the
    // gatekeeper of the association's constitution.
    expect(can({ isBoardMember: true }, "boardPosition:manage")).toBe(true);
  });

  it("cannot grant a system role, which is what stops a seat becoming admin", () => {
    /*
     * The load-bearing assertion of this file. A board member who could write
     * a system_role row could write themselves an ADMIN one, and every promise
     * above about settings, plugins and themes staying with an administrator
     * would be a convention rather than a boundary.
     *
     * Both grants are behind the one capability. The property manager grant
     * carries less than a board member already holds, so conferring it could
     * not be an escalation; it is here because a standing grant to somebody who
     * neither lives in the building nor was elected is the same kind of
     * decision as installing a plugin.
     */
    expect(can({ isBoardMember: true }, "systemRole:manage")).toBe(false);
  });
});

describe("property manager", () => {
  it("can handle issues", () => {
    expect(can({ isPropertyManager: true }, "issues:handle")).toBe(true);
  });

  it.each<Capability>([
    "addressBook:read",
    "addressBook:write",
    "memberRegister:read",
    "apartmentRegister:read",
    "protectedData:reveal",
    "residentDirectory:read",
    "association:manage",
    "association:read",
    // An external contractor confers nothing on anybody, in either direction:
    // not a seat on the board that hired them, and not a grant of their own.
    "boardPosition:manage",
    "systemRole:manage",
    // They handle the association's issues; they do not live in the building.
    // A laundry hour held by a contractor is an hour taken from a household,
    // and who has booked what is resident data they have no business reading.
    "bookings:book",
    "bookings:manage",
    "bookings:configure",
    // A motion is the members' business with their own association. An external
    // contractor neither puts one nor reads the queue they arrive in.
    "motions:submit",
    "motions:handle",
    // Nor the event calendar. Arranging what the association does is the
    // board's, and putting a name down for the cleaning day is a resident's -
    // a place taken by an external contractor is a place taken from a
    // household.
    "events:manage",
    "events:attend",
    // The conversation under a notice about the stairwell is the residents'
    // own, and moderating it is the board's.
    "news:comment",
    "site:manage",
  ])("is denied %s", (capability) => {
    // An external property manager must never reach the register: this is a
    // published product promise, not a default.
    expect(can({ isPropertyManager: true }, capability)).toBe(false);
  });

  it("gains nothing from also being a resident beyond resident access", () => {
    const granted = capabilitiesFor(
      roles({ isPropertyManager: true, isResident: true }),
    );
    expect(granted.has("addressBook:read")).toBe(false);
    expect(granted.has("residentDirectory:read")).toBe(true);
  });
});

describe("resident and member", () => {
  it.each<Capability>([
    "self:manage",
    "residentDirectory:read",
    // Booking the laundry room is part of living here, not a board activity.
    "bookings:book",
    // Nor is putting your name down for the cleaning day. It is a capability of
    // its own rather than self:manage, so an external person with an account and
    // no residency cannot take a place at something arranged for the house.
    "events:attend",
    // Nor is answering a notice the board put up.
    "news:comment",
  ])("a resident can %s", (capability) => {
    expect(can({ isResident: true }, capability)).toBe(true);
  });

  it.each<Capability>([
    "addressBook:read",
    "memberRegister:read",
    "apartmentRegister:read",
    "protectedData:reveal",
    "association:manage",
    "association:read",
    "invitation:send",
    "boardPosition:manage",
    "systemRole:manage",
    // A resident books for themselves. Seeing or cancelling a neighbour's
    // booking, and deciding what the house offers, are the board's.
    "bookings:manage",
    "bookings:configure",
    // A resident signs themselves up. Who else is coming, and arranging the
    // date at all, are the board's.
    "events:manage",
    // A resident writes a comment; hiding a neighbour's is the board's, and it
    // is the same capability the board publishes the website under.
    "site:manage",
  ])("a resident is denied %s", (capability) => {
    expect(can({ isResident: true }, capability)).toBe(false);
  });

  it("gives a member exactly one capability a resident does not hold", () => {
    /*
     * The one place where membership rather than residency decides access, and
     * the difference is a statute rather than a product choice.
     *
     * EFL 6 kap. 15 § gives the right to have an item taken up at a general
     * meeting to a member, and BRL 9 kap. 14 § applies that chapter to a
     * housing cooperative with six exceptions of which this is not one. So a
     * partner, an adult child or a tenant living here holds no motion right.
     *
     * Written as the exact difference rather than as a containment: a
     * capability that quietly widened to every resident would still satisfy
     * "a member holds at least what a resident holds".
     *
     * Everything else about membership stays out of the capability model. A
     * member's right to their own apartment register entry is a per-apartment
     * check rather than a capability.
     */
    const member = capabilitiesFor(roles({ isResident: true, isMember: true }));
    const resident = capabilitiesFor(roles({ isResident: true }));
    const extra = [...member].filter((capability) => !resident.has(capability));
    expect(extra).toEqual(["motions:submit"]);
  });

  it("denies a resident who is not a member the motion right", () => {
    // The same statute stated on its own, so a slip that granted it to
    // residents fails here as well as in the difference above.
    expect(can({ isResident: true }, "motions:submit")).toBe(false);
    expect(can({ isResident: true, isMember: true }, "motions:submit")).toBe(
      true,
    );
  });

  it("does not let a board seat stand in for membership", () => {
    // The right attaches to the tenant-ownership and not to the office. A board
    // member who holds no tenant-ownership works the queue and holds no right
    // to put an item into it.
    expect(can({ isBoardMember: true }, "motions:handle")).toBe(true);
    expect(can({ isBoardMember: true }, "motions:submit")).toBe(false);
    expect(
      can(
        { isBoardMember: true, isResident: true, isMember: true },
        "motions:submit",
      ),
    ).toBe(true);
  });
});

describe("external person with an account but no role", () => {
  it("can manage only their own record", () => {
    const granted = capabilitiesFor(NOBODY);
    expect([...granted]).toEqual(["self:manage"]);
  });

  it("cannot take a place at anything the association arranges", () => {
    // The reason events:attend is a capability rather than part of self:manage.
    // Somebody mid-onboarding holds their own record and nothing else, and a
    // sign-up folded into self:manage would have let them put their name down
    // for the general meeting.
    expect(can({}, "events:attend")).toBe(false);
    expect(can({}, "self:manage")).toBe(true);
  });
});

describe("combined roles", () => {
  it("gives an external admin full access without any residency", () => {
    // Admins and board members may be external to the association entirely,
    // which is why capabilities never depend on holding a residency.
    expect(can({ isAdmin: true }, "association:manage")).toBe(true);
    expect(can({ isAdmin: true }, "addressBook:read")).toBe(true);
  });

  it("leaves an administrator as the only one who may grant a system role", () => {
    // Stated as the union rather than per role, because the hazard is a
    // combination: somebody who is on the board and lives here and manages the
    // property still cannot grant themselves the administrator's rights.
    expect(
      capabilitiesFor(
        roles({
          isBoardMember: true,
          isPropertyManager: true,
          isResident: true,
          isMember: true,
        }),
      ).has("systemRole:manage"),
    ).toBe(false);
    expect(can({ isAdmin: true }, "systemRole:manage")).toBe(true);
  });

  it("unions capabilities rather than picking one role", () => {
    const granted = capabilitiesFor(
      roles({ isBoardMember: true, isPropertyManager: true }),
    );
    expect(granted.has("addressBook:read")).toBe(true);
    expect(granted.has("issues:handle")).toBe(true);
  });
});
