import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { Panel } from "../ui/Panel";
import type { PluginFinding } from "./plugin-api";
import { findingLabel } from "./plugin-labels";

export interface FindingsPanelProps {
  findings: readonly PluginFinding[];
}

/**
 * Why something on the data volume is not running.
 *
 * The loader skips a malformed or refused plugin rather than failing the boot
 * (ADR 0003), which is the right behaviour and would be invisible without this
 * panel: an instance that quietly drops a plugin the board installed is worse
 * than one that says so. The technical detail is shown as well as the reason,
 * because the person who reads this is the one who has to decide whether to
 * reinstall, remove, or ask the plugin's author.
 */
export function FindingsPanel({
  findings,
}: FindingsPanelProps): ReactElement | null {
  const { t } = useTranslation();

  if (findings.length === 0) {
    return null;
  }

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
              {t(findingLabel(finding.reason))}
            </span>
            <span className="font-data text-small text-ink-muted">
              {finding.detail}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
