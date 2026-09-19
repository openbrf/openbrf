import pg from "pg";

import { stack } from "./stack";

/**
 * A seat on the board, granted straight in the database.
 *
 * Written here rather than through the application, although the application
 * can now do it: `api/board-positions` exists behind `boardPosition:manage`,
 * and the register screens drive it. A spec that needs somebody on the board
 * needs a precondition rather than a subject, and recording an election through
 * three screens to arrange one would put the register's own flow into every
 * spec that happens to need a board member.
 *
 * The shared fixture still has an administrator and residents and nobody on the
 * board, because the sign-up approval path it provisions people through writes
 * residencies and nothing else. So a spec that needs a seat asks for one here.
 *
 * A seat decides more than one thing in the product now. It decides who is
 * emailed when the public writes to the association, whose name the board
 * roster may publish, and - since the chat - who is in the board's own room:
 * membership of that room is derived from an unexpired seat rather than written
 * down, so this function is what puts somebody in it.
 *
 * The connection is the owner's, like the audit-log reads, the page fixture and
 * the property-manager grant. A board position is service tier: no append-only
 * trigger, nothing statutory.
 */

async function withClient<T>(
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: stack.databaseUrl });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/**
 * Puts this person on the board as chair, if they are not on it already.
 *
 * Idempotent against the database rather than against process state: the suite
 * may run spec files in different worker processes, so "have I already done
 * this" has to be a question about the instance. The identifier is derived from
 * the person, which is what makes the insert idempotent - the table has no
 * unique constraint on the seat itself, because a person can hold the same
 * position twice over two terms.
 */
export async function grantBoardSeat(personId: string): Promise<void> {
  await withClient(async (client) => {
    // Prisma maps the model to board_position but leaves the column names in
    // camel case, so every one of them has to be quoted.
    await client.query(
      `INSERT INTO public.board_position
         (id, "personId", position, "electedOn", "createdAt", "updatedAt")
       VALUES ($1, $2, 'CHAIR'::"BoardPositionType", CURRENT_DATE, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [`e2e-board-${personId}`, personId],
    );
  });
}
