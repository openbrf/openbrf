import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { processRole } from "../config/process-role";
import { JobQueueService } from "../jobs/job-queue.service";
import { CatalogClient } from "../packaging/catalog.client";
import { dataPaths } from "../packaging/data-paths";
import { npmInstall } from "../packaging/npm-install";
import { ensureArchive } from "../packaging/package-archive";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { RestartCoordinator } from "./restart-coordinator.service";

/** The queue the admin screen and the CLI both enqueue onto. */
export const PLUGIN_INSTALL_QUEUE = "plugin-install";

/** What a run's own staging tree is called, and the file that claims it. */
const STAGING_PREFIX = "run-";
const LEASE_SUFFIX = ".lease";

/**
 * How long a staging tree may go unrenewed before another run collects it.
 *
 * Time since the last sign of life, not time since the run began, so a slow
 * npm install over a slow network is never mistaken for an abandoned one.
 */
const STAGING_LEASE_MS = 60_000;

/** Comfortably inside the lease, so a busy event loop does not lose one. */
const STAGING_RENEWAL_MS = 10_000;

export interface PluginInstallJob {
  /** Which plugin triggered the run. Informational: the run reconciles all. */
  reason: string;
  /** Whether to replace the process once the volume matches. */
  restart: boolean;
}

export interface ReconcileOutcome {
  /** Plugin ids now present on the volume. */
  installed: string[];
  /** Plugin ids that could not be installed, with the reason. */
  failed: { id: string; error: string }[];
  /** True when the installation tree was rebuilt. */
  changed: boolean;
}

/**
 * Reconciles /data/plugins to the desired state in the database.
 *
 * The whole installation is rebuilt from the InstalledPlugin rows on every
 * run, rather than one plugin being added to whatever is already there. That
 * is forced by npm's behaviour, measured in the spike behind ADR 0003:
 * `npm install <package> --prefix /data/plugins` prunes packages the
 * directory's package.json does not name, so installing plugin B would
 * uninstall plugin A. The loader owning that package.json and installing a
 * complete dependency set is the fix, and it has a second, larger benefit -
 * the operation becomes idempotent, so a crash at any step converges on the
 * next run instead of leaving the volume and the database disagreeing.
 *
 * The sequence is: download every archive and verify its sha512, assemble the
 * whole tree in a staging directory, move it into place atomically, mark the
 * rows installed, and only then hand over to the restart coordinator.
 */
