import { describe, expect, it } from "vitest";

import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import {
  capabilitiesFor,
  type Capability,
  type PrincipalRoles,
} from "../authorization/capabilities";
import { DataSubjectRequestController } from "./data-subject-request.controller";

/**
 * Which seat decides what happens to one named person's data.
 *
 * The pairing is the whole of this file, and it is a decision rather than a
 * detail. These routes are gated on the address book and not on
 * `dataProtection:manage`, because the two capabilities answer different
 * questions: the data protection screen holds the association's account of
 * itself - what it processes, what it agreed with whom, what went wrong - and
 * this decides whether one person's data is erased or stops being used. That is
 * a register decision of the same weight as entering a move-out, and it belongs
 * to whoever may write the register.
 *
 * The read is gated the same way as the write, because the ground a person gave
 * and the ground the board relied on both name a person and say something about
 * them.
 *
 * The moment a seat is added that may keep the association's compliance records
 * without being entitled to the register - an auditor, an external data
 * protection officer - this file is what says the routes already knew the
 * difference.
 */

/** Whether a seat holding these roles reaches a capability. */
function can(roles: PrincipalRoles, capability: Capability): boolean {
  return capabilitiesFor(roles).has(capability);
}

/** What the class demands of every route in it. */
function requiredOnClass(target: object): Capability[] | undefined {
  return Reflect.getMetadata(REQUIRED_CAPABILITIES, target) as
    Capability[] | undefined;
}

const BOARD: PrincipalRoles = {
  isAdmin: false,
  isBoardMember: true,
  isPropertyManager: false,
  isResident: false,
  isMember: false,
};

const PROPERTY_MANAGER: PrincipalRoles = {
  isAdmin: false,
  isBoardMember: false,
  isPropertyManager: true,
  isResident: false,
  isMember: false,
};

const RESIDENT: PrincipalRoles = {
  isAdmin: false,
  isBoardMember: false,
  isPropertyManager: false,
  isResident: true,
  isMember: true,
};

describe("the data subject request routes", () => {
  it("demands the register's read and its write, not the data protection screen's", () => {
    expect(requiredOnClass(DataSubjectRequestController)).toEqual([
      "addressBook:read",
      "addressBook:write",
    ]);
  });

  it("is open to the board, which holds both", () => {
    for (const capability of requiredOnClass(DataSubjectRequestController) ??
      []) {
      expect(can(BOARD, capability)).toBe(true);
    }
  });

  it("is closed to the external property manager and to a resident", () => {
    // Both hold issues:report or issues:handle and neither may write the
    // register, which is what deciding one of these requests amounts to.
    expect(can(PROPERTY_MANAGER, "addressBook:write")).toBe(false);
    expect(can(RESIDENT, "addressBook:write")).toBe(false);
  });
});
