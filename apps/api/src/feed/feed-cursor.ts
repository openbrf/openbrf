/**
 * Where a page of the feed or of a post's comments ends, as one value a reader
 * hands back.
 *
 * Two halves, because the ordering the feed is read in takes two columns to be
 * total and a cursor on an ordering that is not total is a bug waiting for two
 * posts to share an instant. `createdAt` alone is not total: two rows written in
 * the same instant tie, and the page boundary then falls between them in
 * whichever order the database happened to answer, so the same tie either
 * repeats a post on both pages or drops it from both.
 *
 * The identifier breaks it. It is not a time and says nothing about one - a cuid
 * is not ordered by when it was made - and it is not asked to be: all it has to
 * do is make exactly one row the boundary and answer the same way twice.
 *
 * Read in both directions: {@link olderThan} for the page before, and
 * {@link newerThan} for the poll (ADR 0010). The news screen's thread keeps a
 * cursor of its own, because a cursor is the wire format of the endpoints that
 * issue it and that thread's is published.
 */
export interface FeedCursor {
  /** The instant of the row the page ended at. */
  createdAt: Date;
  /** That row's identifier, which breaks a tie on the instant. */
  id: string;
}

/**
 * Separates the two halves of a cursor.
 *
 * A character neither half can contain: an ISO instant is digits and punctuation
 * fixed by the format, and an identifier is a cuid or a UUID.
 */
const CURSOR_SEPARATOR = "|";

/** The cursor for the page ending at this row. */
export function feedCursor(row: { id: string; createdAt: Date }): string {
  return `${row.createdAt.toISOString()}${CURSOR_SEPARATOR}${row.id}`;
}

/**
 * The cursor a reader handed back, or null when it is not one.
 *
 * Null rather than a lenient reading, and the controller turns it into a
 * refusal. A cursor this service cannot make sense of names a place nobody can
 * name, and answering it with the newest page instead would answer a different
 * question: a reader pressing for the posts before the ones on their screen
 * would be handed the ones already there, and a poll would be answered with
 * posts it had shown an hour ago.
 */
export function parseFeedCursor(value: string): FeedCursor | null {
  const halves = value.split(CURSOR_SEPARATOR);
  if (halves.length !== 2) {
    /*
     * Exactly two halves, so a value carrying a second separator is refused
     * rather than read as an identifier containing one. Neither half of a cursor
     * this application issued can hold the separator at all.
     */
    return null;
  }
  const [instant, id] = halves;
  /*
   * Neither half may be empty: a cursor names an instant and a row, and a value
   * with one of them missing names neither. The undefined the compiler allows
   * for an index is unreachable past the length check above.
   */
  if (
    instant === undefined ||
    id === undefined ||
    instant === "" ||
    id === ""
  ) {
    return null;
  }

  const createdAt = new Date(instant);
  /*
   * Round-tripped rather than merely parsed. `new Date` accepts more than one
   * spelling of a moment and reads some strings that are not one at all, so an
   * instant that does not come back out exactly as it went in is refused - a
   * cursor is compared against a stored column and has to mean one moment.
   */
  if (
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== instant
  ) {
    return null;
  }

  return { createdAt, id };
}

/**
 * Everything strictly before one point.
 *
 * The comparison the ordering implies, written out rather than handed to the
 * query builder's own cursor option. That one names a row: it reads the boundary
 * values back out of the row the cursor points at, and a post can be purged out
 * from under a reader between one page and the next, because it is erased on its
 * own clock a year at a time. A cursor whose row has gone matches nothing at all
 * - a page silently empty, which is the failure paging exists to remove rather
 * than to introduce somewhere new. These comparisons are against the two values
 * the reader was handed, so the row they were read from no longer has to be
 * there.
 */
export function olderThan(cursor: FeedCursor) {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

/**
 * Everything strictly after one point.
 *
 * The mirror of {@link olderThan}, and the whole of what a poll asks. It
 * survives a purged row for the same reason, which matters more here than on a
 * page: a screen left open overnight polls with a cursor whose post the purge
 * may have reached.
 */
export function newerThan(cursor: FeedCursor) {
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  };
}
