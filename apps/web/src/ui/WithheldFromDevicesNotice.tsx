import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { WithheldFromDevices } from "../api/withheld-from-devices";
import { Notice } from "./Notice";

/**
 * The editors' mark on an item the register check withholds from devices
 * (ADR 0032): that no screen or other device shows it, and the words that
 * caused it, so the board can rephrase it.
 *
 * A word that names only somebody with protected personal data is never
 * shown. The notice says that the text names somebody in the register, and no
 * more.
 *
 * The words are shown in the register's monospace face: what is found is a
 * name, an apartment number, an email address or a phone number as the
 * register holds them.
 */
export function WithheldFromDevicesNotice({
  mark,
}: {
  mark: WithheldFromDevices | undefined;
}): ReactElement | null {
  const { t } = useTranslation();
  if (mark === undefined) {
    return null;
  }
  return (
    <Notice tone="warn">
      <p>{t("devices.withheld.title")}</p>
      {mark.words.length > 0 && (
        <p>
          {t("devices.withheld.words")}{" "}
          {mark.words.map((word, index) => (
            <span key={word}>
              {index > 0 && ", "}
              <span className="font-data">{word}</span>
            </span>
          ))}
        </p>
      )}
      {mark.unshownWords && (
        <p>
          {mark.words.length > 0
            ? t("devices.withheld.unshownAlso")
            : t("devices.withheld.unshown")}
        </p>
      )}
      <p>{t("devices.withheld.rephrase")}</p>
    </Notice>
  );
}
