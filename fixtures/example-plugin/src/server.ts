import type {
  PluginHost,
  PluginRoute,
  PluginServerContribution,
  PluginServerFactory,
  PluginSettingsValues,
} from "@openbrf/plugin-sdk";

/**
 * The reference plugin's server entry point.
 *
 * Every import here is `import type`, which is what makes the emitted bundle
 * genuinely dependency-free: the SDK exists for the author's build and is not
 * resolvable from an installed plugin directory at runtime (ADR 0003). The
 * emitted `dist/server.cjs` therefore contains no `require` call at all, and
 * the host reaches this file with a plain `require` and calls `createPlugin`.
 */

/** The settings this plugin declares, narrowed from what the host stores. */
interface OccupancySettings {
  heading: string;
  showMembers: boolean;
  rowLimit: number;
  grouping: string;
}

/**
 * Fallbacks for a value the host did not supply.
 *
 * The host applies the manifest's declared defaults before handing values
 * over, so these only bite for a stored settings row written before a field
 * existed. They repeat the manifest's defaults on purpose: a plugin that
 * guesses a different value here would behave one way on a fresh install and
 * another way after an upgrade.
 */
const FALLBACK: OccupancySettings = {
  heading: "Occupancy",
  showMembers: true,
  rowLimit: 25,
  grouping: "address",
};

function readSettings(values: PluginSettingsValues): OccupancySettings {
  const heading = values.heading;
  const showMembers = values.showMembers;
  const rowLimit = values.rowLimit;
  const grouping = values.grouping;

  return {
    heading: typeof heading === "string" ? heading : FALLBACK.heading,
    showMembers:
      typeof showMembers === "boolean" ? showMembers : FALLBACK.showMembers,
    rowLimit:
      typeof rowLimit === "number" && Number.isInteger(rowLimit) && rowLimit > 0
        ? rowLimit
        : FALLBACK.rowLimit,
    grouping: typeof grouping === "string" ? grouping : FALLBACK.grouping,
  };
}

/**
 * Builds the plugin.
 *
 * Named `createPlugin` because that is the export the loader looks for. No
 * route declares a capability: the host raises every route to the floor its
 * plugin's permissions imply, so declaring one here could only ever widen the
 * audience below what `addressBook:read` requires.
 */
export const createPlugin: PluginServerFactory = (
  host: PluginHost,
): PluginServerContribution => {
  const summary: PluginRoute = {
    method: "GET",
    path: "/summary",
    async handle() {
      const [values, counts] = await Promise.all([
        host.settings.read(),
        host.addressBook.summary(),
      ]);
      const settings = readSettings(values);

      return {
        heading: settings.heading,
        summary: counts,
        grouping: settings.grouping,
        showMembers: settings.showMembers,
        limit: settings.rowLimit,
      };
    },
  };

  const apartments: PluginRoute = {
    method: "GET",
    path: "/apartments",
    async handle() {
      const settings = readSettings(await host.settings.read());
      const rows = await host.addressBook.apartments();

      return { apartments: rows.slice(0, settings.rowLimit) };
    },
  };

  const routes: readonly PluginRoute[] = [summary, apartments];

  return {
    routes,
    onStart() {
      host.logger.info(
        `Serving ${String(routes.length)} routes with permissions: ` +
          `${host.permissions.join(", ")}.`,
      );
    },
  };
};
