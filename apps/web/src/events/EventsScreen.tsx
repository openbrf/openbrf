import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { EventAttendPanel } from "./EventAttendPanel";

export interface EventsScreenProps {
  viewer: Viewer;
}

/**
 * The association's calendar (evenemangskalendern): what is coming, and one's
 * own place at each date.
 *
 * events:attend belongs to whoever lives here. The external property manager
 * does not hold it - they handle the association's issues and do not live in
 * the building, so a place at the cleaning day is not theirs to take.
 *
 * One page, one audience. Arranging the calendar - entering a series,
 * publishing it, calling off a date and reading who is coming - is the board's
 * page at /board/events, so a board member who lives here reads the same
 * screen here as their neighbours do (ADR 0049).
 *
 * Hiding the panel is courtesy only. The API refuses every call either way, the
 * dates a resident is shown are the published ones the server filtered, and the
 * list behind the panel carries counts rather than names, so there is nothing
 * on it for a screen to leak. The panel owns its own read.
 */
export function EventsScreen({ viewer }: EventsScreenProps): ReactElement {
  const { t } = useTranslation();

  const canAttend = viewer.capabilities.includes("events:attend");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("events.title")}</h1>
        <p className="text-body text-ink-muted">{t("events.intro")}</p>
      </header>

      {canAttend ? <EventAttendPanel /> : null}
    </div>
  );
}
