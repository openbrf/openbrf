const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A Date header for a letter that arrived yesterday.
 *
 * Relative to the real clock rather than a fixed day, because the collector
 * leaves a letter unstored once it is older than the retention window: a fixed
 * date would pass today and have every test that collects with the real clock
 * start skipping its letter two years from now.
 *
 * Yesterday rather than now, so it can never be ahead of the collector's clock
 * and be replaced with the time of reading. `toUTCString` gives the RFC 2822
 * form with "GMT" as the zone, which that standard still accepts.
 */
export function yesterdayDateHeader(now: Date = new Date()): string {
  return new Date(now.getTime() - MILLISECONDS_PER_DAY).toUTCString();
}
