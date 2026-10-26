import { describe, expect, it } from "vite-plus/test";

import { previewed } from "../api/viewer-preview";
import {
  BOARD_FRONT,
  currentDestination,
  groupsOf,
  isOffered,
  NAV_ITEMS,
  NAV_SECTIONS,
  navItemsFor,
  pluginNavItems,
  sectionsOf,
  type NavItem,
} from "./nav-items";

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

  it("is offered the overview, the issue queue and their own settings, and nothing else", () => {
    expect(destinations(PROPERTY_MANAGER)).toEqual([
      "/",
      "/board/issues",
      "/settings",
    ]);
  });

  it("is not offered the board's front page, with one page to gather", () => {
    // The front page gathers two or more of the board's pages; for an account
    // whose section is the issue queue alone it would be a page in front of
    // that page.
    expect(destinations(PROPERTY_MANAGER)).not.toContain(BOARD_FRONT);
  });

  it("is not offered the address book", () => {
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/board/address-book");
  });

  it("is not offered bookings, because they do not live in the building", () => {
    // The capability model grants them neither half of the module, and the
    // navigation must not offer a door the grant list does not open: a laundry
    // hour held by an external contractor is an hour taken from a household.
    expect(PROPERTY_MANAGER).not.toContain("bookings:book");
    expect(PROPERTY_MANAGER).not.toContain("bookings:manage");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/bookings");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/board/bookings");
  });

  it("is not offered motions, which are the members' own business", () => {
    // The capability model grants them neither half of the module: a motion is a
    // member exercising a right under EFL 6 kap. 15 §, and the queue it arrives
    // in is the board's. An external contractor is on neither side of that.
    expect(PROPERTY_MANAGER).not.toContain("motions:submit");
    expect(PROPERTY_MANAGER).not.toContain("motions:handle");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/motions");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/board/motions");
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
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/board/events");
  });

  it("is not offered the general meeting, which is the members' own business", () => {
    // The capability model grants them nothing here: arranging a meeting,
    // summoning the members and minuting what they decided is the board's own
    // side of the members' business with their own association, and the list of
    // who was in the room is resident data. An external contractor is on neither
    // side of that.
    expect(PROPERTY_MANAGER).not.toContain("meetings:manage");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/board/meetings");
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
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/board/mailbox");
  });

  it("is not offered the fees, which are the board's own business", () => {
    // The capability model grants them nothing here, on the same reading as the
    // charges: what a household pays the association is its own business with
    // its own members, and an external contractor is on neither side of it.
    expect(PROPERTY_MANAGER).not.toContain("fees:manage");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/board/fees");
  });

  it("reaches the issue queue and not the house's issues page", () => {
    // They handle the association's issues; they do not live in the building,
    // so they never hold issues:report. The queue is the board's page and asks
    // for handling alone, and the house's page, where an issue is reported, is
    // not theirs (ADR 0049: one page, one audience).
    expect(PROPERTY_MANAGER).not.toContain("issues:report");
    expect(destinations(PROPERTY_MANAGER)).toContain("/board/issues");
    expect(destinations(PROPERTY_MANAGER)).not.toContain("/issues");
  });
});

