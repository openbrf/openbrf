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
  /** Offered to everyone when absent. */
  capability?: string;
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
 */
const ENTRIES: readonly NavEntry[] = [
  { to: "/", labelKey: "nav.addressBook" },
  {
    to: "/plugins",
    // Under the plugins namespace rather than nav, because the label is that
    // feature's own word for itself and moves with it.
    labelKey: "plugins.navLabel",
    capability: "association:read",
  },
  { to: "/settings", labelKey: "nav.settings" },
];

/**
 * The destinations offered to every account.
 *
 * Used while the viewer is still unknown, so the band does not shuffle its
 * links once the viewer's capabilities arrive.
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
  return ENTRIES.filter(
    (entry) =>
      entry.capability === undefined || capabilities.includes(entry.capability),
  );
}
