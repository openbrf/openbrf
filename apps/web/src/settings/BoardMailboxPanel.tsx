import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { BoardMailboxSettings } from "../api/instance";
import { saveBoardMailbox } from "../api/instance";
import { FIELD, FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface BoardMailboxPanelProps {
  value: BoardMailboxSettings;
  onSaved?: (value: BoardMailboxSettings) => void;
  editable?: boolean;
}

/**
 * The port to offer when the settings name none.
 *
 * Not one number for both, for the reason the SMTP panel gives about its own
 * pair. The "encrypted connection" checkbox means implicit TLS - the client
 * starts the handshake the moment it connects - and that is what a mailbox
 * provider offers on 995. Port 110 is the cleartext one. Pairing the two the
 * wrong way round asks for a handshake from a port that answers with a greeting,
 * so the connection simply times out.
 */
const IMPLICIT_TLS_PORT = "995";
const CLEARTEXT_PORT = "110";

function defaultPortFor(secure: boolean): string {
  return secure ? IMPLICIT_TLS_PORT : CLEARTEXT_PORT;
}

/**
 * The mailbox the board's own address is collected from.
 *
 * Beside the SMTP panel and shaped like it, because it is the same kind of
 * setting: where this instance's correspondence goes out, and where it comes in.
 * What is done with the mail once it is here is the board's own screen.
 *
 * The password field starts empty even when one is stored. The API never returns
 * it, and leaving the field empty keeps what is there rather than clearing it -
 * which is stated in the hint, because a form that silently means two different
 * things by "empty" is a trap.
 *
 * There is no "test the connection" button here, and that is a decision rather
 * than an omission: collecting the mailbox now is a control on the board's own
 * screen, where it belongs - it answers with how many letters arrived, which is
 * the useful answer, and it is what a board actually presses after an
 * administrator has filled this in.
 */
export function BoardMailboxPanel({
  value,
  onSaved,
  editable = true,
}: BoardMailboxPanelProps): ReactElement {
  const { t } = useTranslation();
  const [address, setAddress] = useState(value.address ?? "");
  const [host, setHost] = useState(value.host ?? "");
  const [port, setPort] = useState(
    value.port === null ? defaultPortFor(value.secure) : String(value.port),
  );
  const [secure, setSecure] = useState(value.secure);
  const [user, setUser] = useState(value.user ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [configured, setConfigured] = useState(value.configured);

  const save = useSaveAction(saveBoardMailbox, (saved) => {
    setPassword("");
    setClearPassword(false);
    setConfigured(saved.configured);
    onSaved?.(saved);
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsedPort = Number.parseInt(port, 10);

    void save.submit({
      address: address.trim() === "" ? null : address.trim(),
      host: host.trim() === "" ? null : host.trim(),
      port: Number.isNaN(parsedPort) ? null : parsedPort,
      secure,
      user: user.trim() === "" ? null : user.trim(),
      // Three states, not two: undefined keeps the stored password, null clears
      // it, a string replaces it.
      password: clearPassword ? null : password === "" ? undefined : password,
    });
  };

  return (
    <Panel
      title={t("settings.boardMailbox.title")}
      description={t("settings.boardMailbox.description")}
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
        ) : save.state.kind === "saved" ? (
          /* Confirmed here rather than left to the standing notice. The settings
             screen keys this panel on the host and on whether a password is
             stored, so replacing only the password changes neither key, the
             panel does not remount, and without this branch the screen looks
             identical before and after the save. */
          <Notice tone="ok" live>
            {t("settings.saved")}
          </Notice>
        ) : configured ? (
          <Notice tone="ok">{t("settings.boardMailbox.configured")}</Notice>
        ) : (
          <Notice tone="warn">
            {t("settings.boardMailbox.notConfigured")}
          </Notice>
        )
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <label className={LABEL}>
          {t("settings.boardMailbox.address")}
          <input
            type="email"
            name="boardMailboxAddress"
            autoComplete="off"
            disabled={!editable}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
            }}
            className={FIELD}
          />
          <span className={HINT}>{t("settings.boardMailbox.addressHint")}</span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            {t("settings.boardMailbox.host")}
            <input
              type="text"
              name="boardMailboxHost"
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
            {t("settings.boardMailbox.port")}
            <input
              type="number"
              name="boardMailboxPort"
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
        </div>

        <label className={LABEL}>
          {t("settings.boardMailbox.user")}
          <input
            type="text"
            name="boardMailboxUser"
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
          {t("settings.boardMailbox.password")}
          <input
            type="password"
            name="boardMailboxPassword"
            autoComplete="new-password"
            disabled={!editable || clearPassword}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            className={FIELD}
          />
          {value.passwordSet ? (
            <span className={HINT}>
              {t("settings.boardMailbox.passwordKept")}
            </span>
          ) : null}
        </label>

        {value.passwordSet && editable ? (
          <label className="flex min-h-11 items-center gap-2 text-small">
            <input
              type="checkbox"
              name="boardMailboxClearPassword"
              checked={clearPassword}
              onChange={(event) => {
                setClearPassword(event.target.checked);
              }}
              className="size-4"
            />
            {t("settings.boardMailbox.passwordClear")}
          </label>
        ) : null}

        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            name="boardMailboxSecure"
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
          {t("settings.boardMailbox.secure")}
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
                : t("settings.save")}
            </button>
          </div>
        ) : null}
      </form>
    </Panel>
  );
}
