import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DynamicModule } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import type { PluginHost, PluginManifest } from "@openbrf/plugin-sdk";

import type { Env } from "../config/env";
import { processRole } from "../config/process-role";
import { PrismaService } from "../database/prisma.service";
import { type Locale, SUPPORTED_LOCALES } from "../i18n/i18n.service";
import { dataPaths } from "../packaging/data-paths";
import { npmAvailable } from "../packaging/npm-install";
import {
  type DiscoveredPlugin,
  scanPluginDirectory,
  type SkippedPlugin,
} from "./plugin-directory";
import {
  createPluginHost,
  type PluginHostBinding,
  type PluginHostContext,
  routeCapabilityFloor,
} from "./plugin-host";
import { sealPluginModule } from "./plugin-module-seal";
import {
  type PluginRecord,
  PluginRegistryService,
} from "./plugin-registry.service";
import {
  bridgeHostResolution,
  findResolutionConflicts,
  requirePluginBundle,
} from "./plugin-resolution";

/**
 * Loading the installed plugins, before the application is built.
 *
 * Boot-time is the only time a plugin is ever loaded, and that is a
 * consequence of the install flow rather than a limitation: installing a
 * plugin ends by replacing the process, so what runs is always what is on the
 * data volume when the process starts. A plugin's NestJS module has to be in
 * the graph when NestFactory builds it - a module registered afterwards can
 * contribute providers but never controllers - so the work here happens before
 * `NestFactory.create` and its result is handed to the application as part of
 * its own module graph.
 *
 * The governing rule, from ADR 0003: a malformed or failing plugin is skipped
 * and reported, never fatal. Every step below either produces a loaded plugin
 * or a finding, and nothing here throws for a plugin's own defect.
 */

/** A plugin that passed every gate and is part of the application's graph. */
export interface BootPlugin {
  id: string;
  version: string;
  manifest: PluginManifest;
  directory: string;
  /** Null for a view-only plugin, which contributes no backend at all. */
  module: DynamicModule | null;
  /** Shared with the host object, so switching the plugin off reaches it. */
  context: PluginHostContext;
  host: PluginHost;
  /** The paths the plugin's controllers were sealed onto. */
  controllers: string[];
  /** The plugin's merged locale files, served lazily to the browser. */
  locales: Partial<Record<Locale, Record<string, unknown>>>;
}

/** Why a plugin present on the volume is not running. */
export interface PluginFinding {
  id: string | null;
  directory: string;
  reason: string;
  detail: string;
}

export interface PluginBoot {
  plugins: BootPlugin[];
  findings: PluginFinding[];
  /**
   * Manifests of packages on the volume that are not running. The admin screen
   * still renders a disabled plugin's settings form from these: switching a
   * plugin off is not a reason to lose the values it was configured with.
   */
  dormant: Map<string, PluginManifest>;
  /** True when the data volume does not match the desired state. */
  reconcileNeeded: boolean;
}

export function emptyPluginBoot(): PluginBoot {
  return {
    plugins: [],
    findings: [],
    dormant: new Map(),
    reconcileNeeded: false,
  };
}

/**
 * What this process loaded.
 *
 * A holder rather than an injected value, for the same reason the host object
 * is late-bound: the plugins are loaded before there is a container to put
 * them in, and the container is then built from what they contributed.
 * PluginsModule reads it once, through a provider, so nothing else has to.
 */
let current: PluginBoot = emptyPluginBoot();

export function setPluginBoot(boot: PluginBoot): void {
  current = boot;
}

export function pluginBoot(): PluginBoot {
  return current;
}

/**
 * Reads the desired state.
 *
 * A short-lived client of its own, because this runs before the application's
 * container exists and the rows decide which plugin bundles may be executed at
 * all. A database that cannot be reached here is not a plugin failure and is
 * not caught: the application would fail to start a moment later anyway, and
 * silently booting with every plugin missing would be the worse answer.
 */
export async function readPluginRecords(env: Env): Promise<PluginRecord[]> {
  const prisma = new PrismaService(env);
  try {
    await prisma.$connect();
    return await new PluginRegistryService(prisma).list();
  } finally {
    await prisma.$disconnect();
  }
}

export interface LoadPluginsOptions {
  env: Env;
  records: readonly PluginRecord[];
  binding: PluginHostBinding;
}

