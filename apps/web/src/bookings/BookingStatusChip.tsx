import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { BookingStatus } from "../api/bookings";
import type { TranslationKey } from "../i18n/translation-key";

const LABEL: Readonly<Record<BookingStatus, TranslationKey>> = {
  BOOKED: "bookings.status.BOOKED",
  CANCELLED: "bookings.status.CANCELLED",
  RELEASED: "bookings.status.RELEASED",
};

/**
 * Where a booking stands, as a sign.
 *
 * Colour is never the only signal: each state carries its own word as well as
 * its own border, so a reader who cannot tell the tones apart still reads which
 * state this is.
 *
 * A cancelled booking is drawn neutral rather than as a warning. It is not a
 * problem - somebody changed their mind and the hour went back on the calendar
 * - and painting it as one would make a board reading a month of the guest
 * apartment look for something to put right. A released booking is a warning
 * because it is a hour the association took back.
 *
 * None of these is the trust accent, which this interface keeps for positions
 * of trust.
 */
const TONE: Readonly<Record<BookingStatus, string>> = {
  BOOKED: "border-ok bg-ok-soft",
  CANCELLED: "border-line bg-sunken",
  RELEASED: "border-warn bg-warn-soft",
};

export function BookingStatusChip({
  status,
}: {
  status: BookingStatus;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <span
      className={`inline-flex items-center rounded-control border-l-4 px-2 py-1 text-chip text-ink uppercase ${TONE[status]}`}
    >
      {t(LABEL[status])}
    </span>
  );
}
