import type { PluginViewSection } from "@openbrf/plugin-sdk";

import type { TranslationKey } from "../i18n/translation-key";

/**
 * The sections of the navigation, in the order the band shows them.
 *
 * Every destination belongs to exactly one of them, whoever is looking, so a
 * destination is found in the same place by every seat that is offered it.
 *
 * - association: the association and its life - the overview every sign-in
 *   lands on, what the board publishes, the calendar, the rooms, the archive
 *   and the items a member puts to the general meeting.
 * - building: the building and the apartments in it - faults, the shared rooms,
 *   keys, a household's binder, letting the apartment.
 * - board: the board's pages, every one of them under /board and none of them
 *   offered to a resident (ADR 0049). One page, one audience: a house page
 *   carries no board half, and the board's work on a module is a page of its
 *   own here. Grouped by the kind of work, see BOARD_GROUPS.
 * - settings: how the instance is configured, and each account's own settings.
 *
 * The order keeps positions still across seats. The board's section is third,
 * so somebody who gains a seat sees one sign appear between the building and
 * the settings while the first two stay where they were, and the settings sign
 * stands at the band's end, where it never moves either.
 */
export const NAV_SECTIONS = [
  { id: "association", labelKey: "nav.sections.association" },
  { id: "building", labelKey: "nav.sections.building" },
  { id: "board", labelKey: "nav.sections.board" },
  { id: "settings", labelKey: "nav.sections.settings" },
] as const satisfies readonly {
  /*
   * A plugin names one of these in its manifest, so they are the SDK's list.
   * Typed against it here, and pluginNavItems types the other direction: a
   * section only one side had would be one no plugin could name, or one this
   * band had nowhere to show.
   */
  id: PluginViewSection;
  labelKey: TranslationKey;
}[];

export type NavSectionId = (typeof NAV_SECTIONS)[number]["id"];

/**
 * The groups of the board's section, in the order the section lists them.
 *
 * One level, by the kind of work rather than by module: the board looks for
 * what is waiting, then for a register, then for what it publishes, and the
 * money and the data protection duty are each a desk of their own. The front
 * page stands above them all, in no group.
 *
 * "Queues" rather than "To handle" for the first, because the front page's row
 * already reads "To handle", and the same words twice in one panel is what the
 * news entries below avoid.
 */
export const BOARD_GROUPS = [
  { id: "queues", labelKey: "nav.boardGroups.queues" },
  { id: "register", labelKey: "nav.boardGroups.register" },
  { id: "publish", labelKey: "nav.boardGroups.publish" },
  { id: "money", labelKey: "nav.boardGroups.money" },
  { id: "dataProtection", labelKey: "nav.boardGroups.dataProtection" },
] as const satisfies readonly { id: string; labelKey: TranslationKey }[];

export type BoardGroupId = (typeof BOARD_GROUPS)[number]["id"];

/** The board's front page, "To handle". */
export const BOARD_FRONT = "/board";

/** A destination's place in the navigation, whoever contributed it. */
interface NavDestination {
  to: string;
  /** The section of the navigation that holds it. */
  section: NavSectionId;
  /** Its group, for a destination in the board's section; see BOARD_GROUPS. */
  group?: BoardGroupId;
  /** Its column in the phone bar, when it has one; see navItemsFor. */
  barSlot?: 1 | 2 | 3;
  /**
   * The `to` of the destination this one is shown under, indented beneath it.
   *
   * Set only when that destination is offered too: a child whose parent is not
   * offered stands in its section like any other, so nobody loses a link
   * because of a grant they do not hold. See navItemsFor.
   */
  parent?: string;
  /** Shown as a small brass plate, e.g. an open issue count. */
  count?: number;
}

/**
 * A destination as the navigation renders it.
 *
 * The core's own are labelled by a key the compiler checks against the core's
 * translations. A plugin's view is labelled by its title, a key in the
 * plugin's own namespace that exists only in a locale file the install put on
 * the data volume, so it carries the plugin's id to be read in. See
 * useNavLabel.
 */
export type NavItem = NavDestination &
  (
    | { labelKey: TranslationKey; pluginId?: undefined }
    | { labelKey: string; pluginId: string }
  );

/** A section with the destinations one account is offered in it. */
export interface OfferedSection {
  id: NavSectionId;
  labelKey: TranslationKey;
  items: readonly NavItem[];
}

