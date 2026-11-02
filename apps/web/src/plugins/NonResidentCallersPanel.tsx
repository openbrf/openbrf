import { useId, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { QUIET_BUTTON } from "../ui/controls";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import {
  type PluginConsentAct,
  type PluginNonResidentCallerSummary,
  type PluginSummary,
  setPluginNonResidentCallerWithdrawn,
} from "./plugin-api";
import { nonResidentCallerLabel } from "./plugin-labels";

/**
 * Whom each plugin's resident routes serve besides residents, and who
 * consented to it (ADR 0053, "The consent screen").
 *
 * The administrator consents to each class with the install, on the board's
 * decision, and can withdraw one here without removing the plugin. The board
 * reads here which classes the install serves and whose consent stands behind
 * each, so the panel is shown to whoever may read the plugins page, and its
 * buttons only to whoever may manage it.
 *
 * Absent when no installed plugin serves anybody beside residents, on the
 * actions panel's precedent.
 */
export function NonResidentCallersPanel({
  plugins,
  editable,
  onChanged,
}: {
  plugins: readonly PluginSummary[];
  editable: boolean;
  onChanged: () => void;
}): ReactElement | null {
  const { t } = useTranslation();

  const serving = plugins.filter(
    (plugin) => plugin.nonResidentCallers.length > 0,
  );
  if (serving.length === 0) {
    return null;
  }

  return (
    <Panel
      title={t("plugins.callers.title")}
      description={t("plugins.callers.description")}
    >
      {serving.map((plugin) => (
        <section key={plugin.id} className="flex flex-col gap-2">
          <h3 className="text-label text-ink-muted uppercase">{plugin.id}</h3>
          <ul className="flex flex-col gap-3">
            {plugin.nonResidentCallers.map((summary) => (
              <CallerRow
                key={summary.caller}
                pluginId={plugin.id}
                summary={summary}
                editable={editable}
                onChanged={onChanged}
              />
            ))}
          </ul>
        </section>
      ))}
    </Panel>
  );
}

function CallerRow({
  pluginId,
  summary,
  editable,
  onChanged,
}: {
  pluginId: string;
  summary: PluginNonResidentCallerSummary;
  editable: boolean;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const labelId = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async (): Promise<void> => {
    // Single-flight: the button is disabled while a change is in flight, and
    // this guards a second click that lands before the re-render.
    if (busy) {
      return;
    }
    setBusy(true);
    setFailed(false);
    const result = await setPluginNonResidentCallerWithdrawn(
      pluginId,
      summary.caller,
      !summary.withdrawn,
    );
    setBusy(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    // Re-read rather than flipped here: whether a class is served, and whose
    // act stands behind it, are the server's answer.
    onChanged();
  };

  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          id={labelId}
          className="inline-block text-small text-ink first-letter:uppercase"
        >
          {t(nonResidentCallerLabel(summary.caller))}
        </span>
        <span className="text-chip text-ink-muted uppercase">
          {t(
            summary.withdrawn
              ? "plugins.callers.withdrawn"
              : "plugins.callers.served",
          )}
        </span>
      </div>

      <ConsentActLine
        act={summary.consented}
        withName="plugins.callers.consentedBy"
        withProtected="plugins.callers.consentedByProtected"
        withoutName="plugins.callers.consentedByNobody"
      />
      {summary.withdrawn ? (
        <ConsentActLine
          act={summary.withdrawnBy}
          withName="plugins.callers.withdrawnBy"
          withProtected="plugins.callers.withdrawnByProtected"
          withoutName="plugins.callers.withdrawnByNobody"
        />
      ) : null}

      {editable ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            aria-describedby={labelId}
            onClick={() => {
              void toggle();
            }}
            className={QUIET_BUTTON}
          >
            {t(
              summary.withdrawn
                ? "plugins.callers.consentAgain"
                : "plugins.callers.withdraw",
            )}
          </button>
        </div>
      ) : null}

      {failed ? (
        <Notice tone="danger" live>
          {t("plugins.callers.failed")}
        </Notice>
      ) : null}
    </li>
  );
}

/**
 * Who did it and when, or nothing when the log names no act: an install made
 * before classes were recorded has none to show.
 */
function ConsentActLine({
  act,
  withName,
  withProtected,
  withoutName,
}: {
  act: PluginConsentAct | null;
  withName: "plugins.callers.consentedBy" | "plugins.callers.withdrawnBy";
  withProtected:
    | "plugins.callers.consentedByProtected"
    | "plugins.callers.withdrawnByProtected";
  withoutName:
    "plugins.callers.consentedByNobody" | "plugins.callers.withdrawnByNobody";
}): ReactElement | null {
  const { t, i18n } = useTranslation();
  if (act === null) {
    return null;
  }
  return (
    <p className="flex flex-wrap items-baseline gap-2 text-small text-ink-muted">
      <span>
        {act.protectedActor
          ? t(withProtected)
          : act.by === null
            ? t(withoutName)
            : t(withName, { name: act.by })}
      </span>
      <time dateTime={act.at} className="font-data">
        {formatMoment(act.at, i18n.language)}
      </time>
    </p>
  );
}
