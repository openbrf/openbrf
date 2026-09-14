import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import { authClient } from "../auth/auth-client";
import { formatConnectedAppMoment } from "../connected-apps/connected-app-dates";
import { disconnectFailureKey } from "../connected-apps/connected-app-failures";
import {
  type ConnectedApp,
  disconnectMyConnectedApp,
  fetchMyConnectedApps,
} from "../connected-apps/connections-api";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";

/** A passkey as the auth API reports it. */
interface PasskeyRow {
  id: string;
  name?: string | null;
}

type Outcome =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; messageKey: TranslationKey }
  | { kind: "failed"; messageKey: TranslationKey };

/**
 * Sign-in and security: password, authenticator app, passkeys, connected apps.
 *
 * The first three go through the Better Auth client rather than our own API,
 * because they are Better Auth's own flows and reimplementing them around its
 * primitives is how account systems acquire holes. Creating a passkey in
 * particular can only happen here: it calls WebAuthn on the device.
 *
 * Connected apps belong beside them and go through our own API. What a member
 * granted an external program is a standing way in to their account, held by
 * something other than them, so it is read and withdrawn where the other ways
 * in are - and it needs no capability, for the reason the endpoint states: a
 * member who can let an app act for them must not need the board in order to
 * take it back.
 *
 * Failures are shown as one translated sentence chosen from a code, never as
 * the library's own English message.
 *
 * The authenticator-app enrolment shows the setup link as selectable text. A
 * scannable code would need a QR encoder, which is a dependency decision this
 * stage does not get to make on its own, so the screen says plainly that the
 * link has to be entered by hand rather than pretending the step is finished.
 */
export function SecurityPanel({
  twoFactorEnabled,
}: {
  twoFactorEnabled: boolean;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-headline">{t("settings.security.title")}</h2>
        <p className="text-body text-ink-muted">
          {t("settings.security.description")}
        </p>
      </div>
      <PasswordSection />
      <TotpSection enabled={twoFactorEnabled} />
      <PasskeySection />
      <ConnectedAppsSection />
    </>
  );
}

function PasswordSection(): ReactElement {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  const submit = async (): Promise<void> => {
    if (next !== repeat) {
      setOutcome({
        kind: "failed",
        messageKey: "settings.security.password.errors.mismatch",
      });
      return;
    }
    if (next.length < 12) {
      setOutcome({
        kind: "failed",
        messageKey: "settings.security.password.errors.weak",
      });
      return;
    }

    setOutcome({ kind: "working" });
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      // Every other session is dropped. Changing a password is what someone
      // does when they think it leaked, and leaving the old sessions alive
      // would leave whoever has it signed in.
      revokeOtherSessions: true,
    });

    if (error !== null && error !== undefined) {
      setOutcome({
        kind: "failed",
        messageKey:
          error.status === 400 || error.status === 401
            ? "settings.security.password.errors.wrong"
            : "settings.security.password.errors.unknown",
      });
      return;
    }

    setCurrent("");
    setNext("");
    setRepeat("");
    setOutcome({
      kind: "done",
      messageKey: "settings.security.password.changed",
    });
  };

  return (
    <Panel
      title={t("settings.security.password.title")}
      notice={<OutcomeNotice outcome={outcome} />}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className={LABEL}>
          {t("settings.security.password.current")}
          <input
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            required
            value={current}
            onChange={(event) => {
              setCurrent(event.target.value);
            }}
            className={FIELD}
          />
        </label>

        <label className={LABEL}>
          {t("settings.security.password.new")}
          <input
            type="password"
            name="newPassword"
            autoComplete="new-password"
            required
            minLength={12}
            value={next}
            onChange={(event) => {
              setNext(event.target.value);
            }}
            className={FIELD}
          />
          <span className={HINT}>{t("setup.administrator.passwordHint")}</span>
        </label>

        <label className={LABEL}>
          {t("settings.security.password.repeat")}
          <input
            type="password"
            name="repeatPassword"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(event) => {
              setRepeat(event.target.value);
            }}
            className={FIELD}
          />
        </label>

        <div>
          <button
            type="submit"
            disabled={outcome.kind === "working"}
            className={PRIMARY_BUTTON}
          >
            {outcome.kind === "working"
              ? t("settings.saving")
              : t("settings.security.password.submit")}
          </button>
        </div>
      </form>
    </Panel>
  );
}

