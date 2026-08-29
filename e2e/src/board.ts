import pg from "pg";

import { stack } from "./stack";

/**
 * A seat on the board, granted straight in the database.
 *
 * There is no endpoint that elects somebody: board positions are entered from
 * the register screens that phase 1 does not build, and the fixture instance
 * therefore has an administrator and residents but nobody on the board. That
 * matters to exactly one thing in the product - who is emailed when the public
 * writes to the association - so the seat is written here rather than the
 * assertion being dropped.
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
