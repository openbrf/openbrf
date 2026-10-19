import { setTimeout as delay } from "node:timers/promises";

import { appStartedAt, runInNewAppContainer, stack } from "./stack";

/**
 * Driving the plugin system from outside the instance.
 *
 * Installing or removing a plugin ends with the server replacing its own
 * process: it exits once the install job has committed and the supervisor
 * starts it again. A spec has to be able to tell that replacement from the
 * process that answered before it, and a health check alone cannot - the old
 * process answers it too, right up to the moment it exits. So the question is
 * asked of both: Docker says when the container's current process started, and
 * the health endpoint says whether that process is serving yet.
 */

/** How long a restart may take before a spec gives up on it. */
const RESTART_TIMEOUT_MS = 3 * 60_000;

/** How often the restart is looked for. */
const RESTART_POLL_MS = 1000;

/** Whether the process now serving answers its health check. */
async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${stack.baseUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Waits until a process started after `since` answers its health check, and
 * returns when it started.
 *
 * `since` is a start time read from Docker as well, never the clock of the
 * machine driving the suite, so the two are compared on the same clock.
 */
export async function waitForRestart(since: Date): Promise<Date> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  let startedAt: Date | null = null;

  while (Date.now() < deadline) {
    try {
      startedAt = appStartedAt();
    } catch {
      // Between two processes Docker can briefly have nothing to report.
      startedAt = null;
    }
    if (
      startedAt !== null &&
      startedAt.getTime() > since.getTime() &&
      (await healthy())
    ) {
      return startedAt;
    }
    await delay(RESTART_POLL_MS);
  }

  throw new Error(
    `No process started after ${since.toISOString()} answered its health ` +
      `check within ${String(RESTART_TIMEOUT_MS / 1000)} s; the container's ` +
      `current process started at ${startedAt?.toISOString() ?? "an unknown time"}.`,
  );
}

/** How long one command-line run may take, the entrypoint's steps included. */
const CLI_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs the instance's command-line tool, the way an operator does.
 *
 * The tool is not on the image's PATH: it is `dist/cli/main.js`, run from the
 * image's working directory. It runs in a container of its own that goes
 * through the entrypoint, because that is what hands it the runtime database
 * URL and takes the owner's credentials away before it starts. The server keeps
 * running beside it and restarts itself once it picks up the job the tool
 * queued.
 */
export function cli(args: readonly string[]): {
  status: number;
  output: string;
} {
  return runInNewAppContainer(
    ["node", "dist/cli/main.js", ...args],
    CLI_TIMEOUT_MS,
  );
}
