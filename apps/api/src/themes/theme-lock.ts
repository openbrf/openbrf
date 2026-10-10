import type { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";

/**
 * The lock a transaction takes before it changes which themes exist or which
 * one is active.
 *
 * What is safe to write depends on other rows: a theme may be removed only
 * while it is not active and nothing inherits from it, activated only while it
 * is installed, and installed as a child only while its parent is. At READ
 * COMMITTED each check passes on what it read and the writes then cross - an
 * uninstall and an activation of the same theme both commit, and the
 * association points at a theme that is gone. `activeThemeId` has no foreign
 * key to stop it, by design: the active theme is a preference, not a
 * relation.
 *
 * One key for every theme mutation, for the reason `menu-lock.ts` gives: which
 * rows a write depends on is what it is about to find out, and themes change
 * rarely enough that serialising them costs nothing anybody would notice.
 * Taken for the transaction, so the commit or the rollback releases it.
 */
export async function lockThemes(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"themes"}))`;
}

/**
 * Runs the file work that undoes a theme transaction which did not commit,
 * under the same lock.
 *
 * The lock above goes with the transaction, and the undo comes after it:
 * unlocked, an install or a removal of the same id could commit in between and
 * have its files undone under its own row. When the lock cannot be taken -
 * most often because the database that failed the transaction is still out of
 * reach, and then nothing else can commit either - the work runs without it
 * rather than leave the volume disagreeing with the rows; the store's own
 * check that the files are still the ones it placed is what remains.
 */
export async function underThemeLock(
  prisma: PrismaService,
  work: () => Promise<void>,
): Promise<void> {
  let locked = false;
  try {
    await prisma.$transaction(async (tx) => {
      await lockThemes(tx);
      locked = true;
      await work();
    });
  } catch (cause) {
    if (locked) {
      throw cause;
    }
    await work();
  }
}
