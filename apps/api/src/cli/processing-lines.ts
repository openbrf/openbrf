import type { LocalizedText, PluginProcessing } from "@openbrf/plugin-sdk";
import type { TFunction } from "i18next";

import { FALLBACK_LOCALE } from "../i18n/i18n.service";
import { terminalText } from "./terminal-text";

/**
 * What `openbrf plugin add` prints about a plugin's processing of personal
 * data before the operator consents (ADR 0035): the purpose, the legal basis
 * with the interest relied on where that is the basis, the retention and whose
 * data it is - the consent screen's sentences, from the same translations.
 *
 * The install seeds the plugin's row in the record of processing activities
 * from this declaration, and the command echoes it back, so it is printed
 * whole rather than summarised. A plugin that names personal data and declares
 * no processing is told apart from one that declares one, as the consent
 * screen tells them apart, and a plugin that handles nobody's data, which gets
 * no row, prints nothing.
 *
 * The catalog's text is in the fallback locale the lines are translated into,
 * and is made safe for the terminal before the sentence is completed with it.
 */
export function processingLines(
  entry: {
    personalData: readonly string[];
    processing: PluginProcessing | null;
    installedVersion: string | null;
  },
  t: TFunction,
): string[] {
  const { processing } = entry;
  if (processing === null) {
    return entry.personalData.length === 0
      ? []
      : [
          `  ${t("plugins.consent.processing.title")}`,
          `    ${t("plugins.consent.processing.undeclared")}`,
        ];
  }

  const text = (value: LocalizedText) => terminalText(value[FALLBACK_LOCALE]);
  const lines = [
    `  ${t("plugins.consent.processing.title")}`,
    `    ${t("plugins.consent.processing.purpose", { text: text(processing.purpose) })}`,
    processing.legitimateInterest === undefined
      ? `    ${t("plugins.consent.processing.legalBasis", {
          basis: t(`plugins.consent.processing.basis.${processing.legalBasis}`),
        })}`
      : `    ${t("plugins.consent.processing.legitimateInterest", {
          text: text(processing.legitimateInterest),
        })}`,
    `    ${t("plugins.consent.processing.retention", { text: text(processing.retention) })}`,
    `    ${t("plugins.consent.processing.dataSubjects", {
      subjects: processing.dataSubjects
        .map((subject) => t(`plugins.consent.processing.subject.${subject}`))
        .join(", "),
    })}`,
  ];
  if (entry.installedVersion !== null) {
    lines.push(`    ${t("plugins.consent.processing.update")}`);
  }
  return lines;
}
