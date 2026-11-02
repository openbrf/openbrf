import type { IssueStatusMeaning } from "@openbrf/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { ISSUE_MEANING_LABEL } from "./issue-labels";

/**
 * Where an issue stands, as a sign.
 *
 * The tone follows the meaning and never the board's label, so a status the
 * board added under a meaning reads as that meaning. Colour is never the only
 * signal: each sign carries its own word as well, so a reader who cannot tell
 * the tones apart still reads where the issue stands.
 */
const TONE: Readonly<Record<IssueStatusMeaning, string>> = {
  NEW: "border-warn bg-warn-soft",
  IN_PROGRESS: "border-info bg-info-soft",
  WAITING: "border-line-strong bg-page",
  DONE: "border-ok bg-ok-soft",
};

/**
 * `label` is the board's own name for the status, and is given only on the
 * issue queue, which is the issue module's own screen for its handlers.
 * Everywhere else - the reporter's own list, a post, the overview, the data
 * subject access report - the chip says the meaning in the reader's language,
 * because a label is text the board wrote for its handlers (ADR 0054).
 */
export function IssueStatusChip({
  meaning,
  label,
}: {
  meaning: IssueStatusMeaning;
  label?: string;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <span
      className={`inline-flex items-center rounded-control border-l-4 px-2 py-1 text-chip text-ink uppercase ${TONE[meaning]}`}
    >
      {label ?? t(ISSUE_MEANING_LABEL[meaning])}
    </span>
  );
}
