import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { QUIET_BUTTON } from "../ui/controls";
import { BoardZone, type BoardAudience } from "../ui/BoardZone";
import { QUEUES, type QueueId } from "./overview-panels";
import { QUEUE_COUNTS } from "./queue-counts";
import { ITEM_LINK, ITEM_ROW } from "./ReadPanel";
import { useRead } from "./use-read";

const LABEL: Readonly<Record<QueueId, TranslationKey>> = {
  issues: "overview.toHandle.queue.issues",
  boardMailbox: "overview.toHandle.queue.boardMailbox",
  motions: "overview.toHandle.queue.motions",
  sublets: "overview.toHandle.queue.sublets",
  keyOrders: "overview.toHandle.queue.keyOrders",
  brokerUpdateRequests: "overview.toHandle.queue.brokerUpdateRequests",
  accountRequests: "overview.toHandle.queue.accountRequests",
  chatReports: "overview.toHandle.queue.chatReports",
  importProposals: "overview.toHandle.queue.importProposals",
};

/**
 * Whose work the queues are. The issue queue is the one the board shares with
 * the property manager, so a viewer who holds nothing else is signed for both;
 * every other queue is the board's, and the sign follows the widest function
 * on the list rather than a role.
 */
function audienceOf(queues: readonly QueueId[]): BoardAudience {
  return queues.every((id) => id === "issues") ? "issueHandling" : "board";
}

/**
 * "To handle": the board's zone on the overview, with one row for each queue this account works, with what is waiting
 * in it and the way to it.
 *
 * A list of rows on a notice board rather than a row of tiles: each line names
 * the queue in words and gives its count in the mono grid, so the counts line
 * up and read the way the register's figures do. A queue with nothing in it
 * keeps its row and says so in words, because a row that disappeared would
 * read the same as a capability that had been taken away.
 *
 * Each row owns its read. One queue failing puts its own sentence and retry on
 * its own row, and the others keep their counts.
 *
 * Rendered by the overview only for an account that holds a queue's
 * capability, so a resident sees neither the zone nor its sign.
 *
 * Nobody is named. The model holds no assignee, so these are the queues the
 * seat works rather than tasks given to this person.
 */
export function ToHandlePanel({
  queues,
}: {
  queues: readonly QueueId[];
}): ReactElement {
  const { t } = useTranslation();

  return (
    <BoardZone
      title={t("overview.toHandle.title")}
      audience={audienceOf(queues)}
    >
      <p className="text-small text-ink-muted">
        {t("overview.toHandle.description")}
      </p>
      <ul className="flex flex-col gap-3">
        {queues.map((id) => (
          <QueueRow key={id} id={id} />
        ))}
      </ul>
    </BoardZone>
  );
}

function QueueRow({ id }: { id: QueueId }): ReactElement | null {
  const { t } = useTranslation();
  const { state, retry } = useRead(QUEUE_COUNTS[id]);
  const to = QUEUES.find((queue) => queue.id === id)?.to ?? "/";

  // Not this account's queue after all; see QUEUE_COUNTS.
  if (state.kind === "loaded" && state.value === null) {
    return null;
  }

  return (
    <li className={ITEM_ROW}>
      <Link to={to} className={`text-body font-semibold ${ITEM_LINK}`}>
        {t(LABEL[id])}
      </Link>
      <span className="ml-auto flex items-center gap-3">
        {state.kind === "loading" ? (
          <span role="status" className="text-small text-ink-muted">
            {t("app.loading")}
          </span>
        ) : state.kind === "failed" ? (
          <>
            <span className="text-small text-danger">
              {t("overview.toHandle.rowFailed")}
            </span>
            <button type="button" onClick={retry} className={QUIET_BUTTON}>
              {t("app.retry")}
            </button>
          </>
        ) : state.value === null ? null : state.value.count === 0 ? (
          <span className="text-small text-ink-muted">
            {t("overview.toHandle.none")}
          </span>
        ) : (
          <span className="font-data text-data text-ink">
            {state.value.more
              ? t("overview.toHandle.atLeast", { count: state.value.count })
              : state.value.count}
          </span>
        )}
      </span>
    </li>
  );
}
