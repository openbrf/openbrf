import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { isReadOnly } from "../support/read-only";
import { BoardPage } from "../ui/BoardPage";
import { EventAdminPanel } from "./EventAdminPanel";

export interface EventBoardScreenProps {
  viewer: Viewer;
}

/**
 * "Manage events": arranging the association's calendar, as a page of its own
 * under /board.
 *
 * `events:manage` is the board's: entering a series, publishing it, calling off
 * a date and reading who is coming. The external property manager holds it no
 * more than events:attend - they handle the association's issues and do not
 * live in the building, so the cleaning day's dates are not theirs to arrange.
 * What is coming, and one's own place at it, stay on the house's page, which a
 * board member who lives here reaches like anybody else (ADR 0049).
 *
 * A support session (ADR 0028) holds events:manage and not events:attend, so it
 * is offered this page, read only: the calendar as the board keeps it, with
 * nothing on it that changes it.
 *
 * No read here. The panel asks the board's path for every series including the
 * drafts and owns that read, so it can refresh it after an act without telling
 * the page about it; the house's page asks the sign-up path for something
 * different, and neither answer could stand in for the other.
 *
 * Hiding the page is courtesy only. The API refuses every call either way.
 */
export function EventBoardScreen({
  viewer,
}: EventBoardScreenProps): ReactElement {
  const { t } = useTranslation();

  return (
    <BoardPage
      title={t("events.boardTitle")}
      offered={viewer.capabilities.includes("events:manage")}
    >
      <EventAdminPanel readOnly={isReadOnly(viewer)} />
    </BoardPage>
  );
}