/**
 * Loads every consented plugin on the data volume.
 *
 * The order of the gates matters and is the same as it was when plugin code
 * was never executed at boot: consent, then enablement, then the permission
 * snapshot, then module identity - and only then is the bundle required. A
 * plugin's bundle runs at full process privilege, so nothing that can refuse a
 * plugin may run after the code that executes it.
 */
export async function loadPlugins(
  options: LoadPluginsOptions,
): Promise<PluginBoot> {
  const logger = new Logger("PluginBoot");
  const boot = emptyPluginBoot();
  const { env, records, binding } = options;

  if (!env.OPENBRF_PLUGINS_ENABLED) {
    logger.log("Plugins are disabled by OPENBRF_PLUGINS_ENABLED.");
    return boot;
  }

  if (processRole() === "cli") {
    // A plugin's bundle runs at full process privilege. Listing what is
    // installed is not a reason to execute it, and the command-line tool reads
    // the database rather than this process's loaded set.
    return boot;
  }

  // Set before anything is required from the volume. Without it a plugin
  // bundle cannot resolve a single host package, because CJS resolution walks
  // up from /data and never reaches the application's node_modules.
  const hostModules = bridgeHostResolution();
  if (hostModules === null) {
    logger.error(
      "The host's node_modules could not be located, so module resolution " +
        "for plugins cannot be bridged. No plugins were loaded.",
    );
    return boot;
  }
  logger.log(`Plugin module resolution bridged to ${hostModules}.`);

  if (!(await npmAvailable())) {
    // Reported at boot rather than at the first install: it is a property of
    // the image, and an operator who learns it only when a board tries to
    // install something learns it at the worst possible moment.
    logger.warn(
      "The npm CLI is not on PATH. Plugins already installed will load, but " +
        "installing or removing one cannot work until it is present.",
    );
  }

  const paths = dataPaths(env.OPENBRF_DATA_DIR);
  const scan = await scanPluginDirectory(paths.plugins);
  const byId = new Map(records.map((record) => [record.id, record]));

  for (const skipped of scan.skipped) {
    note(boot, logger, skipped);
  }

  for (const discovered of scan.plugins) {
    await register(boot, logger, binding, discovered, byId);
  }

  // A row the volume does not carry. On a deployment without a persistent
  // /data/plugins volume this is every plugin on every boot, which is exactly
  // what the reinstall option exists for.
  for (const record of records) {
    if (
      record.status === "INSTALLED" &&
      !scan.plugins.some((plugin) => plugin.id === record.id)
    ) {
      boot.reconcileNeeded = true;
      boot.findings.push({
        id: record.id,
        directory: paths.plugins,
        reason: "not-on-volume",
        detail:
          "The plugin is recorded as installed but is not on the data volume.",
      });
    }
  }

  logger.log(
    `Loaded ${String(boot.plugins.length)} plugin(s); ` +
      `${String(boot.findings.length)} not loaded.`,
  );
  return boot;
}

function note(boot: PluginBoot, logger: Logger, skipped: SkippedPlugin): void {
  boot.findings.push({
    id: null,
    directory: skipped.directory,
    reason: skipped.reason,
    detail: skipped.detail,
  });
  logger.warn(
    `Skipping ${skipped.packageName ?? skipped.directory}: ${skipped.detail}`,
  );
}

function fail(
  boot: PluginBoot,
  logger: Logger,
  discovered: DiscoveredPlugin,
  reason: string,
  detail: string,
): void {
  boot.dormant.set(discovered.id, discovered.manifest);
  boot.findings.push({
    id: discovered.id,
    directory: discovered.directory,
    reason,
    detail,
  });
  logger.warn(`Plugin "${discovered.id}" not loaded: ${detail}`);
}

