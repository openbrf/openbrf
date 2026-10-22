import type { PluginDeviceRoute } from "@openbrf/plugin-sdk";
import type { TFunction } from "i18next";

import { terminalText } from "./terminal-text";

/**
 * What `openbrf plugin add` prints about a plugin's device routes before the
 * operator consents (ADR 0031): the statement the consent screen makes, from
 * the same translations, and nothing for a plugin that declares none.
 *
 * The paths come from the catalog and are made safe for the terminal before
 * the sentence is completed with them.
 */
export function deviceRouteLines(
  routes: readonly PluginDeviceRoute[],
  t: TFunction,
): string[] {
  if (routes.length === 0) {
    return [];
  }
  const paths = routes.map((route) => terminalText(route.path)).join(", ");
  return [
    `  ${t("plugins.consent.deviceRoutes.reach")}`,
    `  ${t("plugins.consent.deviceRoutes.readOnly")}`,
    `  ${t("plugins.consent.deviceRoutes.paths", { paths })}`,
  ];
}