@Injectable()
export class PluginInstallerService
  implements OnModuleInit, OnApplicationBootstrap
{
  private readonly logger = new Logger(PluginInstallerService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: PluginRegistryService,
    private readonly jobs: JobQueueService,
    private readonly catalog: CatalogClient,
    private readonly restart: RestartCoordinator,
    private readonly loader: PluginLoaderService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the reconcile directly rather than racing a
      // worker for it.
      return;
    }
    if (processRole() === "cli") {
      // The command-line tool enqueues and reconciles; it must not also
      // consume the queue. A short-lived process winning a job the server
      // needs to finish by restarting itself would leave the plugin installed
      // and the server still running the old code with no record that a
      // restart is owed.
      return;
    }
    if (!this.env.OPENBRF_PLUGINS_ENABLED) {
      return;
    }
    await this.registerWorker();
  }

  /**
   * Reinstalls what the volume is missing, when the deployment asks for it.
   *
   * Runs after every module has initialised, so the loader has already
   * finished its scan and knows whether the volume matches. Off by default:
   * on a normal deployment an empty /data/plugins means something is wrong
   * that a silent reinstall would hide.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (
      this.env.NODE_ENV === "test" ||
      !this.env.OPENBRF_PLUGINS_ENABLED ||
      !this.env.OPENBRF_PLUGINS_REINSTALL_ON_BOOT ||
      !this.loader.needsReconcile()
    ) {
      return;
    }
    this.logger.log(
      "The data volume does not match the installed plugins; queueing a " +
        "reinstall.",
    );
    await this.enqueue({ reason: "boot", restart: true });
  }

  /** Puts a reconcile on the queue. */
  async enqueue(job: PluginInstallJob): Promise<void> {
    await this.jobs.send(PLUGIN_INSTALL_QUEUE, { ...job });
  }

  /**
   * Registers the worker.
   *
   * Uses pg-boss directly rather than JobQueueService.work, because the job id
   * is needed: the restart may only happen once this job's completion has
   * been committed, and reading that back requires the id.
   */
  private async registerWorker(): Promise<void> {
    await this.jobs.ensureQueue(PLUGIN_INSTALL_QUEUE);
    const boss = this.jobs.instance;

    await boss.work<PluginInstallJob>(PLUGIN_INSTALL_QUEUE, async (batch) => {
      for (const job of batch) {
        await this.reconcile();
        if (!job.data.restart) {
          continue;
        }
        // Deliberately not awaited: the restart must not begin until this
        // handler has returned and pg-boss has committed the completion,
        // which is precisely what the coordinator waits for. Awaiting here
        // would deadlock on a completion that cannot happen yet.
        void this.restart.restartWhenCommitted(async () => {
          const stored = await boss.getJobById(PLUGIN_INSTALL_QUEUE, job.id);
          return stored?.state === "completed";
        });
      }
    });

    this.logger.log(`Watching the ${PLUGIN_INSTALL_QUEUE} queue.`);
  }

  /**
   * Brings the data volume in line with the database.
   *
   * Safe to run at any time and from any state: it reads the desired set,
   * makes sure every archive is present and verified, and rebuilds the tree.
   */
  async reconcile(): Promise<ReconcileOutcome> {
    const paths = dataPaths(this.env.OPENBRF_DATA_DIR);
    const records = await this.registry.list();
    const outcome: ReconcileOutcome = {
      installed: [],
      failed: [],
      changed: false,
    };

    const archives = new Map<string, string>();
    const headers = this.catalog.authorization();
    const allowUncuratedSources = this.catalog.allowsUncuratedSources();

    for (const record of records) {
      try {
        const archive = await ensureArchive(
          paths.pluginArchives,
          record.id,
          record.version,
          { url: record.tarballUrl, sha512: record.checksum },
          { headers, allowUncuratedSources },
        );
        archives.set(record.packageName, archive);
        outcome.installed.push(record.id);
      } catch (cause) {
        const error = String(cause);
        this.logger.error(
          `Plugin "${record.id}" could not be fetched: ${error}`,
        );
        await this.registry.markFailed(record.id, error);
        outcome.failed.push({ id: record.id, error });
      }
    }

    if (outcome.failed.length > 0) {
      /*
       * One archive could not be verified, so the tree is left exactly as it
       * is. Rebuilding without that plugin would uninstall it - and the usual
       * cause of a failed fetch is a release host being briefly unavailable,
       * which is no reason at all to take a working plugin off an
       * association's instance. The rows that did fetch keep the status they
       * had; the next run converges once the archive is reachable again.
       */
      this.logger.warn(
        `${String(outcome.failed.length)} plugin archive(s) could not be ` +
          "verified. The installation was left unchanged.",
      );
      return outcome;
    }

    const desired = buildDependencySet(archives);
    if (await this.alreadyInstalled(paths.plugins, desired)) {
      // The tree already matches. Marking the rows is still right: a previous
      // run may have moved the files and died before it could say so.
      await this.markInstalled(outcome.installed);
      return outcome;
    }

    try {
      await this.rebuild(paths.plugins, paths.pluginStaging, desired, archives);
    } catch (cause) {
      const error = String(cause);
      this.logger.error(`The plugin installation could not be built: ${error}`);
      for (const id of outcome.installed) {
        await this.registry.markFailed(id, error);
      }
      return {
        installed: [],
        failed: outcome.installed.map((id) => ({ id, error })),
        changed: false,
      };
    }

    await this.markInstalled(outcome.installed);
    outcome.changed = true;
    return outcome;
  }

  private async markInstalled(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.registry.markInstalled(id);
    }
  }

  /**
   * Whether the tree on the volume already satisfies the desired set.
   *
   * Compares the package.json the last successful run wrote. Cheap, and it is
   * what makes a boot-time reconcile on an unchanged instance free.
   */
  private async alreadyInstalled(
    root: string,
    desired: Record<string, string>,
  ): Promise<boolean> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      );
      const current = (raw as { dependencies?: Record<string, string> })
        .dependencies;
      return (
        current !== undefined &&
        JSON.stringify(sorted(current)) === JSON.stringify(sorted(desired))
      );
    } catch {
      return false;
    }
  }

  /**
   * Builds the tree in a staging directory and moves it into place.
   *
   * The move is two renames rather than an overwrite, because renaming onto a
   * non-empty directory fails. The old tree is moved aside first and put back
   * if the second rename does not happen, so a failure leaves the instance
   * running what it was running rather than nothing at all. A crash between
   * the two leaves no node_modules, which the next reconcile rebuilds - the
   * reason the whole operation is defined as "converge on the desired set"
   * rather than "apply this change".
   *
   * The staging tree is removed whether the run succeeds or fails, and trees
   * an earlier run abandoned are collected before this one starts. A run that
   * is killed mid-install leaves a tree nothing else knows is dead, and each
   * one holds a full copy of every archive: an unreachable registry or a
   * killed npm, repeated, would otherwise fill the data volume and take the
   * instance down.
   *
   * The staging root is shared between processes, so it is not this run's to
   * empty. The admin screen enqueues a reconcile the server worker runs, the
   * command-line tool runs one of its own directly, and both reach the same
   * directory: a second run can be copying archives into a tree of its own at
   * this moment, and removing the root would take it out from under itself.
   * Ownership is therefore held rather than assumed - see the lease below.
   */
  private async rebuild(
    root: string,
    stagingRoot: string,
    desired: Record<string, string>,
    archives: ReadonlyMap<string, string>,
  ): Promise<void> {
    await mkdir(stagingRoot, { recursive: true });
    for (const collected of await collectAbandonedStaging(stagingRoot)) {
      this.logger.warn(`Collected an abandoned staging tree at ${collected}.`);
    }

    const staging = join(stagingRoot, `${STAGING_PREFIX}${randomUUID()}`);
    const lease = `${staging}${LEASE_SUFFIX}`;

    // Written before the tree exists, so no tree is ever seen without one and
    // a missing lease is a reliable sign of an abandoned run rather than of a
    // run that has not claimed its tree yet.
    await writeFile(lease, `${new Date().toISOString()}\n`, "utf8");
    const renewal = setInterval(() => {
      const now = new Date();
      void utimes(lease, now, now).catch(() => {
        // Nothing to renew. The run's own cleanup below is what matters.
      });
    }, STAGING_RENEWAL_MS);
    // The lease must never be a reason the process stays up.
    renewal.unref();

    try {
      await this.stageAndSwap(root, staging, desired, archives);
    } finally {
      clearInterval(renewal);
      await rm(staging, { recursive: true, force: true }).catch(() => {
        // A staging tree that cannot be removed is collected by a later run
        // once the lease lapses; failing here would mask the real error.
      });
      await rm(lease, { force: true }).catch(() => {
        // Same: the lease is stale from here on either way.
      });
    }
  }

  /** Builds the staging tree and swaps it in. Always called from `rebuild`. */
  private async stageAndSwap(
    root: string,
    staging: string,
    desired: Record<string, string>,
    archives: ReadonlyMap<string, string>,
  ): Promise<void> {
    const previous = join(root, "node_modules.previous");

    await mkdir(join(staging, "archives"), { recursive: true });

    // The archives are copied into the staging directory and referenced from
    // there, so npm's lockfile records paths that stay valid after the move.
    const staged: Record<string, string> = {};
    for (const [packageName, archive] of archives) {
      const name = basename(archive);
      const target = join(staging, "archives", name);
      await copyFile(archive, target);
      staged[packageName] = `file:./archives/${name}`;
    }

    await writeFile(
      join(staging, "package.json"),
      `${JSON.stringify(
        {
          name: "openbrf-plugins",
          version: "0.0.0",
          private: true,
          description:
            "Installed Open BRF plugins. Managed by the application; edit " +
            "through the admin interface or the openbrf CLI.",
          dependencies: sorted(staged),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await npmInstall({ cwd: staging });

    /*
     * npm writes no node_modules when there is nothing to install, which is
     * exactly the state after the last plugin is removed. An empty directory
     * makes the move below one operation rather than two cases, and leaves the
     * volume in the shape the next run expects to find.
     */
    const stagedModules = join(staging, "node_modules");
    await mkdir(stagedModules, { recursive: true });

    await rm(previous, { recursive: true, force: true });
    const current = join(root, "node_modules");
    await mkdir(root, { recursive: true });

    const hadPrevious = await rename(current, previous).then(
      () => true,
      () => false,
    );

    try {
      await rename(stagedModules, current);
    } catch (cause) {
      // Put the working installation back rather than leaving the instance
      // with no plugins at all because a move failed.
      if (hadPrevious) {
        await rename(previous, current).catch(() => {
          // Nothing more can be done here; the next reconcile rebuilds.
        });
      }
      throw cause;
    }

    // Written after the move, so a package.json naming a tree that is not
    // there yet never exists: alreadyInstalled reads exactly this file.
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "openbrf-plugins",
          version: "0.0.0",
          private: true,
          dependencies: sorted(desired),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await copyFile(
      join(staging, "package-lock.json"),
      join(root, "package-lock.json"),
    ).catch(() => {
      // npm omits the lockfile when there is nothing to install.
    });

    await rm(previous, { recursive: true, force: true });
  }
}

/**
 * The dependency set, keyed by package name.
 *
 * Recorded with the archive's file name rather than its absolute path: the
 * comparison against a previous run has to survive the data directory being
 * mounted somewhere else, which is exactly what happens between a development
 * machine and a container.
 */
export function buildDependencySet(
  archives: ReadonlyMap<string, string>,
): Record<string, string> {
  const dependencies: Record<string, string> = {};
  for (const [packageName, archive] of archives) {
    dependencies[packageName] = `file:./archives/${basename(archive)}`;
  }
  return sorted(dependencies);
}

/**
 * Removes the staging trees no run is still working in, and names them.
 *
 * A run renews its lease while it works, so an unrenewed one belongs to a run
 * that stopped without cleaning up - the only kind of tree another process is
 * entitled to remove. Removing the staging root outright would be simpler and
 * is wrong: the admin screen enqueues a reconcile the server worker runs while
 * the command-line tool can be running one of its own, so a tree in there may
 * be being written to by a live process at this moment.
 *
 * A crash still converges. The trees a killed process left are collected by
 * whichever run comes along once the lease has lapsed, so repeated failures -
 * an unreachable registry, a killed npm - cannot accumulate on the volume,
 * while a run that is merely slow keeps its tree for as long as it needs it.
 */
export async function collectAbandonedStaging(
  stagingRoot: string,
): Promise<string[]> {
  const cutoff = Date.now() - STAGING_LEASE_MS;
  const collected: string[] = [];

  for (const name of await stagingRuns(stagingRoot)) {
    const tree = join(stagingRoot, name);
    const lease = `${tree}${LEASE_SUFFIX}`;
    if ((await lastRenewed(lease)) > cutoff) {
      continue;
    }
    // Asked before the removal, so a lease whose tree the run had already
    // taken away is not reported as a tree that was reclaimed.
    const held = await present(tree);
    const removed = await rm(tree, { recursive: true, force: true }).then(
      () => true,
      () => false,
    );
    await rm(lease, { force: true }).catch(() => {
      // Collected by a later run; a lease file costs nothing to leave.
    });
    if (held && removed) {
      collected.push(tree);
    }
  }

  return collected;
}

/**
 * Every run the staging root still holds, named from its tree or its lease.
 *
 * Both, because the two are removed in sequence and a process killed between
 * them leaves one without the other. Anything else in the directory is left
 * alone: this function's whole purpose is not to assume what is in there.
 */
async function stagingRuns(stagingRoot: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(stagingRoot);
  } catch {
    // Nothing has been staged here yet.
    return [];
  }

  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.startsWith(STAGING_PREFIX)) {
      continue;
    }
    names.add(
      entry.endsWith(LEASE_SUFFIX)
        ? entry.slice(0, -LEASE_SUFFIX.length)
        : entry,
    );
  }
  return [...names];
}

/** When the run last said it was alive, or 0 when it never did. */
async function lastRenewed(lease: string): Promise<number> {
  try {
    return (await stat(lease)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Whether the path is there at all. */
async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sorted(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}
