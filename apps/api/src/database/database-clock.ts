import type { Prisma } from "../generated/prisma/client";
import type { PrismaService } from "./prisma.service";

/**
 * The database's clock at this moment, for a decision that must be judged on
 * the same clock as the rows it reads.
 *
 * `clock_timestamp()`, not `now()`: `now()` is the start of the transaction,
 * and a decision taken after a lock wait belongs to the moment the lock was
 * got. Prisma fills `@default(now())` and every `new Date()` from the clock of
 * the API process, and two processes, or one whose clock has stepped, disagree
 * with each other and with the database; a window judged on one clock against a
 * column written on another is shifted by their difference.
 *
 * Read inside the transaction that takes the decision, after its locks.
 */
export async function databaseNow(
  db: Prisma.TransactionClient | PrismaService,
): Promise<Date> {
  const [row] = await db.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  if (row === undefined) {
    throw new Error("The database returned no clock reading.");
  }
  return row.now;
}