/**
 * A destination, and what it takes to be offered it.
 *
 * The capability is not an authorization boundary - the API refuses the calls
 * regardless of what the navigation shows - but a link nobody in that seat can
 * use is still a defect: it teaches a resident that part of the product is
 * broken for them rather than not theirs.
 */
interface NavEntry extends Omit<NavDestination, "barSlot"> {
  labelKey: TranslationKey;
  /**
   * Offered to everyone when absent; to holders of any one of these when a list.
   *
   * Any rather than all, because a destination can belong to two seats for two
   * different reasons, and requiring both would hide it from the seat that holds
   * one. None of the core's own does today: a module with a resident's half and
   * the board's has a house page and a board page, one capability each
   * (ADR 0049).
   */
  capability?: string | readonly string[];
}

/**
 * The application's destinations, in one list.
 *
 * Held here rather than in each route so a new destination cannot appear on one
 * screen and be missing from the next - which is what would happen the moment
 * two routes each kept their own copy.
 *
 * Grouped by section, in the order each section lists them. The sections and
 * the phone bar are derived from these entries and never kept beside them. An
 * entry with a parent comes directly after it, which is where it is shown;
 * nesting is one level deep.
 *
 * Settings is offered to every account, not only an admin: the profile and the
 * security screens inside it belong to whoever is signed in. The admin-only
 * panels are decided by capability within the screen, and the API refuses the
 * calls regardless of what the navigation shows.
 *
 * Plugins is different. Nothing on that screen belongs to a resident, so it is
 * offered only to whoever may read how the instance is configured.
 */
