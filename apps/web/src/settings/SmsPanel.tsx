import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { SmsSettings } from "../api/instance";
import { saveSms, sendSmsTest } from "../api/instance";
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

export interface SmsPanelProps {
  value: SmsSettings;
  onSaved?: (value: SmsSettings) => void;
  editable?: boolean;
}

const TEST_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "sms-not-configured": "settings.sms.errors.notConfigured",
  "no-phone": "settings.sms.errors.noPhone",
};

/**
 * The driver the board can pick on this screen.
 *
 * The screen offers the drivers this build ships and no more, while the API
 * takes any name: an instance running a driver added elsewhere keeps it, and
 * saving from here would only ever be a deliberate change to one of these.
 */
const HTTP_GATEWAY = "http-gateway";

/**
 * How the instance sends text messages.
 *
 * Off until a board turns it on, and the notice says what that means rather
 * than what is missing: an association with no SMS provider is not broken, it
 * is one that reaches its members by email, which is the ordinary case and
 * costs nothing.
 *
 * The gateway address is the whole of the openness on this screen. The driver
 * posts each message to an address the board provides, so the provider is
 * whoever answers it - a commercial one, a gateway on the association's own
 * hardware, or a few lines in front of either.
 *
 * The credential field starts empty even when one is stored. The API never
 * returns it, and leaving the field empty keeps what is there rather than
 * clearing it - which is stated in the hint, because a form that silently means
 * two different things by "empty" is a trap.
 */
export function SmsPanel({
  value,
  onSaved,
  editable = true,
}: SmsPanelProps): ReactElement {
  const { t } = useTranslation();
  const [driver, setDriver] = useState(value.driver ?? "");
  const [gatewayUrl, setGatewayUrl] = useState(value.gatewayUrl ?? "");
  const [senderName, setSenderName] = useState(value.senderName ?? "");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [configured, setConfigured] = useState(value.configured);
  /** Where the last test went, so the confirmation can name the handset. */
  const [testedNumber, setTestedNumber] = useState<string | null>(null);

  const save = useSaveAction(saveSms, (saved) => {
    setToken("");
    setClearToken(false);
    setConfigured(saved.configured);
    onSaved?.(saved);
  });
  const test = useSaveAction(sendSmsTest, (result) => {
    setTestedNumber(result.sentTo);
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    void save.submit({
      driver: driver === "" ? null : driver,
      gatewayUrl: gatewayUrl.trim() === "" ? null : gatewayUrl.trim(),
      senderName: senderName.trim() === "" ? null : senderName.trim(),
      // Three states, not two: undefined keeps the stored credential, null
      // clears it, a string replaces it.
      token: clearToken ? null : token === "" ? undefined : token,
    });
  };

  return (
    <Panel
      title={t("settings.sms.title")}
      description={t("settings.sms.description")}
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
                "settings.sms.errors.unknown",
              ),
            )}
          </Notice>
        ) : test.state.kind === "saved" && testedNumber !== null ? (
          <Notice tone="ok" live>
            {/* The number in the data face, the sentence around it in the UI
                face, as everywhere else a number is printed. Split rather than
                interpolated because both languages end the sentence with it;
                a translation needing it in the middle would want a Trans. */}
            {t("settings.sms.testSentTo")}{" "}
            <span className="font-data">{testedNumber}</span>
          </Notice>
        ) : save.state.kind === "saved" ? (
          /* Confirmed here rather than left to the standing "configured"
             notice, for the reason the email panel confirms its own save: the
             settings screen keys this panel on what is stored, so replacing
             only the credential would leave the screen looking identical
             before and after. */
          <Notice tone="ok" live>
            {t("settings.saved")}
          </Notice>
        ) : configured ? (
          <Notice tone="ok">{t("settings.sms.configured")}</Notice>
        ) : (
          <Notice tone="warn">{t("settings.sms.notConfigured")}</Notice>
        )
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <label className={LABEL}>
          {t("settings.sms.driver")}
          <select
            name="smsDriver"
            disabled={!editable}
            value={driver}
            onChange={(event) => {
              setDriver(event.target.value);
            }}
            className={FIELD}
          >
            <option value="">{t("settings.sms.driverNone")}</option>
            <option value={HTTP_GATEWAY}>
              {t("settings.sms.driverHttpGateway")}
            </option>
          </select>
          <span className={HINT}>{t("settings.sms.driverHint")}</span>
        </label>

        <label className={LABEL}>
          {t("settings.sms.gatewayUrl")}
          <input
            type="url"
            name="smsGatewayUrl"
            autoComplete="off"
            disabled={!editable}
            value={gatewayUrl}
            onChange={(event) => {
              setGatewayUrl(event.target.value);
            }}
            className={FIELD_DATA}
          />
          <span className={HINT}>{t("settings.sms.gatewayUrlHint")}</span>
        </label>

        <label className={LABEL}>
          {t("settings.sms.senderName")}
          <input
            type="text"
            name="smsSenderName"
            autoComplete="off"
            maxLength={64}
            disabled={!editable}
            value={senderName}
            onChange={(event) => {
              setSenderName(event.target.value);
            }}
            className={FIELD}
          />
          <span className={HINT}>{t("settings.sms.senderNameHint")}</span>
        </label>

        <label className={LABEL}>
          {t("settings.sms.token")}
          <input
            type="password"
            name="smsGatewayToken"
            autoComplete="new-password"
            disabled={!editable || clearToken}
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
            }}
            className={FIELD}
          />
          {value.tokenSet ? (
            <span className={HINT}>{t("settings.sms.tokenKept")}</span>
          ) : null}
        </label>

        {value.tokenSet && editable ? (
          <label className="flex min-h-11 items-center gap-2 text-small">
            <input
              type="checkbox"
              name="smsClearToken"
              checked={clearToken}
              onChange={(event) => {
                setClearToken(event.target.checked);
              }}
              className="size-4"
            />
            {t("settings.sms.tokenClear")}
          </label>
        ) : null}

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

            <button
              type="button"
              disabled={!configured || test.state.kind === "saving"}
              onClick={() => {
                void test.submit();
              }}
              className={SECONDARY_BUTTON}
            >
              {test.state.kind === "saving"
                ? t("settings.sms.sending")
                : t("settings.sms.sendTest")}
            </button>
          </div>
        ) : null}
      </form>
    </Panel>
  );
}
