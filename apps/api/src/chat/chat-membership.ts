import type { Prisma } from "../generated/prisma/client";
import type { ChatKind } from "../generated/prisma/enums";
import { activeBoardSeatWhere } from "../mail/board-recipients";

import type { PrismaService } from "../database/prisma.service";

/**
 * Who is in which room, asked of the register rather than of a flag.
 *
 * One file because three services ask the same question and the answer is the
 * security boundary. The rooms endpoint asks it to list rooms, the group
 * endpoints ask it before letting anybody add or leave, and the moderation queue
 * asks it before letting somebody report a message out of a room - and a second
 * spelling of any of those is a way for two of them to disagree about who is in
 * a room.
 *
 * ## The two kinds, and why neither is a list the board keeps
 *
 * The board chat's members are derived: whoever holds a board seat that has not
 * ended. A person joins the day their term is recorded and leaves the day it
 * ends, and nobody administers anything.
 *
 * A group's members are written down, because there is no election to derive
 * them from - but the writing down is only half of the test. The other half is a
 * residency that has not ended, so a place in a group ends the day somebody
 * moves out, exactly as a booking allowance bites on the day it says. What they
 * wrote stays in the room, attributed as before, and goes on the retention clock
 * it was always on.
 *
 * ## One refusal for two cases
 *
 * Every function here answers "not in it" and "there is no such room" with the
 * same value, and the callers turn both into one refusal. Distinguishing them
 * would let anybody holding `chat:participate` walk the identifier space and
 * learn what rooms the association has - which is the whole of what makes a
 * group invisible to somebody who is not in it.
 */

/**
 * A client that can answer these questions.
 *
 * The transaction client as well as the service, so a caller that has to decide
 * membership inside the transaction it is going to write in can do it there
 * rather than before it.
 */
export type ChatDbClient = PrismaService | Prisma.TransactionClient;

/** A room, as the membership question answers it. */
export interface ChatRoom {
  id: string;
  kind: ChatKind;
  name: string | null;
  createdByPersonId: string | null;
}

/** The columns a room is read with, wherever one is read. */
export const ROOM_COLUMNS = {
  id: true,
  kind: true,
  name: true,
  createdByPersonId: true,
} as const;

/**
 * A residency that has not ended.
 *
 * The predicate `PrincipalService.forPerson` derives `isResident` from, asked of
 * the register here rather than read off the principal - for the reason the seat
 * is asked for rather than read off `isBoardMember`: this is the membership of a
 * room, and a room that trusted a flag computed somewhere else would be a
 * boundary that moved the day that flag was cached.
 *
 * A move-out date in the future is a scheduled move-out and does not end the
 * residency yet, which is the same half of the predicate a clause testing only
 * for null would drop.
 */
export function liveResidencyWhere(now: Date): Prisma.ResidencyWhereInput {
  return { OR: [{ movedOutOn: null }, { movedOutOn: { gt: now } }] };
}

/** Whether this person holds a board seat that has not ended. */
export async function holdsBoardSeat(
  db: ChatDbClient,
  personId: string,
  now: Date,
): Promise<boolean> {
  const person = await db.person.findFirst({
    where: { id: personId, ...activeBoardSeatWhere(now) },
    select: { id: true },
  });
  return person !== null;
}

/**
 * Whether this person lives here, which is what a place in a group rests on.
 *
 * Asked of the residencies rather than of the member register: a group is for
 * the people in the building, and a partner or an adult child living in one of
 * its apartments is as much a part of a work party as the member is.
 */
export async function livesHere(
  db: ChatDbClient,
  personId: string,
  now: Date,
): Promise<boolean> {
  const residency = await db.residency.findFirst({
    where: { personId, ...liveResidencyWhere(now) },
    select: { id: true },
  });
  return residency !== null;
}

/**
 * The room this person may read, or null.
 *
 * Null for a room that does not exist, a board chat this person holds no seat
 * in, and a group they are not in or no longer live here for. One value, so a
 * caller cannot accidentally tell them apart and neither can a caller probing
 * identifiers.
 */
export async function roomFor(
  db: ChatDbClient,
  chatId: string,
  personId: string,
  now: Date,
): Promise<ChatRoom | null> {
  const chat = await db.chat.findUnique({
    where: { id: chatId },
    select: ROOM_COLUMNS,
  });
  if (chat === null) {
    return null;
  }

  const inIt =
    chat.kind === "BOARD"
      ? await holdsBoardSeat(db, personId, now)
      : await isGroupMember(db, chat.id, personId, now);

  return inIt ? chat : null;
}

/**
 * Whether this person is in a group: written down, and still living here.
 *
 * Both halves in one question, because a caller that asked only for the row
 * would be answering with a membership the register has already ended.
 */
export async function isGroupMember(
  db: ChatDbClient,
  chatId: string,
  personId: string,
  now: Date,
): Promise<boolean> {
  const row = await db.chatGroupMember.findUnique({
    where: { chatId_personId: { chatId, personId } },
    select: { chatId: true },
  });
  if (row === null) {
    return false;
  }
  return livesHere(db, personId, now);
}

/**
 * Every group this person is in, in the order they were put into them.
 *
 * Answered with no rows at all for somebody who no longer lives here rather than
 * with the rooms they are written down in: one query for the residency instead
 * of one per room, and the same answer.
 */
export async function groupsFor(
  db: ChatDbClient,
  personId: string,
  now: Date,
): Promise<ChatRoom[]> {
  if (!(await livesHere(db, personId, now))) {
    return [];
  }

  const memberships = await db.chatGroupMember.findMany({
    where: { personId },
    orderBy: [{ joinedAt: "asc" }],
    select: { chat: { select: ROOM_COLUMNS } },
  });

  return memberships.map((membership) => membership.chat);
}
