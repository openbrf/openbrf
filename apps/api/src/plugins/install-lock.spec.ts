import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireInstallLock,
  INSTALL_LOCK_FILE,
  InstallLockError,
} from "./install-lock";

/**
 * The claim on the installation tree.
 *
 * Two processes reach the same `/data/plugins`: the server worker consuming
 * the queue the admin screen enqueues onto, and the command-line tool
 * reconciling directly. What follows is the whole of the rule that keeps them
 * apart - one run holds the tree, the rest wait, and a run that stopped
 * renewing its claim is the only kind another run may take over.
 *
 * Driven against a real directory, because what is under test is entirely
 * about which of two runs is allowed to touch a file.
 */

const AN_HOUR = 60 * 60 * 1000;

let root: string;
let lockPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbrf-install-lock-"));
  lockPath = join(root, INSTALL_LOCK_FILE);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** A claim left by a run that stopped renewing it. */
async function abandonedClaim(token: string): Promise<void> {
  await writeFile(lockPath, `${token}\n`, "utf8");
  const stopped = new Date(Date.now() - AN_HOUR);
  await utimes(lockPath, stopped, stopped);
}

describe("acquireInstallLock", () => {
  it("lets exactly one of several racing runs in", async () => {
    const attempts = [0, 1, 2, 3].map(() =>
      acquireInstallLock(lockPath, { timeoutMs: 10 }),
    );

    const results = await Promise.allSettled(attempts);
    const held = results.filter((result) => result.status === "fulfilled");

    expect(held).toHaveLength(1);
    for (const result of held) {
      await result.value.release();
    }
  });

  /**
   * The property the whole thing exists for. The second run must not begin
   * while the first is between moving a tree into place and writing the
   * metadata that says what it moved.
   */
  it("makes a second run wait until the first gives the tree up", async () => {
    const first = await acquireInstallLock(lockPath);
    const order: string[] = [];

    const waiting = acquireInstallLock(lockPath, { timeoutMs: 10_000 }).then(
      (lock) => {
        order.push("second run");
        return lock;
      },
    );

    // Comfortably longer than the interval a waiting run looks again on, so a
    // run that could get in would have done by now.
    await delay(600);
    order.push("first run finished");
    await first.release();
    const second = await waiting;

    expect(order).toEqual(["first run finished", "second run"]);
    await second.release();
  });

  it("says the tree is held rather than waiting for it forever", async () => {
    // A queued job that waited without bound is a worker that never processes
    // anything again.
    await writeFile(lockPath, "another-run\n", "utf8");

    await expect(
      acquireInstallLock(lockPath, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(InstallLockError);
    // Left exactly as it was: a claim being renewed is not this run's to break.
    expect(await readFile(lockPath, "utf8")).toContain("another-run");
  });

  /**
   * A killed process leaves its claim behind. If nothing could ever take it
   * over the instance would refuse to install anything again, which is the one
   * outcome the convergence rule does not allow.
   */
  it("takes over a claim whose run stopped renewing", async () => {
    await abandonedClaim("a-run-that-was-killed");
    let tookOver = false;

    const lock = await acquireInstallLock(lockPath, {
      timeoutMs: 5_000,
      onTakeOver: () => {
        tookOver = true;
      },
    });

    expect(tookOver).toBe(true);
    expect(await readFile(lockPath, "utf8")).not.toContain(
      "a-run-that-was-killed",
    );
    await lock.release();
  });

  it("does not report a take-over when the tree was simply free", async () => {
    let tookOver = false;

    const lock = await acquireInstallLock(lockPath, {
      onTakeOver: () => {
        tookOver = true;
      },
    });

    expect(tookOver).toBe(false);
    await lock.release();
  });
});

describe("a claim that was taken over", () => {
  /**
   * The run stalled long enough to lose the tree and then came back. It must
   * not commit: another run has rebuilt the tree since, and this one would be
   * writing metadata for a set that is no longer on the volume.
   */
  it("refuses to let its run commit", async () => {
    const stalled = await acquireInstallLock(lockPath);
    await expect(stalled.assertHeld()).resolves.toBeUndefined();

    const stopped = new Date(Date.now() - AN_HOUR);
    await utimes(lockPath, stopped, stopped);
    const other = await acquireInstallLock(lockPath, { timeoutMs: 5_000 });

    await expect(stalled.assertHeld()).rejects.toBeInstanceOf(InstallLockError);
    await other.release();
  });

  it("is not given away when its own run finishes", async () => {
    const stalled = await acquireInstallLock(lockPath);
    const stopped = new Date(Date.now() - AN_HOUR);
    await utimes(lockPath, stopped, stopped);
    const other = await acquireInstallLock(lockPath, { timeoutMs: 5_000 });

    await stalled.release();

    // The run that has the tree still has it. A release that removed whatever
    // claim it found would hand the tree to a third run mid-rebuild.
    await expect(
      acquireInstallLock(lockPath, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(InstallLockError);
    await other.release();
  });
});
