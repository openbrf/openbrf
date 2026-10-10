import type { Prisma } from "../generated/prisma/client";

/**
 * The count of import chunks that have written to the register, which a preview
 * records and an apply compares (see the `ImportRevision` model).
 *
 * Read and advanced here rather than inline, so the singleton's id is spelled
 * once. A missing row reads as 0 and is created by the first chunk that writes:
 * the migration inserts it, but a database restored without it must not turn
 * every apply into a refusal.
 */
const SINGLETON = 1;

export async function readImportRevision(
  client: Pick<Prisma.TransactionClient, "importRevision">,
): Promise<number> {
  const row = await client.importRevision.findUnique({
    where: { id: SINGLETON },
    select: { revision: true },
  });
  return row?.revision ?? 0;
}

/**
 * Moves the count on, in the transaction that wrote.
 *
 * Inside it and not after it: a count advanced once the writes have committed is
 * never advanced when the process dies in between, and every preview taken
 * before those writes could then be applied. Nor before it, in a transaction of
 * its own, which a chunk that then rolls back would leave advanced for writes
 * that never happened. The row lock this takes is held to the commit, which
 * costs nothing, since one import runs at a time.
 */
export async function advanceImportRevision(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.importRevision.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, revision: 1 },
    update: { revision: { increment: 1 } },
  });
}
