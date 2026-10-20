import { describe, expect, it } from "vite-plus/test";

import {
  type Capability,
  capabilitiesFor,
} from "../authorization/capabilities";
import { offeredSection } from "./plugin-view-offer";

/**
 * Who the navigation offers a plugin's view to.
 *
 * Read against the seats the product actually grants rather than hand-written
 * capability lists, so a change to what a seat holds shows up here as a change
 * to who is offered a plugin's entry.
 */

const NOBODY = {
  isAdmin: false,
  isBoardMember: false,
  isPropertyManager: false,
  isResident: false,
  isMember: false,
};

const resident = capabilitiesFor({ ...NOBODY, isResident: true });
const board = capabilitiesFor({ ...NOBODY, isBoardMember: true });
const admin = capabilitiesFor({ ...NOBODY, isAdmin: true });
const propertyManager = capabilitiesFor({
  ...NOBODY,
  isPropertyManager: true,
});

/** The floors a plugin's routes are raised to; see routeCapabilityFloor. */
const OPEN: Capability = "self:manage";
const REGISTER: Capability = "addressBook:read";

describe("offeredSection", () => {
  it("offers nothing for a view that names no section", () => {
    expect(offeredSection(undefined, OPEN, resident)).toBeNull();
    expect(offeredSection(undefined, OPEN, board)).toBeNull();
  });

  it("offers a view whose routes are open to every account in the section it names", () => {
    expect(offeredSection("building", OPEN, resident)).toBe("building");
    expect(offeredSection("association", OPEN, board)).toBe("association");
    expect(offeredSection("settings", OPEN, propertyManager)).toBe("settings");
  });

  it("offers a view whose routes read the register only to whoever may read it", () => {
    expect(offeredSection("association", REGISTER, resident)).toBeNull();
    expect(offeredSection("association", REGISTER, propertyManager)).toBeNull();
    expect(offeredSection("association", REGISTER, board)).toBe("association");
    expect(offeredSection("association", REGISTER, admin)).toBe("association");
  });

  // The board's section holds nothing a resident is offered, whatever the
  // plugin's routes would admit.
  it("offers a view in the board's section to the board and the administrator alone", () => {
    expect(offeredSection("board", OPEN, resident)).toBeNull();
    expect(offeredSection("board", OPEN, propertyManager)).toBeNull();
    expect(offeredSection("board", OPEN, board)).toBe("board");
    expect(offeredSection("board", OPEN, admin)).toBe("board");
  });
});
