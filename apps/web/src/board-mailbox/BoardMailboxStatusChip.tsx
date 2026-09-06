import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { BoardMailboxThreadStatus } from "../api/board-mailbox";
import type { TranslationKey } from "../i18n/translation-key";

const LABEL: Readonly<Record<BoardMailboxThreadStatus, TranslationKey>> = {
  NEW: "boardMailbox.status.NEW",
  TAKEN: "boardMailbox.status.TAKEN",
  ANSWERED: "boardMailbox.status.ANSWERED",
  CLOSED: "boardMailbox.status.CLOSED",
};

/**
 * Where a thread stands, as a sign.
 *
 * Colour is never the only signal: each state carries its own word as well as
 * its own border weight, so a reader who cannot tell the two tones apart still
 * reads which state this is. The issue queue's chip, with four states instead of
 * three, and the tones follow the same reading - a warning for what is owed, the
 * information tone for what somebody is on, the confirming tone for what has
 * been answered, and a quiet border for what is finished.
 */
const TONE: Readonly<Record<BoardMailboxThreadStatus, string>> = {
  NEW: "border-warn bg-warn-soft",
  TAKEN: "border-info bg-info-soft",
  ANSWERED: "border-ok bg-ok-soft",
  CLOSED: "border-line-strong bg-sunken",
};

export function BoardMailboxStatusChip({
  status,
}: {
  status: BoardMailboxThreadStatus;
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