const ENTRIES: readonly NavEntry[] = [
  {
    to: "/",
    section: "association",
    labelKey: "nav.overview",
    // Offered to everyone, because every account lands here and the screen
    // decides its panels from the account's capabilities. An external property
    // manager finds the issue queue's count on it and nothing of the house's.
    //
    // In the association's section rather than a section of its own: it is the
    // association's notice board, and the board's section may only hold
    // destinations no resident is offered.
  },
  {
    to: "/news",
    section: "association",
    // The reading side's own word for itself, under its own namespace, so the
    // label moves with the feature. The board's writing side is a separate entry
    // below, worded as the act it is rather than putting the same noun in the
    // band twice.
    labelKey: "newsReader.navLabel",
    // One capability and no any-of list, because there is one seat here rather
    // than two halves. news:comment belongs to whoever lives in the house: a
    // partner, an adult child and a tenant hold it exactly as a member does,
    // because answering a notice about the building is not the statutory right
    // that membership carries - membership adds motions:submit and nothing else.
    // The board holds it as well, and its own site:manage adds the
    // strike-through control inside the screen rather than a second door to it.
    //
    // Deliberately not the external property manager, who holds neither: they
    // handle the association's issues and do not live in the building, so the
    // notices addressed to the house are not theirs to answer.
    capability: "news:comment",
  },
  {
    to: "/events",
    section: "association",
    // Under the events namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "events.navLabel",
    // What is coming and one's own place at it. Arranging the calendar is the
    // board's page.
    //
    // Deliberately not the external property manager, who holds neither: they
    // handle the association's issues and do not live in the building, so a
    // place at the cleaning day is not theirs to take and its dates are not
    // theirs to arrange.
    capability: "events:attend",
  },
  {
    to: "/feed",
    section: "association",
    // Under the module's own namespace rather than nav, because the label is
    // that module's word for itself and moves with it.
    labelKey: "feed.navLabel",
    // One capability and no any-of list, although three kinds of audience sit
    // behind it: Alla, which is everybody who lives here and the board;
    // Styrelsen, whose members are whoever holds a seat; and a group, which
    // somebody who lives here made for something the house is doing. Which
    // audiences there are for this account is the service's answer and never
    // this list's.
    //
    // Deliberately not the external property manager, on the news:comment
    // precedent: they handle the association's issues, they were not elected to
    // anything and they do not live here.
    //
    // The administrator holds it through the ADMIN grant and is offered this
    // destination, and finds no audience in it. That is not a link to a screen
    // that can only refuse them - the screen answers, and what it says is that
    // the feed is for the people who live here and the board, and that this
    // account is neither. Hiding it from them would be hiding the explanation
    // as well.
    capability: "chat:participate",
  },
  {
    to: "/documents",
    section: "association",
    // The archive's own word for itself, under its own namespace, so the label
    // moves with the feature.
    labelKey: "documents.navLabel",
    // Offered to the people the archive is kept for - anyone living in the
    // building, and whoever administers it, who holds the same grant. Filing a
    // document and reading every shelf by its audience is the board's page.
    // Deliberately not the external property manager: their seat is issue
    // handling, and the association's own binder is not theirs to browse. This
    // gates the band only; what any account may actually read is still each
    // document's audience, decided on the server, and the public documents
    // remain public on the website.
    capability: "residentDirectory:read",
  },
  {
    to: "/motions",
    section: "association",
    // Under the motions namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "motions.navLabel",
    // The member's half alone; the board's queue is a page of its own below.
    //
    // motions:submit is a MEMBER's, and the only entry in this file gated on
    // something derived from membership rather than from residency: EFL 6 kap.
    // 15 §, applied to a housing cooperative by BRL 9 kap. 14 §, gives the right
    // to put an item to a general meeting to a member. So a partner, an adult
    // child or a tenant living here is offered nothing here, and that absence is
    // the statute rather than a decision about screens. A board member who holds
    // no tenant-ownership is not offered it either: there is no form on it for
    // them, and the queue they work is on the board's page.
    capability: "motions:submit",
  },
  {
    to: "/issues",
    section: "building",
    // Under the issues namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "issues.navLabel",
    // Reporting and following one's own reports. The queue is the board's page,
    // so the external property manager, who reports nothing, is not offered
    // this one.
    capability: "issues:report",
  },
  {
    to: "/bookings",
    section: "building",
    // Under the bookings namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "bookings.navLabel",
    // Booking, and reading what one holds. Who holds which hour is the board's
    // page.
    //
    // Deliberately not the external property manager, who holds neither: they
    // handle the association's issues and do not live in the building, so a
    // laundry hour is not theirs to take or to give away.
    capability: "bookings:book",
  },
  {
    to: "/key-orders",
    section: "building",
    // Under the key order namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "keyOrders.navLabel",
    // Placing an order and following one's own; the queue is the board's page.
    // The deliberate contrast with sublets below: nothing gives anybody a right
    // to a key, so keyOrders:place follows living here the way bookings:book
    // does - a partner, an adult child and a tenant are offered this
    // destination and not the sublets one.
    capability: "keyOrders:place",
  },
  {
    to: "/apartment-binder",
    section: "building",
    // The binder's own word for itself, under its own namespace, so the label
    // moves with the feature.
    labelKey: "apartmentBinder.navLabel",
    // The archive's own gate, on the documents entry, and for the same reasons:
    // the people the binders are kept for are the people who live in the
    // building, and the external property manager is deliberately not one of
    // them - their seat is issue handling, and a household's papers are not
    // theirs to browse. Every apartment's binder is the board's page.
    //
    // The administrator is offered the destination through the same grant, and
    // what they find is a sentence saying that a binder is read by whoever
    // lives in the apartment - on the feed's reasoning, that hiding the door
    // would hide the explanation with it.
    //
    // What any account may actually read is decided per request against the
    // residencies it holds today, on the server, and never here.
    capability: "residentDirectory:read",
  },
  {
    to: "/sublets",
    section: "building",
    // Under the sublets namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "sublets.navLabel",
    // The applicant's half alone; deciding is the board's page.
    //
    // sublets:apply is derived from membership, like motions:submit and for the
    // same kind of reason: BRL 7 kap. 10 § forsta stycket lets a
    // bostadsrattshavare let "sin lagenhet" in andra hand with the board's
    // consent, so the act belongs to whoever holds the tenant-ownership. A
    // partner, an adult child or a tenant living here is offered nothing here,
    // and that absence is the statute rather than a decision about screens.
    capability: "sublets:apply",
  },
  {
    to: BOARD_FRONT,
    section: "board",
    labelKey: "board.front.title",
    // No capability of its own, and no group. It is offered to an account
    // offered two or more of the board's pages, and decided in navItemsFor once
    // the others are known: with one page there is nothing to gather, and the
    // section is that page.
  },
  {
    to: "/board/issues",
    section: "board",
    group: "queues",
    // Named by the act, as the page is: "Issues" is the house's own word for
    // reporting one, and the same word twice in the band would be one word for
    // two pages.
    labelKey: "issues.boardTitle",
    // The board's and the external property manager's, who holds this and
    // nothing else: their whole account exists to work this queue, and for them
    // the section is this page alone.
    capability: "issues:handle",
  },
  {
    to: "/board/motions",
    section: "board",
    group: "queues",
    labelKey: "motions.boardTitle",
    // The board's, because a motion is addressed to it. The external property
    // manager holds it no more than motions:submit.
    capability: "motions:handle",
  },
  {
    to: "/board/sublets",
    section: "board",
    group: "queues",
    labelKey: "sublets.boardTitle",
    // The board's, because BRL 7 kap. 10 § names the styrelse as who gives the
    // consent. The external property manager holds neither half.
    capability: "sublets:handle",
  },
  {
    to: "/board/key-orders",
    section: "board",
    group: "queues",
    labelKey: "keyOrders.boardTitle",
    // The board's, because it is the association's own property being given
    // out and its building being opened. Deliberately not the external property
    // manager, although handing out keys is plausibly part of what a vicevard
    // does: the queue names residents and their apartments, which is the
    // address book in another shape.
    capability: "keyOrders:handle",
  },
  {
    to: "/board/mailbox",
    section: "board",
    group: "queues",
    // Under the module's own namespace rather than nav, because the label is
    // that module's word for itself and moves with it.
    labelKey: "boardMailbox.navLabel",
    capability: "boardMailbox:handle",
  },
  {
    to: "/board/reports",
    section: "board",
    group: "queues",
    labelKey: "feed.boardTitle",
    // What somebody in the feed asked the board to look at. The board's alone:
    // the external property manager is in no audience of the feed, and a
    // report out of a group is the only way anybody outside it reads a word of
    // what was said there.
    capability: "chat:moderate",
  },
  {
    to: "/board/address-book",
    section: "board",
    group: "register",
    labelKey: "nav.addressBook",
    // The board's view alone, because this section holds only what no resident
    // is offered.
    //
    // Never the external property manager, who holds neither view: decision 11
    // says they never reach the address book at all, and a link straight to a
    // screen that can only refuse them is the platform showing an outside party
    // a door it promised was not there.
    capability: "addressBook:read",
  },
  {
    to: "/board/binders",
    section: "board",
    group: "register",
    labelKey: "apartmentBinder.boardTitle",
    // The one capability in the product a board seat alone confers: the
    // administrator's grant of every capability does not carry it (ADR 0017),
    // so an administrator without a seat is not offered this page. Opening a
    // household's binder here is a disclosure, and the server writes it to the
    // audit log.
    capability: "apartmentBinder:manage",
  },
  {
    to: "/board/import",
    section: "board",
    group: "register",
    labelKey: "import.navLabel",
    // Writing to the register, which is what the import does: the capability
    // its endpoints are guarded by besides the address book's. The statutory
    // registers stay reached from the address book; the import has a row
    // because it is a task rather than a view of the register.
    capability: "addressBook:write",
  },
  {
    to: "/board/news",
    section: "board",
    group: "publish",
    // The module's own word for itself, under its own namespace, so the label
    // moves with the feature. It names the act rather than the subject, because
    // the band also carries the reading side above: a board member holds both
    // capabilities, and two links reading "News" would be one word for two
    // screens with nothing to tell them apart.
    labelKey: "news.navLabel",
    // Writing the association's website, which is what news is. Reading it
    // needs no capability at all on the website itself, so this entry is only
    // ever offered to whoever writes it.
    capability: "site:manage",
  },
  {
    to: "/board/site",
    section: "board",
    group: "publish",
    // The website's own word for itself, under its own namespace, so the label
    // moves with the feature.
    labelKey: "siteAdmin.navLabel",
    // Only whoever writes the association's website. Nothing on that screen
    // belongs to a resident: reading the site needs no account at all, which is
    // what a public website is.
    capability: "site:manage",
  },
  {
    to: "/board/events",
    section: "board",
    group: "publish",
    labelKey: "events.boardTitle",
    // Entering a series, publishing it, calling off a date and reading who is
    // coming. Deliberately not the external property manager, on the house
    // entry's reasoning: the dates are not theirs to arrange.
    capability: "events:manage",
  },
  {
    to: "/board/documents",
    section: "board",
    group: "publish",
    labelKey: "documents.boardTitle",
    // Filing a document, and every shelf the board may read sorted by its
    // audience. Editing one on the house's shelf stays where it is, under the
    // board's sign (ADR 0049).
    capability: "documents:manage",
  },
  {
    to: "/board/bookings",
    section: "board",
    group: "publish",
    // Among what the board publishes, because what it keeps here is the
    // calendar the house books from. Named by the act, as the page is.
    labelKey: "bookings.boardTitle",
    // Who holds which hour, and cancelling one on a household's behalf.
    // Deliberately not the external property manager: they do not live in the
    // building, and the calendar names the households in it.
    capability: "bookings:manage",
  },
  {
    to: "/board/meetings",
    section: "board",
    group: "publish",
    // Under the meetings namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "meetings.navLabel",
    // The board's page, because every act on it is the board's own side of one
    // meeting: arranging it, summoning the members, checking them in and
    // minuting what was decided. What a member holds at a general meeting is
    // the right to attend, speak and vote (EFL 6 kap. 2-3 §§), and none of that
    // happens on this platform - the meeting is in a room or on a call. The
    // members' own record of past meetings would be a house page of its own,
    // and there is none yet.
    //
    // Deliberately not derived from membership, which makes it the opposite of
    // motions:submit. A member who is also on the board holds it as a board
    // member, which is the ordinary case. The external property manager holds it
    // no more than they hold the motions queue: the members' decisions about
    // their own association are no part of a contractor's work, and the list of
    // who was in the room is resident data they have no business reading.
    capability: "meetings:manage",
  },
  {
    to: "/board/fees",
    section: "board",
    group: "money",
    // Under the fees namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "fees.navLabel",
    // Separate from memberCharges:manage although both are money and both sit
    // with the board today. Fixing the avgifter is the board's standing task
    // under BRL 9 kap. 13 § while a debitering is an event, and a cooperative
    // that has given its treasurer the fee book while the whole board approves
    // individual charges is a seat split only two capabilities can express.
    //
    // Deliberately not the external property manager's, on the motions:handle
    // precedent: what a household pays the association is the board's business
    // with its own members. There is no resident half - a member learns what
    // they owe from the notice the board produces.
    capability: "fees:manage",
  },
  {
    to: "/board/charges",
    section: "board",
    group: "money",
    // Under the charges namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "charges.navLabel",
    // One capability and no any-of list, because there is one audience. The
    // module has no resident half: a member learns what they are charged from
    // the notice the accounting system sends, and what Open BRF holds is the
    // basis the board records and hands to whoever keeps the books.
    //
    // Deliberately not the external property manager, on the motions:handle
    // precedent: they handle the association's issues, and what the association
    // charges its members is its own business with its own members. Nor the
    // economic manager who receives the list, who has no account here at all.
    capability: "memberCharges:manage",
  },
  {
    to: "/board/data-protection",
    section: "board",
    group: "dataProtection",
    // Under the module's own namespace, like the meetings entry above: the
    // label is this module's word for itself and moves with it.
    labelKey: "dataProtection.navLabel",
    // One capability. The four records behind this door are one duty - showing
    // that the association processes lawfully, GDPR art. 5(2) - and a board
    // that reached one of them and not the others could not answer for it.
    //
    // There is no member's half here to be shut out of. What a person
    // holds about their own data is exercised on their own profile (the export)
    // or recorded by the board on the person's page in the register, which is
    // gated on the address book rather than here, because that is a fact about
    // one named person rather than about the association.
    capability: "dataProtection:manage",
  },
  { to: "/settings", labelKey: "nav.settings", section: "settings" },
  {
    to: "/plugins",
    section: "settings",
    // Under the plugins namespace rather than nav, because the label is that
    // feature's own word for itself and moves with it.
    labelKey: "plugins.navLabel",
    capability: "association:read",
  },
  {
    to: "/licences",
    section: "settings",
    // Under the module's own namespace rather than nav, on the plugins entry's
    // terms. association:manage rather than the plugin list's association:read,
    // because every route behind the screen asks for it: the capability that
    // installs a paid plugin is the one that enters its licence (ADR 0042).
    labelKey: "licences.navLabel",
    capability: "association:manage",
  },
  {
    to: "/connected-apps",
    section: "settings",
    // Under the module's own namespace rather than nav, because the label is
    // that module's word for itself and moves with it.
    labelKey: "connectedApps.navLabel",
    // The same seat as plugins above, and for the same reason: what an external
    // program may reach is part of how the instance is configured, and the
    // board answers for what leaves the association. One capability rather than
    // an any-of list - a member's own connections are on their settings screen,
    // which every account already reaches, so there is no member's half of this
    // destination to be shut out of.
    //
    // Deliberately not dataProtection:manage, although cutting somebody else's
    // connection needs it: gating the door on the stronger of the screen's two
    // capabilities would hide the list from the seat that may read it.
    capability: "association:read",
  },
];

