import { ASSOCIATION_TIME_ZONE } from "@openbrf/shared";

/**
 * The day and the time an instant fell on, on the association's clock.
 *
 * For an instant sent as an ISO string, where the time matters as much as the
 * day: when a support access ends, when a supporter signed in. The zone is the
 * association's rather than the browser's, because a supporter reading it from
 * another country is reading about this instance.
 *
 * An unparseable value is returned as it arrived rather than rendered as an
 * invalid date: what the server sent is at least true.
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
