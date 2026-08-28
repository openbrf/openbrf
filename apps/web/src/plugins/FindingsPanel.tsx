import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { Panel } from "../ui/Panel";
import type { PluginFinding } from "./plugin-api";
import {
  findingLabel,
  permissionLabel,
  personalDataLabel,
} from "./plugin-labels";

/**
 * Which lists in a finding's detail are codes with sentences of their own.
 *
 * A board told that a package handles `residency` has been told nothing. The
 * declaration it is reading is the same one the consent screen showed it, so
 * it is read through the same table.
 */
const LIST_LABELS: Readonly<Record<string, (code: string) => TranslationKey>> =
  {
    permissions: permissionLabel,
    categories: personalDataLabel,
  };

export interface FindingsPanelProps {
  findings: readonly PluginFinding[];
}

/**
 * Why something on the data volume is not running.
 *
 * The loader skips a malformed or refused plugin rather than failing the boot
 * (ADR 0003), which is the right behaviour and would be invisible without this
 * panel: an instance that quietly drops a plugin the board installed is worse
 * than one that says so.
 *
 * The server sends a code and the values the sentence needs; the sentence is
 * chosen here. That split is what keeps this panel in the reader's language -
 * the API is English throughout, so anything it phrased would arrive in
 * English however the interface is set.
 */
export function FindingsPanel({
  findings,
}: FindingsPanelProps): ReactElement | null {
  const { t } = useTranslation();

  if (findings.length === 0) {
    return null;
  }

  /** The detail, with every list of codes read as a list of sentences. */
  const completed = (
    finding: PluginFinding,
  ): Record<string, string | number> => {
    const values: Record<string, string | number> = {
      reason: finding.reason,
    };
    for (const [name, value] of Object.entries(finding.detail)) {
      if (typeof value !== "object") {
        values[name] = value;
        continue;
      }
      const label = LIST_LABELS[name];
      values[name] = value
        .map((code) => (label === undefined ? code : t(label(code))))
        .join(", ");
    }
    return values;
  };

  return (
    <Panel
      title={t("plugins.findings.title")}
      description={t("plugins.findings.description")}
    >
      <ul className="flex flex-col gap-3">
        {findings.map((finding) => (
          <li
            key={`${finding.id ?? finding.directory}-${finding.reason}`}
            className="flex flex-col gap-1 border-l-4 border-warn pl-3"
          >
            <span className="text-body text-ink">
              {finding.id ?? finding.directory}
            </span>
            <span className="text-small text-ink-muted">
              {t(findingLabel(finding.reason), completed(finding))}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
