import { describe, expect, it } from "vitest";

import { navItemsFor, NAV_ITEMS } from "./nav-items";

/**
 * Which destinations each seat is offered.
 *
 * The navigation is not an authorization boundary - the API refuses the calls
 * whatever the band shows - but one entry in this list carries a promise the
 * platform makes to a housing cooperative about an outside party, and a promise
 * is worth asserting where it can be read.
 */

const destinations = (capabilities: readonly string[] | undefined): string[] =>
  navItemsFor(capabilities).map((item) => item.to);

describe("the external property manager", () => {
  /**
   * Decision 11: access to issue handling, and never to the address book.
   *
   * These are the capabilities the model actually grants that seat, written out
   * rather than imported, so a change to the grant list shows up here as a
   * changed expectation rather than as a test that silently follows it.
   */
  const PROPERTY_MANAGER = ["issues:handle", "self:manage"];

  it("is offered the issue queue and their own settings, and nothing else", () => {
    expect(destinations(PROPERTY_MANAGER)).toEqual(["/settings", "/issues"]);
  });

  it("is not offered the address book", () => {
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/");
  });

  it("reaches issues without holding the reporting capability", () => {
    // They handle the association's issues; they do not live in the building,
    // so they never hold issues:report. An entry gated on that alone would hide
    // the queue from the one account whose whole purpose is to work it.
    expect(PROPERTY_MANAGER).not.toContain("issues:report");
    expect(destinations(PROPERTY_MANAGER)).toContain("/issues");
  });
});

describe("the other seats", () => {
  it("offers a resident the address book, settings and issues", () => {
    expect(
      destinations(["self:manage", "residentDirectory:read", "issues:report"]),
    ).toEqual(["/", "/settings", "/issues"]);
  });

  it("offers the board everything its capabilities reach", () => {
    expect(
      destinations([
        "association:read",
        "addressBook:read",
        "self:manage",
        "issues:report",
        "issues:handle",
      ]),
    ).toEqual(["/", "/plugins", "/settings", "/issues"]);
  });

  it("offers an account with no capabilities only what belongs to everyone", () => {
    expect(destinations([])).toEqual(["/settings"]);
  });

  it("holds the band still while the viewer is unknown", () => {
    // The entries with no capability requirement, so the band does not shuffle
    // its links once the viewer's capabilities arrive.
    expect(navItemsFor(undefined)).toEqual(NAV_ITEMS);
    expect(NAV_ITEMS.map((item) => item.to)).toEqual(["/settings"]);
  });
});
