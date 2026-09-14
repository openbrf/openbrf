import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import { QUIET_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { formatConnectedAppMoment } from "./connected-app-dates";
import { disconnectFailureKey } from "./connected-app-failures";
import {
  type ConnectedAppGrant,
  disconnectConnectedApp,
  fetchConnectedApps,
} from "./connections-api";
import { RegisterClientPanel } from "./RegisterClientPanel";

export interface ConnectedAppsScreenProps {
  viewer: Viewer;
}

/** Everything one read produces, applied to the screen in one step. */
interface Loaded {
  /**
   * Whether the read has settled.
   *
   * Distinct from "there is nothing to show", because the two look the same
   * and mean opposite things: before the read lands, an empty list is unknown
   * rather than empty.
   */
  ready: boolean;
  connectedApps: readonly ConnectedAppGrant[];
  loadFailed: boolean;
}

const EMPTY: Loaded = { ready: false, connectedApps: [], loadFailed: false };

/**
 * Every connection on the instance.
 *
 * Two capabilities, and they answer two different questions rather than being
 * two sizes of one. Seeing that a member has connected something is part of
 * knowing what leaves the association, which is `association:read`. Cutting
 * somebody else's connection is acting on another person's data and sits with
 * whoever answers for that, which is `dataProtection:manage`. A board member
 * therefore reads this screen and may not be the person who ends a connection
 * on it.
 *
 * Registering a client is a third question again - it changes how the instance
 * is configured - and its panel carries `association:manage`.
 *
 * Hiding a control is courtesy only. The API enforces all three and refuses the
 * calls regardless of what this screen offers.
 *
 * What an app has done is not here. That is in the audit log, against the
 * person, where reading it is itself recorded.
 */
export function ConnectedAppsScreen({
  viewer,
}: ConnectedAppsScreenProps): ReactElement {
  const { t, i18n } = useTranslation();

  const canRead = viewer.capabilities.includes("association:read");
  const canDisconnect = viewer.capabilities.includes("dataProtection:manage");
  const canRegister = viewer.capabilities.includes("association:manage");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  /**
   * Which read is the current one.
   *
   * Two can be in flight at once - a board cuts a connection while the answer
   * to the retry before it is still coming back - and both answers are well
   * formed, so the screen cannot tell them apart by content. Only the newest
   * may be applied; without that, whichever arrives last wins and an older one
   * puts a connection that has just been cut back on the list.
   */
  const currentRead = useRef(0);

  const read = useCallback(async (): Promise<Loaded> => {
    if (!canRead) {
      // Nothing to wait for: this viewer never asks for the list, and the panel
      // that needs it is not rendered for them either.
      return { ...EMPTY, ready: true };
    }
    const result = await fetchConnectedApps();
    return result.ok
      ? { ...EMPTY, ready: true, connectedApps: result.value.connectedApps }
      : { ...EMPTY, ready: true, loadFailed: true };
  }, [canRead]);

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

  const { ready, connectedApps, loadFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("connectedApps.title")}</h1>
        <p className="text-body text-ink-muted">{t("connectedApps.intro")}</p>
      </header>

      {loadFailed ? (
        <LoadFailure messageKey="connectedApps.loadFailed" onRetry={readInto} />
      ) : null}

      {!canRead ? (
        <Notice tone="info">{t("connectedApps.forbidden")}</Notice>
      ) : null}

      {canRead && !ready && !loadFailed ? (
        <p role="status" className="text-body text-ink-muted">
          {t("connectedApps.loading")}
        </p>
      ) : null}

      {canRead && ready && !loadFailed ? (
        <Panel title={t("connectedApps.listTitle")}>
          {connectedApps.length === 0 ? (
            <p className="text-body text-ink-muted">
              {t("connectedApps.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {connectedApps.map((grant) => (
                <GrantRow
                  key={`${grant.userId}:${grant.clientId}`}
                  grant={grant}
                  locale={i18n.language}
                  editable={canDisconnect}
                  onChanged={readInto}
                />
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      {canRegister ? <RegisterClientPanel /> : null}
    </div>
  );
}

/**
 * One connection, and the board's way of ending it.
 *
 * The state of the act is the row's own rather than the screen's, on the
 * precedent the plugin action rows set: several connections can be worked in
 * turn, and a failure belongs beside the one it happened to rather than at the
 * top of a list of twenty.
 */
function GrantRow({
  grant,
  locale,
  editable,
  onChanged,
}: {
  grant: ConnectedAppGrant;
  locale: string;
  editable: boolean;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  /**
   * Cutting a connection is two presses rather than a browser dialogue.
   *
   * A native confirm cannot be styled, cannot be translated and cannot be read
   * by a test. Asking in the page keeps the question in the board's own
   * language and next to the row it is about.
   */
  const [confirming, setConfirming] = useState(false);
  const [failureKey, setFailureKey] = useState<TranslationKey | null>(null);

  const appName = grant.clientName ?? t("connectedApps.unnamedApp");

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setFailureKey(null);
    const result = await disconnectConnectedApp(grant.userId, grant.clientId);
    setBusy(false);

    if (!result.ok) {
      setFailureKey(disconnectFailureKey(result.failure));
      return;
    }

    setConfirming(false);
    // Re-read rather than struck from the list here: what is connected is the
    // server's answer, and the row is one of several things the read settles.
    onChanged();
  };

  return (
    <li className="flex flex-col gap-1 rounded-control border border-line bg-page px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-body">{appName}</span>
        <span className="font-data text-small text-ink-muted">
          {grant.clientHost ?? t("connectedApps.unknownHost")}
        </span>
      </div>

      <p className="text-small">
        <span className="text-label text-ink-muted uppercase">
          {t("connectedApps.person")}
        </span>{" "}
        {grant.personName}
      </p>

      <p className="text-small text-ink-muted">
        <span className="text-label uppercase">
          {t("connectedApps.connectedAt")}
        </span>{" "}
        {formatConnectedAppMoment(grant.connectedAt, locale)}
      </p>

      {editable ? (
        <div className="flex flex-wrap gap-2">
          {confirming ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void disconnect();
                }}
                className={QUIET_BUTTON}
              >
                {busy
                  ? t("connectedApps.disconnecting")
                  : t("connectedApps.disconnectConfirm")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                }}
                className={QUIET_BUTTON}
              >
                {t("connectedApps.disconnectCancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label={t("connectedApps.disconnectLabelFor", {
                app: appName,
                person: grant.personName,
              })}
              onClick={() => {
                setConfirming(true);
              }}
              className={QUIET_BUTTON}
            >
              {t("connectedApps.disconnect")}
            </button>
          )}
        </div>
      ) : null}

      {confirming ? (
        <Notice tone="warn" live>
          {t("connectedApps.disconnectWarning")}
        </Notice>
      ) : null}

      {failureKey === null ? null : (
        <Notice tone="danger" live>
          {t(failureKey)}
        </Notice>
      )}
    </li>
  );
}
