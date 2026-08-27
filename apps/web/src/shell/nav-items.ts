import type { NavItem } from "./AppShell";

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
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", labelKey: "nav.addressBook" },
  { to: "/settings", labelKey: "nav.settings" },
];
