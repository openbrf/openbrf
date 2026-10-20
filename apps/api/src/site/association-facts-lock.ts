import type { Prisma } from "../generated/prisma/client";

/**
 * The lock every write to the association's facts takes before it reads them.
 *
 * A confirmation and a change to the months setting each read the row and then
 * write it. Both pass back the updatedAt they read, because neither writes a
 * fact and Prisma would otherwise move it on its own; both audit a value they
 * read, the date or the number they replaced. At READ COMMITTED - the isolation
 * everything in this application runs at - a save that commits between that
 * read and the write is undone in part: the confirmation writes back the
 * updatedAt from before the save, and the page says a fact edited this morning
 * was last edited in January. Two months changes at once both read the same old
 * number, and the log says the second replaced it rather than the first one's.
 *
 * The save takes it too, though it reads nothing, because it is the write the
 * other two must not interleave with. And it serialises the first creation of
 * the row: a months change on an instance with no row creates one, and a save
 * arriving with it would otherwise collide on the primary key.
 *
 * An advisory lock rather than `SELECT ... FOR UPDATE`, because there is no row
 * to lock before the first write creates one. One key, because there is one
 * row. Held here rather than beside the writers because the lock only works if
 * every writer uses the same key: a second spelling of this string would be two
 * locks that never meet. Taken for the transaction, so the commit or the
 * rollback releases it.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockAssociationFacts(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"association-facts"}))`;
}
