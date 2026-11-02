import type {
  CatalogResidentRoute,
  PluginNonResidentCaller,
} from "@openbrf/plugin-sdk";

/**
 * The board's consent to a plugin's resident routes (ADR 0051).
 *
 * A resident route lets a listed resident reach a plugin that reads the
 * register, so the plugin's author may not decide it: the board decides it, on
 * the consent screen and with `openbrf plugin add`, and the install records
 * the paths it consented to (`consentedResidentRoutes`). The loader holds the
 * installed manifest to them before any of the plugin's code runs, as it holds
 * the device routes to theirs.
 */

/**
 * The paths the manifest declares as resident routes beyond what the board
 * consented to, in the manifest's order: a route it never saw, or one moved to
 * cover a path it did not cover.
 *
 * A route covers its path and everything below it, so a declared route inside
 * a consented one answers no path the board was not shown, and is within the
 * consent. One that drops a route answers fewer people and is within it too.
 * An install with nothing recorded, such as one made before resident routes
 * were recorded, consented to none.
 */
export function residentRoutesBeyondConsent(
  declared: readonly { path: string }[],
  consented: readonly string[],
): string[] {
  return declared
    .map((route) => route.path)
    .filter(
      (path) =>
        !consented.some(
          (covering) => path === covering || path.startsWith(`${covering}/`),
        ),
    );
}

/**
 * Whether two lists of resident routes, as the catalog lists them, declare the
 * same routes under the same titles.
 *
 * The title is compared as well as the path, unlike a recipient's purpose:
 * it is what the consent screen tells the board a resident can do there, and
 * the board consents to the route by reading it.
 */
export function sameResidentRoutes(
  left: readonly CatalogResidentRoute[],
  right: readonly CatalogResidentRoute[],
): boolean {
  const canonical = (routes: readonly CatalogResidentRoute[]): string[] =>
    routes
      .map((route) =>
        JSON.stringify([route.path, route.title.sv, route.title.en]),
      )
      .sort();
  const a = canonical(left);
  const b = canonical(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The classes of caller the manifest declares beyond what the administrator
 * approved for the install, in the manifest's order (ADR 0053).
 *
 * A declared class outside the approved set would serve people nobody
 * consented to, so the version is refused as `resident-routes-widened` until
 * the administrator consents again. A version that declares fewer classes
 * serves fewer people and is within the consent. An install with nothing
 * recorded approved none.
 */
export function nonResidentCallersBeyondConsent(
  declared: readonly string[] | undefined,
  approved: readonly string[],
): string[] {
  return (declared ?? []).filter((caller) => !approved.includes(caller));
}

/**
 * The classes of caller a plugin's resident routes serve: the ones the
 * installed manifest declares that the install approved, in the manifest's
 * order (ADR 0053). Worked out on each request from the two and never stored,
 * so a class stops being served as soon as either one drops it.
 */
export function servedNonResidentCallers(
  declared: readonly PluginNonResidentCaller[] | undefined,
  approved: readonly string[],
): PluginNonResidentCaller[] {
  return (declared ?? []).filter((caller) => approved.includes(caller));
}
