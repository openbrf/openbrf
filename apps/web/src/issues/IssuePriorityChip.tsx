import type { IssuePriority } from "@openbrf/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { ISSUE_PRIORITY_LABEL } from "./issue-labels";

/**
 * How urgent a handler judged an issue, as a sign beside its status.
 *
 * Normal is the ordinary case and says nothing: a sign on every row would be
 * noise, and an urgent issue has to stand out from the rest. Colour is never
 * the only signal, so each sign carries its word.
 */
const TONE: Readonly<Record<Exclude<IssuePriority, "NORMAL">, string>> = {
  URGENT: "border-danger bg-danger-soft",
  LOW: "border-line-strong bg-page",
};

export function IssuePriorityChip({
  priority,
}: {
  priority: IssuePriority;
}): ReactElement | null {
  const { t } = useTranslation();
  if (priority === "NORMAL") {
    return null;
  }
  return (
    <span
      className={`inline-flex items-center rounded-control border-l-4 px-2 py-1 text-chip text-ink uppercase ${TONE[priority]}`}
    >
      {t(ISSUE_PRIORITY_LABEL[priority])}
    </span>
  );
}
