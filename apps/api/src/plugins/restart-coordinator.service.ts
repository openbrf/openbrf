import { randomUUID } from "node:crypto";
import { utimes } from "node:fs/promises";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { failureName } from "../logging/failure";

/**
 * Something that can be closed so in-flight requests finish. INestApplication
 * satisfies it; a test double is two lines.
 */
export interface ClosableApplication {
  close(): Promise<void>;
}

const COMMIT_POLL_INTERVAL_MS = 100;
const COMMIT_POLL_ATTEMPTS = 100;

/** How long in-flight requests are given before the process exits anyway. */
export const DRAIN_TIMEOUT_MS = 10_000;

/**
 * Restarting the process after an install.
 *
 * Installing a plugin adds code the running process cannot load, so the
 * process has to be replaced. The order of the last four steps is the whole of
 * the correctness argument, and it is the plan's:
 *
 *   1. Move the installed package into place.
 *   2. Mark the pg-boss job complete and WAIT for that to be committed.
 *   3. Drain in-flight HTTP.
 *   4. Exit, and let the supervisor start a fresh process.
 *
 * Step 2 before step 4 is not a nicety. Exiting before the completion commits
 * leaves the job visible for retry, so the new process runs the install again,
 * exits again, and the container loops - an outage produced by the feature
 * that was supposed to add one plugin.
 *
 * In development there is no supervisor. The dev process runs under
 * `node --watch`, which restarts on a file change and NOT on an exit, so the
 * simulation is to touch the entry file: the watcher then replaces the process
 * exactly as a supervisor would.
 */
@Injectable()
export class RestartCoordinator {
  private readonly logger = new Logger(RestartCoordinator.name);
  private application: ClosableApplication | null = null;
  /** The restart-ending jobs accepted here that have not reached the restart. */
  private readonly owed = new Set<string>();
  /** Set once a restart has been handed over; never cleared. */
  private handedOver = false;

  /**
   * Tells this process from the one that replaces it.
   *
   * Opaque, and new in every process. The process on its way out keeps
   * answering for as long as its install job runs and its drain lasts, so a
   * reader waiting for the replacement needs something that changes when the
   * process does; a flag the outgoing process sets can only say what that
   * process knows.
   */
  readonly processId = randomUUID();

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Called from the bootstrap once the application exists. */
  bind(application: ClosableApplication): void {
    this.application = application;
  }

  /**
   * Whether this process is to be replaced.
   *
   * True from the moment an operation that ends in a restart is accepted, and
   * not only once its job hands over to {@link restartWhenCommitted}: the job
   * runs a whole reconcile first, npm included, and a process answering
   * "nothing pending" through that window reads as the replacement already
   * serving. Once a restart has been handed over it is never cleared, because
   * the change that asked for it takes effect only in the next process, and
   * only that process starts without it.
   *
   * Counted per job rather than held as one flag. A job that fails for good
   * before the restart replaces nothing, and a flag it could not clear would
   * report a restart for the rest of the process; a flag it did clear would
   * hide another job's restart still on its way.
   */
  get restartPending(): boolean {
    return this.handedOver || this.owed.size > 0;
  }

  /**
   * Records that a job ending in a restart has been accepted.
   *
   * Called where the reconcile is queued and again where a worker picks it
   * up, so a run the command-line tool queued reads as pending here as well
   * from the moment this process starts on it. The id makes the second call
   * the same obligation as the first.
   */
  expectRestart(jobId: string): void {
    this.owed.add(jobId);
  }

  /**
   * Releases a job that failed and will not be retried.
   *
   * Only its own restart: another job accepted meanwhile still owes one.
   */
  abandonRestart(jobId: string): void {
    this.owed.delete(jobId);
  }

