import type { AuthorView, IssueHandledBy } from "@openbrf/shared";

import type { FeedDbClient } from "../feed/feed-audience";
import { readAuthors } from "../feed/feed-author";
import type { Prisma } from "../generated/prisma/client";
import { activeBoardSeatWhere } from "../mail/board-recipients";

/**
 * Who handles the issues of a type, or of one issue, as a filter on persons
 * (handläggare, ADR 0054).
 *
 * The one spelling of the rule, read for every question that turns on it:
 * whether the person asking may read or change an issue, who an issue may be
 * assigned to, whether a type's default assignee still handles it, and - for
 * the mail that follows a report - whom to tell. Each of those asks it of the
 * database inside `IssueService`, never of the request's roles, so the screen,
 * the actions and the jobs that have only a person's identifier all get one
 * answer.
 *
 * `EVERY_HANDLER` is everybody holding `issues:handle`: an administrator, a
 * board member with a seat today, and the property manager. `BOARD` leaves the
 * property manager out. It keeps the administrator in, which ADR 0054 left
 * open (its question 4): an administrator holds `issues:configure`, so one
 * left out of a type the board keeps to itself could open it to every handler
 * and read it anyway, and a rule its subject can lift is no protection.
 *
 * Nothing about an address or an account: this says who handles, not who can be
 * reached. A seat with no address on record still handles, and is assignable.
 *
 * The spec beside this file holds it to `capabilitiesFor` for every combination
 * of roles, as the broker notice's recipients are held to theirs: the filter
 * and the capability are computed in two places, and nothing else keeps them
 * in step.
 *
 * @param now Taken once by the caller, so one request cannot see two boards.
 */
export function issueHandlersWhere(
  handledBy: IssueHandledBy,
  now: Date,
): Prisma.PersonWhereInput {
  return {
    OR: [
      { systemRoles: { some: { role: "ADMIN" as const } } },
      activeBoardSeatWhere(now),
      ...(handledBy === "EVERY_HANDLER"
        ? [{ systemRoles: { some: { role: "PROPERTY_MANAGER" as const } } }]
        : []),
    ],
  };
}

/**
 * Who handles one issue: its type's handlers, narrowed to the board when the
 * issue is closed to everybody else. An issue is tightened past its type and
 * never loosened past it.
 */
export function issueHandledBy(issue: {
  boardOnly: boolean;
  type: { handledBy: IssueHandledBy };
}): IssueHandledBy {
  return issue.boardOnly ? "BOARD" : issue.type.handledBy;
}

/**
 * The issues a reader who is let into types of this scope may handle.
 *
 * `BOARD` is a reader the board-only rule lets in, who handles every issue;
 * `EVERY_HANDLER` is one it does not, who handles the issues neither the type
 * nor the issue itself keeps to the board.
 */
export function issuesHandledWhere(
  readerScope: IssueHandledBy,
): Prisma.IssueWhereInput {
  return readerScope === "BOARD"
    ? {}
    : { boardOnly: false, type: { handledBy: "EVERY_HANDLER" } };
}

/** The types a reader who is let into types of this scope handles. */
export function typesHandledWhere(
  readerScope: IssueHandledBy,
): Prisma.IssueTypeWhereInput {
  return readerScope === "BOARD" ? {} : { handledBy: "EVERY_HANDLER" };
}

/**
 * The people who handle issues of this scope, ordered by name, each as the
 * feed's `AuthorView` - names and nothing else, with a protected handler's
 * withheld (ADR 0056). The read the assignee picker and the type's default
 * assignee are chosen from, so neither reaches the address book, which the
 * property manager never reads (decision 11 of the product decision log).
 */
export async function readIssueHandlers(
  db: FeedDbClient,
  handledBy: IssueHandledBy,
  now: Date,
): Promise<AuthorView[]> {
  const persons = await db.person.findMany({
    where: issueHandlersWhere(handledBy, now),
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  const viewOf = await readAuthors(
    db,
    persons.map((person) => person.id),
  );
  return persons.map((person) => viewOf(person.id));
}

/** Whether this person handles issues of this scope now. */
export async function handlesIssues(
  db: FeedDbClient,
  personId: string,
  handledBy: IssueHandledBy,
  now: Date,
): Promise<boolean> {
  const person = await db.person.findFirst({
    where: { AND: [{ id: personId }, issueHandlersWhere(handledBy, now)] },
    select: { id: true },
  });
  return person !== null;
}
