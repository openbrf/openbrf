import { localDayOf } from "@openbrf/shared";

import type { Prisma } from "../generated/prisma/client";
import type { AudienceKind } from "../generated/prisma/enums";
import { activeBoardSeatWhere, holdsBoardSeat } from "../mail/board-recipients";
import { residencyHeldOn } from "../registers/held-on";
import { FeedError } from "./feed.error";

import type { PrismaService } from "../database/prisma.service";

/**
 * Who is in which audience, asked of the register rather than of a flag.
 *
 * One file because every path in the feed asks the same question and the answer
 * is the security boundary. Listing a person's audiences, reading a post by its
 * identifier, searching, commenting, liking, reporting, putting somebody into a
 * group: each asks here, and a second spelling of any of it is a way for two of
 * them to disagree about who is in a group (ADR 0026).
 *
 * ## The four kinds, and why only one of them is a list
 *
 * Alla is everybody who lives here and everybody holding a board seat that has
 * not ended. Styrelsen is whoever holds a seat today. Administratörer is whoever
 * holds the administrator system role, and the board. All three are derived: a
 * person joins on the day their residency, term or grant begins and leaves on
 * the day it ends, and nobody administers a list.
 *
 * A group's members are written down, because there is no election to derive
 * them from - but the writing down is only half of the test. The other half is a
 * residency held today, so a place in a group ends the day somebody moves out,
 * exactly as a booking allowance bites on the day it says. What they wrote stays
 * where it is, attributed as before, and goes on the retention clock it was
 * always on.
 *
 * ## One refusal for two cases
 *
 * Every function here answers "not in it" and "there is no such thing" with the
 * same value, and the callers turn both into one refusal. Distinguishing them
 * would let anybody holding `chat:participate` walk the identifier space and
 * learn what groups the house has made and what is said in them - which is the
 * whole of what makes a group invisible to somebody who is not in it
 * (ADR 0012).
 */

/**
 * A client that can answer these questions.
 *
 * The transaction client as well as the service, so a caller that has to decide
 * membership inside the transaction it is going to write in can do it there
 * rather than before it.
 */
export type FeedDbClient = PrismaService | Prisma.TransactionClient;

/** An audience, as the membership question answers it. */
export interface AudienceRow {
  id: string;
  kind: AudienceKind;
  name: string | null;
  createdByPersonId: string | null;
}

/** The columns an audience is read with, wherever one is read. */
export const AUDIENCE_COLUMNS = {
  id: true,
  kind: true,
  name: true,
  createdByPersonId: true,
} as const;

/**
 * Whether this person lives here, which is what Alla and a place in a group rest
 * on.
 *
 * Asked of the residencies rather than of the member register: the feed is for
 * the people in the building, and a partner or an adult child living in one of
 * its apartments is as much a neighbour as the member is.
 *
 * The predicate `PrincipalService.forPerson` derives `isResident` from, asked of
 * the register here rather than read off the principal - for the reason the seat
 * is asked for rather than read off `isBoardMember`: this is the membership of an
 * audience, and a boundary that trusted a flag computed somewhere else would be a
 * boundary that moved the day that flag was cached.
 */
export async function livesHere(
  db: FeedDbClient,
  personId: string,
  now: Date,
): Promise<boolean> {
  const residency = await db.residency.findFirst({
    where: { personId, ...residencyHeldOn(localDayOf(now)) },
    select: { id: true },
  });
  return residency !== null;
}

/**
 * Whether this person holds the administrator system role: the grant, asked of
 * the register, for the reason {@link livesHere} asks for the residency.
 */
export async function isAdministrator(
  db: FeedDbClient,
  personId: string,
): Promise<boolean> {
  const role = await db.systemRole.findUnique({
    where: { personId_role: { personId, role: "ADMIN" } },
    select: { id: true },
  });
  return role !== null;
}

/**
 * Whether this person is in this audience today.
 *
 * The whole of the answer for every kind, in one place. The board is in Alla
 * because it answers for what is written there and because what it posts as
 * Styrelsen goes there, and in Administratörer for the same two reasons. The
 * administrator, who holds every capability, no seat and no residency, is in
 * Administratörer alone: the one audience written to them.
 */
export async function isInAudience(
  db: FeedDbClient,
  audience: { id: string; kind: AudienceKind },
  personId: string,
  now: Date,
): Promise<boolean> {
  switch (audience.kind) {
    case "ALL":
      return (
        (await livesHere(db, personId, now)) ||
        holdsBoardSeat(db, personId, now)
      );
    case "BOARD":
      return holdsBoardSeat(db, personId, now);
    case "GROUP":
      return isGroupMember(db, audience.id, personId, now);
    case "ADMIN":
      return (
        (await isAdministrator(db, personId)) ||
        holdsBoardSeat(db, personId, now)
      );
  }
}

