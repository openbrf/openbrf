import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type BookableResourceSummary,
  type BookingApartment,
  fetchBookableResources,
  fetchBookingApartments,
  fetchOwnBookings,
  type OwnBooking,
} from "../api/bookings";
import type { Viewer } from "../api/instance";
import { LoadFailure } from "../ui/LoadFailure";
import { BookSlotPanel } from "./BookSlotPanel";
import { OwnBookingsPanel } from "./OwnBookingsPanel";

export interface BookingsScreenProps {
  viewer: Viewer;
}

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  resources: readonly BookableResourceSummary[];
  apartments: readonly BookingApartment[];
  own: readonly OwnBooking[];
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  resources: [],
  apartments: [],
  own: [],
  loadFailed: false,
};

/**
 * Booking what the house offers, and reading what one holds.
 *
 * The house's page, for whoever lives here and holds bookings:book: the
 * calendar of free and not free, the form, and what they hold. Who holds which
 * hour is the board's page at /board/bookings (ADR 0049). The external property
 * manager holds neither: they handle the association's issues and do not live
 * in the building, so a laundry hour is not theirs to take or to give away.
 *
 * Hiding a panel is courtesy only. The API refuses every call either way, the
 * apartments a form offers are filtered by the server, and a slot the resident
 * calendar draws as taken carries no identity for a screen to leak.
 *
 * ## Which read lives where
 *
 * The screen owns the reads its panels share - the catalogue, the caller's own
 * apartments, and what the caller holds - so a cancellation in one panel
 * refreshes the other. The read that is one panel's own stays there: the slots
 * for the resource and window it is showing, which nothing else on the screen
 * needs.
 */
export function BookingsScreen({ viewer }: BookingsScreenProps): ReactElement {
  const { t } = useTranslation();

  const canBook = viewer.capabilities.includes("bookings:book");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const currentRead = useRef(0);

  const read = useCallback(async (): Promise<Loaded> => {
    const [resources, apartments, own] = await Promise.all([
      canBook ? fetchBookableResources() : null,
      canBook ? fetchBookingApartments() : null,
      canBook ? fetchOwnBookings() : null,
    ]);

    return {
      ready: true,
      resources: resources?.ok === true ? resources.value : [],
      apartments: apartments?.ok === true ? apartments.value : [],
      own: own?.ok === true ? own.value : [],
      loadFailed:
        resources?.ok === false ||
        apartments?.ok === false ||
        own?.ok === false,
    };
  }, [canBook]);

  /**
   * Reads, and applies the answer only while it is still the newest one.
   *
   * One rule for the first read and every re-read, on the precedent
   * `MotionsScreen` sets. It matters more now than it did: the failure
   * notice offers a retry, so two reads in flight is somebody pressing a button
   * twice rather than a race nobody could reach, and an older failure landing after a
   * newer success would put the screen back into the state the reader had just
   * got out of.
   */
  const reload = useCallback((): void => {
    const version = ++currentRead.current;
    void read().then((next) => {
      if (version === currentRead.current) {
        setLoaded(next);
      }
    });
  }, [read]);

  useEffect(() => {
    reload();
    /*
     * Leaving supersedes whatever is in flight, so a response that arrives
     * after the screen is gone is dropped by the same check that drops a
     * superseded one. One rule for both.
     */
    return () => {
      currentRead.current += 1;
    };
  }, [reload]);

  const { ready, resources, apartments, own, loadFailed } = loaded;

  const [cancellations, setCancellations] = useState(0);
  const cancelled = useCallback((): void => {
    setCancellations((count) => count + 1);
    reload();
  }, [reload]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("bookings.title")}</h1>
        <p className="text-body text-ink-muted">{t("bookings.intro")}</p>
      </header>

      {loadFailed ? (
        <LoadFailure messageKey="bookings.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("bookings.loading")}
        </p>
      )}

      {ready && canBook ? (
        <>
          <BookSlotPanel
            resources={resources}
            apartments={apartments}
            onBooked={reload}
            cancellations={cancellations}
          />
          <OwnBookingsPanel bookings={own} onCancelled={cancelled} />
        </>
      ) : null}
    </div>
  );
}
