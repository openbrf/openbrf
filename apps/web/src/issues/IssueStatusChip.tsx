import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { IssueStatus } from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";

const LABEL: Readonly<Record<IssueStatus, TranslationKey>> = {
  NEW: "issues.status.NEW",
  IN_PROGRESS: "issues.status.IN_PROGRESS",
  DONE: "issues.status.DONE",
};

/**
 * Where an issue stands, as a sign.
 *
 * Colour is never the only signal: each state carries its own word as well as
 * its own border weight, so a reader who cannot tell the two tones apart still
 * reads which state this is.
 */
const TONE: Readonly<Record<IssueStatus, string>> = {
  NEW: "border-warn bg-warn-soft",
  IN_PROGRESS: "border-info bg-info-soft",
  DONE: "border-ok bg-ok-soft",
};

export function IssueStatusChip({
  status,
}: {
  status: IssueStatus;
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
