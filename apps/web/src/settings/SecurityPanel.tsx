import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { authClient } from "../auth/auth-client";
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
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";

/** A passkey as the auth API reports it. */
interface PasskeyRow {
  id: string;
  name?: string | null;
  createdAt?: string | Date | null;
}

type Outcome =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; messageKey: TranslationKey }
  | { kind: "failed"; messageKey: TranslationKey };

/**
 * Sign-in and security: password, authenticator app, passkeys.
 *
 * These go through the Better Auth client rather than our own API, because they
 * are Better Auth's own flows and reimplementing them around its primitives is
 * how account systems acquire holes. Creating a passkey in particular can only
 * happen here: it calls WebAuthn on the device.
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
      <PasswordSection />
      <TotpSection enabled={twoFactorEnabled} />
      <PasskeySection />
      <p className={HINT}>{t("settings.security.description")}</p>
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
  const [on, setOn] = useState(enabled);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<readonly string[]>([]);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

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
    setOn(true);
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
    setOn(false);
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

/** One notice for the three sections, so their states cannot render differently. */
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