describe("the other seats", () => {
  it("offers the overview to everybody", () => {
    // The page every sign-in lands on. What is on it follows from the
    // account's capabilities, so there is nothing to gate the door on.
    for (const capabilities of [[], ["issues:handle"], ["news:comment"]]) {
      expect(destinations(capabilities)).toContain("/");
    }
  });

  it("offers the address book on the board's view of it and on no other", () => {
    /*
     * The board's section holds only what no resident is offered, so the
     * entry asks for the board's view alone, and a resident holding the
     * directory's capability is offered no door to it.
     */
    expect(destinations(["addressBook:read"])).toContain("/board/address-book");
    expect(destinations(["residentDirectory:read"])).not.toContain(
      "/board/address-book",
    );
    expect(
      navItemsFor(["addressBook:read"]).find(
        (item) => item.to === "/board/address-book",
      )?.section,
    ).toBe("board");
  });

  it("offers the board's mailbox on the board's capability and on no other", () => {
    /*
     * One capability rather than an any-of list. Every resident may write to the
     * board; none of them may read what the neighbours wrote, so neither living
     * here nor holding the tenant-ownership opens this door - and handling issue
     * reports does not either.
     */
    expect(destinations(["boardMailbox:handle"])).toContain("/board/mailbox");
    expect(destinations(["issues:handle"])).not.toContain("/board/mailbox");
    expect(destinations(["residentDirectory:read"])).not.toContain(
      "/board/mailbox",
    );
    expect(destinations(["motions:submit"])).not.toContain("/board/mailbox");
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
    expect(destinations(["chat:participate"])).toContain("/feed");
    expect(destinations(["news:comment"])).not.toContain("/feed");
    expect(destinations(["residentDirectory:read"])).not.toContain("/feed");
    expect(destinations(["motions:submit"])).not.toContain("/feed");
    expect(destinations(["issues:handle"])).not.toContain("/feed");
  });

  it("offers the apartment binder to the people it is kept for", () => {
    /*
     * Two pages for two ways of reaching the papers. Somebody who lives in the
     * building reaches their own home's binder through the residency the
     * register holds, which is the capability every resident has; a board seat
     * reaches every apartment's, on the board's page, through the one
     * capability no grant of capabilities carries (ADR 0017).
     *
     * The external property manager is on neither side of it: their seat is
     * issue handling, they do not live here, and a household's papers are not
     * theirs to browse - the archive's own rule, on the documents entry.
     */
    expect(destinations(["residentDirectory:read"])).toContain(
      "/apartment-binder",
    );
    expect(destinations(["residentDirectory:read"])).not.toContain(
      "/board/binders",
    );
    expect(destinations(["apartmentBinder:manage"])).toContain(
      "/board/binders",
    );
    expect(destinations(["apartmentBinder:manage"])).not.toContain(
      "/apartment-binder",
    );
    expect(destinations(["issues:handle", "self:manage"])).not.toContain(
      "/apartment-binder",
    );
    expect(destinations(["documents:manage"])).not.toContain(
      "/apartment-binder",
    );
    // The administrator holds every capability but the seat's, so the
    // household's page and not the board's.
    expect(destinations(ADMINISTRATOR)).toContain("/apartment-binder");
    expect(destinations(ADMINISTRATOR)).not.toContain("/board/binders");
  });

  it("keeps the fees and the charges on two capabilities", () => {
    /*
     * Two doors and two grants, although the board holds both today. Fixing the
     * avgifter is the board's standing task under BRL 9 kap. 13 § while a
     * debitering records an event, and a cooperative that gives its treasurer
     * the fee book while the whole board approves individual charges is a seat
     * split only two capabilities can express.
     */
    expect(destinations(["fees:manage"])).toContain("/board/fees");
    expect(destinations(["fees:manage"])).not.toContain("/board/charges");
    expect(destinations(["memberCharges:manage"])).toContain("/board/charges");
    expect(destinations(["memberCharges:manage"])).not.toContain("/board/fees");
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
      "/news",
      "/events",
      "/feed",
      "/documents",
      "/issues",
      "/bookings",
      "/apartment-binder",
      "/settings",
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
      "/news",
      "/events",
      "/documents",
      "/motions",
      "/issues",
      "/bookings",
      "/apartment-binder",
      "/settings",
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
        // The one capability a board seat alone confers: an administrator
        // holding every grant in the product does not hold it (ADR 0017).
        "apartmentBinder:manage",
      ]),
    ).toEqual([
      "/",
      "/news",
      "/events",
      "/feed",
      "/issues",
      "/bookings",
      BOARD_FRONT,
      "/board/issues",
      "/board/motions",
      "/board/mailbox",
      "/board/address-book",
      "/board/binders",
      "/board/events",
      "/board/documents",
      "/board/bookings",
      "/board/meetings",
      "/board/data-protection",
      "/board/settings",
      "/board/plugins",
      "/board/connected-apps",
      "/settings",
    ]);
  });

  it("offers a board member who holds no tenant-ownership the queue and not the form", () => {
    // Two pages for the two halves (ADR 0049). A board seat carries
    // motions:handle and never motions:submit - the right to put an item
    // belongs to the membership and not to the office - so the board member is
    // offered the queue they work, and the member the page where an item is
    // put in.
    expect(destinations(["motions:handle"])).toContain("/board/motions");
    expect(destinations(["motions:handle"])).not.toContain("/motions");
    expect(destinations(["motions:submit"])).toContain("/motions");
    expect(destinations(["motions:submit"])).not.toContain("/board/motions");
  });

  it("offers the house's pages on the resident's half alone", () => {
    // The board's half of each module is a page of its own under /board, so a
    // house page asks for the act a resident does there and nothing else.
    expect(destinations(["issues:handle"])).not.toContain("/issues");
    expect(destinations(["issues:report"])).toContain("/issues");
    expect(destinations(["sublets:handle"])).not.toContain("/sublets");
    expect(destinations(["sublets:handle"])).toContain("/board/sublets");
    expect(destinations(["sublets:apply"])).toContain("/sublets");
    expect(destinations(["sublets:apply"])).not.toContain("/board/sublets");
    expect(destinations(["keyOrders:handle"])).not.toContain("/key-orders");
    expect(destinations(["keyOrders:handle"])).toContain("/board/key-orders");
    expect(destinations(["keyOrders:place"])).toContain("/key-orders");
    expect(destinations(["keyOrders:place"])).not.toContain(
      "/board/key-orders",
    );
    expect(destinations(["documents:manage"])).not.toContain("/documents");
    expect(destinations(["documents:manage"])).toContain("/board/documents");
    expect(destinations(["residentDirectory:read"])).toContain("/documents");
    expect(destinations(["residentDirectory:read"])).not.toContain(
      "/board/documents",
    );
  });

  it("offers the reported posts to whoever answers them, and the feed to whoever reads it", () => {
    // Answering a report is the board's page; reporting one is done in the
    // feed, where the post is read.
    expect(destinations(["chat:moderate"])).toContain("/board/reports");
    expect(destinations(["chat:moderate"])).not.toContain("/feed");
    expect(destinations(["chat:participate"])).not.toContain("/board/reports");
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

  it("offers whoever runs the calendar the board's bookings page, not the house's", () => {
    // Two pages for the two halves. The board holds both today and is offered
    // both; a seat granted only the running of the calendar is offered the
    // board's page and no form for booking an hour it does not take.
    expect(destinations(["bookings:manage"])).toContain("/board/bookings");
    expect(destinations(["bookings:manage"])).not.toContain("/bookings");
    expect(destinations(["bookings:book"])).not.toContain("/board/bookings");
  });

  it("offers whoever arranges the calendar the board's events page, not the house's", () => {
    // Two pages for the two halves, as bookings above. A support session holds
    // the arranging and not the attending, and is offered the board's page and
    // no place at a date it would not attend.
    expect(destinations(["events:manage"])).toContain("/board/events");
    expect(destinations(["events:manage"])).not.toContain("/events");
    expect(destinations(["events:attend"])).toContain("/events");
    expect(destinations(["events:attend"])).not.toContain("/board/events");
  });

  it("offers the general meeting on the board's capability and on no other", () => {
    /*
     * The board's page. The right a member holds at a general meeting is to
     * attend, speak and vote, none of which happens here, so membership opens
     * no door to this page - and neither does living in the building. There is
     * no house page for it at all.
     */
    expect(destinations(["meetings:manage"])).toContain("/board/meetings");
    expect(destinations(["motions:submit"])).not.toContain("/board/meetings");
    expect(destinations(["motions:handle"])).not.toContain("/board/meetings");
    expect(destinations(["residentDirectory:read"])).not.toContain(
      "/board/meetings",
    );
    for (const seat of [RESIDENT, MEMBER, BOARD, ADMINISTRATOR]) {
      expect(destinations(seat)).not.toContain("/meetings");
    }
  });

  it("offers data protection on the board's capability and on no other", () => {
    /*
     * The same shape as the general meeting above, and for the same reason:
     * these are the association's own records as controller, so there is no
     * member's half of the screen and living in the building opens no door to
     * it. The external property manager holds issues:handle and nothing here.
     */
    expect(destinations(["dataProtection:manage"])).toContain(
      "/board/data-protection",
    );
    expect(destinations(["residentDirectory:read"])).not.toContain(
      "/board/data-protection",
    );
    expect(destinations(["motions:submit"])).not.toContain(
      "/board/data-protection",
    );
    expect(destinations(["issues:handle"])).not.toContain(
      "/board/data-protection",
    );
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
    expect(destinations(["association:read"])).toContain(
      "/board/connected-apps",
    );
    expect(destinations(["dataProtection:manage"])).not.toContain(
      "/board/connected-apps",
    );
    expect(destinations(["residentDirectory:read"])).not.toContain(
      "/board/connected-apps",
    );
    // A member's own connections are on the settings page every account
    // already reaches, so there is no member's half of this destination.
    expect(destinations(["self:manage"])).not.toContain(
      "/board/connected-apps",
    );
  });

  it("offers the licence screen to the seat that installs plugins alone", () => {
    // Every route behind it asks for association:manage (ADR 0042), so a reader
    // of the plugin list is not offered a door that would only say "not you".
    expect(destinations(["association:manage"])).toContain("/board/licences");
    expect(destinations(["association:read"])).not.toContain("/board/licences");
  });

  it("offers the association's settings to whoever reads them, and the account's own to everybody", () => {
    // One page, one audience (ADR 0049): /settings is the person's own
    // account, and how the instance is configured is the board's page.
    expect(destinations(["association:read"])).toContain("/board/settings");
    expect(destinations(["association:read"])).toContain("/settings");
    for (const seat of [RESIDENT, MEMBER, ["issues:handle"]]) {
      expect(destinations(seat)).not.toContain("/board/settings");
      expect(destinations(seat)).toContain("/settings");
    }
  });

  it("offers an account with no capabilities only what belongs to everyone", () => {
    expect(destinations([])).toEqual(["/", "/settings"]);
  });

  it("holds the band still while the viewer is unknown", () => {
    // The entries with no capability requirement, so the band does not shuffle
    // its links once the viewer's capabilities arrive.
    expect(navItemsFor(undefined)).toEqual(NAV_ITEMS);
    expect(NAV_ITEMS.map((item) => item.to)).toEqual(["/", "/settings"]);
  });
});

