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
 * The friendly path, with a constraint behind it. The partial unique index
 * `processor_agreement_one_open` (one row per `processorKey` WHERE `endedAt` IS
 * NULL, written by hand in its migration) refuses a second open row whatever
 * the writer did, so one that skips this lock or reads before taking it fails
 * on a unique violation instead of leaving two classifications standing. The
 * lock is what keeps a writer that follows the rules from meeting that error:
 * it waits a moment for the other, which with rows this few and written by
 * hand is never felt, and then reads a state it can act on. Taken for the
 * transaction, so the commit or the rollback releases it.
 *
 * Taken by `ProcessorAgreementService.record` and by
 * `ProcessorAgreementService.seed`, which reads the storage row and then
 * inserts or closes it, and so takes the "storage" key before the read. The
 * other writers never leave a recipient with two open rows: `recordExternal`
 * creates a key of its own and `end` only closes. That `end` does not wait
 * here is why `record` asks whether a board-recorded recipient still exists
 * of its own close rather than of a read: such a recipient is its open row,
 * and the lock does not keep `end` from closing it.
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
