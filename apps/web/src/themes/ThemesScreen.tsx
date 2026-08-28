import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import {
  activateTheme,
  type CatalogTheme,
  fetchInstalledThemes,
  fetchThemeCatalog,
  fetchThemePreview,
  installTheme,
  type ThemeLintFinding,
  type ThemeSummary,
  uninstallTheme,
} from "../api/themes";
import type { TranslationKey } from "../i18n/translation-key";
import { useThemeRuntime } from "../theme/theme-runtime-context";
import { PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { LintFindings } from "./LintFindings";

/**
 * Installing, previewing and activating themes.
 *
 * A theme is data, so nothing here restarts anything: installing writes a row
 * and some files, activating writes one column, and the browser re-applies a
 * stylesheet. That is the whole reason themes are separate from plugins.
 *
 * Previewing applies the theme to this browser and to nothing else. It is the
 * step that makes activation safe to offer at all: a board sees the register on
 * the new theme before anybody else does.
 *
 * The screen shows more than a name for each theme because a board is deciding
 * whether to trust it: which theme it inherits from, which typefaces it brings
 * and under which licence, and which of the core's layouts it selects.
 */

const FAILURE_KEYS: Readonly<Record<string, TranslationKey>> = {
  "catalog-not-configured": "themeCatalog.errors.catalogNotConfigured",
  "catalog-unreachable": "themeCatalog.errors.catalogUnreachable",
  "catalog-invalid": "themeCatalog.errors.catalogInvalid",
  "package-unreachable": "themeCatalog.errors.packageUnreachable",
  "package-too-large": "themeCatalog.errors.packageTooLarge",
  "checksum-mismatch": "themeCatalog.errors.checksumMismatch",
  "package-unreadable": "themeCatalog.errors.packageUnreadable",
  "manifest-invalid": "themeCatalog.errors.manifestInvalid",
  "identity-mismatch": "themeCatalog.errors.identityMismatch",
  "lint-failed": "themeCatalog.errors.lintFailed",
  "not-in-catalog": "themeCatalog.errors.notInCatalog",
  "theme-not-installed": "themeCatalog.errors.themeNotInstalled",
  "built-in-theme": "themeCatalog.errors.builtInTheme",
  "theme-in-use": "themeCatalog.errors.themeInUse",
  "theme-has-dependants": "themeCatalog.errors.themeHasDependants",
  "theme-unresolvable": "themeCatalog.errors.themeUnresolvable",
  "housing-cooperative-missing":
    "themeCatalog.errors.housingCooperativeMissing",
};

function failureKey(failure: ApiFailure): TranslationKey {
  if (failure.status === 403) {
    return "themeCatalog.errors.forbidden";
  }
  return FAILURE_KEYS[failure.reason] ?? "themeCatalog.errors.unknown";
}

/** Everything one read produces, applied to the screen in one step. */
interface Loaded {
  installed: ThemeSummary[] | null;
  loadFailed: boolean;
  catalog: CatalogTheme[] | null;
  catalogFailure: ApiFailure | null;
}

type Action =
  | { kind: "idle" }
  | { kind: "working"; themeId: string }
  | { kind: "failed"; failure: ApiFailure }
  /** Activated, but the re-read that follows it did not land. */
  | { kind: "stale" }
  | { kind: "installed"; themeId: string; warnings: ThemeLintFinding[] };

/** Findings the server attached to a refusal, when it attached any. */
function findingsOf(failure: ApiFailure): ThemeLintFinding[] {
  return Array.isArray(failure.detail)
    ? failure.detail.filter(
        (entry): entry is ThemeLintFinding =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as ThemeLintFinding).rule === "string",
      )
    : [];
}