  /**
   * Waits for the job completion to commit, then replaces the process.
   *
   * Never throws: this runs after the install has already succeeded, and a
   * failure to restart is a state the next boot resolves, not a reason to
   * unwind work that is already on the volume.
   */
  async restartWhenCommitted(
    isCommitted: () => Promise<boolean>,
  ): Promise<void> {
    this.handedOver = true;

    for (let attempt = 0; attempt < COMMIT_POLL_ATTEMPTS; attempt += 1) {
      let committed = false;
      try {
        committed = await isCommitted();
      } catch (cause) {
        this.logger.warn(
          `Could not read back the install job's state: ${String(cause)}`,
        );
      }
      if (committed) {
        await this.restart();
        return;
      }
      await delay(COMMIT_POLL_INTERVAL_MS);
    }

    // Refusing to restart is the safe direction. The install is on the volume
    // and the next boot loads it; restarting now with the job still pending
    // would make the new process repeat the install and exit again.
    this.logger.error(
      "The install job did not read back as completed, so the process was " +
        "not restarted. The plugin is installed and will load at the next " +
        "restart.",
    );
  }

  private async restart(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Tests assert that a restart was requested; actually exiting would take
      // the test runner with it.
      this.logger.log("Restart requested (suppressed in test).");
      return;
    }

    if (this.env.NODE_ENV !== "production") {
      const touched = await touchEntryFile();
      if (touched) {
        this.logger.log(
          "Plugin installed. Touched the entry file so the development " +
            "watcher restarts the process.",
        );
        return;
      }
      this.logger.warn(
        "Plugin installed, but the entry file could not be touched. Restart " +
          "the API to load it.",
      );
      return;
    }

    this.logger.log("Plugin installed. Draining and exiting for a restart.");
    const outcome = await drain(this.application, DRAIN_TIMEOUT_MS);
    if (outcome.kind === "failed") {
      this.logger.warn(`Shutdown was not clean: ${outcome.detail}`);
    } else if (outcome.kind === "timed-out") {
      this.logger.warn(
        "In-flight requests did not finish within the drain timeout; " +
          "exiting anyway so the replacement process starts.",
      );
    }
    // Zero, not a failure code: the install worked. A supervisor configured
    // with `restart: unless-stopped` starts the replacement either way, and a
    // non-zero code would read as a crash in every log that collects them.
    process.exit(0);
  }
}

export type DrainOutcome =
  | { kind: "closed" }
  | { kind: "timed-out" }
  | { kind: "failed"; detail: string };

/**
 * Closes the application, or gives up on it.
 *
 * `close()` waits for in-flight HTTP to finish, and a keep-alive or a slow
 * connection can hold it open with no bound. A hang is not a rejection, so a
 * try/catch does not reach it: the exit below would simply never run, the
 * replacement process would never start, and the installed plugin would never
 * load - while the board watches a restart notice that has no end state. That
 * is the exact failure the restart contract exists to avoid, so the deadline
 * wins and the process exits either way. Exiting on the deadline is the same
 * outcome a supervisor's own shutdown timeout produces, and the job
 * completion has already been committed by this point.
 *
 * Exported for its test: the caller ends by replacing the process, which a
 * test runner cannot survive.
 */
export async function drain(
  application: ClosableApplication | null,
  timeoutMs: number,
): Promise<DrainOutcome> {
  if (application === null) {
    return { kind: "closed" };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DrainOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "timed-out" });
    }, timeoutMs);
  });

  const closing = application.close().then(
    (): DrainOutcome => ({ kind: "closed" }),
    // Closing runs every module's shutdown hook, a loaded plugin's included,
    // so what a rejection says is the plugin's own text. The caller logs this,
    // and the class of the failure is what it is entitled to.
    (cause: unknown): DrainOutcome => ({
      kind: "failed",
      detail: failureName(cause),
    }),
  );

  try {
    return await Promise.race([closing, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Touches the entry file so `node --watch` replaces the process.
 *
 * process.argv[1] is the script the watcher is watching, which is the file
 * whose mtime it reacts to.
 */
async function touchEntryFile(): Promise<boolean> {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    const now = new Date();
    await utimes(entry, now, now);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
