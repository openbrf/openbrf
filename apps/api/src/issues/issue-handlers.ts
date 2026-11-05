import type { AuthorView, IssueHandledBy } from "@openbrf/shared";

import type { FeedDbClient } from "../feed/feed-audience";
import { readAuthors } from "../feed/feed-author";
import type { Prisma } from "../generated/prisma/client";
import { activeBoardSeatWhere } from "../mail/board-recipients";
import { IssueError } from "./issue.error";

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
 * property manager out and keeps the administrator in, seat or not, as the
 * owner decided (ADR 0054, question 4): an administrator holds
 * `issues:configure`, so one left out of a type the board keeps to itself
 * could open it to every handler and read it anyway, and a rule its subject
 * can lift is no protection.
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
 * The handlers of a scope whom a mail about an issue may go to: those of
 * {@link issueHandlersWhere} with an address on record and whose processing is
 * not restricted.
 *
 * The rule and nothing beside it, as `activeBoardRecipientsWhere` is the seat
 * with an address added: a handler with no address still handles and is still
 * assignable, and is simply not somebody this channel reaches. A person whose
 * processing is restricted (GDPR art. 18) still handles too, but is mailed
 * nothing: art. 18(2) permits storing what is known of them and little else,
 * and sending is a use.
 */
export function issueRecipientsWhere(
  handledBy: IssueHandledBy,
  now: Date,
): Prisma.PersonWhereInput {
  return {
    AND: [
      issueHandlersWhere(handledBy, now),
      { emailCipher: { not: null }, processingRestrictedAt: null },
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

/**
 * Whether a reader who is let into types of this scope handles this issue: the
 * same rule as {@link issuesHandledWhere}, asked of a row already read.
 */
export function scopeHandlesIssue(
  readerScope: IssueHandledBy,
  issue: { boardOnly: boolean; type: { handledBy: IssueHandledBy } },
): boolean {
  return readerScope === "BOARD" || issueHandledBy(issue) === "EVERY_HANDLER";
}

/**
 * The scope of issues this person handles: `BOARD` when the board-only rule
 * lets them in, `EVERY_HANDLER` otherwise.
 *
 * Asked of the database, never of the request's roles, so a read on the
 * screen, through an action, from the feed or the media route, and a write
 * inside a transaction all get one answer. Says nothing about whether the
 * person handles issues at all: the caller has asked that of `issues:handle`
 * first, and a person in neither scope answers `EVERY_HANDLER`, the narrower.
 */
export async function issueReaderScope(
  db: FeedDbClient,
  personId: string,
  now: Date,
): Promise<IssueHandledBy> {
  return (await handlesIssues(db, personId, "BOARD", now))
    ? "BOARD"
    : "EVERY_HANDLER";
}

/**
 * An issue this person handles, read with the caller's select, or the refusal
 * that answers an issue that does not exist: one the reader may not open is
 * not one they may learn of.
 *
 * The one read a handler's act on a single issue starts from, in
 * `IssueService`, `IssueConversationService` and `IssueFitService` alike, so
 * the rule of who may open an issue is spelled once.
 */
export async function requireHandledIssue<S extends Prisma.IssueSelect>(
  db: FeedDbClient,
  issueId: string,
  readerPersonId: string,
  select: S,
  now: Date = new Date(),
): Promise<Prisma.IssueGetPayload<{ select: S }>> {
  const scope = await issueReaderScope(db, readerPersonId, now);
  const issue = await db.issue.findFirst({
    where: { id: issueId, ...issuesHandledWhere(scope) },
    select,
  });
  if (issue === null) {
    throw new IssueError("No such issue.", "issue-not-found");
  }
  return issue;
}

/** The types a reader who is let into types of this scope handles. */
export function typesHandledWhere(
  readerScope: IssueHandledBy,
): Prisma.IssueTypeWhereInput {
  return readerScope === "BOARD" ? {} : { handledBy: "EVERY_HANDLER" };
}

/**
 * The people who handle issues of this scope, each as the feed's `AuthorView`
 * - names and nothing else, with a protected handler's withheld (ADR 0056).
 * The read the assignee picker and the type's default assignee are chosen
 * from, so neither reaches the address book, which the property manager never
 * reads (decision 11 of the product decision log).
 *
 * The named handlers come first, by name. A protected handler comes after
 * them, in the order of their identifiers, which say nothing: left among the
 * others, their place in an alphabetical list would hint at the name the
 * entry withholds. The resident picker orders a protected resident the same
 * way.
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
  const named: AuthorView[] = [];
  const shielded: { personId: string; view: AuthorView }[] = [];
  for (const { id } of persons) {
    const view = viewOf(id);
    if (view.kind === "person") {
      named.push(view);
    } else {
      // Protected, or erased between the two reads: either way unnamed, so
      // placed by identifier rather than by the name the first read sorted on.
      shielded.push({ personId: id, view });
    }
  }
  shielded.sort((a, b) =>
    a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0,
  );
  return [...named, ...shielded.map((entry) => entry.view)];
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
