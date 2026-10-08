import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it decides where a page sits in the
 * board's list of pages.
 *
 * A new page is placed by reading where the others sit - and directly before
 * the privacy notice when the notice is at the end, which moves the notice one
 * place down. At READ COMMITTED a rearrangement committing between that read
 * and that write would be undone by it: the board drags the notice to the top,
 * and a page created in the same moment puts it back at the end. Every write
 * that sets a page's sort order takes this first, so the two take turns.
 *
 * An advisory lock rather than row locks, for the reason `menu-lock.ts` gives:
 * what a placement depends on is a set of rows, and which ones is what the
 * write is about to find out. One key for the whole list, because the list is
 * a few dozen pages arranged by a board member now and then.
 *
 * Held here rather than beside either writer because the lock only works if
 * every writer uses the same key. Taken for the transaction, so the commit or
 * the rollback releases it.
 */
export async function lockPageOrder(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"site-page-order"}))`;
}
