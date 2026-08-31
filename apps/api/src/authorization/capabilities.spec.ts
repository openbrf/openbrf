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
  ])("a resident is denied %s", (capability) => {
    expect(can({ isResident: true }, capability)).toBe(false);
  });

  it("gives a member no more than a resident", () => {
    // Membership is about the tenant-ownership, not about system access. A
    // member's right to their own apartment register entry is a separate,
    // per-apartment check rather than a capability.
    const member = capabilitiesFor(roles({ isResident: true, isMember: true }));
    const resident = capabilitiesFor(roles({ isResident: true }));
    expect([...member].sort()).toEqual([...resident].sort());
  });
});

describe("external person with an account but no role", () => {
  it("can manage only their own record", () => {
    const granted = capabilitiesFor(NOBODY);
    expect([...granted]).toEqual(["self:manage"]);
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
