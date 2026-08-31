import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type BookableResourceSummary,
  type BookingBooker,
  cancelBookingForBoard,
  fetchManagedBookings,
  type ManagedBooking,
} from "../api/bookings";
import type { ApiFailure } from "../api/client";
import { FIELD, LABEL, QUIET_BUTTON } from "../ui/controls";
import { NotRecorded } from "../ui/NotRecorded";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import {
  formatDayWithWeekday,
  localDayNow,
  shiftLocalDay,
} from "./booking-calendar";
import { bookingFailureKey } from "./booking-failures";
import { BookingPeriod } from "./BookingPeriod";
import { BookingStatusChip } from "./BookingStatusChip";

/**
 * How many days the board reads at once.
 *
 * Four weeks, which is the span a board is asked about: who has the guest
 * apartment next month, and who had the laundry room the week somebody is
 * complaining about. Well inside the 62 days one request may ask for.
 */
const WINDOW_DAYS = 28;

export interface BookingBoardPanelProps {
  /**
   * The resources the filter offers, or none.
   *
   * Passed in rather than read here so the screen owns one read of the
   * catalogue. An empty list is not an error: the filter is simply absent and
   * the board reads every resource at once, which is what the endpoint answers
   * with when no resource is named. A resource the board has withdrawn is not
   * on this list either, and the bookings standing against it are still in the
   * unfiltered answer - which is the half that matters, because a withdrawn
   * sauna's bookings are exactly the ones a board goes looking for.
   */
  resources: readonly BookableResourceSummary[];
  /** Called after a cancellation, so the caller can reload its own lists. */
  onChanged: () => void;
}

/** Everything one read produces, applied in one step. */
interface Loaded {
  /**
   * Which request this answer belongs to: the filter and the window.
   *
   * Carried so the panel can tell an answer about what is on screen from one
   * about the month that was on screen a moment ago. Staleness is read during
   * the render rather than cleared by a second state write before the read
   * starts, which would put the list through a render nobody needs.
   */
  key: string;
  bookings: readonly ManagedBooking[];
  failure: ApiFailure | null;
}

/**
 * The board's view of the calendar: who holds what, and cancelling it.
 *
 * This is the half the capability exists for. A booking says which apartment
 * and which person holds which hour, which is personal data no other resident
 * is shown, so everything on this panel is behind bookings:manage and nothing
 * on it is reachable from the resident calendar above.
 *
 * Cancelled bookings are in the list rather than filtered out. A board reading
 * this is often reading it because somebody says they cancelled something, and
 * a list that hid cancellations could not answer that. They carry no cancel
 * button, because there is nothing left to cancel.
 *
 * A booker with protected personal data is rendered without their name. The
 * board's own address book prints it because a statutory register has to; a
 * booking calendar has no such reason, and the server does not send it either.
 */
