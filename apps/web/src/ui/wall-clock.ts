/**
 * A datetime-local control's value, and the instant it means.
 *
 * The control holds "2026-09-06T13:00" - the reader's own wall clock, with no
 * seconds and no zone - and the API takes an instant. Parsed here rather than
 * sent as written: the string means one moment to the person reading it and
 * nothing at all to a server in another zone, and this is the one place that
 * knows which of the two is meant.
 */

/** The instant a datetime-local value means, or null for an empty one. */
export function toInstant(wallClock: string): string | null {
  if (wallClock === "") {
    return null;
  }
  const instant = new Date(wallClock);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/**
 * The reverse of {@link toInstant}: an instant as the wall clock a
 * datetime-local control holds, in the reader's own zone.
 */
export function toWallClock(instant: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${String(instant.getFullYear())}-${pad(instant.getMonth() + 1)}-` +
    `${pad(instant.getDate())}T${pad(instant.getHours())}:` +
    `${pad(instant.getMinutes())}`
  );
}