/**
 * The destinations offered to every account.
 *
 * Used while the viewer is still unknown. Only the overview and the settings
 * qualify - the overview's panels and the settings' profile and security
 * panels follow from whoever is signed in, and every other destination answers
 * to somebody's capability - so a band built from this list only ever gains
 * links once the capabilities arrive, and never shows one it has to take away
 * again. Offering and then withdrawing is the direction that matters: it tells
 * somebody a part of the product is theirs and then contradicts itself.
 */
export const NAV_ITEMS: readonly NavItem[] = ENTRIES.filter(
  (entry) => entry.capability === undefined && entry.to !== BOARD_FRONT,
);

/*
 * The phone bar's three destinations: one list for an account with board
 * pages, one for everybody else.
 *
 * Chosen by what the account is offered, because the client has nothing else
 * to go on: the viewer carries capabilities and no roles, and asking what
 * somebody may do rather than who they are is the product's rule. An account
 * offered any of the board's pages gets the board's bar, which is the board
 * itself, the administrator and the external property manager.
 *
 * The overview is the first column for every account, because it is the page
 * every sign-in lands on and a phone has to be able to get back to it.
 *
 * The board then reaches for its own first page - the front page where it has
 * one, otherwise the one page it has, which for the property manager is the
 * issue queue - and the feed. Everybody else gets what residents do on a
 * phone: reporting an issue and booking a room. The news is not in the bar,
 * because the overview lists the newest items.
 *
 * Each list is intersected with what the account is offered and never filled
 * up. Filling a gap from the rest would put whichever destination came next
 * into a column nobody chose for it, and move it again when a grant changed; an
 * empty column says nothing false. Settings is in neither list: at the bar's
 * lettering its label is wider than a quarter of a small phone, and it is
 * always in the sheet behind the menu button, with every other destination.
 */
