import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { QUIET_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { CatalogPanel } from "./CatalogPanel";
import { ConsentPanel } from "./ConsentPanel";
import { FindingsPanel } from "./FindingsPanel";
import { InstalledPluginsPanel } from "./InstalledPluginsPanel";
import {
  type CatalogPlugin,
  fetchPlugins,
  installPlugin,
  type PluginsOverview,
  type PluginSummary,
  setPluginActionArmed,
} from "./plugin-api";
import {
  actionEffectLabel,
  actionPersonalDataLabel,
  actionSurfaceLabel,
} from "./plugin-labels";

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
  const currentRead = useRef(0);
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

  /**
   * Reads, and applies the answer only while it is still the newest one.
   *
   * One rule for the first read and every re-read, on the precedent
   * `MotionsScreen` sets. It matters more now than it did: the failure notice
   * offers a retry, so two reads in flight is a board pressing a button twice
   * rather than a race nobody could reach, and an older failure landing after a
   * newer success would put the screen back into the state the reader had just
   * got out of.
   */
  const readInto = useCallback((): void => {
    const version = ++currentRead.current;
    void read().then((next) => {
      if (version === currentRead.current) {
        setLoaded(next);
      }
    });
  }, [read]);

  useEffect(() => {
    readInto();
    /*
     * Leaving supersedes whatever is in flight, so a response that arrives
     * after the screen is gone is dropped by the same check that drops a
     * superseded one. One rule for both.
     */
    return () => {
      currentRead.current += 1;
    };
  }, [readInto]);

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
    readInto();
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
      actions: pending.actions,
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

          <ActionsPanel
            plugins={overview.plugins}
            editable={canManage}
            onChanged={reload}
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

/**
 * One consented action, read out of the canonical string it is held as.
 *
 * Parsed from the end rather than from the front. The string is
 * `id:capability:effect:personalData:surfaces`, and a capability carries a
 * colon of its own - so counting from the left would read the whole capability
 * of `news:write` as `news`. The id cannot contain a colon and the three
 * trailing fields are fixed, which leaves everything between them as the
 * capability however many colons it has.
 */
interface ConsentedAction {
  id: string;
  capability: string;
  effect: string;
  /**
   * The last two fields, which the row states rather than drops.
   *
   * Which personal data this particular action can touch, and how far it may be
   * offered, are what an administrator is deciding about when they arm one -
   * and the aggregate list on the plugin's own card cannot answer either
   * question, because it says what the plugin touches somewhere rather than
   * what this action receives. Both are stored, pipe-separated, by
   * `canonicalAction`.
   */
  personalData: string[];
  surfaces: string[];
}

function parseConsentedAction(canonical: string): ConsentedAction {
  const parts = canonical.split(":");
  const id = parts[0] ?? canonical;

  // Fewer than the five fields is a string this build cannot read. It is still
  // shown, by its id: the entry is part of a declaration the board consented
  // to, and a list that quietly drops one is worse than a row that says less.
  if (parts.length < 5) {
    return { id, capability: "", effect: "", personalData: [], surfaces: [] };
  }

  // Empty rather than [""]: a declaration touching no personal data stores an
  // empty field, and splitting one yields a single blank entry.
  const list = (field: string | undefined): string[] =>
    field === undefined || field === "" ? [] : field.split("|");

  return {
    id,
    capability: parts.slice(1, parts.length - 3).join(":"),
    effect: parts[parts.length - 3] ?? "",
    personalData: list(parts[parts.length - 2]),
    surfaces: list(parts[parts.length - 1]),
  };
}

/**
 * What the plugins on this instance may be asked to do, and what is offered.
 *
 * Declaring an action and offering it are two decisions. The board consented
 * to the declaration when it installed the plugin; arming is what puts one
 * action within reach of a connected app and the AI package, and it is an
 * administrator's to give. The panel states that in a sentence, because this
 * is the only place a board member is told what arming means - a row of
 * toggles with no sentence would read as switches for turning features on.
 *
 * Absent entirely when nothing declares an action, on the findings panel's
 * precedent: an empty heading about a mechanism that is not in play on this
 * instance is a question the board would have to go and answer.
 */
function ActionsPanel({
  plugins,
  editable,
  onChanged,
}: {
  plugins: readonly PluginSummary[];
  editable: boolean;
  onChanged: () => void;
}): ReactElement | null {
  const { t } = useTranslation();

  const declaring = plugins.filter(
    (plugin) => plugin.consentedActions.length > 0,
  );
  if (declaring.length === 0) {
    return null;
  }

  return (
    <Panel
      title={t("plugins.actions.title")}
      description={t("plugins.actions.description")}
    >
      {declaring.map((plugin) => (
        <section key={plugin.id} className="flex flex-col gap-2">
          <h3 className="text-label text-ink-muted uppercase">{plugin.id}</h3>
          <ul className="flex flex-col gap-3">
            {plugin.consentedActions.map((canonical) => {
              const action = parseConsentedAction(canonical);
              return (
                <ActionRow
                  key={canonical}
                  pluginId={plugin.id}
                  action={action}
                  armed={plugin.armedActions.includes(action.id)}
                  editable={editable}
                  onChanged={onChanged}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </Panel>
  );
}

function ActionRow({
  pluginId,
  action,
  armed,
  editable,
  onChanged,
}: {
  pluginId: string;
  action: ConsentedAction;
  armed: boolean;
  editable: boolean;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * The effect in words, when this build has words for it.
   *
   * What an action does to the records is the part of a declaration a board
   * acts on, and "write" is not it.
   */
  const effect = actionEffectLabel(action.effect);

  const toggle = async (): Promise<void> => {
    setBusy(true);
    setFailed(false);
    const result = await setPluginActionArmed(pluginId, action.id, !armed);
    setBusy(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    // Re-read rather than flipped here: what is armed is the server's answer,
    // and the row is one of several things the read settles.
    onChanged();
  };

  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-data text-small text-ink">{action.id}</span>
        <span className="font-data text-small text-ink-muted">
          {action.capability}
        </span>
        {effect === null ? null : (
          <span className="text-small text-ink-muted">{t(effect)}</span>
        )}
        <span className="text-chip text-ink-muted uppercase">
          {t(armed ? "plugins.actions.armed" : "plugins.actions.notArmed")}
        </span>
      </div>

      {/*
        What this action touches and how far it may go, on the row where the
        decision is made. Arming is what carries an action beyond the
        association's own screens, so the two facts that decide whether it
        should be belong beside the toggle rather than only on the install
        screen the board read once.
      */}
      <div className="flex flex-wrap items-baseline gap-2 text-small text-ink-muted">
        <span>
          {action.personalData.length === 0
            ? t("plugins.actions.noPersonalData")
            : action.personalData
                .map((category) => t(actionPersonalDataLabel(category)))
                .join(", ")}
        </span>
        {action.surfaces.length === 0 ? null : (
          <span>
            {action.surfaces
              .map((surface) => t(actionSurfaceLabel(surface)))
              .join(", ")}
          </span>
        )}
      </div>

      {editable ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void toggle();
            }}
            className={QUIET_BUTTON}
          >
            {t(armed ? "plugins.actions.disarm" : "plugins.actions.arm")}
          </button>
        </div>
      ) : null}

      {failed ? (
        <Notice tone="danger" live>
          {t("plugins.actions.failed")}
        </Notice>
      ) : null}
    </li>
  );
}
