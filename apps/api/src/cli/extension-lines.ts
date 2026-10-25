import type { CatalogExtensionPoint } from "@openbrf/plugin-sdk";
import type { TFunction } from "i18next";

import type {
  CatalogHeldPlugin,
  CatalogPluginExtension,
} from "../plugins/plugin-admin.service";
import { terminalText } from "./terminal-text";

/**
 * What `openbrf plugin add` prints about the extension points a plugin offers
 * and the ones it extends before the operator consents (ADR 0030): the
 * statements the consent screen makes, from the same translations, and
 * nothing for a plugin that declares neither. Then, as the consent screen
 * does, the installed plugins that installing it would hold to the board (ADR
 * 0052).
 *
 * The names and descriptions come from the catalog and are made safe for the
 * terminal before they are put into the sentence. `categories` words a list
 * of personal-data categories the way the rest of the consent printout does.
 */
export function extensionLines(
  declaration: {
    extensionPoints: readonly CatalogExtensionPoint[];
    extends: readonly CatalogPluginExtension[];
    holdsToBoard: readonly CatalogHeldPlugin[];
  },
  t: TFunction,
  categories: (values: readonly string[]) => string,
): string[] {
  const lines: string[] = [];
  for (const point of declaration.extensionPoints) {
    const names = {
      title: terminalText(point.title.en),
      description: terminalText(point.description.en),
    };
    lines.push(
      `  ${
        point.personalData.length === 0
          ? t("plugins.consent.extensions.pointNoPersonalData", names)
          : t("plugins.consent.extensions.point", {
              ...names,
              categories: categories(point.personalData),
            })
      }`,
    );
  }
  for (const extension of declaration.extends) {
    const names = {
      plugin: terminalText(extension.pluginName?.en ?? extension.plugin),
      point: terminalText(extension.pointTitle?.en ?? extension.point),
    };
    lines.push(
      `  ${
        extension.personalData.length === 0
          ? t("plugins.consent.extensions.extendsNoPersonalData", names)
          : t("plugins.consent.extensions.extends", {
              ...names,
              categories: categories(extension.personalData),
            })
      }`,
    );
  }
  if (declaration.extends.length > 0) {
    lines.push(`  ${t("plugins.consent.extensions.addonNote")}`);
  }
  if (declaration.holdsToBoard.length > 0) {
    lines.push(
      `  ${t("plugins.consent.extensions.holdsToBoard", {
        count: declaration.holdsToBoard.length,
        plugins: declaration.holdsToBoard
          .map((plugin) => terminalText(plugin.name?.en ?? plugin.id))
          .join(", "),
      })}`,
    );
  }
  return lines;
}
