import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import { npmInstall } from "../packaging/npm-install";
import {
  ARCHIVE_TIMEOUT_MS,
  assertStagedPackages,
  buildDependencySet,
  collectAbandonedStaging,
  FETCH_BUDGET_MS,
  type PluginInstallJob,
  PluginInstallerService,
  type ReconcileOutcome,
} from "./plugin-installer.service";
import type { PluginRecord } from "./plugin-registry.service";
import { RestartCoordinator } from "./restart-coordinator.service";

// Whether npm is started at all is what some of the specs below observe.
vi.mock("../packaging/npm-install", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  npmInstall: vi.fn(),
}));

const exec = promisify(execFile);

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

/**
 * The staged tree is checked against the consent rows before it is moved into
 * place. npm installs an archive under the name it is handed, so a verified
 * archive that holds another package, or another release, would otherwise be
 * marked installed and then refused by the loader at every boot.
 */
describe("assertStagedPackages", () => {
  const consented = new Map([["openbrf-plugin-occupancy", "1.4.0"]]);

  async function staged(packageJson: Record<string, unknown>): Promise<void> {
    const directory = join(staging, "openbrf-plugin-occupancy");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify(packageJson),
    );
  }

  it("accepts the package consented to", async () => {
    await staged({
      name: "openbrf-plugin-occupancy",
      version: "1.4.0",
      dependencies: {},
    });

    await expect(
      assertStagedPackages(staging, consented),
    ).resolves.toBeUndefined();
  });

  it("refuses an archive that holds another package", async () => {
    await staged({ name: "@someone-else/occupancy", version: "1.4.0" });

    await expect(assertStagedPackages(staging, consented)).rejects.toThrow(
      "The archive for openbrf-plugin-occupancy@1.4.0 holds @someone-else/occupancy@1.4.0.",
    );
  });

  it("refuses an archive that holds another version", async () => {
    await staged({ name: "openbrf-plugin-occupancy", version: "1.3.0" });

    await expect(assertStagedPackages(staging, consented)).rejects.toThrow(
      "holds openbrf-plugin-occupancy@1.3.0",
    );
  });

  it("refuses an archive that declares a runtime dependency", async () => {
    await staged({
      name: "openbrf-plugin-occupancy",
      version: "1.4.0",
      dependencies: "left-pad",
    });

    await expect(assertStagedPackages(staging, consented)).rejects.toThrow(
      /is not an installable plugin package: dependencies: /,
    );
  });

  it("refuses a tree the archive is missing from", async () => {
    await expect(assertStagedPackages(staging, consented)).rejects.toThrow(
      "was not installed as a package",
    );
  });

  it("refuses a package npm brought in beside the consented ones", async () => {
    await staged({ name: "openbrf-plugin-occupancy", version: "1.4.0" });
    await mkdir(join(staging, "local-package"));
    await mkdir(join(staging, "@scope", "other"), { recursive: true });

    await expect(assertStagedPackages(staging, consented)).rejects.toThrow(
      "npm installed packages no archive was consented for: @scope/other, local-package.",
    );
  });

  it("accepts a scoped package and npm's own bookkeeping", async () => {
    const directory = join(staging, "@openbrf", "plugin-occupancy");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "@openbrf/plugin-occupancy", version: "1.4.0" }),
    );
    await writeFile(join(staging, ".package-lock.json"), "{}");
    await mkdir(join(staging, ".bin"));

    await expect(
      assertStagedPackages(
        staging,
        new Map([["@openbrf/plugin-occupancy", "1.4.0"]]),
      ),
    ).resolves.toBeUndefined();
  });
});

/**
 * npm acts on what an archive's package.json declares before the staged tree
 * can be read: offline, a `file:` dependency still resolves, and npm links a
 * package from elsewhere on the volume into the staging tree. So an archive's
 * package.json is read from the archive, and a package declaring anything is
 * refused before npm is started at all.
 */
