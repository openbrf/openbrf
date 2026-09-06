import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { DataProtectionOverview } from "../api/data-protection";
import { HINT } from "../ui/controls";

export interface OverviewStripProps {
  overview: DataProtectionOverview;
  /**
   * The moment these counts were read.
   *
   * Passed in rather than read from the clock while rendering, for two reasons.
   * A component that reads the clock during render produces a different answer
   * every time React re-renders it, for no reason the reader can see. And the
   * hours left belong to the read: the strip should say what was true when the
   * counts were taken, not what is true at paint time.
   */
  readAt: Date;
}

/**
 * What is waiting, in four sentences, above everything else on the screen.
 *
 * Sentences rather than a row of numbers. A board opening this screen wants to
 * know whether it owes anybody anything today, and "3" over a label is a
 * quantity where the answer is a state - the difference between "one breach is
 * past its 72 hours" and a figure the reader has to interpret.
 *
 * Every count reads as a word when it is zero, never as a blank or a dash: a
 * board that has nothing waiting should be told so, because an empty strip
 * looks like a screen that has not loaded.
 */
export function OverviewStrip({
  overview,
  readAt,
}: OverviewStripProps): ReactElement {
  const { t } = useTranslation();

  const hoursLeft =
    overview.breaches.nearestDeadline === null
      ? null
      : Math.round(
          (new Date(overview.breaches.nearestDeadline).getTime() -
            readAt.getTime()) /
            (60 * 60 * 1000),
        );

  return (
    <ul className="flex flex-col gap-2">
      <li className={HINT}>
        {overview.breaches.overdue > 0
          ? t("dataProtection.overview.breachesOverdue", {
              count: overview.breaches.overdue,
            })
          : overview.breaches.awaitingDecision > 0
            ? t("dataProtection.overview.breachesWaiting", {
                count: overview.breaches.awaitingDecision,
                hours: hoursLeft ?? 0,
              })
            : t("dataProtection.overview.breachesNone")}
      </li>
      <li className={HINT}>
        {overview.requests.overdue > 0
          ? t("dataProtection.overview.requestsOverdue", {
              count: overview.requests.overdue,
            })
          : overview.requests.open > 0
            ? t("dataProtection.overview.requestsOpen", {
                count: overview.requests.open,
              })
            : t("dataProtection.overview.requestsNone")}
      </li>
      <li className={HINT}>
        {overview.processors.notRecorded > 0
          ? t("dataProtection.overview.processorsNotRecorded", {
              count: overview.processors.notRecorded,
            })
          : overview.processors.pending > 0
            ? t("dataProtection.overview.processorsPending", {
                count: overview.processors.pending,
              })
            : t("dataProtection.overview.processorsRecorded")}
      </li>
      <li className={HINT}>
        {!overview.notice.published
          ? t("dataProtection.overview.noticeUnpublished")
          : overview.notice.missingHeadings > 0
            ? t("dataProtection.overview.noticeMissing", {
                count: overview.notice.missingHeadings,
              })
            : t("dataProtection.overview.noticeComplete")}
      </li>
    </ul>
  );
}