const BAR_FOR_RESIDENTS: readonly string[] = ["/", "/issues", "/bookings"];
const BAR_SLOTS = [1, 2, 3] as const;

/** The bar for an account whose first board page is this one. */
function barForTheBoard(firstBoardPage: string): readonly string[] {
  return ["/", firstBoardPage, "/feed"];
}

/**
 * The destinations a viewer with these capabilities is offered, each with its
 * column in the phone bar when it has one.
 *
 * Unknown capabilities give the destinations every account is offered and no
 * bar at all, so the bar gains its columns once the viewer arrives rather than
 * showing one it then takes back.
 */
export function navItemsFor(
  capabilities: readonly string[] | undefined,
): readonly NavItem[] {
  if (capabilities === undefined) {
    return NAV_ITEMS;
  }
  const held = ENTRIES.filter((entry) => holds(capabilities, entry.capability));
  const boardPages = held.filter(
    (entry) => entry.section === "board" && entry.to !== BOARD_FRONT,
  );
  // The front page gathers the board's pages, so it is there when there are
  // at least two to gather.
  const offered =
    boardPages.length >= 2
      ? held
      : held.filter((entry) => entry.to !== BOARD_FRONT);
  const [firstBoardPage] =
    boardPages.length >= 2 ? [BOARD_FRONT] : boardPages.map((page) => page.to);
  const bar = (
    firstBoardPage === undefined
      ? BAR_FOR_RESIDENTS
      : barForTheBoard(firstBoardPage)
  ).filter((to) => offered.some((entry) => entry.to === to));

  return offered.map(({ parent, ...entry }) => {
    const index = bar.indexOf(entry.to);
    return {
      ...entry,
      // Only under a parent this account is offered; otherwise the entry stands
      // in its section, so nobody loses a link for a grant they do not hold.
      ...(parent !== undefined && offered.some((o) => o.to === parent)
        ? { parent }
        : {}),
      ...(index === -1 ? {} : { barSlot: BAR_SLOTS[index] }),
    };
  });
}

