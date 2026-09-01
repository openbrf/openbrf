import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { EventAdminPanel } from "./EventAdminPanel";
import { EventAttendPanel } from "./EventAttendPanel";

export interface EventsScreenProps {
  viewer: Viewer;
}

/**
 * The association's calendar (evenemangskalendern), in two halves.
 *
 * What a viewer sees follows from their capabilities, and the two halves are
 * independent. A resident holds events:attend and gets what is coming and their
 * own place at each date. A board member additionally holds events:manage and
 * gets the half that arranges the calendar: entering a series, publishing it,
 * calling off a date and reading who is coming. The external property manager
 * holds neither - they handle the association's issues and do not live in the
 * building, so a place at the cleaning day is not theirs to take and its dates
 * are not theirs to arrange.
 *
 * The attending half comes first, because for every seat that reaches this
 * screen today it is the act: a board member reading what is coming is somebody
 * living here doing so. The screen does not rely on that staying true - a viewer
 * holding only events:manage gets the board's half alone.
 *
 * Hiding a panel is courtesy only. The API refuses every call either way, the
 * dates a resident is shown are the published ones the server filtered, and the
 * list behind the attending half carries counts rather than names, so there is
 * nothing on it for a screen to leak.
 *
 * ## Why there is no read here
 *
 * Unlike the booking screen, the two halves share no data at all: one asks the
 * sign-up path for the dates still to come with the caller's own place on each,
 * the other asks the board's path for every series including the drafts. Neither
 * answer can stand in for the other, so each panel owns its own read - and a
 * read lifted to this screen would be one the panel below could not refresh
 * after an act without telling the whole screen about it.
 */
export function EventsScreen({ viewer }: EventsScreenProps): ReactElement {
  const { t } = useTranslation();

  const canAttend = viewer.capabilities.includes("events:attend");
  const canManage = viewer.capabilities.includes("events:manage");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("events.title")}</h1>
        <p className="text-body text-ink-muted">{t("events.intro")}</p>
      </header>

      {canAttend ? <EventAttendPanel /> : null}

      {canManage ? <EventAdminPanel /> : null}
    </div>
  );
}
