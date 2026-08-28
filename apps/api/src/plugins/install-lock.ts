import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat, utimes } from "node:fs/promises";

/**
 * A cross-process mutex over the plugin installation tree.
 *
 * Two runs reach the same `/data/plugins` on the same volume: the admin screen
 * enqueues a reconcile the server worker runs, and the command-line tool runs
 * one of its own directly in a process of its own. A reconcile reads the
 * desired state, decides whether the tree already matches, moves the current
 * `node_modules` aside, moves its own in and then writes the metadata that
 * describes what it moved. Two of those interleaved leave the tree and the
 * metadata describing different plugin sets - and the next run believes the
 * metadata, so the disagreement survives every subsequent reconcile.
 *
 * A Postgres advisory lock cannot express it: the section to be held spans an
 * npm install, and the pooled client the application uses cannot pin one
 * connection for that long. The claim therefore lives on the same volume as
 * the thing it protects, and is held the way a staging tree is - by a file
 * whose modification time the holder keeps current.
 *
 * A crash still converges. A holder that stops renewing has, by definition,
 * stopped working, and the next run takes the claim over once a full lease has
 * passed with no sign of life. Nothing is ever left in a state that needs the
 * lock to repair: the reconcile is defined as "converge on the desired set",
 * so whoever holds it next rebuilds from the rows regardless of how the
 * previous holder stopped.
 */

/** The file that claims the tree. Named inside the installation root. */
export const INSTALL_LOCK_FILE = ".install.lock";

/**
 * How long a claim may go unrenewed before another run takes it over.
 *
 * Time since the last sign of life, not time since the run began, so a slow
 * npm install over a slow network is never mistaken for an abandoned one.
 */
const LEASE_MS = 60_000;

/** Comfortably inside the lease, so a busy event loop does not lose a claim. */
const RENEWAL_MS = 10_000;

/** How often a waiting run looks again. */
const POLL_MS = 200;

/**
 * How long a run waits for the one that holds the tree.
 *
 * Generously longer than an install, because the holder keeps the claim for
 * its whole run and a waiter that gave up early would report a failure for a
 * plugin that is being installed correctly by somebody else. It is bounded all
 * the same: a queued job that waits forever is a worker that never processes
 * anything again.
 */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** Raised when the tree cannot be claimed, or was claimed by somebody else. */
export class InstallLockError extends Error {}

export interface InstallLock {
  /**
   * Throws unless the claim is still this run's.
   *
   * Asked immediately before the first irreversible step. A run whose claim
   * was taken over stopped renewing for a full lease, which is long enough
   * that it has to assume another run has rebuilt the tree since - committing
   * over that would replace a current installation with a stale one.
   */
  assertHeld(): Promise<void>;
  /** Gives the tree up, unless another run has already taken the claim over. */
  release(): Promise<void>;
}

export interface AcquireInstallLockOptions {
  /** How long to wait for a run that is still working. */
  timeoutMs?: number;
  /** Called once, when a run finds the tree held and begins to wait. */
  onWait?: () => void;
  /** Called when a claim that stopped being renewed is taken over. */
  onTakeOver?: () => void;
}

/**
 * Claims the installation tree, waiting for whoever holds it.
 *
 * The claim is created with an exclusive create, so exactly one of any number
 * of racing runs gets it and the rest wait. The token it carries is what makes
 * releasing safe: a run only ever removes the claim it can still see is its
 * own, so a run that was taken over cannot unlock the tree for a third.
 */
