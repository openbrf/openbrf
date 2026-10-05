import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it closes and replaces a recipient's row.
 *
 * "One open row per recipient" is what `list` and `forPlugins` read the record
 * through, and at READ COMMITTED two writers can both close the same row and
 * both insert, leaving a dated record that says the association agreed two
 * different things with one recipient over the same period. It is also what
 * makes a plugin install's "only if unrecorded" a decision rather than a race:
 * the row it finds absent cannot be written by the data protection screen
 * before the install's insert commits.
 *
 * An advisory lock rather than a constraint: the rule is a partial uniqueness
 * Prisma's schema cannot state, and the rows are few and written by hand, so a
 * writer waiting a moment for another is never felt. Taken for the
 * transaction, so the commit or the rollback releases it.
 *
 * Taken by `ProcessorAgreementService.record` and nothing else. The other
 * writers never leave a recipient with two open rows: `recordExternal` creates
 * a key of its own and `end` only closes. `seed` reads a row and then writes
 * it without this lock; nothing calls it today, and whatever wires it up has
 * to take the lock first.
 *
 * Held here rather than beside the writer because a lock only works if every
 * writer takes the same key.
 */
export async function lockProcessorAgreement(
  tx: Prisma.TransactionClient,
  processorKey: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`processor-agreement:${processorKey}`}))`;
}
