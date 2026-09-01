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

  it("is not offered bookings, because they do not live in the building", () => {
    // The capability model grants them neither half of the module, and the
    // navigation must not offer a door the grant list does not open: a laundry
    // hour held by an external contractor is an hour taken from a household.
    expect(PROPERTY_MANAGER).not.toContain("bookings:book");
    expect(PROPERTY_MANAGER).not.toContain("bookings:manage");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/bookings");
  });

  it("is not offered motions, which are the members' own business", () => {
    // The capability model grants them neither half of the module: a motion is a
    // member exercising a right under EFL 6 kap. 15 §, and the queue it arrives
    // in is the board's. An external contractor is on neither side of that.
    expect(PROPERTY_MANAGER).not.toContain("motions:submit");
    expect(PROPERTY_MANAGER).not.toContain("motions:handle");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/motions");
  });

  it("is not offered the event calendar either, for the same reason", () => {
    // The capability model grants them neither half of the module: putting your
    // name down for the cleaning day is part of living here, and arranging what
    // the association does is the board's. An external contractor is on neither
    // side of that, and a place they took would be a place taken from a
    // household.
    expect(PROPERTY_MANAGER).not.toContain("events:attend");
    expect(PROPERTY_MANAGER).not.toContain("events:manage");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/events");
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
  it("offers a resident who is not a member everything but motions", () => {
    /*
     * The capabilities a resident actually holds, and motions:submit is not among
     * them: it is derived from membership rather than from residency, because EFL
     * 6 kap. 15 § gives the right to put an item to a general meeting to a member
     * and BRL 9 kap. 14 § applies that chapter unchanged. A partner, an adult
     * child or a tenant lives here and has no such right.
     */
    expect(
      destinations([
        "self:manage",
        "residentDirectory:read",
        "issues:report",
        "bookings:book",
        "events:attend",
      ]),
    ).toEqual([
      "/",
      "/settings",
      "/issues",
      "/bookings",
      "/events",
      "/documents",
    ]);
  });

  it("offers a member the motions destination as well", () => {
    // The same seat with the tenant-ownership: one more capability, one more
    // destination, and the difference is the statute.
    expect(
      destinations([
        "self:manage",
        "residentDirectory:read",
        "issues:report",
        "bookings:book",
        "events:attend",
        "motions:submit",
      ]),
    ).toEqual([
      "/",
      "/settings",
      "/issues",
      "/bookings",
      "/events",
      "/motions",
      "/documents",
    ]);
  });

  it("offers the board everything its capabilities reach", () => {
    expect(
      destinations([
        "association:read",
        "addressBook:read",
        "self:manage",
        "issues:report",
        "issues:handle",
        "documents:manage",
        "bookings:book",
        "bookings:manage",
        "bookings:configure",
        "events:attend",
        "events:manage",
        "motions:handle",
      ]),
    ).toEqual([
      "/",
      "/plugins",
      "/settings",
      "/issues",
      "/bookings",
      "/events",
      "/motions",
      "/documents",
    ]);
  });

  it("offers motions to a board member who holds no tenant-ownership", () => {
    // Any of the two, not all of them. A board seat carries motions:handle and
    // never motions:submit - the right to put an item belongs to the membership
    // and not to the office - so an entry gated on submit alone would hide the
    // queue from the seat that exists to work it.
    expect(destinations(["motions:handle"])).toContain("/motions");
    expect(destinations(["motions:submit"])).toContain("/motions");
  });

  it("offers bookings to whoever runs the calendar without holding a slot", () => {
    // Any of the two, not all of them. The board holds both halves today, so
    // an entry gated on bookings:book alone would pass every assertion above
    // and still hide the calendar from a seat granted only the running of it.
    expect(destinations(["bookings:manage"])).toContain("/bookings");
  });

  it("offers the calendar to whoever arranges it without attending it", () => {
    // Any of the two, not all of them. The board holds both halves today, so an
    // entry gated on events:attend alone would pass every assertion above and
    // still hide the calendar from a seat granted only the arranging of it.
    expect(destinations(["events:manage"])).toContain("/events");
    expect(destinations(["events:attend"])).toContain("/events");
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
