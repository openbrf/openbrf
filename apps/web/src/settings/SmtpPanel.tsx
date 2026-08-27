import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { SmtpSettings } from "../api/instance";
import { saveSmtp, sendSmtpTest } from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface SmtpPanelProps {
  value: SmtpSettings;
  onSaved?: (value: SmtpSettings) => void;
  submitLabel?: string;
  editable?: boolean;
}

const TEST_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "mail-not-configured": "settings.smtp.errors.notConfigured",
  "no-email": "settings.smtp.errors.noEmail",
};

/**
 * The port to offer when the settings name none, per transport.
 *
 * Not one number for both. The "encrypted connection" checkbox is nodemailer's
 * `secure` flag, which means IMPLICIT TLS: the client starts the handshake the
 * moment it connects, and that is what servers offer on 465. Port 587 is the
 * submission port that opens in cleartext and upgrades through STARTTLS. Pairing
 * 587 with an implicit-TLS connection asks for a handshake from a port that
 * answers with a greeting, so the default combination the wizard used to present
 * was one that cannot connect.
 */
const IMPLICIT_TLS_PORT = "465";
const STARTTLS_SUBMISSION_PORT = "587";

function defaultPortFor(secure: boolean): string {
  return secure ? IMPLICIT_TLS_PORT : STARTTLS_SUBMISSION_PORT;
}

/**
 * How the instance sends mail.
 *
 * Skippable in the wizard, and the notice says what skipping costs: with no
 * SMTP server there is no way to deliver an invitation, an activation link or a
 * sign-in link, so nobody can be brought into the register at all. The screen
 * says that plainly rather than letting an administrator discover it when the
 * first invitation silently fails.
 *
 * The password field starts empty even when one is stored. The API never
 * returns it, and leaving the field empty keeps what is there rather than
 * clearing it - which is stated in the hint, because a form that silently means
 * two different things by "empty" is a trap.
 */
export function SmtpPanel({
  value,
  onSaved,
  submitLabel,
  editable = true,
}: SmtpPanelProps): ReactElement {
  const { t } = useTranslation();
  const [host, setHost] = useState(value.host ?? "");
  const [port, setPort] = useState(
    value.port === null ? defaultPortFor(value.secure) : String(value.port),
  );
  const [secure, setSecure] = useState(value.secure);
  const [user, setUser] = useState(value.user ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [fromAddress, setFromAddress] = useState(value.fromAddress ?? "");
  const [configured, setConfigured] = useState(value.configured);
  /** Where the last test went, so the confirmation can name the mailbox. */
  const [testedAddress, setTestedAddress] = useState<string | null>(null);

  const save = useSaveAction(saveSmtp, (saved) => {
    setPassword("");
    setClearPassword(false);
    setConfigured(saved.configured);
    onSaved?.(saved);
  });
  const test = useSaveAction(sendSmtpTest, (result) => {
    setTestedAddress(result.sentTo);
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsedPort = Number.parseInt(port, 10);

    void save.submit({
      host: host.trim() === "" ? null : host.trim(),
      port: Number.isNaN(parsedPort) ? null : parsedPort,
      secure,
      user: user.trim() === "" ? null : user.trim(),
      // Three states, not two: undefined keeps the stored password, null clears
      // it, a string replaces it.
      password: clearPassword ? null : password === "" ? undefined : password,
      fromAddress: fromAddress.trim() === "" ? null : fromAddress.trim(),
    });
  };

  return (
    <Panel
      title={t("settings.smtp.title")}
      description={t("settings.smtp.description")}
      notice={
        save.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                save.state.failure,
                {},
                "settings.errors.unknown",
              ),
            )}
          </Notice>
        ) : test.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                test.state.failure,
                TEST_FAILURES,
                "settings.smtp.errors.unknown",
              ),
            )}
          </Notice>
        ) : test.state.kind === "saved" && testedAddress !== null ? (
          <Notice tone="ok" live>
            {t("settings.smtp.testSent", { email: testedAddress })}
          </Notice>
        ) : save.state.kind === "saved" ? (
          /* Confirmed here rather than left to the standing "configured"
             notice. The settings screen keys this panel on the host and on
             whether a password is stored, so replacing only the password
             changes neither key, the panel does not remount, and without this
             branch the screen looks identical before and after the save. */
          <Notice tone="ok" live>
            {t("settings.saved")}
          </Notice>
        ) : configured ? (
          <Notice tone="ok">{t("settings.smtp.configured")}</Notice>
        ) : (
          <Notice tone="warn">{t("settings.smtp.notConfigured")}</Notice>
        )
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            {t("settings.smtp.host")}
            <input
              type="text"
              name="smtpHost"
              autoComplete="off"
              disabled={!editable}
              value={host}
              onChange={(event) => {
                setHost(event.target.value);
              }}
              className={FIELD_DATA}
            />
          </label>

          <label className={LABEL}>
            {t("settings.smtp.port")}
            <input
              type="number"
              name="smtpPort"
              min={1}
              max={65535}
              disabled={!editable}
              value={port}
              onChange={(event) => {
                setPort(event.target.value);
              }}
              className={FIELD_DATA}
            />
          </label>

          <label className={LABEL}>
            {t("settings.smtp.user")}
            <input
              type="text"
              name="smtpUser"
              autoComplete="off"
              disabled={!editable}
              value={user}
              onChange={(event) => {
                setUser(event.target.value);
              }}
              className={FIELD}
            />
          </label>

          <label className={LABEL}>
            {t("settings.smtp.fromAddress")}
            <input
              type="email"
              name="smtpFromAddress"
              autoComplete="off"
              disabled={!editable}
              value={fromAddress}
              onChange={(event) => {
                setFromAddress(event.target.value);
              }}
              className={FIELD}
            />
          </label>
        </div>

        <label className={LABEL}>
          {t("settings.smtp.password")}
          <input
            type="password"
            name="smtpPassword"
            autoComplete="new-password"
            disabled={!editable || clearPassword}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            className={FIELD}
          />
          {value.passwordSet ? (
            <span className={HINT}>{t("settings.smtp.passwordKept")}</span>
          ) : null}
        </label>

        {value.passwordSet && editable ? (
          <label className="flex min-h-11 items-center gap-2 text-small">
            <input
              type="checkbox"
              name="smtpClearPassword"
              checked={clearPassword}
              onChange={(event) => {
                setClearPassword(event.target.checked);
              }}
              className="size-4"
            />
            {t("settings.smtp.passwordClear")}
          </label>
        ) : null}

        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            name="smtpSecure"
            checked={secure}
            disabled={!editable}
            onChange={(event) => {
              const next = event.target.checked;
              setSecure(next);
              // The two transports listen on different ports, so a port still
              // sitting on the other mode's default follows the switch. A port
              // the administrator actually typed is left alone.
              if (port === defaultPortFor(!next) || port === "") {
                setPort(defaultPortFor(next));
              }
            }}
            className="size-4"
          />
          {t("settings.smtp.secure")}
        </label>

        {editable ? (
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={save.state.kind === "saving"}
              className={PRIMARY_BUTTON}
            >
              {save.state.kind === "saving"
                ? t("settings.saving")
                : (submitLabel ?? t("settings.save"))}
            </button>

            <button
              type="button"
              disabled={!configured || test.state.kind === "saving"}
              onClick={() => {
                void test.submit();
              }}
              className={SECONDARY_BUTTON}
            >
              {test.state.kind === "saving"
                ? t("settings.smtp.sending")
                : t("settings.smtp.sendTest")}
            </button>
          </div>
        ) : null}
      </form>
    </Panel>
  );
}