describe("the board's front page", () => {
  it("is offered to an account offered two or more of the board's pages", () => {
    // It gathers the board's pages, so it is there when there is more than one
    // to gather.
    expect(destinations(["issues:handle", "fees:manage"])).toContain(
      BOARD_FRONT,
    );
  });

  it("is not offered with one page, which is then the section", () => {
    expect(destinations(["fees:manage"])).not.toContain(BOARD_FRONT);
    expect(destinations(["issues:handle"])).not.toContain(BOARD_FRONT);
    expect(destinations([])).not.toContain(BOARD_FRONT);
  });

  it("stands first in the board's section, in no group", () => {
    const front = navItemsFor(["issues:handle", "fees:manage"]).filter(
      (item) => item.section === "board",
    );
    expect(front[0]?.to).toBe(BOARD_FRONT);
    expect(front[0]?.group).toBeUndefined();
  });

  it("is never offered while the viewer is unknown", () => {
    expect(NAV_ITEMS.map((item) => item.to)).not.toContain(BOARD_FRONT);
  });

  it("is offered by its address to exactly the accounts the band lists it for", () => {
    // What the page itself asks before it renders: a queue held is not enough,
    // because the property manager holds one and has no front page.
    expect(isOffered(["issues:handle", "fees:manage"], BOARD_FRONT)).toBe(true);
    expect(isOffered(["issues:handle", "self:manage"], BOARD_FRONT)).toBe(
      false,
    );
    expect(isOffered(["issues:handle"], "/board/issues")).toBe(true);
    expect(isOffered(["self:manage"], "/board/fees")).toBe(false);
  });
});

