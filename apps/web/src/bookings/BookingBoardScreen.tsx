import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  fetchBoardBookableResources,
  type BookableResourceSummary,
} from "../api/bookings";
import type { Viewer } from "../api/instance";
import { BoardPage } from "../ui/BoardPage";
import { LoadFailure } from "../ui/LoadFailure";
import { BookingBoardPanel } from "./BookingBoardPanel";

export interface BookingBoardScreenProps {
  viewer: Viewer;
}

/** The catalogue as one read leaves it. */
type Catalogue =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "loaded"; resources: readonly BookableResourceSummary[] };

/**
 * "Handle bookings": the whole calendar, who holds which hour and cancelling
 * one on a household's behalf, as a page of its own under /board.
 *
 * The board's alone. A booking says which apartment and which person holds the
 * hour, which no other resident is shown, so the calendar a resident books
 * from stays on the house's page and this one is reached from the board's
 * section (ADR 0049).
 *
 * The catalogue is read from the board's own path, which answers to
 * bookings:manage, and only for the filter: without it the panel reads every
 * resource at once, so a failed catalogue costs the filter and nothing else.
 */
export function BookingBoardScreen({
  viewer,
}: BookingBoardScreenProps): ReactElement {
  const { t } = useTranslation();

  const canManage = viewer.capabilities.includes("bookings:manage");

  const [catalogue, setCatalogue] = useState<Catalogue>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!canManage) {
      return;
    }
    let active = true;
    void fetchBoardBookableResources().then((result) => {
      if (active) {
        setCatalogue(
          result.ok
            ? { kind: "loaded", resources: result.value }
            : { kind: "failed" },
        );
      }
    });
    return () => {
      active = false;
    };
  }, [canManage, attempt]);

  return (
    <BoardPage title={t("bookings.boardTitle")} offered={canManage}>
      {catalogue.kind === "failed" ? (
        <LoadFailure
          messageKey="bookings.loadFailed"
          // The month stays on screen while the catalogue is asked for again:
          // it does not depend on it, and taking it away would lose the month
          // the board was reading.
          onRetry={() => {
            setAttempt((count) => count + 1);
          }}
        />
      ) : null}

      {catalogue.kind === "loading" ? (
        <p role="status" className="text-body text-ink-muted">
          {t("bookings.loading")}
        </p>
      ) : (
        <BookingBoardPanel
          resources={catalogue.kind === "loaded" ? catalogue.resources : []}
        />
      )}
    </BoardPage>
  );
}
