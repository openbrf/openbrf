import type { PluginViewSection } from "@openbrf/plugin-sdk";

import type { Capability } from "../authorization/capabilities";

/**
 * The capability the board's view is recognised by.
 *
 * It comes with a board seat or the administrator's grant and with nothing a
 * resident or the external property manager holds, which is why the address
 * book already tells its two views apart by it and the application's phone bar
 * chooses the board's columns by it.
 */
const BOARD_VIEW: Capability = "addressBook:read";

/**
 * The section of the navigation an account is offered a plugin's view in, or
 * null when the view is reachable by its address alone.
 *
 * The manifest names the section; the host decides who is offered the entry,
 * on two rules the core's own destinations keep:
 *
 * - Only an account that holds everything the plugin's routes require. A link to a
 *   screen whose every request would be refused teaches a resident that part
 *   of the product is broken for them rather than not theirs. The requirement
 *   is the routes' floor, read from what the board consented to, so the entry
 *   and the routes cannot disagree about who the plugin is for.
 * - In the board's section only to the board. That section holds nothing a
 *   resident is offered, and a plugin naming it does not get to change that.
 *
 * Not an authorization boundary: the view is still reachable by its address,
 * and the plugin's routes refuse whoever lacks their floor regardless of what
 * the navigation shows.
 */
export function offeredSection(
  section: PluginViewSection | undefined,
  routeFloor: readonly Capability[],
  capabilities: ReadonlySet<Capability>,
): PluginViewSection | null {
  if (
    section === undefined ||
    !routeFloor.every((capability) => capabilities.has(capability))
  ) {
    return null;
  }
  if (section === "board" && !capabilities.has(BOARD_VIEW)) {
    return null;
  }
  return section;
}
