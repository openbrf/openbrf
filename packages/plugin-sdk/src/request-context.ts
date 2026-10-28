/**
 * The host members that take a request, each held to the request the work
 * that calls it is serving (ADR 0051, update of 2026-10-28).
 *
 * A request speaks for the person or the device behind it. The host serves
 * each request in an async context of its own, which follows the work begun
 * for it: the plugin's guards, its handler and what the handler awaits or
 * leaves running, its exception filters and the answer's serialization. A
 * member below given a request is refused unless the call is made in the
 * context serving that request. So a request kept in a singleton, handed to a
 * job, a timer or a queue the plugin started elsewhere, or used by a listener
 * that runs when a job or another request emits, acts for nobody: it would
 * otherwise read the person behind it, dispatch with their capabilities or
 * name them as the actor of somebody else's act.
 *
 * `audit.record` with `null` and `devices.revoke` without a request take none,
 * and are not held.
 */
export const PLUGIN_REQUEST_MEMBERS = [
  "addressBook.caller",
  "actions.list",
  "actions.invoke",
  "actions.propose",
  "actions.client",
  "audit.record",
  "themes.install",
  "devices.issue",
  "devices.revoke",
  "devices.current",
] as const;

export type PluginRequestMember = (typeof PLUGIN_REQUEST_MEMBERS)[number];

/**
 * A plugin gave a host member a request that the work making the call is not
 * serving, and nothing of the call was done.
 *
 * Pass a request on only in the work that serves it: the route's own guard,
 * handler or exception filter, and what they await. Background work is handed
 * what it needs from the request, such as an id, and never the request.
 *
 * On a resident route of the plugin's, `addressBook.caller`, `actions.list`,
 * `invoke`, `propose` and `audit.record` raise `PluginResidentRouteError`
 * instead; the other members raise this error on every route.
 *
 * The message names the member and never the request or a person: the error
 * reaches the log.
 */
export class PluginRequestContextError extends Error {
  constructor(
    readonly pluginId: string,
    readonly member: PluginRequestMember,
  ) {
    super(
      `Plugin "${pluginId}" gave ${member} a request that the work making ` +
        "the call is not serving. A request is used only by the work that " +
        "serves it; hand background work what it needs from the request, not " +
        "the request.",
    );
    this.name = "PluginRequestContextError";
  }
}