/*
 * Each seat's whole grant, written out rather than imported for the reason the
 * property manager's list above gives: a change to a grant shows up here as a
 * changed expectation rather than as a test that silently follows it.
 */
const RESIDENT = [
  "self:manage",
  "residentDirectory:read",
  "issues:report",
  "news:comment",
  "bookings:book",
  "events:attend",
  "keyOrders:place",
  "chat:participate",
];
/** A resident holding the tenant-ownership: two capabilities more. */
const MEMBER = [...RESIDENT, "motions:submit", "sublets:apply"];
const BOARD = [
  "apartmentBinder:manage",
  "association:read",
  "boardPosition:manage",
  "addressBook:read",
  "addressBook:write",
  "memberRegister:read",
  "apartmentRegister:read",
  "protectedData:reveal",
  "registerReport:export",
  "invitation:send",
  "signupRequest:decide",
  "self:manage",
  "residentDirectory:read",
  "issues:handle",
  "issues:report",
  "issues:configure",
  "documents:manage",
  "site:manage",
  "news:comment",
  "bookings:book",
  "bookings:manage",
  "bookings:configure",
  "events:manage",
  "motions:handle",
  "meetings:manage",
  "events:attend",
  "memberCharges:manage",
  "fees:manage",
  "dataProtection:manage",
  "boardMailbox:handle",
  "sublets:handle",
  "keyOrders:place",
  "keyOrders:handle",
  "chat:participate",
  "chat:moderate",
];
/** Every capability but the one a board seat alone confers (ADR 0017). */
const ADMINISTRATOR = [
  "association:manage",
  "association:read",
  "addressBook:read",
  "addressBook:write",
  "memberRegister:read",
  "apartmentRegister:read",
  "protectedData:reveal",
  "registerReport:export",
  "invitation:send",
  "signupRequest:decide",
  "self:manage",
  "residentDirectory:read",
  "issues:handle",
  "issues:report",
  "issues:configure",
  "documents:manage",
  "site:manage",
  "news:comment",
  "boardPosition:manage",
  "bookings:book",
  "bookings:manage",
  "bookings:configure",
  "events:manage",
  "events:attend",
  "systemRole:manage",
  "motions:submit",
  "motions:handle",
  "meetings:manage",
  "memberCharges:manage",
  "fees:manage",
  "dataProtection:manage",
  "boardMailbox:handle",
  "sublets:apply",
  "sublets:handle",
  "keyOrders:place",
  "keyOrders:handle",
  "chat:participate",
  "chat:moderate",
];

