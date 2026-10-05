import type { Prisma } from "../generated/prisma/client";

/**
 * The lock an apply takes before it decides whether it may start.
 *
 * One import runs at a time across the instance, and that is decided by reading
 * the set of sessions and then claiming one. Whether another import is running
 * is a question about the whole table, and no single row carries the answer for
 * the claim's row lock to serialise. At READ COMMITTED - the isolation
 * everything in this application runs at - two applies of two different
 * sessions both read "nothing running" and both claim. This lock makes the
 * second wait until the first commits, and its read then sees the first one
 * queued.
 *
 * An advisory lock rather than a partial unique index over the running
 * statuses, for the reason `fees/fee-lock.ts` and `registers/residency-lock.ts`
 * give for theirs: the invariant spans rows, and the apply is the only writer
 * that moves a session to QUEUED, so serialising that one writer is enough. The
 * refusal then comes from the read, as a reason the screen can explain, and
 * not from a constraint violation translated after the fact.
 *
 * Held here rather than inline in the apply because a lock only works if every
 * writer spells the key the same way. A second spelling would be two locks that
 * never meet, which reads as serialised and is not.
 *
 * Taken for the transaction, so the commit or the rollback releases it with
 * nothing left to remember to unlock. The key is namespaced and hashed to the
 * int4 the lock space is addressed in; one key for the whole instance, because
 * one instance serves one association.
 */
export async function lockImportApply(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"import-sessions:running"}))`;
}
