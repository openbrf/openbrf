import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { KeyOrderStatus } from "../api/key-orders";
import type { TranslationKey } from "../i18n/translation-key";

const LABEL: Readonly<Record<KeyOrderStatus, TranslationKey>> = {
  SUBMITTED: "keyOrders.status.SUBMITTED",
  HANDED_OVER: "keyOrders.status.HANDED_OVER",
  DECLINED: "keyOrders.status.DECLINED",
  WITHDRAWN: "keyOrders.status.WITHDRAWN",
};

/**
 * Where an order stands, as a sign.
 *
 * Colour is never the only signal: each state carries its own word as well as
 * its own border weight, so a reader who cannot tell the tones apart still reads
 * which state this is.
 *
 * A submitted order takes the warn tone because it is the one waiting on
 * somebody. A declined order takes the danger tone and a withdrawn one the quiet
 * tone: the board said no to the first, and the resident stopped asking in the
 * second.
 */
const TONE: Readonly<Record<KeyOrderStatus, string>> = {
  SUBMITTED: "border-warn bg-warn-soft",
  HANDED_OVER: "border-ok bg-ok-soft",
  DECLINED: "border-danger bg-danger-soft",
  WITHDRAWN: "border-line bg-sunken",
};

export function KeyOrderStatusChip({
  status,
}: {
  status: KeyOrderStatus;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <span
      className={`inline-flex items-center rounded-control border-l-4 px-2 py-1 text-chip text-ink uppercase ${TONE[status]}`}
    >
      {t(LABEL[status])}
    </span>
  );
}
