import type { PrismaService } from "../database/prisma.service";

/**
 * How many transactions hold, or are queued behind, an advisory lock key, in
 * this database only.
 *
 * Tests that assert one writer waited for another read the wait out of
 * `pg_locks` rather than inferring it from a delay, so a writer that blocks and
 * a writer that finished without taking the key are told apart by what the
 * database says instead of by how long a test was willing to wait.
 *
 * Postgres addresses the advisory lock space with a 64-bit key and reports it
 * split: the high half in `classid`, the low half in `objid`, and `objsubid` 1
 * for the one-argument form the locks are taken with. `hashtext` returns an
 * int4 that the lock function widens to that key, so a negative hash
 * sign-extends and its high half comes back as all ones - which is why both
 * halves are masked out of the key rather than assumed to be zero.
 *
 * `pg_locks` shows the whole cluster, and a key such as `legal-hold:registry`
 * is the same string in every integration worker's database, so the count is
 * held to the database this client is connected to.
 *
 * Callers spell the key out rather than import it, so a writer that quietly
 * changed its key would fail the assertion instead of passing under a new name.
 */
export async function advisoryLockCount(
  prisma: PrismaService,
  key: string,
  granted: boolean,
): Promise<bigint> {
  const [row] = await prisma.$queryRaw<{ locks: bigint }[]>`
    SELECT count(*) AS locks
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND granted = ${granted}
      AND objsubid = 1
      AND classid = ((hashtext(${key})::bigint >> 32) & 4294967295)::oid
      AND objid = (hashtext(${key})::bigint & 4294967295)::oid`;
  return row?.locks ?? 0n;
}

/**
 * Ends the session that holds an advisory lock key, in this database only, and
 * says how many it ended.
 *
 * For tests of what a holder does when its session is lost while the database
 * stays up. Chosen by the granted lock rather than by application name, so it
 * ends that holder and no other session that happens to share the name.
 */
export function terminateAdvisoryLockHolder(
  prisma: PrismaService,
  key: string,
): Promise<number> {
  return terminateAdvisoryLockSessions(prisma, key, true);
}

/**
 * Ends the sessions waiting for an advisory lock key, in this database only,
 * and says how many it ended.
 *
 * The other half of {@link terminateAdvisoryLockHolder}: for tests of what a
 * waiter does when its session is lost before it has the lock.
 */
export function terminateAdvisoryLockWaiters(
  prisma: PrismaService,
  key: string,
): Promise<number> {
  return terminateAdvisoryLockSessions(prisma, key, false);
}

/**
 * Cancels the queries waiting for an advisory lock key, in this database only,
 * and says how many it cancelled.
 *
 * Unlike {@link terminateAdvisoryLockWaiters} the sessions go on: for tests of
 * what a waiter does when only its query is stopped.
 */
export function cancelAdvisoryLockWaiters(
  prisma: PrismaService,
  key: string,
): Promise<number> {
  return terminateAdvisoryLockSessions(prisma, key, false, true);
}

async function terminateAdvisoryLockSessions(
  prisma: PrismaService,
  key: string,
  granted: boolean,
  cancelOnly = false,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ terminated: boolean }[]>`
    SELECT CASE WHEN ${cancelOnly}
      THEN pg_cancel_backend(pid)
      ELSE pg_terminate_backend(pid)
    END AS terminated
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND granted = ${granted}
      AND objsubid = 1
      AND classid = ((hashtext(${key})::bigint >> 32) & 4294967295)::oid
      AND objid = (hashtext(${key})::bigint & 4294967295)::oid`;
  return rows.filter((row) => row.terminated).length;
}

/**
 * How many transactions hold, or are queued behind, this person's legal-hold
 * key: the key a purge and a writer placing a hold on the person are ordered
 * by.
 */
export function holdLockCount(
  prisma: PrismaService,
  personId: string,
  granted: boolean,
): Promise<bigint> {
  return advisoryLockCount(prisma, `legal-hold:${personId}`, granted);
}

/**
 * How many transactions hold, or are queued behind, this apartment's residency
 * key: the key a purge and a writer of the apartment's residencies are ordered
 * by.
 */
export function residencyApartmentLockCount(
  prisma: PrismaService,
  apartmentId: string,
  granted: boolean,
): Promise<bigint> {
  return advisoryLockCount(
    prisma,
    `residency-apartment:${apartmentId}`,
    granted,
  );
}

/**
 * How many lock requests in this database are waiting rather than granted.
 *
 * Unlike the counts above this one is not tied to a key: it counts every lock
 * kind, relation locks such as `LOCK TABLE` as well as advisory ones. Use it
 * when a test holds a table and only needs to know that a set number of
 * requests are queued behind it.
 */
export async function waitingLockCount(prisma: PrismaService): Promise<bigint> {
  const [row] = await prisma.$queryRaw<{ locks: bigint }[]>`
    SELECT count(*) AS locks
    FROM pg_locks
    WHERE NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  return row?.locks ?? 0n;
}

/**
 * How many connections to this database are blocked by a transaction that is
 * itself queued behind this apartment's residency key.
 *
 * The count to use when a test holds the key to stop a writer part way, and
 * needs to know a second writer is waiting for a row the first one holds -
 * not merely that something, somewhere, is waiting. A writer queued behind a
 * row lock waits on the holder's transaction id, and `pg_locks` does not tie a
 * transaction id lock to a database, so {@link waitingLockCount} never sees
 * it. `pg_blocking_pids` names the holder, and the holder is the connection
 * `pg_locks` shows queued behind the key.
 */
export async function blockedBehindResidencyApartmentCount(
  prisma: PrismaService,
  apartmentId: string,
): Promise<bigint> {
  const key = `residency-apartment:${apartmentId}`;
  const [row] = await prisma.$queryRaw<{ blocked: bigint }[]>`
    SELECT count(*) AS blocked
    FROM pg_stat_activity
    WHERE wait_event_type = 'Lock'
      AND datname = current_database()
      AND pg_blocking_pids(pid) && ARRAY(
        SELECT pid
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND NOT granted
          AND objsubid = 1
          AND classid = ((hashtext(${key})::bigint >> 32) & 4294967295)::oid
          AND objid = (hashtext(${key})::bigint & 4294967295)::oid
      )`;
  return row?.blocked ?? 0n;
}

/** Polls until the condition holds, or gives up so a failure is a failure. */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The condition did not hold within the time allowed.");
}