/**
 * Whether an account with these capabilities is offered the destination at
 * this path.
 *
 * A board page asks it of its own path, so the page is offered to exactly the
 * accounts the band lists it for, and the front page to an account with two or
 * more board pages rather than to anybody who opens its address.
 */
export function isOffered(
  capabilities: readonly string[],
  to: string,
): boolean {
  return navItemsFor(capabilities).some((item) => item.to === to);
}

/** A plugin's view as the API describes it to the navigation. */
export interface OfferedPluginView {
  id: string;
  titleKey: string;
  /** Null when this account is offered no entry for it. */
  section: PluginViewSection | null;
}

/**
 * The entries for the plugin views this account is offered.
 *
 * Which views those are, and in which section, is the API's answer: it knows
 * what the plugin's routes require and which seat the account holds, and a
 * second rule here could disagree with it. A view offered nowhere is left out,
 * and is still reachable at its address.
 *
 * Each stands after the core's own destinations in its section, in the order
 * the API lists them, which is by plugin id; in the board's section, after the
 * destinations of its first group. None is in the phone bar: its
 * three columns are chosen for the account, and a plugin is not a reason to
 * move one.
 */
export function pluginNavItems(
  views: readonly OfferedPluginView[],
): readonly NavItem[] {
  return views.flatMap((view) =>
    view.section === null
      ? []
      : [
          {
            to: `/plugin/${view.id}`,
            section: view.section,
            // A view in the board's section is a board page and stands in a
            // group like the rest; "Queues" is where the work arrives.
            ...(view.section === "board" ? { group: "queues" as const } : {}),
            labelKey: view.titleKey,
            pluginId: view.id,
          },
        ],
  );
}