const SEATS = {
  resident: RESIDENT,
  member: MEMBER,
  board: BOARD,
  administrator: ADMINISTRATOR,
  propertyManager: ["issues:handle", "self:manage"],
} as const;

/** A seat's band: each offered section's id and the paths in it, in order. */
const band = (capabilities: readonly string[] | undefined) =>
  sectionsOf(navItemsFor(capabilities)).map((section) => ({
    id: section.id,
    paths: section.items.map((item) => item.to),
  }));

/** A seat's phone bar: the columns that hold a destination, in order. */
const bar = (capabilities: readonly string[] | undefined) =>
  navItemsFor(capabilities)
    .filter((item) => item.barSlot !== undefined)
    .map((item) => [item.barSlot, item.to])
    .toSorted((a, b) => Number(a[0]) - Number(b[0]));

const ASSOCIATION_FOR_A_RESIDENT = [
  "/",
  "/news",
  "/events",
  "/feed",
  "/documents",
];
const BUILDING_FOR_A_RESIDENT = [
  "/issues",
  "/bookings",
  "/key-orders",
  "/apartment-binder",
];
/** Every page of the board's section, the front page first. */
const THE_WHOLE_BOARD_SECTION = {
  id: "board",
  paths: [
    BOARD_FRONT,
    "/board/issues",
    "/board/motions",
    "/board/sublets",
    "/board/key-orders",
    "/board/mailbox",
    "/board/reports",
    "/board/address-book",
    "/board/binders",
    "/board/import",
    "/board/news",
    "/board/site",
    "/board/events",
    "/board/documents",
    "/board/bookings",
    "/board/meetings",
    "/board/fees",
    "/board/charges",
    "/board/data-protection",
    "/board/settings",
    "/board/plugins",
    "/board/connected-apps",
  ],
};
/** The person's own account, which is the whole of the settings section. */
const OWN_SETTINGS = { id: "settings", paths: ["/settings"] };

describe("the sections", () => {
  it("puts every destination in one of the four, and leaves none of them empty", () => {
    const every = [...new Set(Object.values(SEATS).flat())];
    const items = navItemsFor(every);
    const ids: readonly string[] = NAV_SECTIONS.map((section) => section.id);

    expect(items).toHaveLength(35);
    for (const item of items) {
      expect(ids).toContain(item.section);
    }
    for (const id of ids) {
      expect(items.some((item) => item.section === id)).toBe(true);
    }
  });

  it("gives a resident the association, the building and the settings", () => {
    expect(band(SEATS.resident)).toEqual([
      { id: "association", paths: ASSOCIATION_FOR_A_RESIDENT },
      { id: "building", paths: BUILDING_FOR_A_RESIDENT },
      { id: "settings", paths: ["/settings"] },
    ]);
  });

  it("gives a member the motions and the subletting as well", () => {
    // The two destinations membership adds, each in the section a resident
    // already has, so the member's band has the resident's shape.
    expect(band(SEATS.member)).toEqual([
      { id: "association", paths: [...ASSOCIATION_FOR_A_RESIDENT, "/motions"] },
      { id: "building", paths: [...BUILDING_FOR_A_RESIDENT, "/sublets"] },
      { id: "settings", paths: ["/settings"] },
    ]);
  });

  it("gives the board all four sections, and no member's page", () => {
    // A board seat holds no tenant-ownership, so the motions and the subletting
    // a member is offered are not in its band; their queues are in its section.
    expect(band(SEATS.board)).toEqual([
      { id: "association", paths: ASSOCIATION_FOR_A_RESIDENT },
      { id: "building", paths: BUILDING_FOR_A_RESIDENT },
      THE_WHOLE_BOARD_SECTION,
      OWN_SETTINGS,
    ]);
  });

  it("gives the administrator all four sections, and every board page but the seat's own", () => {
    // Every capability, a member's two included, so both halves of the motions
    // and of the subletting - and every board page but the binders, which no
    // grant of capabilities carries (ADR 0017). The licence screen besides,
    // which every route behind it gates on association:manage, the capability
    // that installs plugins (ADR 0042).
    expect(band(SEATS.administrator)).toEqual([
      {
        id: "association",
        paths: [...ASSOCIATION_FOR_A_RESIDENT, "/motions"],
      },
      { id: "building", paths: [...BUILDING_FOR_A_RESIDENT, "/sublets"] },
      {
        ...THE_WHOLE_BOARD_SECTION,
        paths: THE_WHOLE_BOARD_SECTION.paths
          .filter((path) => path !== "/board/binders")
          .flatMap((path) =>
            path === "/board/plugins" ? [path, "/board/licences"] : [path],
          ),
      },
      OWN_SETTINGS,
    ]);
  });

  it("keeps the general meeting on the board's pages and the motions in the association", () => {
    // The meeting is the board's page; the motions a member puts to it are the
    // member's, at the section's level, under no parent.
    for (const seat of [SEATS.board, SEATS.administrator]) {
      const sections = sectionsOf(navItemsFor(seat));
      const paths = (id: string) =>
        sections
          .find((section) => section.id === id)
          ?.items.map((item) => item.to);
      expect(paths("board")).toContain("/board/meetings");
      expect(paths("association")).not.toContain("/board/meetings");
    }
    for (const seat of [SEATS.member, SEATS.administrator]) {
      const motions = navItemsFor(seat).find((item) => item.to === "/motions");
      expect(motions?.section).toBe("association");
      expect(motions?.parent).toBeUndefined();
    }
  });

  it("gives the property manager the overview, the issue queue and the settings, nothing else", () => {
    // Decision 11 read as the whole band: the page everybody lands on, the
    // issue queue alone in the board's section, and the account's own
    // settings. No address book, and no front page in front of the one page.
    expect(band(SEATS.propertyManager)).toEqual([
      { id: "association", paths: ["/"] },
      { id: "board", paths: ["/board/issues"] },
      { id: "settings", paths: ["/settings"] },
    ]);
  });

  it("gives an unknown viewer the overview and the settings alone", () => {
    expect(band(undefined)).toEqual([
      { id: "association", paths: ["/"] },
      { id: "settings", paths: ["/settings"] },
    ]);
  });

  it("only ever gains sections once the viewer arrives", () => {
    // The band shown while the viewer is unknown is part of every seat's, so
    // no sign it shows is taken away when the capabilities arrive.
    const unknown = band(undefined).map((section) => section.id);
    for (const capabilities of Object.values(SEATS)) {
      const known = band(capabilities).map((section) => section.id);
      for (const id of unknown) {
        expect(known).toContain(id);
      }
    }
  });
});

