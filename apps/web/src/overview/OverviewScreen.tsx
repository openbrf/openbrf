import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { fetchViewer } from "../api/instance";
import { LoadFailure } from "../ui/LoadFailure";
import { BoardLine } from "./BoardLine";
import { offersAnything, overviewPanelsFor } from "./overview-panels";
import { BookingsPanel, EventsPanel, NewsPanel } from "./ResidentPanels";
import { useRead } from "./use-read";
import { WaitingPanel } from "./WaitingPanel";

/**
 * The overview: the page every sign-in lands on.
 *
 * A notice board in the room rather than a dashboard of tiles. What the house
 * is doing and what this person is waiting for are lists of plain rows.
 *
 * Which panels there are is read from the viewer's capabilities before anything
 * else is asked for, so no panel calls an endpoint that would refuse this
 * account. Until the viewer has answered there are no panels at all, and if it
 * cannot answer the page says so: guessing at a set of panels would either
 * show ones that can only fail or hide ones this person has.
 *
 * The house's page, as every other page is one audience's (ADR 0044). The
 * board's queues are on the board's front page; whoever works one gets a
 * single line above the panels saying how much is waiting there, with the way
 * to it.
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
        <Panels capabilities={state.value.capabilities} />
      )}
    </div>
  );
}

function Panels({
  capabilities,
}: {
  capabilities: readonly string[];
}): ReactElement {
  const { t } = useTranslation();
  const panels = overviewPanelsFor(capabilities);

  if (!offersAnything(panels)) {
    return (
      <p className="text-body text-ink-muted">{t("overview.nothingOffered")}</p>
    );
  }

  return (
    <>
      {panels.toHandle.length === 0 ? null : (
        <BoardLine capabilities={capabilities} queues={panels.toHandle} />
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
