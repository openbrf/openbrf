import type { PrismaClient } from "../generated/prisma/client";

/**
 * The lock install and uninstall of one catalog package take, kind and id.
 *
 * Both are a read followed by a write, and the read is a gate. An install asks
 * whether the package is already here - a deprecated entry is let through for
 * a reinstall and refused for a fresh install - and then writes the consent
 * row or the installed row; an uninstall deletes the row the gate reads. At
 * READ COMMITTED, the isolation everything in this application runs at, an
 * install can read "installed" while an uninstall is removing the row, and the
 * outcome is an uninstall followed by an install that the gate was written to
 * refuse. Every gate of both services has that window.
 *
 * An advisory lock rather than a constraint, for the reason
 * `fees/fee-lock.ts` gives: the invariant spans a row and a directory of files
 * - or a row and a job - and no single row carries it. Two administrators
 * acting on one package at the same moment is rare; the cost of the lock is a
 * short wait for the second of them.
 *
 * Held here rather than beside either service because a lock only works if
 * every writer spells the key the same way, and the plugin and the theme
 * services share no class to put it on. A second spelling would be two locks
 * that never meet, which reads as serialised and is not.
 *
 * Per kind and id: different ids never wait for each other, and a plugin never
 * waits for a theme that happens to share its id.
 *
 * Taken for a transaction opened only to hold it, so the commit or the
 * rollback releases it and a crash cannot leave it behind. The work inside runs
 * on the pooled client and not on that transaction: it spans services that
 * each open their own, and what the lock has to exclude is the other
 * administrator's whole operation, not one statement.
 *
 * Not reentrant. A caller that holds it and calls another method that takes it
 * waits for itself until the timeout below.
 */

/**
 * How long the transaction that holds the lock may stay open, waiting for the
 * lock included.
 *
 * Longer than Prisma's five seconds, because a theme install downloads and
 * verifies its package under the lock and the install gates run before that
 * download on purpose. Bounded all the same: a lock held by a stuck request is
 * one administrator's retry, not a package nobody can ever change again.
 */
export const PACKAGE_LOCK_TIMEOUT_MS = 120_000;

export type PackageKind = "plugin" | "theme";

/** Runs `work` while holding the lock for this package. */
export async function withPackageLock<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  kind: PackageKind,
  id: string,
  work: () => Promise<T>,
): Promise<T> {
  return await prisma.$transaction(
    async (tx) => {
      // Run through $executeRaw rather than $queryRaw because the lock
      // function returns void, which the client has no column type for.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`package-install:${kind}:${id}`}))`;
      return await work();
    },
    { timeout: PACKAGE_LOCK_TIMEOUT_MS, maxWait: PACKAGE_LOCK_TIMEOUT_MS },
  );
}
