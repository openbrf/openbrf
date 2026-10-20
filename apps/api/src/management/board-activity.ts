import { Logger } from "@nestjs/common";
import { formatLocalDay, localDayOf } from "@openbrf/shared";

import type { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { boardSeatHeldOn } from "../registers/held-on";

const logger = new Logger("BoardActivity");

/**
 * The persons running the association on a day: a board seat held on it, or
 * ADMIN.
 */
export function runningTheAssociation(
  seat: Prisma.BoardPositionWhereInput,
): Prisma.PersonWhereInput {
  return {
    OR: [
      { boardPositions: { some: seat } },
      { systemRoles: { some: { role: "ADMIN" } } },
    ],
  };
}

/**
 * Notes that an account's session was created or renewed, when the account's
 * person runs the association today.
 *
 * Called from Better Auth's session hooks, after the session's own write has
 * committed. A session is renewed at most once a day while it is used (the
 * `updateAge` in auth-options.ts), so this runs at a sign-in and at the first
 * use of a session on a later day, not on every request.
 *
 * The day is written to the single board_activity row, and moved forward only:
 * whose activity it was is not kept, and neither is any earlier day. The
 * management API's summary reads it beside the sessions and the audit log,
 * because the session is deleted on sign-out and a visit that only reads
 * writes no entry.
 *
 * A failure is logged and swallowed. The person has signed in by now, and a
 * sign-in refused for the sake of a day the host reads would be the wrong way
 * round; the next renewal writes the day again.
 */
export async function recordBoardActivity(
  prisma: PrismaService,
  userId: string,
): Promise<void> {
  const today = localDayOf(new Date());
  try {
    const running = await prisma.user.count({
      where: {
        id: userId,
        person: runningTheAssociation(boardSeatHeldOn(today)),
      },
    });
    if (running === 0) {
      return;
    }
    // The day as text, so the database's time zone cannot move it.
    const day = formatLocalDay(today);
    await prisma.$executeRaw`
      INSERT INTO board_activity (id, "lastOn") VALUES (1, ${day}::date)
      ON CONFLICT (id) DO UPDATE
        SET "lastOn" = GREATEST(board_activity."lastOn", EXCLUDED."lastOn")`;
  } catch (failure) {
    logger.warn(
      "Could not record the board's activity for today. The management " +
        "summary reads the sessions and the audit log as before, and the " +
        "next sign-in or renewal records it again.",
      failure instanceof Error ? failure.stack : undefined,
    );
  }
}
