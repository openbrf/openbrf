import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { OwnBooking } from "../api/bookings";
import { formatBookingDate, formatTimeOfDay } from "./booking-calendar";

/**
 * What period a booking covers, in the terms its resource is booked in.
 *
 * Three modes read three different ways, and rendering all of them as two
 * instants would make the common cases unreadable: a laundry hour is a date and
 * two times, a common room is a date, and a guest apartment is a check-in and a
 * check-out. The stored instants are identical in shape - a start and an end -
 * so it is the mode that decides which of them a reader is shown.
 *
 * Every instant is wrapped in `<time>` with the value the API sent, so what a
 * machine reads is the instant and what a person reads is the association's own
 * clock. The two cannot drift, because the text is formatted from the same
 * value the attribute carries.
 *
 * The end of a booking by the night is the local midnight after the last night,
 * which is exactly the check-out date. Nothing is subtracted to get there.
 */
export function BookingPeriod({
  booking,
}: {
  booking: OwnBooking;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  if (booking.mode === "TIME_SLOTS") {
    return (
      <span className="font-data text-data">
        <time dateTime={booking.startsAt}>
          {formatBookingDate(booking.startsAt, locale)}
        </time>{" "}
        <time dateTime={booking.startsAt}>
          {formatTimeOfDay(booking.startsAt, locale)}
        </time>{" "}
        {t("bookings.until")}{" "}
        <time dateTime={booking.endsAt}>
          {formatTimeOfDay(booking.endsAt, locale)}
        </time>
      </span>
    );
  }

  if (booking.mode === "WHOLE_DAY") {
    return (
      <time dateTime={booking.startsAt} className="font-data text-data">
        {formatBookingDate(booking.startsAt, locale)}
      </time>
    );
  }

  return (
    <span className="font-data text-data">
      <time dateTime={booking.startsAt}>
        {formatBookingDate(booking.startsAt, locale)}
      </time>{" "}
      {t("bookings.until")}{" "}
      <time dateTime={booking.endsAt}>
        {formatBookingDate(booking.endsAt, locale)}
      </time>
    </span>
  );
}
