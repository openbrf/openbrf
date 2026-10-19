/**
 * When something happened, as the day and the time it fell on here.
 *
 * The values are instants, sent as ISO strings. Cutting one to its first ten
 * characters would give the calendar day in UTC, and the association runs an
 * hour or two ahead of that: something done at half past midnight would be
 * shown as the day before.
 *
 * The zone is the association's, not the browser's. A board member reading
 * from another country is reading about what happened here.
 *
 * The time as well as the day, because the screens that print one are read
 * after something has just happened - an app connected, a file imported - and
 * the day alone cannot tell two of them apart.
 */

import { ASSOCIATION_TIME_ZONE } from "@openbrf/shared";

/**
 * The day and the time an instant fell on, in the association's zone.
 *
 * An unparseable value is returned as it arrived rather than rendered as an
 * invalid date: what the server sent is at least true, and "Invalid Date" is
 * worse than an ISO string.
 */
export function formatAssociationMoment(iso: string, locale: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime())
    ? iso
    : new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: ASSOCIATION_TIME_ZONE,
      }).format(value);
}
