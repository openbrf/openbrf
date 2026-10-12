import type { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";

/**
 * The backend a transaction runs on.
 *
 * Read inside the transaction a test holds open, so that {@link waitersBehind}
 * can ask who is queued behind that transaction in particular.
 */
export async function backendPid(
  client: Prisma.TransactionClient,
): Promise<number> {
  const [row] = await client.$queryRaw<{ pid: number }[]>`
    SELECT pg_backend_pid() AS pid`;
  if (row === undefined) {
    throw new Error("The database did not name the backend.");
  }
  return row.pid;
}

/**
 * How many backends wait for a lock the holding backend holds, directly or
 * behind another backend that does.
 *
 * Tests that play a race out in a fixed order hold a transaction open, send the
 * requests, and let go once the database says they are queued. Counting every
 * lock wait in the database would let a wait that has nothing to do with the
 * test stand in for the one it is waiting for, and the transaction would be let
 * go before the request was queued: the test would then pass through the
 * regression it exists for. `pg_blocking_pids` names who a backend waits for,
 * so the count is held to the holder's own queue.
 *
 * Through the chain, because a second writer usually queues behind the first
 * writer's row lock rather than behind the holder itself.
 */
export async function waitersBehind(
  prisma: PrismaService,
  holder: number,
): Promise<number> {
  const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
    WITH RECURSIVE waiting (pid) AS (
      SELECT pid
        FROM pg_stat_activity
       WHERE ${holder}::int = ANY (pg_blocking_pids(pid))
      UNION
      SELECT activity.pid
        FROM pg_stat_activity AS activity
        JOIN waiting ON waiting.pid = ANY (pg_blocking_pids(activity.pid))
    )
    SELECT count(*)::int AS waiting FROM waiting`;
  return row?.waiting ?? 0;
}