export function BookingBoardPanel({
  resources,
  onChanged,
}: BookingBoardPanelProps): ReactElement {
  const { t, i18n } = useTranslation();
  const [resourceId, setResourceId] = useState("");
  const [from, setFrom] = useState(() => localDayNow());
  const [answer, setAnswer] = useState<Loaded | null>(null);
  /**
   * Bumped to ask for the month again without changing which month is asked for.
   *
   * A cancellation needs a fresh read of the same request, which is one the
   * reading effect cannot tell from the read it already made. This is how it is
   * told, and it keeps that effect the only thing that reads.
   */
  const [refreshes, setRefreshes] = useState(0);
  /**
   * Which row the cancellation in flight belongs to.
   *
   * One action serves the whole list, so without this every row reads the same
   * save state and one click puts "cancelling" on every booking in the month.
   */
  const [cancelling, setCancelling] = useState<string | null>(null);

  const to = shiftLocalDay(from, WINDOW_DAYS - 1);
  const key = `${resourceId}|${from}|${to}`;

  const read = useCallback(async (): Promise<Loaded> => {
    const result = await fetchManagedBookings({
      ...(resourceId === "" ? {} : { resourceId }),
      window: { from, to },
    });
    return result.ok
      ? { key, bookings: result.value, failure: null }
      : { key, bookings: [], failure: result.failure };
  }, [key, resourceId, from, to]);

  useEffect(() => {
    /*
     * Every read the panel makes is this one, including the one a cancellation
     * asks for - which is what `refreshes` is for. A cancellation that read for
     * itself would be reading whichever month and resource were on screen when
     * it was sent, and applying that unguarded after the reader has moved on
     * replaces the month being looked at with the one that was. The render
     * below shows nothing while the answer describes another request, so the
     * panel would sit loading with no read left in flight to end it. One owner
     * means the cleanup here covers a late answer whatever asked for it.
     */
    let active = true;
    void read().then((next) => {
      if (active) {
        setAnswer(next);
      }
    });
    return () => {
      active = false;
    };
  }, [read, refreshes]);

  const cancel = useSaveAction(cancelBookingForBoard, () => {
    // Asks the effect for a fresh read rather than taking one, so the answer
    // belongs to whatever is on screen when it lands.
    setRefreshes((count) => count + 1);
    onChanged();
  });

  const busy = cancel.state.kind === "saving";
  // The answer to the request on screen, or nothing while it is in flight.
  const loaded = answer?.key === key ? answer : null;
  const failure =
    cancel.state.kind === "failed"
      ? cancel.state.failure
      : (loaded?.failure ?? null);

  return (
    <Panel
      title={t("bookings.board.title")}
      description={t("bookings.board.description")}
      notice={
        failure !== null ? (
          <Notice tone="danger" live>
            {t(bookingFailureKey(failure))}
          </Notice>
        ) : cancel.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("bookings.board.cancelled")}
          </Notice>
        ) : null
      }
    >
      {resources.length === 0 ? null : (
        <label className={`${LABEL} sm:max-w-80`}>
          {t("bookings.board.resource")}
          <select
            name="boardBookingResource"
            value={resourceId}
            onChange={(event) => {
              setResourceId(event.target.value);
            }}
            className={FIELD}
          >
            <option value="">{t("bookings.board.allResources")}</option>
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <nav className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={QUIET_BUTTON}
          onClick={() => {
            setFrom((current) => shiftLocalDay(current, -WINDOW_DAYS));
          }}
        >
          {t("bookings.board.earlier")}
        </button>
        <span className="text-small text-ink-muted">
          <time dateTime={from}>
            {formatDayWithWeekday(from, i18n.language)}
          </time>{" "}
          {t("bookings.until")}{" "}
          <time dateTime={to}>{formatDayWithWeekday(to, i18n.language)}</time>
        </span>
        <button
          type="button"
          className={`${QUIET_BUTTON} ml-auto`}
          onClick={() => {
            setFrom((current) => shiftLocalDay(current, WINDOW_DAYS));
          }}
        >
          {t("bookings.board.later")}
        </button>
      </nav>

      {loaded === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("bookings.board.loading")}
        </p>
      ) : loaded.bookings.length === 0 ? (
        <p className="text-body text-ink-muted">{t("bookings.board.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {loaded.bookings.map((booking) => (
            <li
              key={booking.id}
              className="flex flex-col gap-2 rounded-control border border-line bg-page px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-body font-semibold">
                  {booking.resourceName}
                </span>
                <BookingStatusChip status={booking.status} />
                <BookingPeriod booking={booking} />
              </div>

              <p className="flex flex-wrap gap-4 text-small text-ink-muted">
                <span>
                  {t("bookings.board.bookedBy")}{" "}
                  <Booker booker={booking.bookedBy} />
                </span>
                <span>
                  {t("bookings.mine.apartment")}{" "}
                  {booking.apartment === null ? (
                    <NotRecorded meaning={t("bookings.mine.noApartment")} />
                  ) : (
                    <span className="font-data text-data">
                      {booking.apartment.address} {booking.apartment.number}
                    </span>
                  )}
                </span>
              </p>

              {/* Offered only while there is something to cancel. A cancelled
                  booking has already given its hour back, and a button that
                  always refused would be a worse way to say so. */}
              {booking.status === "BOOKED" ? (
                <div>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={t("bookings.board.cancelNamed", {
                      resource: booking.resourceName,
                    })}
                    onClick={() => {
                      setCancelling(booking.id);
                      void cancel.submit(booking.id);
                    }}
                    className={QUIET_BUTTON}
                  >
                    {busy && cancelling === booking.id
                      ? t("bookings.board.cancelling")
                      : t("bookings.board.cancel")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Who booked it, in the three shapes the server can answer with. */
function Booker({ booker }: { booker: BookingBooker }): ReactElement {
  const { t } = useTranslation();

  if (booker.kind === "resident") {
    return <span>{booker.name}</span>;
  }
  if (booker.kind === "protected") {
    return <span>{t("bookings.board.bookerProtected")}</span>;
  }
  return <span>{t("bookings.board.bookerUnknown")}</span>;
}
