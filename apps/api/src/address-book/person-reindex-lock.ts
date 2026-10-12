import { Inject, Injectable } from "@nestjs/common";
import { Client } from "pg";

import { ENV } from "../config/config.module";
import { applicationDatabaseUrl, type Env } from "../config/env";

/**
 * The lock a run of the reindex holds from its first row to its last, so one
 * run at a time walks the register.
 *
 * Every boot queues a run, and a run that does not finish queues the next, and
 * the queue hands them to whichever instance asks first: without this, two can
 * walk the same rows at once. Each row's write is safe from the other's - it
 * takes the row's identity number keys and checks the ciphertexts it was
 * computed from - but both would spend the Argon2id, wait for the same import
 * chunks, and each queue a run of its own when it fails. The keys of single
 * rows cannot keep two runs apart; only a key for the whole run can.
 *
 * Taken rather than waited for: a run that finds it held leaves the rows to
 * the run that holds it, which reads until none is left below the current
 * version, and queues the next run itself if it fails. A row written after it
 * began has the current version already, so it leaves nothing behind for the
 * run that gave way.
 *
 * Held on a session of its own, outside the application's pool, for the
 * reasons `packaging/package-lock.ts` gives: the run writes each row in a
 * transaction of its own, so the lock cannot share one with it, and a
 * transaction opened only to hold the lock would be ended by Prisma at its
 * timeout while the run went on. A session lock is released by closing the
 * session, and a crash closes it too, so a restart's run is not kept waiting
 * by the run of a process that has gone.
 *
 * The session can end while the run goes on: the server ends the backend, the
 * network drops. The database then hands the lock to the next run that asks,
 * so the run is given a signal that is aborted the moment the session is lost,
 * and checks it before each row's write.
 *
 * `docker/harden-runtime-role.mjs` counts this session into the runtime role's
 * connection limit.
 */

/** The key the run takes, as `pg_try_advisory_lock(hashtext(...))` takes it. */
export const PERSON_REINDEX_LOCK_KEY = "person-reindex:run";

/** What the lock's session calls itself in `pg_stat_activity`. */
export const PERSON_REINDEX_LOCK_APPLICATION_NAME = "openbrf-reindex-lock";

/**
 * How long opening the lock's session may take. The driver's default is no
 * limit at all.
 */
const CONNECT_MS = 10_000;

/** The lock's session ended while the run held it. */
export class PersonReindexLockLostError extends Error {
  constructor(cause?: unknown) {
    super(
      "The reindex lost its lock, so the run stopped before its next write.",
      { cause },
    );
    this.name = "PersonReindexLockLostError";
  }
}

@Injectable()
export class PersonReindexLock {
  private readonly connectionString: string;

  constructor(@Inject(ENV) env: Env) {
    this.connectionString = applicationDatabaseUrl(env);
  }

  /**
   * Runs `work` while holding the lock, and answers true; answers false
   * without running it when another run holds the lock.
   *
   * `work` is handed the signal that says the lock was lost, and has to check
   * it before every write it makes. Its reason is a
   * {@link PersonReindexLockLostError}.
   */
  async whileHeld(
    work: (lockLost: AbortSignal) => Promise<void>,
  ): Promise<boolean> {
    const client = new Client({
      connectionString: this.connectionString,
      connectionTimeoutMillis: CONNECT_MS,
      application_name: PERSON_REINDEX_LOCK_APPLICATION_NAME,
      // So a network that drops without a word is noticed by the session's
      // end rather than never.
      keepAlive: true,
    });
    const lost = new AbortController();
    let closing = false;
    const onLost = (cause?: unknown): void => {
      if (!closing && !lost.signal.aborted) {
        lost.abort(new PersonReindexLockLostError(cause));
      }
    };
    // A dropped connection is reported as an event, and an event nobody
    // listens for brings the process down. Here it is the lock going away.
    client.on("error", onLost);
    client.on("end", () => {
      onLost();
    });

    try {
      // Inside the cleanup: a connect that fails can leave its socket open,
      // and only ending the client closes it.
      await client.connect();
      const { rows } = await client.query<{ held: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS held",
        [PERSON_REINDEX_LOCK_KEY],
      );
      if (rows[0]?.held !== true) {
        return false;
      }
      await work(lost.signal);
      return true;
    } finally {
      // Closing the session is what releases the lock, so there is no unlock
      // to forget.
      closing = true;
      await client.end().catch(() => undefined);
    }
  }
}
