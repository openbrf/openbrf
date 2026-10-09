import { HttpStatus } from "@nestjs/common";
import { Client } from "pg";

import { applicationDatabaseUrl, type Env } from "../config/env";
import { DomainError } from "../http/domain-error";

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
 * Taken in two places, in this order:
 *
 * - In the process, by a queue per kind and id. A second operation on the same
 *   package waits here, on nothing but a promise, so waiting costs the
 *   database nothing. It is also what keeps the operations of this process
 *   apart when the database half is lost - see below.
 * - In the database, by a session advisory lock, which is what keeps this
 *   process apart from any other one connected to the same database.
 *
 * The session is a connection of its own, opened for the one operation and
 * outside the application's pool, unlike the transaction-scoped locks beside
 * the other modules. The work under it spans services that each open their own
 * transactions, so it runs on the pooled client and the lock cannot share a
 * transaction with it. A transaction opened only to hold the lock would get
 * both of these wrong:
 *
 * - A holder would sit on a pooled connection. Enough of them and the work
 *   cannot get one, and everybody waits out the timeout with no deadlock in
 *   the database to show for it.
 * - Prisma ends an interactive transaction at its timeout, and ending it
 *   releases the lock while the work it guards is still running - a theme
 *   download, a file swap - so the next administrator walks straight in.
 *
 * A session lock instead, released by closing the session once the work has
 * settled, whichever way it settled. A crash closes the session too, so the
 * lock cannot outlive the process.
 *
 * The session can end before the work does: the server terminates the backend,
 * an idle timeout ends it, the network drops. The database then hands the lock
 * to whoever asks next, and nothing stops the work that thought it held it - a
 * rejected promise does not cancel the writes behind it. So the work is given
 * a signal that is aborted the moment the session is lost, and checks it before
 * each write it makes under the lock, failing with {@link PackageLockLostError}
 * rather than writing. The queue in the process is not released until the work
 * has settled, so in this process nothing else gets in even while it winds
 * down.
 *
 * Bounded in how many operations one process admits at a time, held and
 * queued alike, so neither the waiters nor the connections they open grow
 * with the request rate. See {@link MAX_PACKAGE_OPERATIONS}.
 *
 * Not reentrant: a caller that holds it and calls another method that takes it
 * queues behind itself and gives up after {@link PACKAGE_LOCK_WAIT_MS}.
 */

/**
 * How long an operation waits for another one on the same package.
 *
 * Bounds the wait only, never the holder: work under the lock keeps it until
 * it has finished. Long because a theme install downloads and verifies its
 * package under the lock and the install gates run before that download on
 * purpose. Bounded all the same, so a stuck holder costs the second
 * administrator a retry rather than a request that never answers. One budget
 * for the whole wait, in the process and in the database together.
 */
export const PACKAGE_LOCK_WAIT_MS = 120_000;

/**
 * How long opening the lock's session may take.
 *
 * The driver's default is no limit at all, so a database that accepts the
 * connection and never answers would hold the request for good.
 */
export const PACKAGE_LOCK_CONNECT_MS = 10_000;

/**
 * Operations on packages one process admits at a time, held and queued alike.
 *
 * Every holder opens one connection outside the application's pool, and a
 * holder waiting for another process opens one too, so this is also the most
 * connections the lock can add to the database's count. Without it an
 * administrator - or a stolen board session - could open one per request,
 * each held for the length of the wait, until the database refused the pool
 * its own. Four leaves room for one install and three administrators waiting
 * on it; past that a request is refused at once with {@link PackageBusyError}
 * rather than left to wait. Counted per process, so an instance run as several
 * replicas adds up to this many per replica.
 *
 * `docker/harden-runtime-role.mjs` counts these sessions into the runtime
 * role's connection limit, so a change here is a change there.
 */
export const MAX_PACKAGE_OPERATIONS = 4;

/**
 * The wait a refused request is told to leave before retrying.
 *
 * There is no time the package is known to come free: an uninstall is over in
 * a moment, a theme install waits on a download. Long enough not to be refused
 * again behind the same operation, short enough that nobody waits for nothing.
 */
export const PACKAGE_BUSY_RETRY_AFTER_SECONDS = 5;

export type PackageKind = "plugin" | "theme";

/** The bounds one {@link PackageLock} works within. */
export interface PackageLockLimits {
  readonly waitMs: number;
  readonly connectMs: number;
  readonly maxOperations: number;
}

export const PACKAGE_LOCK_LIMITS: PackageLockLimits = {
  waitMs: PACKAGE_LOCK_WAIT_MS,
  connectMs: PACKAGE_LOCK_CONNECT_MS,
  maxOperations: MAX_PACKAGE_OPERATIONS,
};

/**
 * The package was not changed, because another operation had it.
 *
 * Either the operation on the same package did not finish within the wait, or
 * the process already had as many operations on packages as it admits. Both
 * mean the same to whoever asked - nothing was done, and the same request is
 * worth sending again shortly - so they share the reason. Too Many Requests
 * with a Retry-After, the answer `export-busy` gives for the same situation.
 */
export class PackageBusyError extends DomainError {
  readonly status = HttpStatus.TOO_MANY_REQUESTS;
  readonly reason = "package-busy";

  override headers(): Record<string, string> {
    return { "retry-after": String(PACKAGE_BUSY_RETRY_AFTER_SECONDS) };
  }
}

/**
 * The lock's session ended while the work under it was still running.
 *
 * Raised by the work itself, at the first write it would have made after the
 * loss, so what it wrote before is complete and nothing after it was written.
 * A server error rather than a refusal: the session ended because the database
 * or the network failed it, and that is worth a line in the log.
 */