describe("the archives handed to npm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(npmInstall).mockReset();
  });

  /** A verified-looking record for a package npm packs from `packageJson`. */
  async function packed(
    packageJson: Record<string, unknown>,
  ): Promise<{ record: PluginRecord; bytes: Buffer }> {
    const source = join(staging, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify(packageJson));
    const { stdout } = await exec(
      "npm",
      ["pack", "--json", "--pack-destination", staging],
      { cwd: source },
    );
    const name = (JSON.parse(stdout) as { filename: string }[])[0]?.filename;
    const bytes = await readFile(join(staging, name ?? ""));
    const record = {
      id: "occupancy",
      packageName: String(packageJson.name),
      version: String(packageJson.version),
      tarballUrl:
        "https://github.com/openbrf/occupancy/releases/download/v1.0.0/occupancy.tgz",
      checksum: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    } as PluginRecord;
    return { record, bytes };
  }

  function reconcile(record: PluginRecord, bytes: Buffer) {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(bytes)));
    const failed: string[] = [];
    const service = new PluginInstallerService(
      { OPENBRF_DATA_DIR: join(staging, "data") } as Env,
      {
        list: () => Promise.resolve([record]),
        markFailed: (id: string) => {
          failed.push(id);
          return Promise.resolve();
        },
        markInstalled: () => Promise.resolve(),
      } as never,
      {} as never,
      {
        allowsUncuratedSources: () => false,
        authorizationFor: () => ({}),
      } as never,
      {} as never,
      {} as never,
    );
    return { outcome: service.reconcile(), failed };
  }

  it("refuses a local dependency without starting npm", async () => {
    const outside = join(staging, "outside");
    await mkdir(outside);
    await writeFile(
      join(outside, "package.json"),
      JSON.stringify({ name: "local-package", version: "1.0.0" }),
    );
    const { record, bytes } = await packed({
      name: "openbrf-plugin-occupancy",
      version: "1.0.0",
      dependencies: { "local-package": `file:${outside}` },
    });

    const attempt = reconcile(record, bytes);
    const outcome = await attempt.outcome;

    expect(npmInstall).not.toHaveBeenCalled();
    expect(outcome.changed).toBe(false);
    expect(outcome.failed).toEqual([
      {
        id: "occupancy",
        error: expect.stringMatching(
          /openbrf-plugin-occupancy is not an installable plugin package: dependencies: /,
        ) as string,
      },
    ]);
    expect(attempt.failed).toEqual(["occupancy"]);
  });

  it("hands npm an archive that declares nothing", async () => {
    const { record, bytes } = await packed({
      name: "openbrf-plugin-occupancy",
      version: "1.0.0",
    });
    vi.mocked(npmInstall).mockImplementation(async ({ cwd }) => {
      const directory = join(cwd, "node_modules", "openbrf-plugin-occupancy");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: "openbrf-plugin-occupancy", version: "1.0.0" }),
      );
    });

    const outcome = await reconcile(record, bytes).outcome;

    expect(npmInstall).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ failed: [], changed: true });
  });
});

/**
 * A reconcile this process did not accept.
 *
 * The command-line tool queues the run the server's worker performs, and the
 * restart that run ends in is this process's. Unmarked by the worker, the
 * overview would report nothing pending for as long as the reconcile takes -
 * npm included, or waiting for the tool's own run to let go of the tree.
 */
