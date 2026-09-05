import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { CatalogPanel } from "./CatalogPanel";
import { ConsentPanel } from "./ConsentPanel";
import { FindingsPanel } from "./FindingsPanel";
import { InstalledPluginsPanel } from "./InstalledPluginsPanel";
import {
  type CatalogPlugin,
  fetchPlugins,
  installPlugin,
  type PluginsOverview,
} from "./plugin-api";

export interface PluginsScreenProps {
  viewer: Viewer;
}

/** Everything one read produces, applied to the screen in one step. */
interface Loaded {
  /**
   * Whether the read has settled.
   *
   * Distinct from "there is nothing to show", because the two look the same
   * and mean opposite things: before the read lands, an empty plugin list is
   * unknown rather than empty.
   */
  ready: boolean;
  overview: PluginsOverview | null;
  loadFailed: boolean;
  /** True when the restart poll gave up before the new process answered. */
  restartTimedOut: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  overview: null,
  loadFailed: false,
  restartTimedOut: false,
};

/** How often, and for how long, the screen looks for the restarted process. */
const RESTART_POLL_INTERVAL_MS = 2000;
const RESTART_POLL_ATTEMPTS = 30;

/**
 * Plugin management.
 *
 * Reading the list needs association:read, because the board answers for what
 * runs on the instance and for the personal data those plugins reach.
 * Installing, removing and configuring need association:manage. Hiding a
 * control is courtesy only - the API enforces the same rules and refuses the
 * call either way.
 *
 * Installing replaces the server process, so the screen says so plainly rather
 * than appearing to hang: the request that starts an install is answered
 * before the restart, and the connection this page is holding is one of the
 * ones being drained.
 */
export function PluginsScreen({ viewer }: PluginsScreenProps): ReactElement {
  const { t, i18n } = useTranslation();

  const canRead = viewer.capabilities.includes("association:read");
  const canManage = viewer.capabilities.includes("association:manage");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [pending, setPending] = useState<CatalogPlugin | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installFailed, setInstallFailed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [catalogToken, setCatalogToken] = useState(0);

  /**
   * Reads the overview and returns it rather than applying it.
   *
   * The caller decides whether the answer still matters, which is what lets
   * the effect below drop a response that arrives after the screen is gone
   * instead of setting state on a component nobody is looking at.
   */
  const read = useCallback(async (): Promise<Loaded> => {
    if (!canRead) {
      // Nothing to wait for: this viewer never asks for the list, and the
      // panels that need it are not rendered for them either.
      return { ...EMPTY, ready: true };
    }
    const result = await fetchPlugins();
    return result.ok
      ? { ...EMPTY, ready: true, overview: result.value }
      : { ...EMPTY, ready: true, loadFailed: true };
  }, [canRead]);

  useEffect(() => {
    let active = true;
    void read().then((next) => {
      if (active) {
        setLoaded(next);
      }
    });
    return () => {
      active = false;
    };
  }, [read]);

  /**
   * Confirms that the restarted process came back, and with what.
   *
   * Installing replaces the server process, so the screen would otherwise be
   * left telling a board to reload the page and hoping. The poll runs only
   * while a restart is outstanding and stops as soon as a response arrives
   * from a process that is not itself waiting to restart - which is the
   * signal that the new one is serving. What it then found is on the row: the
   * plugin is running, or it is not and the findings below say why.
   */
  useEffect(() => {
    if (!restarting || !canRead) {
      return;
    }

    let active = true;
    let attempts = 0;

    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > RESTART_POLL_ATTEMPTS) {
        // A terminal state, not silence. Leaving `restarting` set would put
        // the board back where the poll exists to keep it from being: a
        // notice saying "restarting" with no end to it, no error, and nothing
        // to do next.
        clearInterval(timer);
        setRestarting(false);
        setLoaded((current) => ({ ...current, restartTimedOut: true }));
        return;
      }
      void fetchPlugins().then((result) => {
        if (!active || !result.ok || result.value.restartPending) {
          return;
        }
        clearInterval(timer);
        setLoaded({ ...EMPTY, ready: true, overview: result.value });
        setRestarting(false);
      });
    }, RESTART_POLL_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [restarting, canRead]);

  const { ready, overview, loadFailed, restartTimedOut } = loaded;

  const reload = (): void => {
    void read().then(setLoaded);
    setCatalogToken((token) => token + 1);
  };

  const confirmInstall = async (): Promise<void> => {
    if (pending === null) {
      return;
    }
    setInstalling(true);
    setInstallFailed(false);

    const result = await installPlugin({
      id: pending.id,
      permissions: pending.permissions,
      personalData: pending.personalData,
    });

    setInstalling(false);
    if (!result.ok) {
      setInstallFailed(true);
      return;
    }

    setPending(null);
    if (result.value.restarting) {
      // No read here. The server answered this request and is now draining the
      // connection it came in on, so a read now is a read against a process
      // that is going away - and its failure would raise the "could not be
      // read" notice beside the restart notice on an install that worked. The
      // restart poll performs the read once the replacement answers.
      setRestarting(true);
      setCatalogToken((token) => token + 1);
      return;
    }
    reload();
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("plugins.title")}</h1>
        <p className="text-body text-ink-muted">{t("plugins.intro")}</p>
      </header>

      {restarting || overview?.restartPending === true ? (
        <Notice tone="info" live>
          {t("plugins.restartNotice")}
        </Notice>
      ) : null}

      {overview !== null && !overview.pluginsEnabled ? (
        <Notice tone="warn">{t("plugins.disabledNotice")}</Notice>
      ) : null}

      {restartTimedOut ? (
        <Notice tone="warn" live>
          {t("plugins.restartTimedOut")}
        </Notice>
      ) : null}

      {loadFailed ? (
        <LoadFailure messageKey="plugins.errors.loadFailed" onRetry={reload} />
      ) : null}

      {!canRead ? (
        <Notice tone="info">{t("plugins.errors.forbidden")}</Notice>
      ) : null}

      {canRead && !ready ? (
        <p role="status" className="text-body text-ink-muted">
          {t("plugins.loading")}
        </p>
      ) : null}

      {overview === null ? null : (
        <>
          <InstalledPluginsPanel
            plugins={overview.plugins}
            editable={canManage}
            onChanged={reload}
            onRestarting={() => {
              setRestarting(true);
            }}
          />

          <FindingsPanel findings={overview.findings} />
        </>
      )}

      {/*
        Installing needs plugins to be switched on as well as the capability to
        manage them. The API refuses the call either way, but a catalog and a
        consent screen an administrator can work all the way through only to be
        refused at the end is a screen that lied about what it was offering.
      */}
      {canManage && overview?.pluginsEnabled === true ? (
        pending === null ? (
          <CatalogPanel
            locale={i18n.language}
            reloadToken={catalogToken}
            onChoose={setPending}
          />
        ) : (
          <>
            {installFailed ? (
              <Notice tone="danger" live>
                {t("plugins.consent.errors.failed")}
              </Notice>
            ) : null}
            <ConsentPanel
              entry={pending}
              locale={i18n.language}
              busy={installing}
              onConfirm={() => {
                void confirmInstall();
              }}
              onCancel={() => {
                setPending(null);
                setInstallFailed(false);
              }}
            />
          </>
        )
      ) : null}
    </div>
  );
}