export class PackageLockLostError extends DomainError {
  readonly status = HttpStatus.SERVICE_UNAVAILABLE;
  readonly reason = "package-lock-lost";

  constructor(kind: PackageKind, id: string, cause?: unknown) {
    super(
      `The lock on the ${kind} ${id} was lost while it was being changed, so ` +
        "the change stopped before its next write.",
      { cause },
    );
  }
}

/** What the lock's sessions call themselves in `pg_stat_activity`. */
export const PACKAGE_LOCK_APPLICATION_NAME = "openbrf-package-lock";

/** Postgres's SQLSTATE for a lock wait cut short by `lock_timeout`. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Runs install and uninstall work while holding the lock for its package.
 *
 * One per process: the queue and the count are held in memory, so a second
 * instance would neither queue behind the first nor count against its limit.
 * The application gets the one `PackagingModule` provides.
 */
export class PackageLock {
  /** The last operation queued on each package, which the next one waits for. */
  private readonly queues = new Map<string, Promise<void>>();
  private admitted = 0;
  private readonly connectionString: string;

  constructor(
    env: Env,
    private readonly limits: PackageLockLimits = PACKAGE_LOCK_LIMITS,
  ) {
    this.connectionString = applicationDatabaseUrl(env);
  }

  /**
   * Runs `work` while holding the lock for this package.
   *
   * `work` is handed the signal that says the lock was lost, and has to check
   * it - `signal.throwIfAborted()` - before every write it makes. Its reason
   * is a {@link PackageLockLostError}.
   *
   * Refuses with {@link PackageBusyError} before anything is opened when the
   * process is at its limit, and when the wait runs out.
   */
  async run<T>(
    kind: PackageKind,
    id: string,
    work: (lockLost: AbortSignal) => Promise<T>,
  ): Promise<T> {
    // Counted before the first await, so nothing is admitted between the
    // check and the count.
    if (this.admitted >= this.limits.maxOperations) {
      throw new PackageBusyError(
        `The ${kind} ${id} was not changed: this instance is already ` +
          `running ${String(this.limits.maxOperations)} package operations.`,
      );
    }
    this.admitted += 1;
    try {
      const deadline = Date.now() + this.limits.waitMs;
      const leave = await this.enqueue(kind, id, deadline);
      try {
        return await this.holdSession(kind, id, deadline, work);
      } finally {
        leave();
      }
    } finally {
      this.admitted -= 1;
    }
  }

  /**
   * Waits for the operations ahead on this package in this process, and
   * returns what lets the next one in.
   *
   * A waiter that gives up lets its place go at once, so the operation behind
   * it waits for the one still running rather than for one that has left.
   */
  private async enqueue(
    kind: PackageKind,
    id: string,
    deadline: number,
  ): Promise<() => void> {
    const key = `${kind}:${id}`;
    const ahead = this.queues.get(key) ?? Promise.resolve();
    let leave: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (leave = resolve));
    const tail = ahead.then(() => done);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) {
        this.queues.delete(key);
      }
    });

    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(this.waitedTooLong(kind, id));
        }, deadline - Date.now());
        void ahead.then(resolve);
      });
    } catch (error) {
      leave();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return leave;
  }

  /** Takes the database's lock on a session of its own and runs `work`. */
  private async holdSession<T>(
    kind: PackageKind,
    id: string,
    deadline: number,
    work: (lockLost: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const client = new Client({
      connectionString: this.connectionString,
      connectionTimeoutMillis: this.limits.connectMs,
      // So the sessions the lock holds can be told apart from the pool's in
      // `pg_stat_activity`, and counted.
      application_name: PACKAGE_LOCK_APPLICATION_NAME,
      // So a network that drops without a word is noticed by the session's
      // end rather than never.
      keepAlive: true,
    });
    const lost = new AbortController();
    let closing = false;
    const onLost = (cause?: unknown): void => {
      if (!closing) {
        lost.abort(new PackageLockLostError(kind, id, cause));
      }
    };
    // A dropped connection is reported as an event, and an event nobody
    // listens for brings the process down. Here it is the lock going away.
    client.on("error", onLost);
    client.on("end", () => onLost());

    try {
      // Inside the cleanup: a connect that fails can leave its socket open,
      // and only ending the client closes it.
      await client.connect();

      const remaining = deadline - Date.now();
      // Zero would mean no limit at all to Postgres.
      if (remaining < 1) {
        throw this.waitedTooLong(kind, id);
      }
      await client.query("SELECT set_config('lock_timeout', $1, false)", [
        String(remaining),
      ]);
      try {
        await client.query("SELECT pg_advisory_lock(hashtext($1))", [
          `package-install:${kind}:${id}`,
        ]);
      } catch (cause) {
        if ((cause as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
          throw this.waitedTooLong(kind, id, cause);
        }
        // The session ended while it waited, which is the same failure as
        // ending while it held.
        if (lost.signal.aborted) {
          throw lost.signal.reason;
        }
        throw cause;
      }
      return await work(lost.signal);
    } finally {
      // Closing the session is what releases the lock, so there is no unlock to
      // forget, and a session that could not unlock cannot go back to a pool
      // still holding it.
      closing = true;
      await client.end().catch(() => undefined);
    }
  }

  private waitedTooLong(
    kind: PackageKind,
    id: string,
    cause?: unknown,
  ): PackageBusyError {
    return new PackageBusyError(
      `The ${kind} ${id} is being changed by another operation that did not ` +
        `finish within ${String(this.limits.waitMs)}ms.`,
      { cause },
    );
  }
}