describe("the queue worker", () => {
  type Batch = {
    id: string;
    data: PluginInstallJob;
    retryCount: number;
    retryLimit: number;
  }[];
  type Handler = (batch: Batch) => Promise<void>;

  /** A worker whose reconcile is `reconcile`, and the coordinator it marks. */
  async function worker(
    reconcile: () => Promise<ReconcileOutcome>,
  ): Promise<{ handler: Handler; restart: RestartCoordinator }> {
    let handler: Handler | undefined;
    const jobs = {
      ensureQueue: async () => undefined,
      instance: {
        work: async (_queue: string, _options: object, registered: Handler) => {
          handler = registered;
        },
      },
    };

    class Reconciling extends PluginInstallerService {
      override reconcile(): Promise<ReconcileOutcome> {
        return reconcile();
      }
    }

    const env = {
      NODE_ENV: "production",
      OPENBRF_PLUGINS_ENABLED: true,
    } as unknown as Env;
    const restart = new RestartCoordinator(env);
    await new Reconciling(
      env,
      {} as never,
      jobs as never,
      {} as never,
      restart,
      {} as never,
    ).onModuleInit();

    if (handler === undefined) {
      throw new Error("no worker was registered");
    }
    return { handler, restart };
  }

  const outcome = (changed: boolean): ReconcileOutcome => ({
    installed: [],
    failed: changed ? [] : [{ id: "occupancy", error: "no archive" }],
    changed,
  });

  const install = (id: string, retryCount: number, retryLimit = 2): Batch => [
    {
      id,
      data: { reason: "install:occupancy", restart: true },
      retryCount,
      retryLimit,
    },
  ];

  it("reports the restart a run ends in while the run is still reconciling", async () => {
    // A reconcile that never finishes, so the run is held inside it.
    const { handler, restart } = await worker(
      () => new Promise<ReconcileOutcome>(() => undefined),
    );

    void handler(install("job-1", 0));

    expect(restart.restartPending).toBe(true);
  });

  /*
   * The run a boot queues when the volume does not match. A tree the reconcile
   * cannot fix - an upgrade whose archive cannot be fetched, say - would
   * otherwise restart the instance into the same tree on every boot.
   */
  describe("the run a boot queues", () => {
    const boot: Batch = [
      {
        id: "job-1",
        data: { reason: "boot", restart: true, onlyIfChanged: true },
        retryCount: 0,
        retryLimit: 2,
      },
    ];

    it("does not restart when it changed nothing", async () => {
      const { handler, restart } = await worker(() =>
        Promise.resolve(outcome(false)),
      );
      const restarting = vi
        .spyOn(restart, "restartWhenCommitted")
        .mockResolvedValue(undefined);

      await handler(boot);

      expect(restarting).not.toHaveBeenCalled();
      expect(restart.restartPending).toBe(false);
    });

    it("restarts when it rebuilt the tree", async () => {
      const { handler, restart } = await worker(() =>
        Promise.resolve(outcome(true)),
      );
      const restarting = vi
        .spyOn(restart, "restartWhenCommitted")
        .mockResolvedValue(undefined);

      await handler(boot);

      expect(restarting).toHaveBeenCalledOnce();
    });
  });

  it("restarts after an install that changed nothing", async () => {
    // The command-line tool reconciles itself and then leaves the queued run
    // to the server, which finds the tree already in place and still has to
    // restart to serve it.
    const { handler, restart } = await worker(() =>
      Promise.resolve(outcome(false)),
    );
    const restarting = vi
      .spyOn(restart, "restartWhenCommitted")
      .mockResolvedValue(undefined);

    await handler(install("job-1", 0));

    expect(restarting).toHaveBeenCalledOnce();
  });

  /*
   * A run that fails for good replaces nothing, and a restart it left pending
   * would keep the screen's restart notice up for the rest of the process.
   */
  describe("when the reconcile fails", () => {
    const failing = (): Promise<ReconcileOutcome> =>
      Promise.reject(new Error("npm failed"));

    it("still reports the restart while the run has retries left", async () => {
      const { handler, restart } = await worker(failing);

      await expect(handler(install("job-1", 1))).rejects.toThrow("npm failed");

      expect(restart.restartPending).toBe(true);
    });

    it("stops reporting it once the last attempt has failed", async () => {
      const { handler, restart } = await worker(failing);

      await expect(handler(install("job-1", 2))).rejects.toThrow("npm failed");

      expect(restart.restartPending).toBe(false);
    });

    it("keeps reporting the restart another run still owes", async () => {
      const { handler, restart } = await worker(failing);
      restart.expectRestart("job-2");

      await expect(handler(install("job-1", 2))).rejects.toThrow("npm failed");

      expect(restart.restartPending).toBe(true);
    });
  });
});

/**
 * The archive downloads.
 *
 * The byte cap bounds size, not time. A release host that sends its headers
 * and then stalls would otherwise hold the install job - and every run waiting
 * for the tree behind it - for as long as it cared to. And the archives are
 * fetched one after another, so the bound that matters is the run's, not one
 * archive's: the job expires under a run that outlasts it.
 */
