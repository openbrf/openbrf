import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it changes the shape of the site menu.
 *
 * The two-level rule is not a property of any one row. "Move A under B" checks
 * that B hangs from nothing and that A has nothing hanging from it, and "move B
 * under A" checks the mirror image; at READ COMMITTED - the isolation
 * everything in this application runs at - both read before either writes,
 * both pass, and both commit. A and B then hang from each other, and both
 * vanish from the website, because a renderer walking down from the top level
 * never reaches either. Adding an entry under A while A is being moved under B
 * makes a third level the same way.
 *
 * Removing a page is the other writer that has to meet these. Its menu entries
 * go with it by cascade, and the page removal records each one it takes - which
 * it can only do truthfully if no entry can be hung under them, or pointed at
 * the page, between the read that finds them and the delete that takes them.
 *
 * An advisory lock rather than row locks or an isolation level, for the reason
 * `legal-hold-lock.ts` gives: the invariant is derived from a set of rows, and
 * serializable would state it at the price of retry handling on every writer.
 * One key for the whole menu rather than one per entry, because which entries a
 * write depends on is what the write is about to find out - and the menu is a
 * few dozen rows arranged by a board member now and then, so serialising every
 * change to it costs nothing anybody could notice.
 *
 * Held here rather than beside either writer because the lock only works if
 * every writer uses the same key: a second spelling of this string would be two
 * locks that never meet. Taken for the transaction, so the commit or the
 * rollback releases it.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */
export async function lockMenu(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"site-menu"}))`;
}
