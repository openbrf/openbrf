import { useCallback, useEffect, useState, type ReactElement } from "react";
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
import { Notice } from "../ui/Notice";
import { BookingBoardPanel } from "./BookingBoardPanel";
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
 * Booking what the house offers, and - for the board - the whole calendar.
 *
 * What a viewer sees follows from their capabilities, and the two halves are
 * independent. A resident holds bookings:book and gets the calendar of free and
 * not free, the form, and what they hold. A board member additionally holds
 * bookings:manage and gets the half that says who holds which hour and can
 * cancel it. The external property manager holds neither: they handle the
 * association's issues and do not live in the building, so a laundry hour is
 * not theirs to take or to give away.
 *
 * The booking half comes first, because for everybody who reaches this screen
 * it is the act: nobody holds bookings:manage without bookings:book, and a
 * board member reading their own laundry week is a resident doing so.
 *
 * Hiding a panel is courtesy only. The API refuses every call either way, the
 * apartments a form offers are filtered by the server, and a slot the resident
 * calendar draws as taken carries no identity for a screen to leak.
 *
 * ## Which read lives where
 *
 * The screen owns the reads its panels share - the catalogue, the caller's own
 * apartments, and what the caller holds - so a booking made in one panel
 * refreshes the other. The two reads that are one panel's own stay there: the
 * slots for the resource and window it is showing, and the board's month with
 * its own filter, neither of which anything else on the screen needs.
 */
export function BookingsScreen({ viewer }: BookingsScreenProps): ReactElement {
  const { t } = useTranslation();

  const canBook = viewer.capabilities.includes("bookings:book");
  const canManage = viewer.capabilities.includes("bookings:manage");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);

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

  useEffect(() => {
    // The effect owns its own call and drops a response that arrives after the
    // screen is gone, rather than applying it to a component nobody is looking
    // at.
    let active = true;
    void read().then((next) => {
      if (active) {
        setLoaded(next);
      }
    });
    return () => {
      active = false;
    };
  }, [read]);

  const reload = (): void => {
    void read().then(setLoaded);
  };

  const { ready, resources, apartments, own, loadFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("bookings.title")}</h1>
        <p className="text-body text-ink-muted">{t("bookings.intro")}</p>
      </header>

      {loadFailed ? (
        <Notice tone="danger" live>
          {t("bookings.loadFailed")}
        </Notice>
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
          />
          <OwnBookingsPanel bookings={own} onCancelled={reload} />
        </>
      ) : null}

      {ready && canManage ? (
        <BookingBoardPanel resources={resources} onChanged={reload} />
      ) : null}
    </div>
  );
}
