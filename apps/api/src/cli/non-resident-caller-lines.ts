import type { PluginNonResidentCaller } from "@openbrf/plugin-sdk";
import type { TFunction } from "i18next";

/**
 * What `openbrf plugin add` prints, after the resident routes, about the
 * people those routes serve who do not live here (ADR 0053): each declared
 * class and only those, that the three refusals hold for them, what the plugin
 * can read of them, what they see of residents' records and, when the property
 * manager is among them, what the association's agreement with them has to
 * say. The consent screen's sentences, from the same translations, and
 * nothing for a plugin that declares no class.
 *
 * The classes are a closed list whose text is the core's, so nothing from the
 * catalog is printed here.
 */
export function nonResidentCallerLines(
  callers: readonly PluginNonResidentCaller[],
  permissions: readonly string[],
  t: TFunction,
): string[] {
  if (callers.length === 0) {
    return [];
  }
  const lines = [
    `  ${t("plugins.consent.nonResidentCallers.title")}`,
    `  ${t("plugins.consent.nonResidentCallers.who")}`,
    ...callers.map(
      (caller) =>
        `    ${t(`plugins.consent.nonResidentCallers.class.${caller}`)}`,
    ),
    `  ${t("plugins.consent.nonResidentCallers.refused")}`,
    `  ${t(
      permissions.includes("addressBook:readContact")
        ? "plugins.consent.nonResidentCallers.readContact"
        : "plugins.consent.nonResidentCallers.readNames",
    )}`,
    `  ${t("plugins.consent.nonResidentCallers.see")}`,
  ];
  if (callers.includes("propertyManager")) {
    lines.push(`  ${t("plugins.consent.nonResidentCallers.propertyManager")}`);
  }
  return lines;
}