export async function acquireInstallLock(
  path: string,
  options: AcquireInstallLockOptions = {},
): Promise<InstallLock> {
  const token = randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let waiting = false;

  for (;;) {
    if (await claim(path, token)) {
      return hold(path, token);
    }

    /*
     * Every path out of a failed claim passes through here and then through
     * the wait below, so the loop runs at most timeoutMs / POLL_MS times
     * whatever the claim failed on. The bound has to hold for reasons other
     * than "another run is working", because some of them never resolve: an
     * entry at this path that is not a readable file - a directory left by a
     * mis-specified volume mount - makes the exclusive create report EEXIST
     * for as long as the instance lives while there is nothing to read, and a
     * claim whose removal is refused stays exactly where it is. Neither state
     * changes on its own, so a retry that did not count against a deadline
     * would spin at full speed inside `reconcile`, holding the queue worker
     * open and leaving a board waiting for a restart that cannot come.
     */
    if (Date.now() >= deadline) {
      throw new InstallLockError(
        `The plugin installation at ${path} could not be claimed within ` +
          `${String(timeoutMs)}ms.`,
      );
    }

    const seen = await observe(path);
    if (seen !== null && seen.mtimeMs <= Date.now() - LEASE_MS) {
      if (await takeOver(path, seen)) {
        options.onTakeOver?.();
      }
    } else if (seen !== null && !waiting) {
      waiting = true;
      options.onWait?.();
    }

    await delay(POLL_MS);
  }
}

/** What the claim on disk says, or null when there is none. */
interface Claim {
  mtimeMs: number;
  token: string;
}

async function observe(path: string): Promise<Claim | null> {
  try {
    const [info, content] = await Promise.all([
      stat(path),
      readFile(path, "utf8"),
    ]);
    return { mtimeMs: info.mtimeMs, token: content.trim() };
  } catch {
    return null;
  }
}

/**
 * Creates the claim, or reports that somebody else holds it.
 *
 * `wx` is the whole of the mutual exclusion: the create either happens or
 * fails because the file is already there, with nothing in between. Any other
 * failure - an unwritable volume, a missing directory - is this run's problem
 * and is raised rather than retried until the deadline.
 */
async function claim(path: string, token: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw cause;
  }

  try {
    await handle.writeFile(`${token}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Removes a claim whose run stopped renewing it.
 *
 * Confirmed against what was seen a moment ago rather than removed outright: a
 * claim that has been renewed, given up or replaced since is a live run's and
 * is left alone, so the ordinary case cannot dispossess a working install. The
 * removal is not the take-over - the exclusive create back in the loop is, so
 * several runs finding the same abandoned claim still produce exactly one
 * holder.
 *
 * Reports whether the claim was actually removed. A removal that was refused
 * has changed nothing, and saying otherwise would have the caller announce a
 * take-over that did not happen on every pass of a loop that is getting
 * nowhere.
 */
async function takeOver(path: string, seen: Claim): Promise<boolean> {
  const again = await observe(path);
  if (
    again === null ||
    again.token !== seen.token ||
    again.mtimeMs !== seen.mtimeMs ||
    again.mtimeMs > Date.now() - LEASE_MS
  ) {
    return false;
  }

  return await rm(path, { force: true }).then(
    () => true,
    () => false,
  );
}

function hold(path: string, token: string): InstallLock {
  const renewal = setInterval(() => {
    void renew(path, token);
  }, RENEWAL_MS);
  // The claim must never be a reason the process stays up.
  renewal.unref();

  return {
    async assertHeld(): Promise<void> {
      const seen = await observe(path);
      if (seen?.token !== token) {
        throw new InstallLockError(
          `The claim on the plugin installation at ${path} was taken over ` +
            "by another run.",
        );
      }
    },

    async release(): Promise<void> {
      clearInterval(renewal);
      const seen = await observe(path);
      if (seen?.token !== token) {
        // Taken over while this run was working. Removing it now would hand
        // the tree to a third run while the second is still rebuilding it.
        return;
      }
      await rm(path, { force: true }).catch(() => {
        // A claim that cannot be removed lapses on its own once it stops
        // being renewed, so the next run takes it over rather than waiting
        // for a lock nobody holds.
      });
    },
  };
}

/** Says the run is alive, and notices if the claim is no longer its own. */
async function renew(path: string, token: string): Promise<void> {
  const seen = await observe(path);
  if (seen?.token !== token) {
    return;
  }
  const now = new Date();
  await utimes(path, now, now).catch(() => {
    // Nothing to renew. `assertHeld` is what stops the run committing.
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
