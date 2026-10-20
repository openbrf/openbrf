import { ASSOCIATION_TIME_ZONE } from "@openbrf/shared";

/**
 * The day and the time an instant fell on, on the association's clock.
 *
 * For an instant sent as an ISO string, where the time matters as much as the
 * day: when an app was connected or last produced a token, when a support
 * access ends, when a supporter signed in. Cutting the string to its first ten
 * characters would give the calendar day in UTC, and the association runs an
 * hour or two ahead of that: something done at half past midnight would be
 * shown as the day before. The time as well as the day, because these are read
 * just after something has happened, and the day alone cannot tell two of them
 * apart.
 *
 * The zone is the association's rather than the browser's, because a board
 * member or a supporter reading it from another country is reading about what
 * happened here.
 *
 * An unparseable value is returned as it arrived rather than rendered as an
 * invalid date: what the server sent is at least true, and "Invalid Date" on a
 * row is worse than an ISO string.
 */
export function formatMoment(iso: string, locale: string): string {
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
