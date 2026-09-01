import type { MailTemplateContext } from "../mail-template";

/**
 * How a bookable resource is booked, as the two booking mails carry it.
 *
 * Written out here rather than imported from the generated Prisma enums,
 * because the templates directory is the shared correspondence layer and has no
 * business depending on the schema. The call sites assign the enum to it, so a
 * mode added to the schema and not answered below is a compile error rather
 * than a period sentence that silently falls through to the wrong shape.
 */
export type BookingMailMode = "TIME_SLOTS" | "WHOLE_DAY" | "DATE_RANGE";

/** The booked period as the two booking mails carry it. */
export interface BookingMailPeriod {
  mode: BookingMailMode;
  startsAt: Date;
  /**
   * For a resource booked by the night, the local midnight after the last
   * night - which is exactly the check-out date. Nothing is subtracted to get
   * there.
   */
  endsAt: Date;
}

/**
 * The period a booking covers, in the terms its resource is booked in.
 *
 * Three modes read three different ways, and stating all of them as two
 * instants would make the common cases unreadable: a laundry hour is a date and
 * two times, a common room is a date, and a guest apartment is a check-in and a
 * check-out. The stored instants are identical in shape, so it is the mode that
 * decides which of them the recipient is shown - the same split the screen
 * makes, so the mail and the calendar say the same thing about one booking.
 *
 * The sentences are locale keys rather than a joined string because the two
 * languages join them differently: Swedish writes a time of day after "kl." and
 * separates the pair with a dash, and names the two ends of a stay arrival and
 * departure.
 */
export function bookingPeriodText(
  period: BookingMailPeriod,
  context: MailTemplateContext,
): string {
  const { t, formatDate, formatTime } = context;

  switch (period.mode) {
    case "TIME_SLOTS":
      return t("email.booking.periodSlot", {
        date: formatDate(period.startsAt),
        from: formatTime(period.startsAt),
        to: formatTime(period.endsAt),
      });

    case "WHOLE_DAY":
      // The date alone, and no key: a whole day is one date, and a sentence
      // wrapped around it would say nothing the date does not.
      return formatDate(period.startsAt);

    case "DATE_RANGE":
      return t("email.booking.periodStay", {
        from: formatDate(period.startsAt),
        to: formatDate(period.endsAt),
      });
  }
}
