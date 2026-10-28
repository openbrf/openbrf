import { describe, expect, it } from "vite-plus/test";

import {
  type Capability,
  capabilitiesFor,
} from "../authorization/capabilities";
import {
  boardViewOffered,
  offeredSection,
  residentViewSection,
} from "./plugin-view-offer";

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
const OPEN: readonly Capability[] = ["self:manage"];
const REGISTER: readonly Capability[] = ["addressBook:read"];
const FINANCES: readonly Capability[] = ["fees:manage", "memberCharges:manage"];

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

  it("offers a view whose routes need both money capabilities only to whoever holds both", () => {
    const onlyFees = new Set<Capability>(["fees:manage", "addressBook:read"]);
    const both = new Set<Capability>([
      "fees:manage",
      "memberCharges:manage",
      "addressBook:read",
    ]);
    expect(offeredSection("association", FINANCES, resident)).toBeNull();
    expect(offeredSection("association", FINANCES, onlyFees)).toBeNull();
    expect(offeredSection("association", FINANCES, both)).toBe("association");
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

// A plugin that declares resident routes (ADR 0051): its view is offered on
// the account's residency rather than on its routes' floor.
describe("residentViewSection", () => {
  const boardResident = capabilitiesFor({
    ...NOBODY,
    isBoardMember: true,
    isResident: true,
  });

  it("offers the view to an account that holds a residency, without a board seat", () => {
    expect(residentViewSection("building", REGISTER, resident, true)).toBe(
      "building",
    );
    expect(residentViewSection("building", REGISTER, boardResident, true)).toBe(
      "building",
    );
  });

  // The routes behind it would refuse them all: the property manager, a
  // former resident, and a board member or administrator living elsewhere.
  it("offers it to nobody who holds no residency today, the board included", () => {
    expect(
      residentViewSection("building", REGISTER, resident, false),
    ).toBeNull();
    expect(residentViewSection("building", REGISTER, board, false)).toBeNull();
    expect(residentViewSection("building", REGISTER, admin, false)).toBeNull();
    expect(
      residentViewSection("building", REGISTER, propertyManager, false),
    ).toBeNull();
  });

  it("keeps the finance half of an extension group's floor", () => {
    const groupFloor: readonly Capability[] = [...REGISTER, ...FINANCES];

    expect(
      residentViewSection("building", groupFloor, resident, true),
    ).toBeNull();
    expect(
      residentViewSection("building", groupFloor, boardResident, true),
    ).toBe("building");
  });

  it("offers nothing for a view that names no section, or the board's", () => {
    expect(residentViewSection(undefined, REGISTER, resident, true)).toBeNull();
    expect(
      residentViewSection("board", REGISTER, boardResident, true),
    ).toBeNull();
  });
});

describe("boardViewOffered", () => {
  it("offers a board view to the board and the administrator holding its capability", () => {
    expect(boardViewOffered("bookings:configure", OPEN, board)).toBe(true);
    expect(boardViewOffered("bookings:configure", OPEN, admin)).toBe(true);
  });

  // Its capability narrows who among the board is offered it, and never opens
  // the board's section to a resident or the property manager.
  it("offers it to nobody without a board seat, whatever capability it declares", () => {
    expect(boardViewOffered("bookings:configure", OPEN, resident)).toBe(false);
    expect(boardViewOffered("bookings:book", OPEN, resident)).toBe(false);
    expect(boardViewOffered("issues:handle", OPEN, propertyManager)).toBe(
      false,
    );
  });

  it("offers it to no board seat without its capability", () => {
    const withoutIt = new Set(board);
    withoutIt.delete("bookings:configure");

    expect(boardViewOffered("bookings:configure", OPEN, withoutIt)).toBe(false);
  });

  it("offers it to no board seat below the routes' floor", () => {
    const withoutBothHalves = new Set(board);
    withoutBothHalves.delete("memberCharges:manage");

    expect(boardViewOffered("bookings:configure", FINANCES, board)).toBe(true);
    expect(
      boardViewOffered("bookings:configure", FINANCES, withoutBothHalves),
    ).toBe(false);
  });
});