/** A section's groups: each heading's key, or null, and the paths under it. */
const groups = (capabilities: readonly string[], id: string) =>
  groupsOf(
    sectionsOf(navItemsFor(capabilities)).find((section) => section.id === id)
      ?.items ?? [],
  ).map((group) => ({
    labelKey: group.labelKey,
    paths: group.items.map((item) => item.to),
  }));

describe("the board's groups", () => {
  it("sets the front page above them all and every other page under its kind of work", () => {
    expect(groups(SEATS.board, "board")).toEqual([
      { labelKey: null, paths: [BOARD_FRONT] },
      {
        labelKey: "nav.boardGroups.queues",
        paths: [
          "/board/issues",
          "/board/motions",
          "/board/sublets",
          "/board/key-orders",
          "/board/mailbox",
          "/board/reports",
        ],
      },
      {
        labelKey: "nav.boardGroups.register",
        paths: ["/board/address-book", "/board/binders", "/board/import"],
      },
      {
        labelKey: "nav.boardGroups.publish",
        paths: [
          "/board/news",
          "/board/site",
          "/board/events",
          "/board/documents",
          "/board/bookings",
          "/board/meetings",
        ],
      },
      {
        labelKey: "nav.boardGroups.money",
        paths: ["/board/fees", "/board/charges"],
      },
      // One page in the group, so the row stands without a heading: a heading
      // over one row says the same thing twice.
      { labelKey: null, paths: ["/board/data-protection"] },
      {
        labelKey: "nav.boardGroups.settings",
        paths: ["/board/settings", "/board/plugins", "/board/connected-apps"],
      },
    ]);
  });

  it("heads a group only where the account is offered two or more pages in it", () => {
    expect(
      groups(["issues:handle", "boardMailbox:handle", "fees:manage"], "board"),
    ).toEqual([
      { labelKey: null, paths: [BOARD_FRONT] },
      {
        labelKey: "nav.boardGroups.queues",
        paths: ["/board/issues", "/board/mailbox"],
      },
      { labelKey: null, paths: ["/board/fees"] },
    ]);
  });

  it("heads nothing for the property manager's one page", () => {
    expect(groups(SEATS.propertyManager, "board")).toEqual([
      { labelKey: null, paths: ["/board/issues"] },
    ]);
  });

  it("leaves every other section one group under no heading", () => {
    expect(groups(SEATS.board, "association")).toEqual([
      { labelKey: null, paths: ASSOCIATION_FOR_A_RESIDENT },
    ]);
    expect(groupsOf([])).toEqual([]);
  });

  it("puts every page of the board's section but the front page in a group", () => {
    const board = navItemsFor(SEATS.administrator).filter(
      (item) => item.section === "board",
    );
    for (const item of board) {
      if (item.to === BOARD_FRONT) {
        expect(item.group).toBeUndefined();
      } else {
        expect(item.group).toBeDefined();
      }
    }
    // And nothing outside it is in one.
    expect(
      navItemsFor(SEATS.administrator).filter(
        (item) => item.section !== "board" && item.group !== undefined,
      ),
    ).toEqual([]);
  });
});

