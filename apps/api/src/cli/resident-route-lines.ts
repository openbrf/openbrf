import type { CatalogResidentRoute } from "@openbrf/plugin-sdk";
import type { TFunction } from "i18next";

import { terminalText } from "./terminal-text";

/**
 * What `openbrf plugin add` prints about a plugin's resident routes before the
 * operator consents (ADR 0051): the statement the consent screen makes, from
 * the same translations, with each route's title and the address it covers,
 * and nothing for a plugin that declares none.
 *
 * The titles are the catalog's English, as the command prints the plugin's
 * name and description. They and the paths come from the catalog and are made
 * safe for the terminal before the sentences are completed with them.
 */
export function residentRouteLines(
  pluginId: string,
  routes: readonly CatalogResidentRoute[],
  t: TFunction,
): string[] {
  if (routes.length === 0) {
    return [];
  }
  return [
    `  ${t("plugins.consent.residentRoutes.title")}`,
    `  ${t("plugins.consent.residentRoutes.who")}`,
    ...routes.map(
      (route) =>
        `    ${t("plugins.consent.residentRoutes.route", {
          title: terminalText(route.title.en),
          path: terminalText(`/api/plugin/${pluginId}/${route.path}`),
        })}`,
    ),
    `  ${t("plugins.consent.residentRoutes.reach")}`,
    `  ${t("plugins.consent.residentRoutes.register")}`,
    `  ${t("plugins.consent.residentRoutes.choice")}`,
  ];
}
