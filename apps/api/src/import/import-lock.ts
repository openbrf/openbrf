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
 * The partial unique index "import_session_one_apply" holds the invariant
 * against any writer; this lock is what lets the apply answer it. Serialised,
 * the refusal comes from the read, as a reason the screen can explain, and the
 * index is left to catch only a writer that does not take the lock.
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

/**
 * The lock every chunk of every import takes before it writes.
 *
 * One key for the instance: what it serialises is the decision "this person is
 * new", which any two chunks can disagree on whichever imports they belong to.
 * The chunk plans again once it holds it, so what it writes was decided
 * against a register no other chunk is adding to.
 *
 * Held here rather than inline in the apply because a lock only works if every
 * writer spells the key the same way, as `fees/fee-lock.ts` says of its own.
 * Taken for the transaction, so the commit or the rollback releases it.
 */
export async function lockImportChunkWrite(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"import-apply"}))`;
}