export function ThemesScreen(): ReactElement {
  const { t } = useTranslation();
  const runtime = useThemeRuntime();

  const [installed, setInstalled] = useState<ThemeSummary[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogTheme[] | null>(null);
  const [catalogFailure, setCatalogFailure] = useState<ApiFailure | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [action, setAction] = useState<Action>({ kind: "idle" });

  const read = useCallback(async (): Promise<Loaded> => {
    const [themes, entries] = await Promise.all([
      fetchInstalledThemes(),
      fetchThemeCatalog(),
    ]);

    return {
      installed: themes.ok ? themes.value : null,
      loadFailed: !themes.ok,
      catalog: entries.ok ? entries.value : null,
      /*
       * Kept apart from the installed-themes failure. A catalog that is not
       * configured is an ordinary state on a self-hosted instance - it means
       * this cooperative installs no themes - while a failed read of what IS
       * installed is a fault worth a red notice.
       */
      catalogFailure: entries.ok ? null : entries.failure,
    };
  }, []);

  const apply = useCallback((next: Loaded): void => {
    setInstalled(next.installed);
    setLoadFailed(next.loadFailed);
    setCatalog(next.catalog);
    setCatalogFailure(next.catalogFailure);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    apply(await read());
  }, [apply, read]);

  useEffect(() => {
    // The effect owns its own call and drops a response that arrives after the
    // screen is gone, rather than applying it to a component nobody is on.
    let live = true;
    void read().then((next) => {
      if (live) {
        apply(next);
      }
    });
    return () => {
      live = false;
    };
  }, [apply, read]);

  const onPreview = async (themeId: string): Promise<void> => {
    setAction({ kind: "working", themeId });
    const result = await fetchThemePreview(themeId);
    if (!result.ok) {
      setAction({ kind: "failed", failure: result.failure });
      return;
    }
    runtime.preview(result.value);
    setAction({ kind: "idle" });
  };

  const onActivate = async (themeId: string | null): Promise<void> => {
    setAction({ kind: "working", themeId: themeId ?? "porttavlan" });
    const result = await activateTheme(themeId);
    if (!result.ok) {
      setAction({ kind: "failed", failure: result.failure });
      return;
    }
    setInstalled(result.value);
    runtime.preview(null);
    /*
     * The activation is done either way: the server has switched. What can
     * still fail is reading back what it now renders, and this browser is then
     * showing the theme it had before. Saying so beats going quiet and leaving
     * a board member to conclude the activation did not take.
     */
    const reloaded = await runtime.reload();
    setAction(reloaded ? { kind: "idle" } : { kind: "stale" });
  };

  const onInstall = async (themeId: string): Promise<void> => {
    setAction({ kind: "working", themeId });
    const result = await installTheme(themeId);
    if (!result.ok) {
      setAction({ kind: "failed", failure: result.failure });
      return;
    }
    await load();
    setAction({
      kind: "installed",
      themeId,
      warnings: result.value.warnings,
    });
  };

  const onUninstall = async (themeId: string): Promise<void> => {
    setAction({ kind: "working", themeId });
    const result = await uninstallTheme(themeId);
    if (!result.ok) {
      setAction({ kind: "failed", failure: result.failure });
      return;
    }
    setInstalled(result.value);
    // A preview of the theme that has just been removed would keep its
    // stylesheet on the page and offer to activate a theme the API no longer
    // has.
    if (runtime.previewing?.id === themeId) {
      runtime.preview(null);
    }
    await load();
    setAction({ kind: "idle" });
  };

  const busy = action.kind === "working";
  const previewing = runtime.previewing;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("themeCatalog.title")}</h1>
        <p className="text-body text-ink-muted">{t("themeCatalog.intro")}</p>
      </header>

      {loadFailed ? (
        <Notice tone="danger" live>
          {t("themeCatalog.errors.loadFailed")}
        </Notice>
      ) : null}

      {previewing === null ? null : (
        <Notice tone="warn">
          <span className="flex flex-col gap-3">
            <span>
              {t("themeCatalog.preview.notice", { theme: previewing.name })}
            </span>
            <span className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy}
                className={PRIMARY_BUTTON}
                onClick={() => {
                  void onActivate(previewing.id);
                }}
              >
                {t("themeCatalog.preview.activate")}
              </button>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => {
                  runtime.preview(null);
                }}
              >
                {t("themeCatalog.preview.stop")}
              </button>
            </span>
          </span>
        </Notice>
      )}

      {action.kind === "failed" ? (
        <Notice tone="danger" live>
          <span className="flex flex-col gap-2">
            <span>{t(failureKey(action.failure))}</span>
            <LintFindings findings={findingsOf(action.failure)} />
          </span>
        </Notice>
      ) : null}

      {action.kind === "stale" ? (
        <Notice tone="warn" live>
          {t("themeCatalog.errors.activatedNotReloaded")}
        </Notice>
      ) : null}

      {action.kind === "installed" ? (
        <Notice tone="ok" live>
          <span className="flex flex-col gap-2">
            <span>
              {t("themeCatalog.installed.done", { theme: action.themeId })}
            </span>
            {action.warnings.length === 0 ? null : (
              <>
                <span>{t("themeCatalog.warnings.title")}</span>
                <LintFindings findings={action.warnings} />
              </>
            )}
          </span>
        </Notice>
      ) : null}

      <Panel
        title={t("themeCatalog.installed.title")}
        description={t("themeCatalog.installed.description")}
      >
        {installed === null ? (
          <p role="status" className="text-body text-ink-muted">
            {t("themeCatalog.loading")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {installed.map((theme) => (
              <InstalledThemeRow
                key={theme.id}
                theme={theme}
                busy={busy}
                previewingId={previewing?.id ?? null}
                onPreview={() => {
                  void onPreview(theme.id);
                }}
                onStopPreview={() => {
                  runtime.preview(null);
                }}
                onActivate={() => {
                  void onActivate(theme.builtIn ? null : theme.id);
                }}
                onRemove={() => {
                  void onUninstall(theme.id);
                }}
              />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title={t("themeCatalog.catalog.title")}
        description={t("themeCatalog.catalog.description")}
        notice={
          catalogFailure === null ? null : (
            <Notice tone="info">{t(failureKey(catalogFailure))}</Notice>
          )
        }
      >
        {catalog === null ? null : catalog.length === 0 ? (
          <p className="text-body text-ink-muted">
            {t("themeCatalog.catalog.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {catalog.map((entry) => (
              <CatalogRow
                key={entry.id}
                entry={entry}
                busy={busy}
                onInstall={() => {
                  void onInstall(entry.id);
                }}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function InstalledThemeRow({
  theme,
  busy,
  previewingId,
  onPreview,
  onStopPreview,
  onActivate,
  onRemove,
}: {
  theme: ThemeSummary;
  busy: boolean;
  previewingId: string | null;
  onPreview: () => void;
  onStopPreview: () => void;
  onActivate: () => void;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const isPreviewing = previewingId === theme.id;

  return (
    <li className="flex flex-col gap-3 rounded-control border border-line p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-title">{theme.name}</h3>
        {/* The state is written as well as coloured: colour is never the only
            signal a board reads. */}
        {theme.active ? (
          <span className="rounded-control bg-trust-soft px-2 py-0.5 text-chip text-trust uppercase">
            {t("themeCatalog.installed.active")}
          </span>
        ) : null}
        {theme.builtIn ? (
          <span className="text-chip text-ink-muted uppercase">
            {t("themeCatalog.installed.builtIn")}
          </span>
        ) : null}
        {theme.version === null ? null : (
          <span className="font-data text-data text-ink-muted">
            {theme.version}
          </span>
        )}
      </div>

      {theme.description === null ? null : (
        <p className="text-small text-ink-muted">{theme.description}</p>
      )}

      <dl className="flex flex-col gap-1 text-small text-ink-muted">
        {theme.extendsThemeId === null ? null : (
          <div className="flex gap-2">
            <dt>{t("themeCatalog.installed.inherits")}</dt>
            <dd className="font-data text-data">{theme.extendsThemeId}</dd>
          </div>
        )}
        {theme.fonts.length === 0 ? null : (
          <div className="flex flex-wrap gap-2">
            <dt>{t("themeCatalog.installed.typefaces")}</dt>
            {theme.fonts.map((font) => (
              <dd key={font.family} className="font-data text-data">
                {t("themeCatalog.installed.typeface", {
                  family: font.family,
                  license: font.license,
                })}
              </dd>
            ))}
          </div>
        )}
        {Object.entries(theme.viewVariants).map(([slot, variant]) => (
          <div key={slot} className="flex gap-2">
            <dt>{t("themeCatalog.installed.viewVariant")}</dt>
            <dd className="font-data text-data">
              {t("themeCatalog.installed.viewVariantValue", { slot, variant })}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap gap-3">
        {theme.active ? null : isPreviewing ? (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={onStopPreview}
          >
            {t("themeCatalog.installed.stopPreview")}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            className={SECONDARY_BUTTON}
            onClick={onPreview}
          >
            {t("themeCatalog.installed.preview")}
          </button>
        )}

        {theme.active ? null : (
          <button
            type="button"
            disabled={busy}
            className={PRIMARY_BUTTON}
            onClick={onActivate}
          >
            {t("themeCatalog.installed.activate")}
          </button>
        )}

        {theme.builtIn || theme.active ? null : (
          <button
            type="button"
            disabled={busy}
            className={QUIET_BUTTON}
            onClick={onRemove}
          >
            {t("themeCatalog.installed.remove")}
          </button>
        )}
      </div>
    </li>
  );
}

function CatalogRow({
  entry,
  busy,
  onInstall,
}: {
  entry: CatalogTheme;
  busy: boolean;
  onInstall: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const current = entry.installedVersion === entry.version;

  return (
    <li className="flex flex-col gap-2 rounded-control border border-line p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-title">{entry.name}</h3>
        <span className="font-data text-data text-ink-muted">
          {entry.version}
        </span>
        {current ? (
          <span className="text-chip text-ink-muted uppercase">
            {t("themeCatalog.catalog.alreadyInstalled")}
          </span>
        ) : null}
      </div>

      {entry.description === null ? null : (
        <p className="text-small text-ink-muted">{entry.description}</p>
      )}

      {entry.contract === null ? null : (
        <p className="font-data text-data text-ink-muted">
          {t("themeCatalog.catalog.contract", { range: entry.contract })}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy || current}
          className={SECONDARY_BUTTON}
          onClick={onInstall}
        >
          {entry.installedVersion === null
            ? t("themeCatalog.catalog.install")
            : current
              ? t("themeCatalog.catalog.alreadyInstalled")
              : t("themeCatalog.catalog.update", { version: entry.version })}
        </button>
      </div>
    </li>
  );
}
