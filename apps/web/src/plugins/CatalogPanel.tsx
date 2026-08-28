import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { QUIET_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { type CatalogPlugin, fetchCatalog } from "./plugin-api";

export interface CatalogPanelProps {
  locale: string;
  onChoose: (entry: CatalogPlugin) => void;
  /** Bumped by the screen after an install, to re-read the index. */
  reloadToken: number;
}

/** Everything one read of the index produces. */
interface Listing {
  loading: boolean;
  source: string | null;
  entries: readonly CatalogPlugin[];
  failure: ApiFailure | null;
}

/** The catalog's own refusals, each with its own sentence. */
const CATALOG_ERRORS: Readonly<Record<string, TranslationKey>> = {
  "catalog-unreachable": "plugins.catalog.errors.unreachable",
  "catalog-malformed": "plugins.catalog.errors.malformed",
  "catalog-source-not-permitted": "plugins.catalog.errors.notPermitted",
};

/**
 * Browsing the curated catalog.
 *
 * The index is read from the source the instance is configured with, on every
 * visit rather than from a cache the board cannot clear: delisting a plugin is
 * a change to that file, and an instance that keeps offering a delisted plugin
 * has defeated the point of curation.
 *
 * Choosing an entry does not install it. It opens the consent screen, which is
 * the only route to an install.
 */
export function CatalogPanel({
  locale,
  onChoose,
  reloadToken,
}: CatalogPanelProps): ReactElement {
  const { t } = useTranslation();
  const swedish = locale.startsWith("sv");

  const [state, setState] = useState<Listing>({
    loading: true,
    source: null,
    entries: [],
    failure: null,
  });

  /**
   * Reads the index and returns it rather than applying it.
   *
   * The caller decides whether the answer still matters, which is what lets
   * the effect below drop a response that arrives after the panel is gone.
   */
  const read = useCallback(async (): Promise<Listing> => {
    const result = await fetchCatalog();
    return result.ok
      ? {
          loading: false,
          source: result.value.source,
          entries: result.value.entries,
          failure: null,
        }
      : { loading: false, source: null, entries: [], failure: result.failure };
  }, []);

  useEffect(() => {
    let active = true;
    void read().then((next) => {
      if (active) {
        setState(next);
      }
    });
    return () => {
      active = false;
    };
  }, [read, reloadToken]);

  /** Re-reads the index at the board's request. */
  const refresh = (): void => {
    setState((current) => ({ ...current, loading: true }));
    void read().then(setState);
  };

  return (
    <Panel
      title={t("plugins.catalog.title")}
      description={t("plugins.catalog.description")}
      notice={
        state.failure === null ? null : (
          <Notice tone="danger" live>
            {t(
              CATALOG_ERRORS[state.failure.reason] ??
                "plugins.catalog.errors.unknown",
            )}
          </Notice>
        )
      }
      actions={
        <>
          <button
            type="button"
            onClick={refresh}
            disabled={state.loading}
            className={SECONDARY_BUTTON}
          >
            {t("plugins.catalog.reload")}
          </button>
          {state.source === null ? null : (
            <span className="font-data text-small text-ink-muted">
              {state.source}
            </span>
          )}
        </>
      }
    >
      {state.loading ? (
        <p role="status" className="text-body text-ink-muted">
          {t("plugins.catalog.loading")}
        </p>
      ) : state.entries.length === 0 && state.failure === null ? (
        <p className="text-body text-ink-muted">{t("plugins.catalog.none")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {state.entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-2 border-t border-line pt-3 first:border-0 first:pt-0 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-body font-semibold text-ink">
                  {swedish ? entry.name.sv : entry.name.en}
                </span>
                <span className="text-small text-ink-muted">
                  {swedish ? entry.description.sv : entry.description.en}
                </span>
                <span className="font-data text-small text-ink-muted">
                  {entry.packageName} {entry.version}
                </span>
                <EntryMarks entry={entry} />
              </div>

              <div className="shrink-0">
                <button
                  type="button"
                  disabled={!entry.supported}
                  onClick={() => {
                    onChoose(entry);
                  }}
                  className={QUIET_BUTTON}
                >
                  {entry.installedVersion === null
                    ? t("plugins.catalog.install")
                    : entry.installedVersion === entry.version
                      ? t("plugins.catalog.reinstall")
                      : t("plugins.catalog.update", { version: entry.version })}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The states an entry can be in.
 *
 * Written as words rather than shown as colour: DESIGN.md's rule is that
 * colour is never the only signal, and "deprecated" is exactly the kind of
 * thing a board must not miss because it reads as a slightly different shade
 * of the same row.
 */
function EntryMarks({ entry }: { entry: CatalogPlugin }): ReactElement | null {
  const { t } = useTranslation();

  const marks: string[] = [];
  if (entry.installedVersion !== null) {
    marks.push(
      t("plugins.catalog.installedVersion", {
        version: entry.installedVersion,
      }),
    );
  }
  if (!entry.supported) {
    marks.push(t("plugins.catalog.unsupported"));
  }
  if (entry.deprecated) {
    marks.push(t("plugins.catalog.deprecated"));
  }

  if (marks.length === 0) {
    return null;
  }

  return (
    <span className="text-chip text-ink-muted uppercase">
      {marks.join(" - ")}
    </span>
  );
}
