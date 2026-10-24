import type { PluginPersonRecordCollection } from "@openbrf/plugin-sdk";
import type { TFunction } from "i18next";

import { terminalText } from "./terminal-text";

/**
 * What `openbrf plugin add` prints about the records a plugin keeps about a
 * person before the operator consents (ADR 0047): each collection, the
 * categories it holds and how long it may keep a record - the consent
 * screen's sentences, from the same translations - and that the host erases
 * them, by date and on a granted request, and reports them.
 *
 * The command echoes the collections back, so each is printed. A plugin that
 * keeps none prints nothing. The collection's name is the plugin's own text,
 * so it is made safe for the terminal before the sentence is completed with
 * it.
 */
export function personRecordsLines(
  personRecords: readonly PluginPersonRecordCollection[],
  t: TFunction,
  categories: (values: readonly string[]) => string,
): string[] {
  if (personRecords.length === 0) {
    return [];
  }
  return [
    `  ${t("plugins.consent.personRecords.title")}`,
    ...personRecords.map(
      (collection) =>
        `    ${terminalText(
          t("plugins.consent.personRecords.collection", {
            collection: collection.collection,
            categories: categories(collection.personalData),
            days: collection.keepAtMostDays,
          }),
        )}`,
    ),
    `    ${t("plugins.consent.personRecords.host")}`,
  ];
}
