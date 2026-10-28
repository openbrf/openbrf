/**
 * The host members a resident route's handler is refused, each in one of two
 * ways (ADR 0051), and the members the host holds back outside the plugin's
 * resident routes while one of them works.
 *
 * The register reads name residents, apartments or how many of either the
 * address book lists, and a resident route has no use for them, so they are
 * refused whatever they are passed. `caller`, the action dispatch, the app an
 * action request came from, the audit entry's actor and a theme install are
 * held to the request the route is serving: a request kept from elsewhere, a
 * board member's in a singleton for one, would otherwise read that person,
 * dispatch or install a theme with their capabilities or record them as the
 * actor of the resident's act.
 *
 * Each of these but `actions.client`, which answers at once and names an app
 * rather than a person, and a record written about a person and a disclosure
 * naming persons, made by the plugin outside every resident route of its own
 * while one of them has yet to answer, waits for that answer first. A listener
 * the handler awaits runs outside the route, in the context of whoever emits,
 * so such a call is refused when the answer does not come in time, and a
 * handler that has not answered within the host's deadline has not. The hold
 * lasts while the handler works, up to its deadline, and then for as long as
 * the work of a handler cut off at that deadline goes on, up to a bounded
 * overrun after it (ADR 0051): a call made outside is refused at once until
 * that work settles or the overrun has passed, and goes ahead after. No
 * listener or callback a handler sets up may outlive its answer or use a
 * request other than its own, and catalog review checks that.
 */
export const PLUGIN_RESIDENT_ROUTE_REFUSED_MEMBERS = [
  "addressBook.residents",
  "addressBook.apartments",
  "addressBook.summary",
  "addressBook.caller",
  "actions.list",
  "actions.invoke",
  "actions.propose",
  "actions.client",
  "audit.record",
  "personRecords.put",
  "recipients.fetch",
  "themes.install",
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
 * (ADR 0051): a register read, or `caller`, an action dispatch, the app an
 * action request came from, an audit entry or a theme install given another
 * request than the one the route is serving.
 *
 * Or, with `outside`, the plugin made such a call, wrote a record about a
 * person or named persons in a disclosure outside every resident route of its
 * own while one of them had yet to answer, and that route did not answer in
 * time. Nothing of the call was done. A handler that awaits a listener on a
 * Subject the plugin shares, which runs in the context of a job or another
 * request, meets this; so does a job or a board route of the plugin's while a
 * resident route's handler works for longer than the host's deadline for it.
 *
 * Met in a plugin's own tests of a resident route, which start with nothing
 * read beforehand, rather than in catalog review. The message names the
 * member and never the request or a person: the error reaches the log.
 */
export class PluginResidentRouteError extends Error {
  constructor(
    readonly pluginId: string,
    readonly member: PluginResidentRouteRefusedMember,
    readonly outside = false,
  ) {
    super(
      outside
        ? `Plugin "${pluginId}" called ${member} outside its resident ` +
            "routes while one of them had yet to answer, and it did not " +
            "answer in time. A resident route's handler may not wait on " +
            "such a call."
        : REGISTER_READS.includes(member)
          ? `Plugin "${pluginId}" called ${member} on a resident route, ` +
            "where the register is not read."
          : `Plugin "${pluginId}" called ${member} on a resident route with ` +
            "another request than the one the route is serving.",
    );
    this.name = "PluginResidentRouteError";
  }
}
