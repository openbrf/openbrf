import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { MotionStatus } from "../api/motions";
import type { TranslationKey } from "../i18n/translation-key";

const LABEL: Readonly<Record<MotionStatus, TranslationKey>> = {
  SUBMITTED: "motions.status.SUBMITTED",
  ACKNOWLEDGED: "motions.status.ACKNOWLEDGED",
  WITHDRAWN: "motions.status.WITHDRAWN",
};

/**
 * Where a motion stands, as a sign.
 *
 * Colour is never the only signal: each state carries its own word as well as
 * its own border weight, so a reader who cannot tell the two tones apart still
 * reads which state this is.
 *
 * A submitted motion is the one that wants attention, which is why it takes the
 * warn tone rather than the neutral one: it is an item with the board that
 * nobody has dealt with yet, and a deadline is running somewhere behind it.
 */
const TONE: Readonly<Record<MotionStatus, string>> = {
  SUBMITTED: "border-warn bg-warn-soft",
  ACKNOWLEDGED: "border-ok bg-ok-soft",
  WITHDRAWN: "border-line bg-sunken",
};

export function MotionStatusChip({
  status,
}: {
  status: MotionStatus;
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
