/**
 * When something in the mailbox happened, written the way the reader writes it.
 *
 * Both values the screens print are instants, sent as ISO strings. Cutting one
 * to its first ten characters gives the calendar day in UTC, and the association
 * runs an hour or two ahead of that: a letter that arrived at half past midnight
 * would be shown as the day before, on the screen whose whole job is to say what
 * is waiting and since when. The cut also fixes the order the parts are written
 * in, which is the reader's own and not this file's to choose.
 *
 * The zone is the association's, not the browser's. A board reading its mailbox
 * from another country is reading about letters that arrived here.
 */
const ZONE = "Europe/Stockholm";

function instant(iso: string): Date | null {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? null : value;
}

/** The calendar day, for a row in the inbox. */
export function formatMailboxDay(iso: string, locale: string): string {
  const value = instant(iso);
  return value === null
    ? iso
    : new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: ZONE,
      }).format(value);
}

/**
 * The day and the time, for a message inside a thread.
 *
 * The time as well, because a thread is read in order and two messages on one
 * day is an ordinary morning: the date alone would leave the reader unable to
 * see which of them came first.
 */
export function formatMailboxMoment(iso: string, locale: string): string {
  const value = instant(iso);
  return value === null
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
