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
    // moves with the feature.
    labelKey: "news.navLabel",
    // Writing the association's website, which is what news is. Reading the
    // news needs no capability at all - it is on the public website - so this
    // entry is only ever offered to whoever writes it.
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
