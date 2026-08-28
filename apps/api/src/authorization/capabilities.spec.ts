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
  it.each<Capability>(["self:manage", "residentDirectory:read"])(
    "a resident can %s",
    (capability) => {
      expect(can({ isResident: true }, capability)).toBe(true);
    },
  );

  it.each<Capability>([
    "addressBook:read",
    "memberRegister:read",
    "apartmentRegister:read",
    "protectedData:reveal",
    "association:manage",
    "association:read",
    "invitation:send",
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

  it("unions capabilities rather than picking one role", () => {
    const granted = capabilitiesFor(
      roles({ isBoardMember: true, isPropertyManager: true }),
    );
    expect(granted.has("addressBook:read")).toBe(true);
    expect(granted.has("issues:handle")).toBe(true);
  });
});
