/**
 * The host members a resident route's handler is refused, each in one of two
 * ways (ADR 0051).
 *
 * The register reads name residents, apartments or how many of either the
 * address book lists, and a resident route has no use for them, so they are
 * refused whatever they are passed. `caller` and the action dispatch are held
 * to the request the route is serving: a request kept from elsewhere, a board
 * member's in a singleton for one, would otherwise read that person or
 * dispatch with their capabilities.
 */
export const PLUGIN_RESIDENT_ROUTE_REFUSED_MEMBERS = [
  "addressBook.residents",
  "addressBook.apartments",
  "addressBook.summary",
  "addressBook.caller",
  "actions.list",
  "actions.invoke",
  "actions.propose",
] as const;

export type PluginResidentRouteRefusedMember =
  (typeof PLUGIN_RESIDENT_ROUTE_REFUSED_MEMBERS)[number];

const REGISTER_READS: readonly PluginResidentRouteRefusedMember[] = [
  "addressBook.residents",
  "addressBook.apartments",
  "addressBook.summary",
];

/**
 * A resident route's handler reached for a host member the route may not use
 * (ADR 0051): a register read, or `caller` or an action dispatched with
 * another request than the one the route is serving.
 *
 * Met in a plugin's own tests of a resident route, which start with nothing
 * read beforehand, rather than in catalog review. The message names the
 * member and never the request or a person: the error reaches the log.
 */
export class PluginResidentRouteError extends Error {
  constructor(
    readonly pluginId: string,
    readonly member: PluginResidentRouteRefusedMember,
  ) {
    super(
      REGISTER_READS.includes(member)
        ? `Plugin "${pluginId}" called ${member} on a resident route, ` +
            "where the register is not read."
        : `Plugin "${pluginId}" called ${member} on a resident route with ` +
            "another request than the one the route is serving.",
    );
    this.name = "PluginResidentRouteError";
  }
}
