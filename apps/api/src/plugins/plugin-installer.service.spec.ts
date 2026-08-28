import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDependencySet,
  collectAbandonedStaging,
} from "./plugin-installer.service";

/**
 * The staging root is shared between processes.
 *
 * `PluginAdminService.install()` enqueues a reconcile the server worker runs;
 * the command-line tool calls the installer directly. Both reach the same
 * directory on the same volume, so a run that emptied it would delete a live
 * run's archives mid-copy and fail an install that was doing nothing wrong.
 * What follows is the whole of the rule that replaces "empty it": a tree is
 * another run's until its lease stops being renewed.
 *
 * Driven against a real directory, because what is under test is entirely
 * about which files survive.
 */

const AN_HOUR = 60 * 60 * 1000;

let staging: string;

beforeEach(async () => {
  staging = await mkdtemp(join(tmpdir(), "openbrf-staging-"));
});

afterEach(async () => {
  await rm(staging, { recursive: true, force: true });
});

/** A staging tree with a lease last renewed `agoMs` ago. */
async function tree(name: string, agoMs: number | null): Promise<string> {
  const path = join(staging, name);
  await mkdir(join(path, "archives"), { recursive: true });
  await writeFile(join(path, "archives", "occupancy-1.4.0.tgz"), "bytes");
  if (agoMs !== null) {
    const lease = `${path}.lease`;
    await writeFile(lease, "held");
    const at = new Date(Date.now() - agoMs);
    await utimes(lease, at, at);
  }
  return path;
}

const remaining = (): Promise<string[]> => readdir(staging);

describe("collectAbandonedStaging", () => {
  it("leaves a tree whose run is still renewing its lease", async () => {
    // The decisive case. This is another process mid-install, and the archives
    // it has copied so far are exactly what a blanket prune would remove.
    await tree("run-live", 0);

    expect(await collectAbandonedStaging(staging)).toEqual([]);
    expect(await remaining()).toContain("run-live");
  });

  it("collects a tree whose run stopped renewing", async () => {
    const abandoned = await tree("run-killed", AN_HOUR);

    expect(await collectAbandonedStaging(staging)).toEqual([abandoned]);
    expect(await remaining()).toEqual([]);
  });

  it("collects a tree that never held a lease", async () => {
    // Written by a version that kept no lease, or by a run killed between
    // creating the tree and claiming it. Either way nothing is working in it:
    // the lease is written first precisely so this is unambiguous.
    const orphan = await tree("run-unclaimed", null);

    expect(await collectAbandonedStaging(staging)).toEqual([orphan]);
    expect(await remaining()).toEqual([]);
  });

  it("collects a lapsed lease whose tree is already gone", async () => {
    await writeFile(join(staging, "run-halfway.lease"), "held");
    const at = new Date(Date.now() - AN_HOUR);
    await utimes(join(staging, "run-halfway.lease"), at, at);

    // Removed, but not reported: no tree was reclaimed, and a log line saying
    // one was would send an operator looking for an install that never was.
    expect(await collectAbandonedStaging(staging)).toEqual([]);
    expect(await remaining()).toEqual([]);
  });

  it("collects only the abandoned tree when a live run is beside it", async () => {
    const live = await tree("run-live", 0);
    const abandoned = await tree("run-killed", AN_HOUR);

    expect(await collectAbandonedStaging(staging)).toEqual([abandoned]);
    expect((await remaining()).sort()).toEqual(["run-live", "run-live.lease"]);
    expect(live).toBe(join(staging, "run-live"));
  });

  it("does not touch what it did not put there", async () => {
    await mkdir(join(staging, "something-else"));
    await writeFile(join(staging, "notes.txt"), "not ours");

    await collectAbandonedStaging(staging);

    expect((await remaining()).sort()).toEqual(["notes.txt", "something-else"]);
  });

  it("says nothing was collected when the root does not exist yet", async () => {
    expect(await collectAbandonedStaging(join(staging, "never-used"))).toEqual(
      [],
    );
  });
});

describe("buildDependencySet", () => {
  it("records each archive by file name rather than by absolute path", () => {
    // The comparison against a previous run has to survive the data directory
    // being mounted somewhere else, which is what happens between a
    // development machine and a container.
    const set = buildDependencySet(
      new Map([
        [
          "openbrf-plugin-occupancy",
          "/data/plugins/archives/occupancy-1.4.0.tgz",
        ],
        ["openbrf-plugin-notices", "/data/plugins/archives/notices-0.2.0.tgz"],
      ]),
    );

    expect(set).toEqual({
      "openbrf-plugin-notices": "file:./archives/notices-0.2.0.tgz",
      "openbrf-plugin-occupancy": "file:./archives/occupancy-1.4.0.tgz",
    });
    expect(Object.keys(set)).toEqual([
      "openbrf-plugin-notices",
      "openbrf-plugin-occupancy",
    ]);
  });
});
