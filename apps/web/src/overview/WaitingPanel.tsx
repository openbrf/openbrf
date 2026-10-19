import { Link } from "@tanstack/react-router";
import { useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiResult } from "../api/client";
import { fetchOwnIssues } from "../api/issues";
import { fetchKeyOrderIntake } from "../api/key-orders";
import { fetchMotionIntake } from "../api/motions";
import { fetchSubletIntake } from "../api/sublets";
import { localDayOfInstant } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { IssueStatusChip } from "../issues/IssueStatusChip";
import { KeyOrderStatusChip } from "../key-orders/KeyOrderStatusChip";
import { MotionStatusChip } from "../motions/MotionStatusChip";
import { SubletStatusChip } from "../sublets/SubletStatusChip";
import {
  waitingItems,
  type WaitingItem,
  type WaitingSources,
} from "./overview-panels";
import { ITEM_LINK, ITEM_ROW, ReadPanel } from "./ReadPanel";
import { useRead } from "./use-read";

const KIND: Readonly<Record<WaitingItem["kind"], TranslationKey>> = {
  issue: "overview.waiting.kind.issue",
  motion: "overview.waiting.kind.motion",
  sublet: "overview.waiting.kind.sublet",
  keyOrder: "overview.waiting.kind.keyOrder",
};

const SCREEN: Readonly<Record<WaitingItem["kind"], string>> = {
  issue: "/issues",
  motion: "/motions",
  sublet: "/sublets",
  keyOrder: "/key-orders",
};

/**
 * "Waiting on the association": what this person sent in and has not had an
 * answer to.
 *
 * Up to four reads, one per intake the account holds, answered as one panel:
 * a list that silently left out the motions because their read failed would
 * say "nothing is waiting" about a motion that is. So any one failing fails
 * the panel, and the retry asks all of them again.
 */
export function WaitingPanel({
  sources,
}: {
  sources: WaitingSources;
}): ReactElement {
  const { t } = useTranslation();
  const { issues, motions, sublets, keyOrders } = sources;

  const read = useCallback(async (): Promise<ApiResult<WaitingItem[]>> => {
    const [ownIssues, motionIntake, subletIntake, keyOrderIntake] =
      await Promise.all([
        issues ? fetchOwnIssues() : null,
        motions ? fetchMotionIntake() : null,
        sublets ? fetchSubletIntake() : null,
        keyOrders ? fetchKeyOrderIntake() : null,
      ]);
    for (const result of [
      ownIssues,
      motionIntake,
      subletIntake,
      keyOrderIntake,
    ]) {
      if (result !== null && !result.ok) {
        return result;
      }
    }
    return {
      ok: true,
      value: waitingItems({
        issues: ownIssues?.ok === true ? ownIssues.value : [],
        motions: motionIntake?.ok === true ? motionIntake.value.motions : [],
        sublets:
          subletIntake?.ok === true ? subletIntake.value.applications : [],
        keyOrders:
          keyOrderIntake?.ok === true ? keyOrderIntake.value.orders : [],
      }),
    };
  }, [issues, motions, sublets, keyOrders]);
  const { state, retry } = useRead(read);

  return (
    <ReadPanel
      title={t("overview.waiting.title")}
      description={t("overview.waiting.description")}
      read={state}
      failureKey="overview.waiting.loadFailed"
      onRetry={retry}
    >
      {(items) =>
        items.length === 0 ? (
          <p className="text-body text-ink-muted">
            {t("overview.waiting.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={`${item.kind}-${idOf(item)}`} className={ITEM_ROW}>
                <span className="text-label text-ink-muted uppercase">
                  {t(KIND[item.kind])}
                </span>
                <Link
                  to={SCREEN[item.kind]}
                  className={`text-body font-semibold ${ITEM_LINK}`}
                >
                  <WaitingName item={item} />
                </Link>
                <WaitingStatus item={item} />
                <span className="ml-auto font-data text-data text-ink-muted">
                  {localDayOfInstant(item.at)}
                </span>
              </li>
            ))}
          </ul>
        )
      }
    </ReadPanel>
  );
}

function idOf(item: WaitingItem): string {
  switch (item.kind) {
    case "issue":
      return item.issue.id;
    case "motion":
      return item.motion.id;
    case "sublet":
      return item.application.id;
    case "keyOrder":
      return item.order.id;
  }
}

/** What the person would call it: the type, the title, the period, the keys. */
function WaitingName({ item }: { item: WaitingItem }): ReactElement {
  const { t } = useTranslation();

  switch (item.kind) {
    case "issue":
      return <>{item.issue.typeName}</>;
    case "motion":
      return <>{item.motion.title}</>;
    case "sublet":
      return (
        <span className="font-data text-data">
          {`${item.application.periodFrom} - ${item.application.periodTo}`}
        </span>
      );
    case "keyOrder":
      return (
        <>
          {t("keyOrders.mine.ordered", {
            quantity: item.order.quantity,
            kind: t(`keyOrders.kind.${item.order.kind}`),
          })}
        </>
      );
  }
}

function WaitingStatus({ item }: { item: WaitingItem }): ReactElement {
  switch (item.kind) {
    case "issue":
      return <IssueStatusChip status={item.issue.status} />;
    case "motion":
      return <MotionStatusChip status={item.motion.status} />;
    case "sublet":
      return <SubletStatusChip status={item.application.status} />;
    case "keyOrder":
      return <KeyOrderStatusChip status={item.order.status} />;
  }
}
