/**
 * When a connection was made, and when it last produced a token.
 *
 * Both values are instants, sent as ISO strings. Cutting one to its first ten
 * characters would give the calendar day in UTC, and the association runs an
 * hour or two ahead of that: an app connected at half past midnight would be
 * shown as the day before, on the screens whose whole job is to say what is
 * connected and since when.
 *
 * The zone is the association's, not the browser's. A board member reading the
 * list from another country is reading about what happened here.
 *
 * The time as well as the day, because both surfaces are read after something
 * has just happened - a member who has connected an app, a board looking at a
 * connection it is about to cut - and the day alone cannot tell two of them
 * apart.
 */
const ZONE = "Europe/Stockholm";

/**
 * The day and the time an instant fell on.
 *
 * An unparseable value is returned as it arrived rather than rendered as an
 * invalid date: what the server sent is at least true, and "Invalid Date" on a
 * row about somebody's connection is worse than an ISO string.
 */
export function formatConnectedAppMoment(iso: string, locale: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime())
    ? iso
    : new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: ZONE,
      }).format(value);
}
