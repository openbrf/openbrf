import { Inject, Injectable } from "@nestjs/common";
import { Client } from "pg";

import { ENV } from "../config/config.module";
import { applicationDatabaseUrl, type Env } from "../config/env";

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
 * Held on a connection of its own, opened for the one operation and outside
 * the application's pool, unlike the transaction-scoped locks beside the other
 * modules. The work under it spans services that each open their own
 * transactions, so it runs on the pooled client and the lock cannot share a
 * transaction with it. A transaction opened only to hold the lock would get
 * both of these wrong:
 *
 * - A waiter would sit on a pooled connection. Enough of them and the holder
 *   cannot get one for its own work, and everybody waits out the timeout with
 *   no deadlock in the database to show for it.
 * - Prisma ends an interactive transaction at its timeout, and ending it
 *   releases the lock while the work it guards is still running - a theme
 *   download, a file swap - so the next administrator walks straight in.
 *
 * A session lock instead, released by closing the session once the work has
 * settled, whichever way it settled. A crash closes the session too, so the
 * lock cannot outlive the process. The one way it ends early is the lock's
 * own connection dropping mid-work, which is the database going away rather
 * than a timer firing.
 *
 * Not reentrant in the way that matters: a caller that holds it and calls
 * another method that takes it opens a second session, and that session waits
 * for the first until {@link PACKAGE_LOCK_WAIT_MS}.
 */

/**
 * How long an operation waits for another one on the same package.
 *
 * Bounds the wait only, never the holder: work under the lock keeps it until
 * it has finished. Long because a theme install downloads and verifies its
 * package under the lock and the install gates run before that download on
 * purpose. Bounded all the same, so a stuck holder costs the second
 * administrator a retry rather than a request that never answers.
 */
export const PACKAGE_LOCK_WAIT_MS = 120_000;

export type PackageKind = "plugin" | "theme";

/** Raised when another operation held the package for longer than the wait. */
export class PackageLockTimeoutError extends Error {}

/** Postgres's SQLSTATE for a lock wait cut short by `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";

/** Runs `work` while holding the lock for this package. */
export async function withPackageLock<T>(
  connectionString: string,
  kind: PackageKind,
  id: string,
  work: () => Promise<T>,
  waitMs: number = PACKAGE_LOCK_WAIT_MS,
): Promise<T> {
  const client = new Client({ connectionString });
  // A connection that drops is reported as an event, and an event nobody
  // listens for brings the process down. The work under the lock is not this
  // connection's to stop, so there is nothing to do with it here.
  client.on("error", () => undefined);
  await client.connect();
  try {
    await client.query("SELECT set_config('lock_timeout', $1, false)", [
      String(waitMs),
    ]);
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [
        `package-install:${kind}:${id}`,
      ]);
    } catch (cause) {
      if ((cause as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
        throw new PackageLockTimeoutError(
          `The ${kind} ${id} is being changed by another operation that did ` +
            `not finish within ${String(waitMs)}ms.`,
          { cause },
        );
      }
      throw cause;
    }
    return await work();
  } finally {
    // Closing the session is what releases the lock, so there is no unlock to
    // forget, and a session that could not unlock cannot go back to a pool
    // still holding it.
    await client.end().catch(() => undefined);
  }
}

/** {@link withPackageLock} on the database the application connects to. */
@Injectable()
export class PackageLock {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async run<T>(
    kind: PackageKind,
    id: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return await withPackageLock(
      applicationDatabaseUrl(this.env),
      kind,
      id,
      work,
    );
  }
}
