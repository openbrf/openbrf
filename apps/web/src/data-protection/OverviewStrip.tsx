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

  const { breaches } = overview;

  /*
   * A breach awaiting a decision and one whose notification is owed are
   * different acts, so each count is said with the hours left on its own
   * nearest bound. Both are said when both are waiting: naming only the first
   * would hide a notification that is still owed.
   */
  const breachSentences =
    breaches.overdue > 0
      ? [
          t("dataProtection.overview.breachesOverdue", {
            count: breaches.overdue,
          }),
        ]
      : [
          ...(breaches.awaitingDecision > 0
            ? [
                t("dataProtection.overview.breachesWaiting", {
                  count: breaches.awaitingDecision,
                  hours: hoursUntil(breaches.nearestDecisionDeadline, readAt),
                }),
              ]
            : []),
          ...(breaches.notificationOwed > 0
            ? [
                t("dataProtection.overview.breachesNotificationOwed", {
                  count: breaches.notificationOwed,
                  hours: hoursUntil(
                    breaches.nearestNotificationDeadline,
                    readAt,
                  ),
                }),
              ]
            : []),
        ];

  return (
    <ul className="flex flex-col gap-2">
      <li className={HINT}>
        {breachSentences.length > 0
          ? breachSentences.join(" ")
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

/** Whole hours from the read to a bound, or none when no bound is running. */
function hoursUntil(deadline: string | null, readAt: Date): number {
  return deadline === null
    ? 0
    : Math.round(
        (new Date(deadline).getTime() - readAt.getTime()) / (60 * 60 * 1000),
      );
}
