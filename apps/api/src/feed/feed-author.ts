import type { AuthorView } from "@openbrf/shared";

import type { FeedDbClient } from "./feed-audience";

/**
 * Who wrote something, as the feed may say it.
 *
 * The one mapping from a person reference to what a reader is told about it.
 * Posts, comments, a group's member panel and the board's report queue all
 * attribute a person on exactly these terms, and the news screen's thread does
 * as well under its own published spelling. It was written four times before
 * the feed, and a second spelling of the rule is a second place for a protected
 * name to escape.
 *
 * A person with protected personal data is named to nobody, and a reference
 * that no longer resolves is reported as unknown rather than as an empty name:
 * a post outlives nothing, but the person who wrote it can be erased while the
 * feed still holds their words.
 */

/** The columns a person is read with to be attributed. */
export const AUTHOR_COLUMNS = {
  id: true,
  firstName: true,
  lastName: true,
  protectedPersonalData: true,
} as const;

/** A person as the register holds them, as far as attributing them goes. */
export interface AuthorRow {
  id: string;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
}

/** One person reference, attributed from the row the register still holds. */
export function authorViewOf(
  personId: string,
  person: AuthorRow | undefined,
): AuthorView {
  if (person === undefined) {
    return { kind: "unknown" };
  }
  if (person.protectedPersonalData) {
    return { kind: "protected", personId };
  }
  return {
    kind: "person",
    personId,
    name: `${person.firstName} ${person.lastName}`.trim(),
  };
}

/**
 * Attributes every reference in a page with one read of the register.
 *
 * Answers a function rather than a map, so a caller cannot read a person out of
 * the map and attribute them by hand: the only way to a name is through
 * {@link authorViewOf}. A reference the read did not find is unknown.
 */
export async function readAuthors(
  db: FeedDbClient,
  personIds: Iterable<string | null>,
): Promise<(personId: string) => AuthorView> {
  const ids = [
    ...new Set(
      [...personIds].filter((id): id is string => id !== null && id !== ""),
    ),
  ];
  const persons =
    ids.length === 0
      ? []
      : await db.person.findMany({
          where: { id: { in: ids } },
          select: AUTHOR_COLUMNS,
        });
  const byId = new Map(persons.map((person) => [person.id, person]));
  return (personId) => authorViewOf(personId, byId.get(personId));
}
