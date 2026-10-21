import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import { ITEM_LINK, ITEM_ROW } from "../overview/ReadPanel";
import { useRead } from "../overview/use-read";
import { BOARD_FRONT, isOffered } from "../shell/nav-items";
import { isReadOnly } from "../support/read-only";
import { BoardPage } from "../ui/BoardPage";
import { QUIET_BUTTON } from "../ui/controls";
import { QUEUE_COUNTS } from "./queue-counts";
import { audienceOf, QUEUES, queuesFor, type QueueId } from "./queues";

const LABEL: Readonly<Record<QueueId, TranslationKey>> = {
  issues: "board.front.queue.issues",
  boardMailbox: "board.front.queue.boardMailbox",
  motions: "board.front.queue.motions",
  sublets: "board.front.queue.sublets",
  keyOrders: "board.front.queue.keyOrders",
  brokerUpdateRequests: "board.front.queue.brokerUpdateRequests",
  accountRequests: "board.front.queue.accountRequests",
  chatReports: "board.front.queue.chatReports",
};

/**
 * "To handle": the board's front page, with one row for each queue this
 * account works, with what is waiting in it and the way to it.
 *
 * The first of the board's pages, and the one the overview's line and the
 * phone bar open (ADR 0049). The overview is the house's notice board; what
 * the seat has to work through is here.
 *
 * A list of rows rather than a row of tiles: each line names the queue in
 * words and gives its count in the mono grid, so the counts line up and read
 * the way the register's figures do. A queue with nothing in it keeps its row
 * and says so in words, because a row that disappeared would read the same as
 * a capability that had been taken away.
 *
 * Each row owns its read. One queue failing puts its own sentence and retry on
 * its own row, and the others keep their counts.
 *
 * Nobody is named. The model holds no assignee, so these are the queues the
 * seat works rather than tasks given to this person.
 */
export function BoardFrontScreen({ viewer }: { viewer: Viewer }): ReactElement {
  const { t } = useTranslation();
  const queues = queuesFor(viewer.capabilities, isReadOnly(viewer));
  // Offered to whoever the band offers it to: an account with two or more
  // board pages to gather. The property manager's one page is the issue queue
  // itself, and a front page over that one queue would be a second page
  // saying the same thing, so they are refused here as anybody else is.
  const offered = isOffered(viewer.capabilities, BOARD_FRONT);

  return (
    <BoardPage
      title={t("board.front.title")}
      audience={audienceOf(queues)}
      offered={offered}
    >
      {queues.length === 0 ? (
        <p className="text-body text-ink-muted">{t("board.front.noQueues")}</p>
      ) : (
        <>
          <p className="text-small text-ink-muted">
            {t("board.front.description")}
          </p>
          <ul className="flex flex-col gap-3">
            {queues.map((id) => (
              <QueueRow key={id} id={id} />
            ))}
          </ul>
        </>
      )}
    </BoardPage>
  );
}

function QueueRow({ id }: { id: QueueId }): ReactElement | null {
  const { t } = useTranslation();
  const { state, retry } = useRead(QUEUE_COUNTS[id]);
  const to = QUEUES.find((queue) => queue.id === id)?.to ?? BOARD_FRONT;

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
              {t("board.front.rowFailed")}
            </span>
            <button type="button" onClick={retry} className={QUIET_BUTTON}>
              {t("app.retry")}
            </button>
          </>
        ) : state.value === null ? null : state.value.count === 0 ? (
          <span className="text-small text-ink-muted">
            {t("board.front.none")}
          </span>
        ) : (
          <span className="font-data text-data text-ink">
            {state.value.more
              ? t("board.front.atLeast", { count: state.value.count })
              : state.value.count}
          </span>
        )}
      </span>
    </li>
  );
}