/**
 * Who is in a derived audience today, as a filter on people rather than a
 * question about one: what a mailing to the audience is addressed from.
 *
 * {@link isInAudience} for everybody at once, and written beside it so the two
 * cannot disagree about who is in Styrelsen or Administratörer. Alla is not
 * here: a mailing to the house goes to the members (`recipientsWhere` in the
 * news module), which is the narrower question the association has always
 * mailed by.
 */
export function audienceMembersWhere(
  kind: "BOARD" | "ADMIN",
  now: Date,
): Prisma.PersonWhereInput {
  return kind === "BOARD"
    ? activeBoardSeatWhere(now)
    : {
        OR: [
          { systemRoles: { some: { role: "ADMIN" } } },
          activeBoardSeatWhere(now),
        ],
      };
}

/**
 * The audience this person is in, or null.
 *
 * Null for an audience that does not exist and one this person is not in. One
 * value, so a caller cannot accidentally tell them apart and neither can a
 * caller probing identifiers.
 */
export async function audienceFor(
  db: FeedDbClient,
  audienceId: string,
  personId: string,
  now: Date,
): Promise<AudienceRow | null> {
  const audience = await db.audience.findUnique({
    where: { id: audienceId },
    select: AUDIENCE_COLUMNS,
  });
  if (audience === null) {
    return null;
  }
  return (await isInAudience(db, audience, personId, now)) ? audience : null;
}

/**
 * Every audience this person is in: Alla, then Styrelsen, then Administratörer,
 * then their groups in the order they were put into them.
 *
 * Alla first because it is the house, and Styrelsen before the rest because a
 * board member's own deliberation is what they came for. A list that reordered
 * itself as audiences were written to would move the one somebody was about to
 * press.
 *
 * The derived audiences are created here if this instance has never had them,
 * so a database emptied by hand needs no seed to work. The migrations create
 * them; only somebody in an audience brings one into existence here, because a
 * row nobody can read is not worth writing.
 */
export async function audiencesFor(
  db: FeedDbClient,
  personId: string,
  now: Date,
): Promise<AudienceRow[]> {
  const seat = await holdsBoardSeat(db, personId, now);
  const resident = await livesHere(db, personId, now);
  const administrator = await isAdministrator(db, personId);

  const all = seat || resident ? [await derivedAudience(db, "ALL")] : [];
  const board = seat ? [await derivedAudience(db, "BOARD")] : [];
  const admin =
    seat || administrator ? [await derivedAudience(db, "ADMIN")] : [];
  const groups = resident ? await writtenInto(db, personId) : [];

  return [...all, ...board, ...admin, ...groups];
}

/**
 * The one audience of a derived kind, created if this instance has none.
 *
 * A partial unique index allows exactly one row of each kind, so two requests
 * arriving at an emptied database together settle rather than each creating
 * one: one insert wins, the other does nothing, and both are answered by the
 * read that follows. `ON CONFLICT` rather than a caught error, because this runs
 * inside a caller's transaction too, and an error there would end it.
 */
export async function derivedAudience(
  db: FeedDbClient,
  kind: "ALL" | "BOARD" | "ADMIN",
): Promise<AudienceRow> {
  const existing = await db.audience.findFirst({
    where: { kind },
    select: AUDIENCE_COLUMNS,
  });
  if (existing !== null) {
    return existing;
  }

  await db.$executeRaw`
    INSERT INTO "audience" ("id", "kind", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${kind}::"AudienceKind", now(), now())
    ON CONFLICT DO NOTHING
  `;
  const created = await db.audience.findFirst({
    where: { kind },
    select: AUDIENCE_COLUMNS,
  });
  if (created === null) {
    throw new Error(`The ${kind} audience could not be created or read.`);
  }
  return created;
}

/**
 * Whether this person is in a group: written down, and still living here.
 *
 * Both halves in one question, because a caller that asked only for the row
 * would be answering with a membership the register has already ended.
 */
export async function isGroupMember(
  db: FeedDbClient,
  audienceId: string,
  personId: string,
  now: Date,
): Promise<boolean> {
  return (
    (await isWrittenIntoGroup(db, audienceId, personId)) &&
    livesHere(db, personId, now)
  );
}

/**
 * Whether the group has a row for this person, whether or not they still live
 * here. Not an answer to whether they are in it, which is
 * {@link isGroupMember}: for the acts that put somebody into a group, where a
 * row a moved-out person left behind is still the row that is there.
 */
export async function isWrittenIntoGroup(
  db: FeedDbClient,
  audienceId: string,
  personId: string,
): Promise<boolean> {
  const row = await db.groupMember.findUnique({
    where: { audienceId_personId: { audienceId, personId } },
    select: { audienceId: true },
  });
  return row !== null;
}

/**
 * Every group this person is in, in the order they were put into them.
 *
 * Answered with no rows at all for somebody who no longer lives here rather than
 * with the groups they are written down in: one query for the residency instead
 * of one per group, and the same answer.
 */
