import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import {
  fetchPluginSettings,
  type PluginSettingsResponse,
  type PluginSummary,
  setPluginEnabled,
  uninstallPlugin,
} from "./plugin-api";
import { PERMISSION_LABELS, PERSONAL_DATA_LABELS } from "./plugin-labels";
import { PluginSettingsForm } from "./PluginSettingsForm";

export interface InstalledPluginsPanelProps {
  plugins: readonly PluginSummary[];
  editable: boolean;
  /** Called after a change that the screen must re-read. */
  onChanged: () => void;
  /** Called when an action asks the server to replace its process. */
  onRestarting: () => void;
}

/**
 * What a plugin's row says about it, in one word.
 *
 * Four states rather than two flags, because "installed but not running" has
 * three different causes a board acts on differently: it was turned off, it is
 * waiting for the restart that loads it, or its install failed.
 */
function stateLabel(plugin: PluginSummary): TranslationKey {
  if (!plugin.enabled) {
    return "plugins.installed.state.disabled";
  }
  if (plugin.status === "FAILED") {
    return "plugins.installed.state.failed";
  }
  if (plugin.loaded) {
    return "plugins.installed.state.running";
  }
  return "plugins.installed.state.awaitingRestart";
}

/**
 * The plugins this instance runs.
 *
 * Every row states what the plugin may do and which personal data it handles,
 * not only its name: the board is answerable for both, and a list that showed
 * only names would make the consent a one-off screen nobody can revisit.
 */
export function InstalledPluginsPanel({
  plugins,
  editable,
  onChanged,
  onRestarting,
}: InstalledPluginsPanelProps): ReactElement {
  const { t } = useTranslation();

  return (
    <Panel
      title={t("plugins.installed.title")}
      description={t("plugins.installed.description")}
    >
      {plugins.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("plugins.installed.none")}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {plugins.map((plugin) => (
            <InstalledPluginRow
              key={plugin.id}
              plugin={plugin}
              editable={editable}
              onChanged={onChanged}
              onRestarting={onRestarting}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function InstalledPluginRow({
  plugin,
  editable,
  onChanged,
  onRestarting,
}: {
  plugin: PluginSummary;
  editable: boolean;
  onChanged: () => void;
  onRestarting: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PluginSettingsResponse | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /**
   * Removal is two presses rather than a browser dialog.
   *
   * A native confirm cannot be styled, cannot be translated by i18next, and
   * cannot be read by a test. Asking in the page keeps the question in the
   * board's own language and next to the row it is about.
   */
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  const act = async (
    run: () => Promise<{ ok: boolean; restarting?: boolean }>,
  ): Promise<void> => {
    setBusy(true);
    setFailed(false);
    const outcome = await run();
    setBusy(false);
    if (!outcome.ok) {
      setFailed(true);
      return;
    }
    if (outcome.restarting === true) {
      onRestarting();
    }
    onChanged();
  };

  const toggleSettings = async (): Promise<void> => {
    if (showSettings) {
      setShowSettings(false);
      return;
    }
    const result = await fetchPluginSettings(plugin.id);
    if (result.ok) {
      setSettings(result.value);
      setShowSettings(true);
    } else {
      setFailed(true);
    }
  };

  return (
    <li className="flex flex-col gap-3 border-t border-line pt-4 first:border-0 first:pt-0">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-body font-semibold text-ink">{plugin.id}</span>
          <span className="font-data text-small text-ink-muted">
            {plugin.packageName} {plugin.version}
          </span>
          <span className="text-chip text-ink-muted uppercase">
            {t(stateLabel(plugin))}
          </span>
        </div>

        <Declaration
          label={t("plugins.installed.permissions")}
          items={plugin.permissions.map((permission) =>
            t(PERMISSION_LABELS[permission] ?? "plugins.permissions.unknown"),
          )}
          emptyLabel={t("plugins.consent.noPermissions")}
        />
        <Declaration
          label={t("plugins.installed.personalData")}
          items={plugin.personalData.map((category) =>
            t(PERSONAL_DATA_LABELS[category] ?? "plugins.personalData.unknown"),
          )}
          emptyLabel={t("plugins.consent.noPersonalData")}
        />
      </div>

      {plugin.lastError === null ? null : (
        <Notice tone="danger">{plugin.lastError}</Notice>
      )}

      {failed ? (
        <Notice tone="danger" live>
          {t("plugins.errors.unknown")}
        </Notice>
      ) : null}

      {editable ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void act(async () => {
                const result = await setPluginEnabled(
                  plugin.id,
                  !plugin.enabled,
                );
                return {
                  ok: result.ok,
                  restarting: result.ok ? result.value.restarting : false,
                };
              });
            }}
            className={QUIET_BUTTON}
          >
            {plugin.enabled
              ? t("plugins.installed.disable")
              : t("plugins.installed.enable")}
          </button>

          {plugin.hasSettings ? (
            <button
              type="button"
              onClick={() => {
                void toggleSettings();
              }}
              className={QUIET_BUTTON}
            >
              {showSettings
                ? t("plugins.installed.hideSettings")
                : t("plugins.installed.settings")}
            </button>
          ) : null}

          {confirmingRemoval ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void act(async () => {
                    const result = await uninstallPlugin(plugin.id);
                    return {
                      ok: result.ok,
                      restarting: result.ok ? result.value.restarting : false,
                    };
                  });
                }}
                className={QUIET_BUTTON}
              >
                {t("plugins.installed.removeConfirm")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingRemoval(false);
                }}
                className={QUIET_BUTTON}
              >
                {t("plugins.installed.removeCancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmingRemoval(true);
              }}
              className={QUIET_BUTTON}
            >
              {t("plugins.installed.remove")}
            </button>
          )}
        </div>
      ) : null}

      {confirmingRemoval ? (
        <Notice tone="warn" live>
          {t("plugins.installed.removeWarning")}
        </Notice>
      ) : null}

      {showSettings && settings?.schema != null ? (
        <PluginSettingsForm
          pluginId={plugin.id}
          schema={settings.schema}
          values={settings.values}
          editable={editable}
        />
      ) : null}
    </li>
  );
}

function Declaration({
  label,
  items,
  emptyLabel,
}: {
  label: string;
  items: readonly string[];
  emptyLabel: string;
}): ReactElement {
  return (
    <p className="text-small text-ink-muted">
      <span className="text-chip uppercase">{label} </span>
      {items.length === 0 ? emptyLabel : items.join("; ")}
    </p>
  );
}