function TotpSection({ enabled }: { enabled: boolean }): ReactElement {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<readonly string[]>([]);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  /*
   * The session's answer, unless this section has itself just changed it.
   *
   * Derived rather than seeded into state once. `enabled` comes from the session,
   * which resolves AFTER the first render, so a seed captured then reads false
   * for everybody. A viewer who already has an authenticator app enrolled would
   * be shown "off" and an Enable button - and pressing it issues a NEW secret
   * and new backup codes, so the entry already in their authenticator stops
   * working. That is a lockout on an account that reaches the member register.
   *
   * Null means "nothing of our own": the session stands.
   */
  const [changed, setChanged] = useState<boolean | null>(null);
  const on = changed ?? enabled;

  const enable = async (): Promise<void> => {
    setOutcome({ kind: "working" });
    const { data, error } = await authClient.twoFactor.enable({ password });

    if (error !== null && error !== undefined) {
      setOutcome({
        kind: "failed",
        messageKey:
          error.status === 400 || error.status === 401
            ? "settings.security.totp.errors.wrongPassword"
            : "settings.security.totp.errors.unknown",
      });
      return;
    }

    setPassword("");
    // The response is a union: this instance configures TOTP, so the OTP-by-mail
    // shape never appears, and narrowing says so rather than asserting it.
    if (data?.method === "totp") {
      setTotpUri(data.totpURI);
      setBackupCodes(data.backupCodes);
    }
    setOutcome({ kind: "idle" });
  };

  const verify = async (): Promise<void> => {
    setOutcome({ kind: "working" });
    const { error } = await authClient.twoFactor.verifyTotp({ code });

    if (error !== null && error !== undefined) {
      setOutcome({
        kind: "failed",
        messageKey: "settings.security.totp.errors.invalidCode",
      });
      return;
    }

    setCode("");
    setTotpUri(null);
    setChanged(true);
    setOutcome({
      kind: "done",
      messageKey: "settings.security.totp.enabled",
    });
  };

  const disable = async (): Promise<void> => {
    setOutcome({ kind: "working" });
    const { error } = await authClient.twoFactor.disable({ password });

    if (error !== null && error !== undefined) {
      setOutcome({
        kind: "failed",
        messageKey:
          error.status === 400 || error.status === 401
            ? "settings.security.totp.errors.wrongPassword"
            : "settings.security.totp.errors.unknown",
      });
      return;
    }

    setPassword("");
    setBackupCodes([]);
    setChanged(false);
    setOutcome({
      kind: "done",
      messageKey: "settings.security.totp.disabled",
    });
  };

  return (
    <Panel
      title={t("settings.security.totp.title")}
      description={t("settings.security.totp.description")}
      notice={<OutcomeNotice outcome={outcome} />}
    >
      {/* The state in words next to the control, not only in it. */}
      <p className="text-small">
        <span className="text-label text-ink-muted uppercase">
          {t("settings.security.totp.title")}
        </span>{" "}
        <span className={on ? "text-ok" : "text-ink-muted"}>
          {on
            ? t("settings.security.totp.on")
            : t("settings.security.totp.off")}
        </span>
      </p>

      {totpUri === null ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void (on ? disable() : enable());
          }}
        >
          <label className={LABEL}>
            {t("settings.security.totp.password")}
            <input
              type="password"
              name="totpPassword"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              className={FIELD}
            />
          </label>

          <div>
            <button
              type="submit"
              disabled={outcome.kind === "working"}
              className={on ? QUIET_BUTTON : PRIMARY_BUTTON}
            >
              {on
                ? t("settings.security.totp.disable")
                : t("settings.security.totp.enable")}
            </button>
          </div>
        </form>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
        >
          <div className="flex flex-col gap-1">
            <span className="text-label text-ink-muted uppercase">
              {t("settings.security.totp.uri")}
            </span>
            {/* The setup link is a secret in text form, so it sits on the mono
                grid and wraps rather than being truncated out of reach. */}
            <code className="rounded-control border border-line bg-sunken p-2 font-data text-data break-all">
              {totpUri}
            </code>
            <span className={HINT}>{t("settings.security.totp.uriHint")}</span>
          </div>

          <label className={LABEL}>
            {t("settings.security.totp.code")}
            <input
              type="text"
              name="totpCode"
              autoComplete="one-time-code"
              inputMode="numeric"
              required
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
              className={FIELD_DATA}
            />
          </label>

          <div>
            <button
              type="submit"
              disabled={outcome.kind === "working"}
              className={PRIMARY_BUTTON}
            >
              {t("settings.security.totp.verify")}
            </button>
          </div>
        </form>
      )}

      {backupCodes.length === 0 ? null : (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <span className="text-label text-ink-muted uppercase">
            {t("settings.security.totp.backupCodes")}
          </span>
          <ul className="flex flex-wrap gap-2">
            {backupCodes.map((backupCode) => (
              <li
                key={backupCode}
                className="rounded-control border border-line bg-sunken px-2 py-1 font-data text-data"
              >
                {backupCode}
              </li>
            ))}
          </ul>
          <span className={HINT}>
            {t("settings.security.totp.backupCodesHint")}
          </span>
        </div>
      )}
    </Panel>
  );
}