export async function groupsFor(
  db: FeedDbClient,
  personId: string,
  now: Date,
): Promise<AudienceRow[]> {
  if (!(await livesHere(db, personId, now))) {
    return [];
  }
  return writtenInto(db, personId);
}

/** The groups this person is written into, for a caller that knows they live here. */
async function writtenInto(
  db: FeedDbClient,
  personId: string,
): Promise<AudienceRow[]> {
  const memberships = await db.groupMember.findMany({
    where: { personId },
    orderBy: [{ joinedAt: "asc" }],
    select: { audience: { select: AUDIENCE_COLUMNS } },
  });
  return memberships.map((membership) => membership.audience);
}

/**
 * Which posts are in front of anybody at all, whoever is reading.
 *
 * A post whose instant has not yet come is a scheduled one and is in nobody's
 * feed until it does. A board post is a news item, and is in the feed only while
 * the item is published: taking a notice down takes it out of the feed, and
 * putting it back puts it back where it was.
 */
export function shownAt(now: Date): Prisma.PostWhereInput {
  return {
    createdAt: { lte: now },
    OR: [{ newsId: null }, { news: { published: true } }],
  };
}

/** A post, as the question of whether somebody may read it answers it. */
export interface ReachablePost {
  id: string;
  audience: AudienceRow;
  authorPersonId: string | null;
  struckAt: Date | null;
  commentsAllowed: boolean;
  /**
   * Set on a post the purge has erased. It is still read - the comments under
   * it are - and every path that adds to a post refuses it.
   */
  erasedAt: Date | null;
}

/**
 * The post this person may read, or null.
 *
 * Null for a post that does not exist, one not yet shown or no longer shown, and
 * one in an audience this person is not in - one value, for the reason the
 * module comment gives. Every path that takes a post's identifier asks this, so
 * a group's post is refused by identifier exactly as one that was never
 * written, on every route.
 */
export async function postFor(
  db: FeedDbClient,
  postId: string,
  personId: string,
  now: Date,
): Promise<ReachablePost | null> {
  const post = await db.post.findFirst({
    where: { id: postId, ...shownAt(now) },
    select: {
      id: true,
      authorPersonId: true,
      struckAt: true,
      commentsAllowed: true,
      erasedAt: true,
      audience: { select: AUDIENCE_COLUMNS },
    },
  });
  if (post === null) {
    return null;
  }
  return (await isInAudience(db, post.audience, personId, now)) ? post : null;
}

/**
 * Refuses a post the purge has erased, read again under a share lock on its
 * row.
 *
 * For every path that adds something to a post: a comment, a like, a read
 * record, a report. The purge erases a post by updating its row and then
 * deleting what hung on the text, and at READ COMMITTED a plain read beside it
 * sees the row as it was until the purge commits - so a comment checked that way
 * could land under a post whose author's part had just gone, and a like or a
 * report after the purge had taken the others. The share lock waits for an
 * erasure in flight and reads the row it left; and an erasure that arrives
 * second waits for this transaction, so whatever it adds is already committed
 * when the purge decides what stands under the post.
 *
 * Raw SQL because the client has no locking read.
 */
export async function refuseErasedPost(
  tx: Prisma.TransactionClient,
  postId: string,
): Promise<LockedPost> {
  const row = await readPostForShare(tx, postId);
  if (row === null) {
    throw new FeedError("There is no such post.", "post-not-found");
  }
  if (row.erasedAt !== null) {
    throw new FeedError("This post has been erased.", "post-erased");
  }
  return row;
}

/** What a post's row says about adding to it, read under a share lock. */
export interface LockedPost {
  struckAt: Date | null;
  commentsAllowed: boolean;
  erasedAt: Date | null;
}

/**
 * A post's row under a share lock, or null when there is none.
 *
 * The read {@link refuseErasedPost} refuses on, for a path that answers in its
 * own module's refusals: the news screen's thread writes under the same posts
 * and has its own reasons to give.
 */
export async function readPostForShare(
  tx: Prisma.TransactionClient,
  postId: string,
): Promise<LockedPost | null> {
  const [row] = await tx.$queryRaw<
    LockedPost[]
  >`SELECT "struckAt", "commentsAllowed", "erasedAt" FROM "post" WHERE "id" = ${postId} FOR SHARE`;
  return row ?? null;
}

/**
 * Whether a post takes comments: written to take them, not struck by the board
 * and not erased by the purge.
 *
 * One rule for both screens a comment is written from. A news item's thread is
 * its post's thread (ADR 0026), so a post the board closed is closed on the news
 * screen exactly as it is in the feed.
 */
export function takesComments(post: {
  struckAt: Date | null;
  commentsAllowed: boolean;
  erasedAt?: Date | null;
}): boolean {
  return (
    post.commentsAllowed && post.struckAt === null && post.erasedAt == null
  );
}
