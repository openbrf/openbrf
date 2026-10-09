import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";

/**
 * That a request's month was extended, when it was told, and why.
 *
 * The date is set in the register face like every other date the register
 * shows (DESIGN.md, the Mono-Grid Rule), so the message is the label, the date
 * and the reason as three parts rather than one interpolated sentence. The
 * reason is the board's own free text and keeps the ordinary typography.
 */
export function ExtensionNote({
  labelKey,
  date,
  reason,
}: {
  labelKey: TranslationKey;
  date: string;
  reason: string;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <>
      {t(labelKey)} <span className="font-data">{date}</span>: {reason}
    </>
  );
}
