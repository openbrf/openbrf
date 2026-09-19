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

  it("is not offered the general meeting, which is the members' own business", () => {
    // The capability model grants them nothing here: arranging a meeting,
    // summoning the members and minuting what they decided is the board's own
    // side of the members' business with their own association, and the list of
    // who was in the room is resident data. An external contractor is on neither
    // side of that.
    expect(PROPERTY_MANAGER).not.toContain("meetings:manage");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/meetings");
  });

  it("is not offered the news, which is addressed to the house", () => {
    // The capability model grants them news:comment no more than it grants them
    // a laundry hour: the board writes a notice to the people who live in the
    // building, and an outside contractor is not among them. Reading what the
    // association has published needs no account at all on its website.
    expect(PROPERTY_MANAGER).not.toContain("news:comment");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/news");
  });

  it("is never offered the board's own correspondence", () => {
    /*
     * The strongest form of decision 11 in this list. What arrives at the
     * board's address is whatever a resident, a bank or an authority chose to
     * write to their association, and a contractor engaged to fix the building
     * has no business reading it - which is also why the issue queue they do
     * read is a separate module: an issue is a report about the house, and a
     * letter to the board is not.
     */
    expect(PROPERTY_MANAGER).not.toContain("boardMailbox:handle");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/board-mailbox");
  });

  it("is not offered the fees, which are the board's own business", () => {
    // The capability model grants them nothing here, on the same reading as the
    // charges: what a household pays the association is its own business with
    // its own members, and an external contractor is on neither side of it.
    expect(PROPERTY_MANAGER).not.toContain("fees:manage");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/fees");
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
  it("offers the board's mailbox on the board's capability and on no other", () => {
    /*
     * One capability rather than an any-of list. Every resident may write to the
     * board; none of them may read what the neighbours wrote, so neither living
     * here nor holding the tenant-ownership opens this door - and handling issue
     * reports does not either.
     */
    expect(destinations(["boardMailbox:handle"])).toContain("/board-mailbox");
    expect(destinations(["issues:handle"])).not.toContain("/board-mailbox");
    expect(destinations(["residentDirectory:read"])).not.toContain(
      "/board-mailbox",
    );
    expect(destinations(["motions:submit"])).not.toContain("/board-mailbox");
  });

  it("offers the chat on one capability and on no other", () => {
    /*
     * One capability rather than an any-of list, although two kinds of room sit
     * behind it: the board's own deliberation, whose members are whoever holds a
     * seat, and a group, which somebody who lives here made. Which rooms there
     * are is the service's answer and never this list's, so the destination is
     * offered to everybody who can reach the endpoints at all.
     *
     * The property manager holds none of it: they handle the association's
     * issues, they were not elected to anything and they do not live here.
     */
    expect(destinations(["chat:participate"])).toContain("/chat");
    expect(destinations(["news:comment"])).not.toContain("/chat");
    expect(destinations(["residentDirectory:read"])).not.toContain("/chat");
    expect(destinations(["motions:submit"])).not.toContain("/chat");
    expect(destinations(["issues:handle"])).not.toContain("/chat");
  });

  it("keeps the fees and the charges on two capabilities", () => {
    /*
     * Two doors and two grants, although the board holds both today. Fixing the
     * avgifter is the board's standing task under BRL 9 kap. 13 § while a
     * debitering records an event, and a cooperative that gives its treasurer
     * the fee book while the whole board approves individual charges is a seat
     * split only two capabilities can express.
     */
    expect(destinations(["fees:manage"])).toContain("/fees");
    expect(destinations(["fees:manage"])).not.toContain("/charges");
    expect(destinations(["memberCharges:manage"])).toContain("/charges");
    expect(destinations(["memberCharges:manage"])).not.toContain("/fees");
  });

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
        "news:comment",
        "bookings:book",
        "events:attend",
        // A group is made by whoever wants one, so the destination is a
        // resident's as well - and what they find in it is the rooms they are
        // in, which is a question this list does not answer.
        "chat:participate",
      ]),
    ).toEqual([
      "/",
      "/settings",
      "/chat",
      "/issues",
      "/bookings",
      "/events",
      "/news",
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
        "news:comment",
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
      "/news",
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
        "news:comment",
        "bookings:book",
        "bookings:manage",
        "bookings:configure",
        "events:attend",
        "events:manage",
        "motions:handle",
        "meetings:manage",
        "dataProtection:manage",
        "boardMailbox:handle",
        "chat:participate",
      ]),
    ).toEqual([
      "/",
      "/plugins",
      "/connected-apps",
      "/settings",
      "/board-mailbox",
      "/chat",
      "/issues",
      "/bookings",
      "/events",
      "/motions",
      "/meetings",
      "/data-protection",
      "/news",
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

  it("offers the news on residency rather than on membership", () => {
    /*
     * The contrast with motions above, and the reason this module has no any-of
     * list. news:comment is granted by living in the building, so it is what
     * opens this destination; membership adds motions:submit and nothing else, so
     * an account holding the member's capability and not the resident's is
     * offered the meeting's business and not the notices.
     */
    expect(destinations(["news:comment"])).toContain("/news");
    expect(destinations(["motions:submit"])).not.toContain("/news");
    // And the board's own writing capability is not a way in either: it opens
    // the screen where news is written, which is a different destination.
    expect(destinations(["site:manage"])).not.toContain("/news");
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

  it("offers the general meeting on the board's capability and on no other", () => {
    /*
     * One capability rather than an any-of list, and the contrast with motions
     * above is what this pins. The right a member holds at a general meeting is
     * to attend, speak and vote, none of which happens here, so membership opens
     * no door to this screen - and neither does living in the building.
     */
    expect(destinations(["meetings:manage"])).toContain("/meetings");
    expect(destinations(["motions:submit"])).not.toContain("/meetings");
    expect(destinations(["motions:handle"])).not.toContain("/meetings");
    expect(destinations(["residentDirectory:read"])).not.toContain("/meetings");
  });

  it("offers data protection on the board's capability and on no other", () => {
    /*
     * The same shape as the general meeting above, and for the same reason:
     * these are the association's own records as controller, so there is no
     * member's half of the screen and living in the building opens no door to
     * it. The external property manager holds issues:handle and nothing here.
     */
    expect(destinations(["dataProtection:manage"])).toContain(
      "/data-protection",
    );
    expect(destinations(["residentDirectory:read"])).not.toContain(
      "/data-protection",
    );
    expect(destinations(["motions:submit"])).not.toContain("/data-protection");
    expect(destinations(["issues:handle"])).not.toContain("/data-protection");
  });

  it("offers connected apps on the capability that reads the instance", () => {
    /*
     * The same seat as plugins, and deliberately not the stronger of the
     * screen's two capabilities. Cutting somebody else's connection needs
     * dataProtection:manage, but gating the door on that would hide the list
     * from the seat entitled to read it - and holding the stronger capability
     * alone is not a way in, because what is behind the door is a list of what
     * the instance is configured to let out.
     */
    expect(destinations(["association:read"])).toContain("/connected-apps");
    expect(destinations(["dataProtection:manage"])).not.toContain(
      "/connected-apps",
    );
    expect(destinations(["residentDirectory:read"])).not.toContain(
      "/connected-apps",
    );
    // A member's own connections are on the settings screen every account
    // already reaches, so there is no member's half of this destination.
    expect(destinations(["self:manage"])).not.toContain("/connected-apps");
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
