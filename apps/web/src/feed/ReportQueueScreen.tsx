import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { BoardPage } from "../ui/BoardPage";
import { ReportQueue } from "./ReportQueue";

export interface ReportQueueScreenProps {
  viewer: Viewer;
}

/**
 * "Review reported posts": what somebody in the feed asked the board to look
 * at, as a page of its own under /board.
 *
 * `chat:moderate` is the board's. Reporting a post stays in the feed, where it
 * is read, and the feed is the same for a board member as for their
 * neighbours (ADR 0049). The queue reads itself and answers for itself
 * (`ReportQueue`); this page is its frame, and mounts it only for an account
 * that holds the capability, so nobody else's browser asks for a report.
 *
 * Hiding the queue is courtesy only. The API refuses the calls either way.
 */
export function ReportQueueScreen({
  viewer,
}: ReportQueueScreenProps): ReactElement {
  const { t } = useTranslation();

  return (
    <BoardPage
      title={t("feed.boardTitle")}
      offered={viewer.capabilities.includes("chat:moderate")}
    >
      <ReportQueue />
    </BoardPage>
  );
}
