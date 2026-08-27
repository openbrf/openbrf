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

/** Default submission port for a server that speaks STARTTLS or implicit TLS. */
const DEFAULT_PORT = "587";

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
    value.port === null ? DEFAULT_PORT : String(value.port),
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
              setSecure(event.target.checked);
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
