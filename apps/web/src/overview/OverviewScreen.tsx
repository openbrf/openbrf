import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { fetchViewer } from "../api/instance";
import { isReadOnly } from "../support/read-only";
import { LoadFailure } from "../ui/LoadFailure";
import { offersAnything, overviewPanelsFor } from "./overview-panels";
import { BookingsPanel, EventsPanel, NewsPanel } from "./ResidentPanels";
import { ToHandlePanel } from "./ToHandlePanel";
import { useRead } from "./use-read";
import { WaitingPanel } from "./WaitingPanel";

/**
 * The overview: the page every sign-in lands on.
 *
 * A notice board in the room rather than a dashboard of tiles. What the house
 * is doing and what this person is waiting for are lists of plain rows, and the
 * board's queues are lines with a count beside each.
 *
 * Which panels there are is read from the viewer's capabilities, and whether it
 * is a support session, before anything else is asked for, so no panel calls an
 * endpoint that would refuse this viewer. Until the viewer has answered there are no panels at all, and if it
 * cannot answer the page says so: guessing at a set of panels would either
 * show ones that can only fail or hide ones this person has.
 *
 * The board's queues come first. They are the seat's work, and a board member
 * is a resident as well, so their own matters follow below as everybody's do.
 */
export function OverviewScreen(): ReactElement {
  const { t } = useTranslation();
  const { state, retry } = useRead(fetchViewer);

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-display">{t("overview.title")}</h1>

      {state.kind === "loading" ? (
        <p role="status" className="text-body text-ink-muted">
          {t("app.loading")}
        </p>
      ) : state.kind === "failed" ? (
        <LoadFailure messageKey="overview.loadFailed" onRetry={retry} />
      ) : (
        <Panels
          capabilities={state.value.capabilities}
          isSupportSession={isReadOnly(state.value)}
        />
      )}
    </div>
  );
}

function Panels({
  capabilities,
  isSupportSession,
}: {
  capabilities: readonly string[];
  isSupportSession: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const panels = overviewPanelsFor(capabilities, isSupportSession);

  if (!offersAnything(panels)) {
    return (
      <p className="text-body text-ink-muted">{t("overview.nothingOffered")}</p>
    );
  }

  return (
    <>
      {panels.toHandle.length === 0 ? null : (
        <ToHandlePanel queues={panels.toHandle} />
      )}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        {panels.waiting === null ? null : (
          <WaitingPanel sources={panels.waiting} />
        )}
        {panels.bookings ? <BookingsPanel /> : null}
        {panels.events ? <EventsPanel /> : null}
        {panels.news ? <NewsPanel /> : null}
      </div>
    </>
  );
}