/** The sections these destinations fill, in band order; empty ones left out. */
export function sectionsOf(items: readonly NavItem[]): OfferedSection[] {
  return NAV_SECTIONS.map((section) => ({
    id: section.id,
    labelKey: section.labelKey,
    items: items.filter((item) => item.section === section.id),
  })).filter((section) => section.items.length > 0);
}

/** A run of a section's destinations under one group heading, or under none. */
export interface OfferedGroup {
  /** Null for the destinations that stand under no heading. */
  labelKey: TranslationKey | null;
  items: readonly NavItem[];
}

/**
 * A section's destinations in their groups, in the order the section lists them.
 *
 * A group this account is offered one destination in shows that row without a
 * heading: a heading over one row says the same thing twice, and the row's own
 * name is the more exact of the two. Outside the board's section every
 * destination stands under no heading, so this is one group of all of them.
 */
export function groupsOf(items: readonly NavItem[]): OfferedGroup[] {
  const groups: OfferedGroup[] = [];
  const ungrouped = items.filter((item) => item.group === undefined);
  if (ungrouped.length > 0) {
    groups.push({ labelKey: null, items: ungrouped });
  }
  for (const group of BOARD_GROUPS) {
    const inGroup = items.filter((item) => item.group === group.id);
    if (inGroup.length > 0) {
      groups.push({
        labelKey: inGroup.length > 1 ? group.labelKey : null,
        items: inGroup,
      });
    }
  }
  return groups;
}

/**
 * The offered destination the reader is on, if any.
 *
 * The one whose path is the pathname, or its longest prefix ending at a segment
 * boundary; the overview's `/` and the board's front page count only on an
 * exact match, because every other page sits under one of them. That is the
 * rule the router's Link applies to mark itself active, plus "the longest
 * wins", so a page whose path lies under two destinations marks the nearer one.
 * A route that is no destination's - a register, a plugin's view offered in no
 * section - marks nothing.
 */
export function currentDestination(
  pathname: string,
  items: readonly NavItem[],
): NavItem | undefined {
  let current: NavItem | undefined;
  for (const item of items) {
    const matches =
      item.to === "/" || item.to === BOARD_FRONT
        ? pathname === item.to
        : pathname === item.to || pathname.startsWith(`${item.to}/`);
    if (
      matches &&
      (current === undefined || item.to.length > current.to.length)
    ) {
      current = item;
    }
  }
  return current;
}

/** Whether these capabilities satisfy an entry's requirement. */
function holds(
  capabilities: readonly string[],
  required: string | readonly string[] | undefined,
): boolean {
  if (required === undefined) {
    return true;
  }
  if (typeof required === "string") {
    return capabilities.includes(required);
  }
  return required.some((capability) => capabilities.includes(capability));
}
