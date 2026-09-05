import type { NavItem } from "./AppShell";

/**
 * A destination, and what it takes to be offered it.
 *
 * The capability is not an authorization boundary - the API refuses the calls
 * regardless of what the navigation shows - but a link nobody in that seat can
 * use is still a defect: it teaches a resident that part of the product is
 * broken for them rather than not theirs.
 */
interface NavEntry extends NavItem {
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
 * Settings is offered to every account, not only an admin: the profile and the
 * security screens inside it belong to whoever is signed in. The admin-only
 * panels are decided by capability within the screen, and the API refuses the
 * calls regardless of what the navigation shows.
 *
 * Plugins is different. Nothing on that screen belongs to a resident, so it is
 * offered only to whoever may read how the instance is configured.
 *
 * The document archive names no capability, because reading it needs none: the
 * server filters the shelf by the viewer's audience, so an account with
 * nothing to see there is shown an empty archive rather than a missing link.
 */
const ENTRIES: readonly NavEntry[] = [
  {
    to: "/",
    labelKey: "nav.addressBook",
    // Either audience of the register, and neither is everybody: an external
    // property manager holds neither, and decision 11 says they never reach the
    // address book at all. The API refuses them both views regardless, but a
    // link straight to a screen that can only refuse them is the platform
    // showing an outside party a door it promised was not there.
    capability: ["addressBook:read", "residentDirectory:read"],
  },
  {
    to: "/plugins",
    // Under the plugins namespace rather than nav, because the label is that
    // feature's own word for itself and moves with it.
    labelKey: "plugins.navLabel",
    capability: "association:read",
  },
  { to: "/settings", labelKey: "nav.settings" },
  {
    to: "/issues",
    // Under the issues namespace rather than nav, because the label is that
    // module's own word for itself and moves with it.
    labelKey: "issues.navLabel",
    capability: ["issues:report", "issues:handle"],
  },
  {
    to: "/bookings",
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
    to: "/events",
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
    to: "/motions",
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
    to: "/meetings",
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
    to: "/news",
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
    to: "/documents",
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
    to: "/admin/site",
    // The website's own word for itself, under its own namespace, so the label
    // moves with the feature.
    labelKey: "siteAdmin.navLabel",
    // Only whoever writes the association's website. Nothing on that screen
    // belongs to a resident: reading the site needs no account at all, which is
    // what a public website is.
    capability: "site:manage",
  },
  {
    to: "/admin/site/news",
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

/** The destinations a viewer with these capabilities is offered. */
export function navItemsFor(
  capabilities: readonly string[] | undefined,
): readonly NavItem[] {
  if (capabilities === undefined) {
    return NAV_ITEMS;
  }
  return ENTRIES.filter((entry) => holds(capabilities, entry.capability));
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