describe("the phone bar", () => {
  it("gives the board the overview, its front page and its feed", () => {
    expect(bar(SEATS.board)).toEqual([
      [1, "/"],
      [2, BOARD_FRONT],
      [3, "/feed"],
    ]);
  });

  it("gives the administrator the board's bar, as an account with the board's pages", () => {
    // Chosen by what the account is offered rather than by who it is: the
    // viewer carries capabilities and no roles.
    expect(bar(SEATS.administrator)).toEqual(bar(SEATS.board));
  });

  it("gives an account with one board page that page in the front page's column", () => {
    // No front page to go to, so the column holds the page the section is.
    expect(bar(["chat:participate", "fees:manage"])).toEqual([
      [1, "/"],
      [2, "/board/fees"],
      [3, "/feed"],
    ]);
  });

  it("gives everybody else the overview, the issues and the bookings", () => {
    const residents = [
      [1, "/"],
      [2, "/issues"],
      [3, "/bookings"],
    ];
    expect(bar(SEATS.resident)).toEqual(residents);
    expect(bar(SEATS.member)).toEqual(residents);
  });

  it("leaves a column empty rather than filling it", () => {
    // The property manager is offered the overview and the issue queue, which
    // is their one board page, and not the feed. The bar holds exactly those
    // two: nothing moves up into the third from the rest of the list.
    expect(bar(SEATS.propertyManager)).toEqual([
      [1, "/"],
      [2, "/board/issues"],
    ]);
  });

  it("never holds the settings, and holds nothing while the viewer is unknown", () => {
    for (const capabilities of Object.values(SEATS)) {
      const settings = navItemsFor(capabilities).find(
        (item) => item.to === "/settings",
      );
      expect(settings?.barSlot).toBeUndefined();
    }
    expect(bar(undefined)).toEqual([]);
    expect(bar([])).toEqual([[1, "/"]]);
  });
});

describe("the current destination", () => {
  const board = navItemsFor(SEATS.board);
  const current = (pathname: string, items = board) =>
    currentDestination(pathname, items)?.to;

  it("is the overview only on its own path", () => {
    expect(current("/")).toBe("/");
    expect(current("/board/address-book")).toBe("/board/address-book");
    expect(current("/news")).toBe("/news");
    expect(current("/news/some-item")).toBe("/news");
  });

  it("is the board's front page only on its own path", () => {
    // Every board page sits under /board, so the front page holding them all
    // would mark it on each of them.
    expect(current("/board")).toBe(BOARD_FRONT);
    expect(current("/board/issues")).toBe("/board/issues");
    expect(current("/board/site/menu")).toBe("/board/site");
    expect(current("/board/sitemap")).toBeUndefined();
  });

  it("is the board's page and not the house's on the same module", () => {
    // /board/issues and /issues share a last segment and nothing else.
    expect(current("/issues")).toBe("/issues");
    expect(current("/board/issues/some-issue")).toBe("/board/issues");
  });

  it("is the longest path that holds the page", () => {
    // No two of today's destinations nest, so two made up for the rule: a page
    // under both is the nearer one's.
    const outer: NavItem = {
      to: "/board/site",
      labelKey: "siteAdmin.navLabel",
      section: "board",
    };
    const inner: NavItem = {
      to: "/board/site/news",
      labelKey: "news.navLabel",
      section: "board",
    };
    for (const items of [
      [outer, inner],
      [inner, outer],
    ]) {
      expect(current("/board/site/news/draft", items)).toBe("/board/site/news");
      expect(current("/board/site/menu", items)).toBe("/board/site");
    }
  });

  it("is nothing on a route that is no destination's", () => {
    // The registers are reached from the address book and are no destination
    // of their own.
    expect(current("/board/registers/members")).toBeUndefined();
    expect(current("/plugin/x")).toBeUndefined();
    // Nor on a destination this account is not offered.
    expect(
      current("/board/meetings", navItemsFor(SEATS.resident)),
    ).toBeUndefined();
    expect(
      current("/board", navItemsFor(SEATS.propertyManager)),
    ).toBeUndefined();
  });

  it("is the issue queue for the property manager on it", () => {
    expect(current("/board/issues", navItemsFor(SEATS.propertyManager))).toBe(
      "/board/issues",
    );
  });
});