describe("the archive downloads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const releaseUrl = (id: string): string =>
    `https://github.com/openbrf/${id}/releases/download/v1.0.0/${id}.tgz`;

  const record = (id: string, checksum = "sha512-unused"): PluginRecord =>
    ({
      id,
      packageName: `openbrf-plugin-${id}`,
      version: "1.0.0",
      tarballUrl: releaseUrl(id),
      checksum,
    }) as PluginRecord;

  /** A body that starts and never sends a byte. */
  const stalled = (): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }),
    );

  /**
   * An installer over `records`, whose release hosts answer with `answer`.
   *
   * `fetched` settles once the download of the named archive has begun, which
   * is after its deadline has started running: only then may a spec move the
   * clock, or the deadline would start late and the spec prove nothing.
   */
  function installer(
    records: PluginRecord[],
    answer: (id: string) => Promise<Response>,
  ) {
    const started = new Map<string, () => void>();
    const beginnings = new Map(
      records.map((each) => [
        each.id,
        new Promise<void>((resolve) => started.set(each.id, resolve)),
      ]),
    );
    const requested: string[] = [];
    vi.stubGlobal("fetch", (url: URL) => {
      const id = records.find((each) => each.tarballUrl === url.href)?.id;
      if (id === undefined) {
        throw new Error(`unexpected fetch of ${url.href}`);
      }
      requested.push(id);
      started.get(id)?.();
      return answer(id);
    });

    const failed: string[] = [];
    const registry = {
      list: () => Promise.resolve(records),
      markFailed: (id: string) => {
        failed.push(id);
        return Promise.resolve();
      },
    };
    const catalog = {
      allowsUncuratedSources: () => false,
      authorizationFor: () => ({}),
    };
    const service = new PluginInstallerService(
      { OPENBRF_DATA_DIR: staging } as Env,
      registry as never,
      {} as never,
      catalog as never,
      {} as never,
      {} as never,
    );

    let outcome: ReconcileOutcome | undefined;
    const reconciling = service.reconcile().then((settled) => {
      outcome = settled;
      return settled;
    });

    return {
      fetched: (id: string): Promise<void> =>
        beginnings.get(id) ?? Promise.reject(new Error(`no ${id}`)),
      outcome: () => outcome,
      reconciling,
      requested,
      failed,
    };
  }

  const timedOut = expect.stringMatching(/did not finish within/) as string;

  it("abandons an archive whose body stalls, at the deadline", async () => {
    vi.useFakeTimers();
    const run = installer([record("occupancy")], () =>
      Promise.resolve(stalled()),
    );

    await run.fetched("occupancy");
    await vi.advanceTimersByTimeAsync(ARCHIVE_TIMEOUT_MS - 1);
    expect(run.outcome()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    const outcome = await run.reconciling;

    expect(outcome.failed).toEqual([{ id: "occupancy", error: timedOut }]);
    expect(run.failed).toEqual(["occupancy"]);
  });

  it("does not start the next download once one has failed", async () => {
    vi.useFakeTimers();
    const run = installer([record("occupancy"), record("bookings")], () =>
      Promise.resolve(stalled()),
    );

    await run.fetched("occupancy");
    await vi.advanceTimersByTimeAsync(ARCHIVE_TIMEOUT_MS);
    const outcome = await run.reconciling;

    // One deadline, not one per plugin: the tree was going to be left as it
    // is either way. The row that was never tried keeps the status it had.
    expect(run.requested).toEqual(["occupancy"]);
    expect(outcome.failed).toEqual([{ id: "occupancy", error: timedOut }]);
    expect(run.failed).toEqual(["occupancy"]);
  });

  it("ends the run within the budget however slowly each archive arrives", async () => {
    vi.useFakeTimers();
    const bytes = Buffer.from("a plugin that took its time");
    const checksum = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    // In just under its own deadline, so it succeeds and leaves the next one
    // only what remains of the run's.
    const slow = (): Promise<Response> =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve(new Response(bytes));
        }, ARCHIVE_TIMEOUT_MS - 1),
      );
    const run = installer(
      [record("occupancy", checksum), record("bookings")],
      (id) => (id === "occupancy" ? slow() : Promise.resolve(stalled())),
    );

    await run.fetched("occupancy");
    await vi.advanceTimersByTimeAsync(ARCHIVE_TIMEOUT_MS - 1);
    await run.fetched("bookings");
    await vi.advanceTimersByTimeAsync(FETCH_BUDGET_MS - ARCHIVE_TIMEOUT_MS);
    expect(run.outcome()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    const outcome = await run.reconciling;

    expect(FETCH_BUDGET_MS).toBeLessThan(2 * ARCHIVE_TIMEOUT_MS);
    expect(outcome.installed).toEqual(["occupancy"]);
    expect(outcome.failed).toEqual([{ id: "bookings", error: timedOut }]);
    expect(run.failed).toEqual(["bookings"]);
  });
});
