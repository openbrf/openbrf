import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { cancelOwnBooking, type OwnBooking } from "../api/bookings";
import { QUIET_BUTTON } from "../ui/controls";
import { NotRecorded } from "../ui/NotRecorded";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { BookingPeriod } from "./BookingPeriod";
import { bookingFailureKey } from "./booking-failures";

export interface OwnBookingsPanelProps {
  bookings: readonly OwnBooking[];
  /** Called after a cancellation, so the caller can reload the calendar too. */
  onCancelled: () => void;
}

/**
 * What this account holds, and giving it back.
 *
 * The list the API answers with is live and unfinished bookings only, which is
 * what a resident acts on: a cancelled booking has already given its slot back
 * and a finished one is history. The whole history of what somebody booked is
 * in their access report, where it belongs, rather than on a screen that would
 * grow for ever.
 *
 * These are the caller's own and deliberately not the household's. A partner's
 * booking is theirs to cancel, and this is where each person sees what they
 * hold - so cancelling here can never be somebody cancelling for somebody else
 * without the log recording that it was.
 */
export function OwnBookingsPanel({
  bookings,
  onCancelled,
}: OwnBookingsPanelProps): ReactElement {
  const { t } = useTranslation();
  const cancel = useSaveAction(cancelOwnBooking, onCancelled);
  /**
   * Which row the cancellation in flight belongs to.
   *
   * One action serves the whole list, so without this every row reads the same
   * save state and one click puts "cancelling" on every booking.
   */
  const [cancelling, setCancelling] = useState<string | null>(null);
  const busy = cancel.state.kind === "saving";

  return (
    <Panel
      title={t("bookings.mine.title")}
      description={t("bookings.mine.description")}
      notice={
        cancel.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(bookingFailureKey(cancel.state.failure))}
          </Notice>
        ) : cancel.state.kind === "saved" ? (
          <Notice tone="ok" live>
            {t("bookings.mine.cancelled")}
          </Notice>
        ) : null
      }
    >
      {bookings.length === 0 ? (
        <p className="text-body text-ink-muted">{t("bookings.mine.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {bookings.map((booking) => (
            <li
              key={booking.id}
              className="flex flex-wrap items-center gap-3 rounded-control border border-line bg-page px-3 py-3"
            >
              <span className="text-body font-semibold">
                {booking.resourceName}
              </span>
              <BookingPeriod booking={booking} />
              <span className="text-small text-ink-muted">
                {t("bookings.mine.apartment")}{" "}
                {booking.apartment === null ? (
                  <NotRecorded meaning={t("bookings.mine.noApartment")} />
                ) : (
                  <span className="font-data text-data">
                    {booking.apartment.address} {booking.apartment.number}
                  </span>
                )}
              </span>

              <button
                type="button"
                disabled={busy}
                // The name carries the resource, because every row on this list
                // offers the same act and "cancel" on its own does not say
                // which booking is about to go.
                aria-label={t("bookings.mine.cancelNamed", {
                  resource: booking.resourceName,
                })}
                onClick={() => {
                  setCancelling(booking.id);
                  void cancel.submit(booking.id);
                }}
                className={`${QUIET_BUTTON} ml-auto`}
              >
                {busy && cancelling === booking.id
                  ? t("bookings.mine.cancelling")
                  : t("bookings.mine.cancel")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
