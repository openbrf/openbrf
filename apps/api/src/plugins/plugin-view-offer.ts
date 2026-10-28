import type { PluginViewSection } from "@openbrf/plugin-sdk";

import type { Capability } from "../authorization/capabilities";
import { residentRouteFloor } from "./plugin-module-seal";

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
 *
 * For a plugin that declares no resident routes. One that does is offered by
 * `residentViewSection` instead.
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

/**
 * The section of the navigation an account is offered the view of a plugin
 * that declares resident routes in, or null (ADR 0051).
 *
 * The view of such a plugin is the residents', and the routes behind it
 * answer a resident without a board seat. So it is offered to an account that
 * holds a residency today, and to nobody else: not on the floor of the
 * plugin's other routes, which a resident lacks, and not to a board member or
 * an administrator who does not live in the house, whom the resident routes
 * refuse. What a resident route requires besides the residency, such as the
 * finance half of an extension group's floor, is required here as well.
 *
 * A resident the address book does not list to the plugin is still offered
 * it, and the view tells them the module is not available to them: deciding
 * the entry by the listing would read the address book for every plugin on
 * every navigation answer, and the navigation is not where access is decided.
 * Never in the board's section, which the manifest refuses beside resident
 * routes and which holds nothing a resident is offered.
 */
export function residentViewSection(
  section: PluginViewSection | undefined,
  routeFloor: readonly Capability[],
  capabilities: ReadonlySet<Capability>,
  holdsResidency: boolean,
): PluginViewSection | null {
  if (
    section === undefined ||
    section === "board" ||
    !holdsResidency ||
    !residentRouteFloor(routeFloor).every((capability) =>
      capabilities.has(capability),
    )
  ) {
    return null;
  }
  return section;
}

/**
 * Whether an account is offered a plugin's board view (ADR 0051, amended
 * 2026-10-26): its entry in the board's section, and the view at
 * `/board/plugin/<id>`, which shows anybody else the sentence every refused
 * board page says.
 *
 * On the rules of the board's section above, and on the capability the board
 * view declares besides, which the board's own routes behind it require. A
 * board member without that capability is refused the page as they would be
 * every call it makes.
 *
 * Not an authorization boundary either: the plugin's routes refuse whoever
 * lacks what they require.
 */
export function boardViewOffered(
  capability: Capability,
  routeFloor: readonly Capability[],
  capabilities: ReadonlySet<Capability>,
): boolean {
  return (
    offeredSection("board", routeFloor, capabilities) === "board" &&
    capabilities.has(capability)
  );
}