async function register(
  boot: PluginBoot,
  logger: Logger,
  binding: PluginHostBinding,
  discovered: DiscoveredPlugin,
  byId: Map<string, PluginRecord>,
): Promise<void> {
  const record = byId.get(discovered.id);

  if (record === undefined) {
    // On the volume but not in the register of what this instance agreed to
    // run. The database is the desired state, so this is drift to be
    // reconciled away, not a plugin to load.
    boot.reconcileNeeded = true;
    fail(
      boot,
      logger,
      discovered,
      "not-consented",
      "No record of consent to run it.",
    );
    return;
  }

  if (!record.enabled) {
    fail(
      boot,
      logger,
      discovered,
      "disabled",
      "Disabled in the admin interface.",
    );
    return;
  }

  const consented = new Set(record.consentedPermissions);
  const widened = discovered.manifest.permissions.filter(
    (permission) => !consented.has(permission),
  );
  if (widened.length > 0) {
    // A republished version that asks for more than the board agreed to.
    fail(
      boot,
      logger,
      discovered,
      "permissions-widened",
      `The installed package asks for ${widened.join(", ")}, which was not ` +
        "consented to. Reinstall it to review the new permissions.",
    );
    return;
  }

  const declared = new Set(record.declaredPersonalData);
  const added = discovered.manifest.personalData.filter(
    (category) => !declared.has(category),
  );
  if (added.length > 0) {
    /*
     * The same gate on the other half of the declaration. A republished
     * version can keep its permissions unchanged and still start handling
     * categories the board never saw - email or residency added to a plugin
     * that declared only a name - and the board's agreement to a stated set of
     * personal data is the legal basis for that processing. The stored
     * snapshot is what it agreed to, so anything beyond it needs fresh
     * consent rather than a boot.
     */
    fail(
      boot,
      logger,
      discovered,
      "personal-data-widened",
      `The installed package handles ${added.join(", ")}, which was not ` +
        "consented to. Reinstall it to review the new declaration.",
    );
    return;
  }

  const conflicts = findResolutionConflicts(discovered.directory);
  if (conflicts.length > 0) {
    // Identity, not the absence of an error: a duplicate copy of a host
    // package loads happily and fails much later at a ModuleRef lookup or an
    // instanceof, by which time the cause is unrecoverable from the symptom.
    fail(
      boot,
      logger,
      discovered,
      "module-identity",
      conflicts
        .map(
          (conflict) =>
            `${conflict.package} resolves to ${conflict.pluginPath} for the ` +
            `plugin but ${conflict.hostPath} for the host`,
        )
        .join("; "),
    );
    return;
  }

  const context: PluginHostContext = {
    manifest: discovered.manifest,
    consented: record.consentedPermissions,
    serving: true,
  };
  const host = createPluginHost(binding, context);
  const locales = await readLocales(logger, discovered);

  if (discovered.serverEntry === null) {
    // A view-only plugin. Nothing to require, and its client entry is served
    // by the asset controller.
    boot.plugins.push({
      id: discovered.id,
      version: discovered.version,
      manifest: discovered.manifest,
      directory: discovered.directory,
      module: null,
      context,
      host,
      controllers: [],
      locales,
    });
    return;
  }

  let contributed: unknown;
  try {
    const factory = requirePluginBundle(discovered.serverEntry);
    if (typeof factory !== "function") {
      fail(
        boot,
        logger,
        discovered,
        "entry-invalid",
        "The server bundle does not export a createPlugin factory.",
      );
      return;
    }
    contributed = await (factory as (host: PluginHost) => unknown)(host);
  } catch (cause) {
    fail(boot, logger, discovered, "load-failed", String(cause));
    return;
  }

  const sealed = sealPluginModule(contributed, {
    pluginId: discovered.id,
    floor: routeCapabilityFloor(record.consentedPermissions),
  });
  if (!sealed.ok) {
    fail(boot, logger, discovered, sealed.reason, sealed.detail);
    return;
  }

  boot.plugins.push({
    id: discovered.id,
    version: discovered.version,
    manifest: discovered.manifest,
    directory: discovered.directory,
    module: sealed.module,
    context,
    host,
    controllers: sealed.controllers,
    locales,
  });

  if (sealed.controllers.length > 0) {
    logger.log(
      `Plugin "${discovered.id}" serves ${sealed.controllers.join(", ")}.`,
    );
  }
}

/**
 * Reads a plugin's locale files.
 *
 * Absent or unreadable locale files are not a reason to refuse the plugin:
 * i18next falls back to the key, which is a visibly wrong label rather than an
 * instance that will not boot. Merging them into the running i18n instance is
 * the loader's job, inside the application, because that is where the service
 * holding them exists.
 */
async function readLocales(
  logger: Logger,
  discovered: DiscoveredPlugin,
): Promise<Partial<Record<Locale, Record<string, unknown>>>> {
  const resources: Partial<Record<Locale, Record<string, unknown>>> = {};

  for (const locale of SUPPORTED_LOCALES) {
    const path = join(discovered.directory, "locales", `${locale}.json`);
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        resources[locale] = parsed as Record<string, unknown>;
      }
    } catch {
      // No file for this locale, or it is not JSON.
    }
  }

  if (Object.keys(resources).length === 0) {
    logger.warn(
      `Plugin "${discovered.id}" ships no readable locale files; its labels ` +
        "will show as keys.",
    );
  }

  return resources;
}
