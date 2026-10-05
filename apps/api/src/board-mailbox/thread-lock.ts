import type { Prisma } from "../generated/prisma/client";

/**
 * Locks one thread's row until the transaction ends.
 *
 * Every write that decides a thread's state from what it reads - take, release,
 * reply, close, a follow-up reopening it, the purge erasing it - takes this
 * first and reads after it. At READ COMMITTED a plain read is answered from
 * whatever had committed when it ran, so two such writes could each read the
 * thread, each decide, and the second overwrite the first: a reply landing over
 * a close leaves a thread ANSWERED with its closing date still set.
 *
 * A row lock rather than an advisory one, because the row is what the other
 * writers touch. Storing a message on a thread takes a key-share lock on the
 * thread through the foreign key, which this conflicts with, so the purge holding
 * it cannot have a letter land on the thread between its reads and its delete.
 */
export async function lockThread(
  tx: Prisma.TransactionClient,
  threadId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM board_mailbox_thread WHERE id = ${threadId} FOR UPDATE`;
}
