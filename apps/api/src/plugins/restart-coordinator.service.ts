import { utimes } from "node:fs/promises";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";

/**
 * Something that can be closed so in-flight requests finish. INestApplication
 * satisfies it; a test double is two lines.
 */
export interface ClosableApplication {
  close(): Promise<void>;
}

const COMMIT_POLL_INTERVAL_MS = 100;
const COMMIT_POLL_ATTEMPTS = 100;

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
  private requested = false;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Called from the bootstrap once the application exists. */
  bind(application: ClosableApplication): void {
    this.application = application;
  }

  /** Whether a restart has been asked for. Read by the health endpoint. */
  get restartRequested(): boolean {
    return this.requested;
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
    this.requested = true;

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
    try {
      await this.application?.close();
    } catch (cause) {
      this.logger.warn(`Shutdown was not clean: ${String(cause)}`);
    }
    // Zero, not a failure code: the install worked. A supervisor configured
    // with `restart: unless-stopped` starts the replacement either way, and a
    // non-zero code would read as a crash in every log that collects them.
    process.exit(0);
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
