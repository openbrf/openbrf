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
    // Supplying the register onward to Lantmateriet. The board is the anmalare
    // the statute names (Lag (2026:485) 3 §, and Forordning (2026:898) 5 kap. 9
    // § lets a styrelseledamot make the association's anmalan), so if the seat
    // did not hold this nobody an association actually has would.
    "registerReport:export",
    "invitation:send",
    "signupRequest:decide",
    "bookings:book",
    "bookings:manage",
    "bookings:configure",
    "events:manage",
    "events:attend",
    // Arranging the general meeting and keeping its record. The board calls the
    // meeting (EFL 6 kap. 16 §), the board's chair or whoever it appointed opens
    // it (26 §), the voting register is drawn up by whoever opened it or by the chair
    // the meeting elected (27 §), and the chair sees that a protokoll is kept
    // (39 §).
    "meetings:manage",
    // Answering a notice about the house is part of living in it, and a board
    // member lives here too. Moderating one of those answers is site:manage,
    // which the board already holds for publishing in the cooperative's name.
    "news:comment",
    "site:manage",
    // Putting a one-off cost on a member or an apartment, and handing the
    // debiting list to whoever keeps the books. Running the cooperative's
    // economy is the board's, the way publishing in its name is.
    "memberCharges:manage",
    // The association is the controller and GDPR art. 5(2) makes it answerable
    // for showing that it processes lawfully. That answerability is the board's
    // own, so the seat holds it rather than borrowing it from an administrator.
    "dataProtection:manage",
    // Giving or refusing the association's consent to a letting in andra hand.
    // BRL 7 kap. 10 § names the styrelse as who gives it, and 11 § makes the
    // board the association's side of the rent tribunal proceeding that follows
    // a refusal.
    "sublets:handle",
    // Handing out a key to the building. The board's because it is the
    // association's own property, and a board member lives here too, so the
    // ordering half comes with the seat as bookings:book does.
    "keyOrders:place",
    "keyOrders:handle",
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
    // The association's account of what it does with its residents' data, and
    // of which contractors receive it, is no part of handling issues.
    "dataProtection:manage",
    "addressBook:read",
    "addressBook:write",
    "memberRegister:read",
    "apartmentRegister:read",
    "protectedData:reveal",
    // And never the supply to Lantmateriet. It carries every holder's personal
    // identity number, and an external contractor is not the anmalare for any
    // of it.
    "registerReport:export",
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
    // Nor the general meeting those motions go to. The members' decisions about
    // their own association are no part of a contractor's work, and the list of
    // who was in the room is resident data they have no business reading.
    "meetings:manage",
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
    // What the association charges its members is its business with its own
    // members. The economic manager who receives the list has no account here
    // at all, and the property manager who has one handles issues.
    "memberCharges:manage",
    // What a member does with their own tenant-ownership is the members'
    // business with their own association.
    "sublets:apply",
    "sublets:handle",
    // And a key to the building is the household's and the board's. An order
    // list names residents and their apartments, which is the address book in
    // another shape - and decision 11 keeps this party out of it.
    "keyOrders:place",
    "keyOrders:handle",
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
    // Nor is asking for a way in through the front door. No statute gives
    // anybody a right to a key, so this follows living here rather than holding
    // the tenant-ownership - a partner, an adult child and a tenant all need
    // one.
    "keyOrders:place",
  ])("a resident can %s", (capability) => {
    expect(can({ isResident: true }, capability)).toBe(true);
  });

  it.each<Capability>([
    "addressBook:read",
    "memberRegister:read",
    "apartmentRegister:read",
    "protectedData:reveal",
    "registerReport:export",
    "association:manage",
    "dataProtection:manage",
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
    // A member is told what they are charged by the notice the accounting
    // system sends. What Open BRF holds is the basis, and reading it is the
    // board's; a member reaches their own charges through the data subject
    // access report instead.
    "memberCharges:manage",
    // A resident orders a key for their own door; answering the queue those
    // orders arrive in is the board's.
    "keyOrders:handle",
  ])("a resident is denied %s", (capability) => {
    expect(can({ isResident: true }, capability)).toBe(false);
  });

  it("gives a member exactly the two capabilities a resident does not hold", () => {
    /*
     * The only place where membership rather than residency decides access, and
     * both differences are statutes rather than product choices.
     *
     * EFL 6 kap. 15 § gives the right to have an item taken up at a general
     * meeting to a member, and BRL 9 kap. 14 § applies that chapter to a
     * housing cooperative with six exceptions of which this is not one. BRL
     * 7 kap. 10 § forsta stycket gives the act of letting in andra hand to a
     * bostadsrattshavare, about "sin lagenhet". So a partner, an adult child or
     * a tenant living here holds neither.
     *
     * Written as the exact difference rather than as a containment: a
     * capability that quietly widened to every resident would still satisfy
     * "a member holds at least what a resident holds". The list is also what
     * makes a capability added to MEMBER_CAPABILITIES without a statute behind
     * it fail here rather than pass unnoticed.
     *
     * Ordering a key is deliberately not on this list. Nothing gives anybody a
     * right to one, so it follows living here - which is the decision the key
     * order module states and this assertion pins.
     *
     * Everything else about membership stays out of the capability model. A
     * member's right to their own apartment register entry is a per-apartment
     * check rather than a capability.
     */
    const member = capabilitiesFor(roles({ isResident: true, isMember: true }));
    const resident = capabilitiesFor(roles({ isResident: true }));
    const extra = [...member].filter((capability) => !resident.has(capability));
    expect([...extra].sort()).toEqual(["motions:submit", "sublets:apply"]);
  });

  it("denies a resident who is not a member the motion right", () => {
    // The same statute stated on its own, so a slip that granted it to
    // residents fails here as well as in the difference above.
    expect(can({ isResident: true }, "motions:submit")).toBe(false);
    expect(can({ isResident: true, isMember: true }, "motions:submit")).toBe(
      true,
    );
  });

  it("denies a resident who is not a member the subletting application", () => {
    // BRL 7 kap. 10 § forsta stycket gives it to the bostadsrattshavare and to
    // nobody else in the flat. Stated on its own as well as in the difference
    // above, so a slip that granted it to residents fails twice.
    expect(can({ isResident: true }, "sublets:apply")).toBe(false);
    expect(can({ isResident: true, isMember: true }, "sublets:apply")).toBe(
      true,
    );
  });

  it("gives a resident who is not a member the key order", () => {
    // The deliberate opposite of the two above, and the reason the key order
    // module decided it separately: no statute gives a right to a key, so a
    // tenant living here on a second-hand contract orders one exactly as a
    // member does.
    expect(can({ isResident: true }, "keyOrders:place")).toBe(true);
  });

  it("does not let a board seat stand in for membership", () => {
    // The right attaches to the tenant-ownership and not to the office. A board
    // member who holds no tenant-ownership works both queues and holds neither
    // right to put something into them.
    expect(can({ isBoardMember: true }, "motions:handle")).toBe(true);
    expect(can({ isBoardMember: true }, "motions:submit")).toBe(false);
    expect(can({ isBoardMember: true }, "sublets:handle")).toBe(true);
    expect(can({ isBoardMember: true }, "sublets:apply")).toBe(false);
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
