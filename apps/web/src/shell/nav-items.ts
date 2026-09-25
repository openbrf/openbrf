import type { TranslationKey } from "../i18n/translation-key";

/**
 * The sections of the navigation, in the order the band shows them.
 *
 * Every destination belongs to exactly one of them, whoever is looking, so a
 * destination is found in the same place by every seat that is offered it.
 *
 * - association: the association's people and its life - the register or the
 *   resident directory, what the board publishes, the calendar, the rooms, the
 *   archive and the items put to the general meeting.
 * - building: the building and the apartments in it - faults, the shared rooms,
 *   keys, a household's binder, letting the apartment.
 * - board: the board's own desk, holding only destinations no resident is
 *   offered. The general meeting sits here rather than beside the motions
 *   because its screen is the board's side of the meeting and nothing else: the
 *   record is the board's to keep, and no member is offered it.
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
] as const satisfies readonly { id: string; labelKey: TranslationKey }[];

export type NavSectionId = (typeof NAV_SECTIONS)[number]["id"];

/** A destination as the navigation renders it. */
export interface NavItem {
  to: string;
  labelKey: TranslationKey;
  /** The section of the navigation that holds it. */
  section: NavSectionId;
  /** Its column in the phone bar, when it has one; see navItemsFor. */
  barSlot?: 1 | 2 | 3;
  /** Shown as a small brass plate, e.g. an open issue count. */
  count?: number;
}

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
interface NavEntry extends Omit<NavItem, "barSlot"> {
  /**
   * Offered to everyone when absent; to holders of any one of these when a list.
   *
   * Any rather than all, because a destination can belong to two seats for two
   * different reasons. Issues is the case: a resident reaches it holding
   * issues:report and an external property manager holding issues:handle, and
   * neither holds the other's - requiring both would hide the queue from the
   * one person whose whole account exists to work it.
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
 * the phone bar are derived from these entries and never kept beside them.
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
    labelKey: "nav.addressBook",
    // Either audience of the register, and neither is everybody: an external
    // property manager holds neither, and decision 11 says they never reach the
    // address book at all. The API refuses them both views regardless, but a
    // link straight to a screen that can only refuse them is the platform
    // showing an outside party a door it promised was not there.
    capability: ["addressBook:read", "residentDirectory:read"],
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
    // Either half of the module. Somebody living here reaches it holding
    // events:attend and whoever arranges the calendar holding events:manage -
    // and although the board holds both today, an entry gated on one of them
    // would tie the navigation to that grant rather than to what the screen
    // offers.
    //
    // Deliberately not the external property manager, who holds neither: they
    // handle the association's issues and do not live in the building, so a
    // place at the cleaning day is not theirs to take and its dates are not
    // theirs to arrange.
    capability: ["events:attend", "events:manage"],
  },
  {
    to: "/chat",
    section: "association",
    // Under the module's own namespace rather than nav, because the label is
    // that module's word for itself and moves with it.
    labelKey: "chat.navLabel",
    // One capability and no any-of list, although two kinds of room sit behind
    // it: the board chat, whose members are whoever holds a seat, and a group,
    // which somebody who lives here made for something the house is doing.
    // Which rooms there are for this account is the service's answer and never
    // this list's.
    //
    // Deliberately not the external property manager, on the news:comment
    // precedent: they handle the association's issues, they were not elected to
    // anything and they do not live here.
    //
    // The administrator holds it through the ADMIN grant and is offered this
    // destination, and finds no room in it. That is not a link to a screen that
    // can only refuse them - the screen answers, and what it says is that the
    // board's room comes from an election and a group from a neighbour, and
    // that this account has neither. Hiding it from them would be hiding the
    // explanation as well.
    capability: "chat:participate",
  },
  {
    to: "/documents",
    section: "association",
    // The archive's own word for itself, under its own namespace, so the label
    // moves with the feature.
    labelKey: "documents.navLabel",
    // Offered to the people the archive is kept for - anyone living in the
    // building, and whoever administers it. Deliberately not the external
    // property manager: their seat is issue handling, and the association's
    // own binder is not theirs to browse. This gates the band only; what any
    // account may actually read is still each document's audience, decided on
    // the server, and the public documents remain public on the website.
    capability: ["residentDirectory:read", "documents:manage"],
  },
  {
    to: "/motions",
    section: "association",
    // Under the motions namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "motions.navLabel",
    // Either half of the module, and the two halves are held by different people
    // for different reasons - which is what makes this an any-of rather than a
    // single capability.
    //
    // motions:submit is a MEMBER's, and the only entry in this file gated on
    // something derived from membership rather than from residency: EFL 6 kap.
    // 15 §, applied to a housing cooperative by BRL 9 kap. 14 §, gives the right
    // to put an item to a general meeting to a member. So a partner, an adult
    // child or a tenant living here is offered nothing here, and that absence is
    // the statute rather than a decision about screens.
    //
    // motions:handle is the board's, because a motion is addressed to it. A board
    // member who holds no tenant-ownership reaches this destination to work the
    // queue and finds no form on it, which is the same rule read from the other
    // end. The external property manager holds neither.
    capability: ["motions:submit", "motions:handle"],
  },
  {
    to: "/issues",
    section: "building",
    // Under the issues namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "issues.navLabel",
    capability: ["issues:report", "issues:handle"],
  },
  {
    to: "/bookings",
    section: "building",
    // Under the bookings namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "bookings.navLabel",
    // Either half of the module. A resident reaches it holding bookings:book
    // and whoever runs the calendar holding bookings:manage - and although the
    // board holds both today, an entry gated on one of them would tie the
    // navigation to that grant rather than to what the screen offers.
    //
    // Deliberately not the external property manager, who holds neither: they
    // handle the association's issues and do not live in the building, so a
    // laundry hour is not theirs to take or to give away.
    capability: ["bookings:book", "bookings:manage"],
  },
  {
    to: "/key-orders",
    section: "building",
    // Under the key order namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "keyOrders.navLabel",
    // Either half, and the deliberate contrast with sublets below. Nothing gives
    // anybody a right to a key, so keyOrders:place follows living here the way
    // bookings:book does - a partner, an adult child and a tenant are offered
    // this destination and not the sublets one. keyOrders:handle is the board's,
    // because it is the association's own property being given out.
    //
    // Deliberately not the external property manager, although handing out keys
    // is plausibly part of what a vicevard does: the queue names residents and
    // their apartments, which is the address book in another shape.
    capability: ["keyOrders:place", "keyOrders:handle"],
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
    // theirs to browse.
    //
    // The second names the board's half, which is the one capability in the
    // product a board seat alone confers: the administrator's grant of every
    // capability does not carry it (ADR 0017). The administrator is still
    // offered the destination, through the first of the two, and what they find
    // is a sentence saying that a binder is read by whoever lives in the
    // apartment - on the chat's reasoning, that hiding the door would hide the
    // explanation with it.
    //
    // What any account may actually read is decided per request against the
    // residencies it holds today, on the server, and never here.
    capability: ["residentDirectory:read", "apartmentBinder:manage"],
  },
  {
    to: "/sublets",
    section: "building",
    // Under the sublets namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "sublets.navLabel",
    // Either half of the module, and the two halves are held by different people
    // for different reasons - which is what makes this an any-of rather than a
    // single capability.
    //
    // sublets:apply is derived from membership, like motions:submit and for the
    // same kind of reason: BRL 7 kap. 10 § forsta stycket lets a
    // bostadsrattshavare let "sin lagenhet" in andra hand with the board's
    // consent, so the act belongs to whoever holds the tenant-ownership. A
    // partner, an adult child or a tenant living here is offered nothing here,
    // and that absence is the statute rather than a decision about screens.
    //
    // sublets:handle is the board's, because the same paragraph names the
    // styrelse as who gives the consent. The external property manager holds
    // neither.
    capability: ["sublets:apply", "sublets:handle"],
  },
  {
    to: "/board-mailbox",
    section: "board",
    // Under the module's own namespace rather than nav, because the label is
    // that module's word for itself and moves with it.
    labelKey: "boardMailbox.navLabel",
    capability: "boardMailbox:handle",
  },
  {
    to: "/admin/site/news",
    section: "board",
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
    to: "/admin/site",
    section: "board",
    // The website's own word for itself, under its own namespace, so the label
    // moves with the feature.
    labelKey: "siteAdmin.navLabel",
    // Only whoever writes the association's website. Nothing on that screen
    // belongs to a resident: reading the site needs no account at all, which is
    // what a public website is.
    capability: "site:manage",
  },
  {
    to: "/meetings",
    section: "board",
    // Under the meetings namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "meetings.navLabel",
    // One capability and no any-of list, and the contrast with motions above is
    // the point. There the module has two halves for two audiences - a member
    // putting an item in, the board working the queue - so an entry gated on
    // either half alone would hide it from the other. Here every act is the
    // board's own side of one meeting: arranging it, summoning the members,
    // checking them in and minuting what was decided. There is no member's half
    // to be shut out of, because what a member holds at a general meeting is the
    // right to attend, speak and vote (EFL 6 kap. 2-3 §§) and none of that
    // happens on this platform - the meeting is in a room or on a call.
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
    to: "/fees",
    section: "board",
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
    to: "/charges",
    section: "board",
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
    to: "/data-protection",
    section: "board",
    // Under the module's own namespace, like the meetings entry above: the
    // label is this module's word for itself and moves with it.
    labelKey: "dataProtection.navLabel",
    // One capability. The four records behind this door are one duty - showing
    // that the association processes lawfully, GDPR art. 5(2) - and a board
    // that reached one of them and not the others could not answer for it.
    //
    // No any-of list, and the contrast with motions is the same one meetings
    // draws: there is no member's half here to be shut out of. What a person
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
 * Used while the viewer is still unknown. Only the settings screen qualifies -
 * the profile and the security panels inside it belong to whoever is signed in,
 * and every other destination answers to somebody's capability - so a band
 * built from this list only ever gains links once the capabilities arrive, and
 * never shows one it has to take away again. Offering and then withdrawing is
 * the direction that matters: it tells somebody a part of the product is theirs
 * and then contradicts itself.
 */
export const NAV_ITEMS: readonly NavItem[] = ENTRIES.filter(
  (entry) => entry.capability === undefined,
);

/*
 * The phone bar's three destinations: one list for the board, one for
 * everybody else.
 *
 * Chosen by a capability because the client has nothing else to go on: the
 * viewer carries capabilities and no roles, and asking what somebody may do
 * rather than who they are is the product's rule. addressBook:read is the one
 * the address book already recognises the board's view by, and it comes with a
 * board seat or the administrator's grant.
 *
 * The board reaches on a phone for the register with its contact details, the
 * issue queue where a resident's report lands, and its own chat. Everybody else
 * gets what residents use the product for on a phone: the news, reporting an
 * issue and booking a room.
 *
 * Each list is intersected with what the account is offered and never filled
 * up. Filling a gap from the rest would put whichever destination came next
 * into a column nobody chose for it, and move it again when a grant changed; an
 * empty column says nothing false. Settings is in neither list: at the bar's
 * lettering its label is wider than a quarter of a small phone, and it is
 * always in the sheet behind the menu button, with every other destination.
 */
const BAR_FOR_THE_BOARD: readonly string[] = ["/", "/issues", "/chat"];
const BAR_FOR_RESIDENTS: readonly string[] = ["/news", "/issues", "/bookings"];
const BAR_SLOTS = [1, 2, 3] as const;

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
  const offered = ENTRIES.filter((entry) =>
    holds(capabilities, entry.capability),
  );
  const bar = (
    capabilities.includes("addressBook:read")
      ? BAR_FOR_THE_BOARD
      : BAR_FOR_RESIDENTS
  ).filter((to) => offered.some((entry) => entry.to === to));

  return offered.map((entry) => {
    const index = bar.indexOf(entry.to);
    return index === -1 ? entry : { ...entry, barSlot: BAR_SLOTS[index] };
  });
}

/** The sections these destinations fill, in band order; empty ones left out. */
export function sectionsOf(items: readonly NavItem[]): OfferedSection[] {
  return NAV_SECTIONS.map((section) => ({
    id: section.id,
    labelKey: section.labelKey,
    items: items.filter((item) => item.section === section.id),
  })).filter((section) => section.items.length > 0);
}

/**
 * The offered destination the reader is on, if any.
 *
 * The one whose path is the pathname, or its longest prefix ending at a segment
 * boundary; the address book's `/` counts only on an exact match. That is the
 * rule the router's Link applies to mark itself active, plus "the longest
 * wins": without it both the website and writing news would be current on
 * /admin/site/news, which is one page. A route that is no destination's - a
 * register, the import, a plugin's view - marks nothing.
 */
export function currentDestination(
  pathname: string,
  items: readonly NavItem[],
): NavItem | undefined {
  let current: NavItem | undefined;
  for (const item of items) {
    const matches =
      item.to === "/"
        ? pathname === "/"
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