describe("pluginNavItems", () => {
  const view = (id: string, section: "building" | "board" | null) => ({
    id,
    titleKey: "view.title",
    section,
    boardView: null,
  });

  it("makes an entry at the view's own address, labelled in its namespace", () => {
    expect(pluginNavItems([view("occupancy", "board")])).toEqual([
      {
        to: "/plugin/occupancy",
        section: "board",
        group: "queues",
        labelKey: "view.title",
        pluginId: "occupancy",
      },
    ]);
  });

  it("leaves out a view this account is offered in no section", () => {
    expect(pluginNavItems([view("occupancy", null)])).toEqual([]);
  });

  it("puts each in the section the API named, after the core's own", () => {
    const items = [
      ...navItemsFor(SEATS.resident),
      ...pluginNavItems([view("laundry-board", "building")]),
    ];
    const building = sectionsOf(items).find(
      (section) => section.id === "building",
    );
    expect(building?.items.at(-1)?.to).toBe("/plugin/laundry-board");
  });

  it("is where the reader is on the view's own page", () => {
    const items = pluginNavItems([view("occupancy", "board")]);
    expect(currentDestination("/plugin/occupancy", items)?.to).toBe(
      "/plugin/occupancy",
    );
    expect(currentDestination("/plugin/occupancy-2", items)).toBeUndefined();
  });

  it("never takes a column in the phone bar", () => {
    expect(
      pluginNavItems([view("occupancy", "board")]).every(
        (item) => item.barSlot === undefined,
      ),
    ).toBe(true);
  });

  describe("a plugin's board view (ADR 0051, amended 2026-10-26)", () => {
    const parking = (offered: boolean) => ({
      ...view("parking-share", "building"),
      boardView: { titleKey: "boardView.title", offered },
    });

    it("stands in the board's section alone, at its address under /board", () => {
      expect(pluginNavItems([parking(true)])).toEqual([
        {
          to: "/plugin/parking-share",
          section: "building",
          labelKey: "view.title",
          pluginId: "parking-share",
        },
        {
          to: "/board/plugin/parking-share",
          section: "board",
          group: "queues",
          labelKey: "boardView.title",
          pluginId: "parking-share",
        },
      ]);
    });

    it("is reached from no other section", () => {
      const items = pluginNavItems([parking(true)]);
      for (const section of sectionsOf(items)) {
        expect(
          section.items.some((item) => item.to.startsWith("/board/plugin/")),
        ).toBe(section.id === "board");
      }
    });

    it("is left out for an account the API does not offer it to", () => {
      expect(pluginNavItems([parking(false)]).map((item) => item.to)).toEqual([
        "/plugin/parking-share",
      ]);
    });

    it("is offered beside the residents' view even where that one is not", () => {
      expect(
        pluginNavItems([{ ...parking(true), section: null }]).map(
          (item) => item.to,
        ),
      ).toEqual(["/board/plugin/parking-share"]);
    });

    it("is where the reader is on its own page, and the residents' view is not", () => {
      const items = pluginNavItems([parking(true)]);
      expect(currentDestination("/board/plugin/parking-share", items)?.to).toBe(
        "/board/plugin/parking-share",
      );
      expect(currentDestination("/plugin/parking-share", items)?.to).toBe(
        "/plugin/parking-share",
      );
    });

    it("stands after every plugin's own view in the board's section", () => {
      expect(
        pluginNavItems([parking(true), view("occupancy", "board")]).map(
          (item) => item.to,
        ),
      ).toEqual([
        "/plugin/parking-share",
        "/plugin/occupancy",
        "/board/plugin/parking-share",
      ]);
    });
  });
});

/**
 * The resident preview (ADR 0049): the capabilities narrowed to a resident's
 * and a member's grants, and the navigation built from them as from anybody's.
 */
describe("the resident preview", () => {
  const asResident = (capabilities: readonly string[]): readonly string[] =>
    previewed({
      personId: "person-1",
      firstName: "Berit",
      lastName: "Styrelse",
      preferredLocale: "sv",
      capabilities: [...capabilities],
      housingCooperative: null,
    }).capabilities;

  it("offers a board member who lives here what a resident is offered, bar and all", () => {
    expect(band(asResident(BOARD))).toEqual(band(RESIDENT));
    expect(bar(asResident(BOARD))).toEqual(bar(RESIDENT));
  });

  it("offers the administrator, who holds every grant, what a member is offered", () => {
    expect(band(asResident(ADMINISTRATOR))).toEqual(band(MEMBER));
    expect(bar(asResident(ADMINISTRATOR))).toEqual(bar(MEMBER));
  });

  it("leaves no destination in the board's section", () => {
    for (const seat of [BOARD, ADMINISTRATOR]) {
      expect(
        navItemsFor(asResident(seat)).filter(
          (item) => item.section === "board",
        ),
      ).toEqual([]);
    }
  });
});