function PasskeySection(): ReactElement {
  const { t } = useTranslation();
  const [passkeys, setPasskeys] = useState<readonly PasskeyRow[]>([]);
  const [name, setName] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  const read = useCallback(async (): Promise<readonly PasskeyRow[]> => {
    const { data } = await authClient.passkey.listUserPasskeys();
    return data ?? [];
  }, []);

  useEffect(() => {
    let active = true;
    void read().then((rows) => {
      if (active) {
        setPasskeys(rows);
      }
    });
    return () => {
      active = false;
    };
  }, [read]);

  const reload = async (): Promise<void> => {
    setPasskeys(await read());
  };

  const add = async (): Promise<void> => {
    setOutcome({ kind: "working" });

    /*
     * WebAuthn is not available over plain http on a remote host, and a browser
     * without it has no passkey to offer. Checked before the call so the answer
     * is "this device cannot" rather than a library error the viewer cannot act
     * on.
     */
    if (!("credentials" in navigator)) {
      setOutcome({
        kind: "failed",
        messageKey: "settings.security.passkeys.errors.unsupported",
      });
      return;
    }

    const result = await authClient.passkey.addPasskey({
      name: name.trim() === "" ? undefined : name.trim(),
    });

    if (result?.error != null) {
      setOutcome({
        kind: "failed",
        messageKey:
          // A cancelled prompt is the ordinary case, not a fault: the viewer
          // dismissed the dialogue or the device timed out.
          result.error.status === 0 || result.error.status === undefined
            ? "settings.security.passkeys.errors.cancelled"
            : "settings.security.passkeys.errors.unknown",
      });
      return;
    }

    setName("");
    await reload();
    setOutcome({
      kind: "done",
      messageKey: "settings.security.passkeys.added",
    });
  };

  const remove = async (id: string): Promise<void> => {
    setOutcome({ kind: "working" });
    const { error } = await authClient.passkey.deletePasskey({ id });

    if (error !== null && error !== undefined) {
      setOutcome({
        kind: "failed",
        messageKey: "settings.security.passkeys.errors.unknown",
      });
      return;
    }

    await reload();
    setOutcome({ kind: "idle" });
  };

  return (
    <Panel
      title={t("settings.security.passkeys.title")}
      description={t("settings.security.passkeys.description")}
      notice={<OutcomeNotice outcome={outcome} />}
    >
      {passkeys.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("settings.security.passkeys.none")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              className="flex flex-wrap items-center gap-3 rounded-control border border-line bg-page px-3 py-2.5"
            >
              <span className="text-body">
                {passkey.name ?? t("settings.security.passkeys.unnamed")}
              </span>
              <button
                type="button"
                aria-label={t("settings.security.passkeys.removeLabel", {
                  name: passkey.name ?? t("settings.security.passkeys.unnamed"),
                })}
                disabled={outcome.kind === "working"}
                onClick={() => {
                  void remove(passkey.id);
                }}
                className={`${QUIET_BUTTON} ml-auto`}
              >
                {t("settings.security.passkeys.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-col gap-4 border-t border-line pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label className={LABEL}>
          {t("settings.security.passkeys.name")}
          <input
            type="text"
            name="passkeyName"
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className={FIELD}
          />
        </label>

        <div>
          <button
            type="submit"
            disabled={outcome.kind === "working"}
            className={SECONDARY_BUTTON}
          >
            {outcome.kind === "working"
              ? t("settings.security.passkeys.adding")
              : t("settings.security.passkeys.add")}
          </button>
        </div>
      </form>
    </Panel>
  );
}

/**
 * The apps this member has let act for them.
 *
 * Read from our own API rather than from the auth client: the grant, the app's
 * name and host, and when a token was last issued are this product's questions
 * about the library's tables, and the disconnect is ours as well - it deletes
 * the access tokens, revokes the refresh tokens and removes the consent in one
 * transaction, so the app stops reaching the association on its next call.
 *
 * Nothing here is gated. Settings is offered to every account, and a member
 * granting an app access to their own data and then needing the board in order
 * to take it back would be the wrong way round.
 */
function ConnectedAppsSection(): ReactElement {
  const { t, i18n } = useTranslation();
  const [apps, setApps] = useState<readonly ConnectedApp[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  /** The connection the confirm is open on, and the one being cut. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  /**
   * Which read is the current one.
   *
   * A disconnect asks for the list again, so two reads can be in flight at
   * once - a member presses the retry on a failed read and then cuts something
   * - and both answers are well formed. Only the newest may be applied;
   * without that, whichever arrives last wins and an older one puts a
   * connection that has just been cut back on the list.
   */
  const currentRead = useRef(0);

  const read = useCallback((): void => {
    const version = ++currentRead.current;
    void fetchMyConnectedApps().then((result) => {
      if (version !== currentRead.current) {
        return;
      }
      if (result.ok) {
        setApps(result.value.connectedApps);
        setLoadFailed(false);
        return;
      }
      /*
       * Whatever is on screen is kept. A failed re-read leaves the member
       * looking at the last thing the server said, which is still a true
       * picture of a moment, and the notice says the read failed.
       */
      setLoadFailed(true);
    });
  }, []);

  useEffect(() => {
    read();
    /*
     * Leaving supersedes whatever is in flight, so a response that arrives
     * after the screen is gone is dropped by the same check that drops a
     * superseded one.
     */
    return () => {
      currentRead.current += 1;
    };
  }, [read]);

  /**
   * The confirm button, focused as it appears.
   *
   * Pressing disconnect unmounts the button that was pressed, and the browser
   * drops focus to the document body. Somebody using a keyboard or a screen
   * reader is then left with no position on the question they have just been
   * asked, and has to tab from the top of the page to answer it. A browser
   * dialogue would have moved focus by itself; two buttons of our own have to
   * do it here.
   *
   * Keyed on which connection the confirm is open for, so it lands once as the
   * question appears rather than again on every re-render while it is answered.
   */
  const confirmButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirming !== null) {
      confirmButton.current?.focus();
    }
  }, [confirming]);

  const disconnect = async (clientId: string): Promise<void> => {
    setWorking(clientId);
    setOutcome({ kind: "working" });
    const result = await disconnectMyConnectedApp(clientId);
    setWorking(null);

    if (!result.ok) {
      setOutcome({
        kind: "failed",
        messageKey: disconnectFailureKey(result.failure),
      });
      return;
    }

    setConfirming(null);
    setOutcome({
      kind: "done",
      messageKey: "connectedApps.mine.disconnected",
    });
    // Re-read rather than struck from the list here: what is connected is the
    // server's answer.
    read();
  };

  return (
    <Panel
      title={t("connectedApps.mine.title")}
      description={t("connectedApps.mine.description")}
      notice={<OutcomeNotice outcome={outcome} />}
    >
      {loadFailed ? (
        <LoadFailure
          messageKey="connectedApps.mine.loadFailed"
          onRetry={read}
        />
      ) : null}

      {apps === null ? (
        loadFailed ? null : (
          <p role="status" className="text-body text-ink-muted">
            {t("connectedApps.loading")}
          </p>
        )
      ) : apps.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("connectedApps.mine.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {apps.map((app) => {
            const appName = app.clientName ?? t("connectedApps.unnamedApp");
            const busy = working === app.clientId;

            return (
              <li
                key={app.clientId}
                className="flex flex-col gap-1 rounded-control border border-line bg-page px-3 py-2.5"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-body">{appName}</span>
                  <span className="font-data text-small text-ink-muted">
                    {app.clientHost ?? t("connectedApps.unknownHost")}
                  </span>
                </div>

                <p className="text-small text-ink-muted">
                  <span className="text-label uppercase">
                    {t("connectedApps.connectedAt")}
                  </span>{" "}
                  <span className="font-data">
                    {formatConnectedAppMoment(app.connectedAt, i18n.language)}
                  </span>
                </p>

                <p className="text-small text-ink-muted">
                  <span className="text-label uppercase">
                    {t("connectedApps.lastTokenIssued")}
                  </span>{" "}
                  {/*
                    Only the date takes the data face. The other branch is a
                    translated sentence rather than a register value.
                  */}
                  {app.lastTokenIssuedAt === null ? (
                    t("connectedApps.noToken")
                  ) : (
                    <span className="font-data">
                      {formatConnectedAppMoment(
                        app.lastTokenIssuedAt,
                        i18n.language,
                      )}
                    </span>
                  )}
                </p>

                {/*
                  Two presses rather than a browser dialogue. A native confirm
                  cannot be styled, cannot be translated and cannot be read by a
                  test, and the question belongs next to the row it is about.
                */}
                <div className="flex flex-wrap gap-2">
                  {confirming === app.clientId ? (
                    <>
                      <button
                        type="button"
                        ref={confirmButton}
                        disabled={busy}
                        onClick={() => {
                          void disconnect(app.clientId);
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
                          setConfirming(null);
                        }}
                        className={QUIET_BUTTON}
                      >
                        {t("connectedApps.disconnectCancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label={t("connectedApps.disconnectLabel", {
                        app: appName,
                      })}
                      disabled={outcome.kind === "working"}
                      onClick={() => {
                        setConfirming(app.clientId);
                      }}
                      className={QUIET_BUTTON}
                    >
                      {t("connectedApps.disconnect")}
                    </button>
                  )}
                </div>

                {confirming === app.clientId ? (
                  <Notice tone="warn" live>
                    {t("connectedApps.mine.disconnectWarning")}
                  </Notice>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** One notice for the four sections, so their states cannot render differently. */
function OutcomeNotice({ outcome }: { outcome: Outcome }): ReactElement | null {
  const { t } = useTranslation();

  if (outcome.kind === "done") {
    return (
      <Notice tone="ok" live>
        {t(outcome.messageKey)}
      </Notice>
    );
  }
  if (outcome.kind === "failed") {
    return (
      <Notice tone="danger" live>
        {t(outcome.messageKey)}
      </Notice>
    );
  }
  return null;
}
