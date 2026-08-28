import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import type {
  PluginHost,
  PluginManifest,
  PluginRoute,
  PluginServerContribution,
} from "@openbrf/plugin-sdk";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { processRole } from "../config/process-role";
import {
  I18nService,
  type Locale,
  SUPPORTED_LOCALES,
} from "../i18n/i18n.service";
import { dataPaths } from "../packaging/data-paths";
import { npmAvailable } from "../packaging/npm-install";
import {
  type DiscoveredPlugin,
  scanPluginDirectory,
  type SkippedPlugin,
} from "./plugin-directory";
import { PluginHostFactory, routeCapabilityFloor } from "./plugin-host.factory";
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
 * A plugin that is loaded and serving.
 */
export interface LoadedPlugin {
  id: string;
  version: string;
  manifest: PluginManifest;
  directory: string;
  routes: Map<string, { route: PluginRoute; capability: string }>;
  host: PluginHost;
  contribution: PluginServerContribution;
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

/**
 * Loads installed plugins at boot.
 *
 * The governing rule, from ADR 0003: a malformed or failing plugin is skipped
 * and reported, never fatal. A broken plugin must not be able to take the
 * association's register offline, so every step below either produces a
 * loaded plugin or a finding, and nothing here throws.
 *
 * Loading happens once, at startup. Plugins contribute HTTP routes through
 * PluginRouteController rather than by registering their own controllers,
 * which is what lets the application's authorization guard cover them: a
 * plugin route is never the one endpoint on the instance that forgot to check
 * a session.
 */
@Injectable()
export class PluginLoaderService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(PluginLoaderService.name);
  private readonly loaded = new Map<string, LoadedPlugin>();
  /**
   * Manifests of plugins present on the volume but not running - disabled, or
   * refused for a reason the board can act on. Kept so the admin screen can
   * still show what a disabled plugin declares and still edit its settings:
   * turning a plugin off is not a reason to lose its settings form.
   */
  private readonly dormant = new Map<string, PluginManifest>();
  private findings: PluginFinding[] = [];
  private started = false;
  /** True when the data volume does not match the desired state. */
  private reconcileNeeded = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: PluginRegistryService,
    private readonly hosts: PluginHostFactory,
    private readonly i18n: I18nService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  async onApplicationShutdown(): Promise<void> {
    for (const plugin of this.loaded.values()) {
      try {
        await plugin.contribution.onStop?.();
      } catch (cause) {
        this.logger.warn(
          `Plugin "${plugin.id}" failed while stopping: ${String(cause)}`,
        );
      }
    }
  }

  /** The plugins currently serving, in id order. */
  list(): LoadedPlugin[] {
    return [...this.loaded.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  get(id: string): LoadedPlugin | null {
    return this.loaded.get(id) ?? null;
  }

  /**
   * The manifest of an installed plugin, running or not.
   *
   * Returns null only when the package is not on the volume at all, which is
   * what the admin screen shows as "installed, awaiting restart".
   */
  manifestFor(id: string): PluginManifest | null {
    return this.loaded.get(id)?.manifest ?? this.dormant.get(id) ?? null;
  }

  /** Every reason a plugin on the volume is not running. */
  report(): PluginFinding[] {
    return [...this.findings];
  }

  /**
   * Stops serving a plugin without restarting the process.
   *
   * Disabling has to bite immediately - a board that turns a plugin off
   * because it is misbehaving cannot be told to wait for a restart - so the
   * plugin leaves the route table and the view list at once and its onStop
   * hook runs. Its code stays in this process's module cache until the next
   * boot, which is a property of loading CommonJS at all and not something
   * this method can undo.
   */
  unload(id: string): void {
    const plugin = this.loaded.get(id);
    if (plugin === undefined) {
      return;
    }
    this.loaded.delete(id);
    this.dormant.set(id, plugin.manifest);
    void Promise.resolve(plugin.contribution.onStop?.()).catch(
      (cause: unknown) => {
        this.logger.warn(
          `Plugin "${id}" failed while stopping: ${String(cause)}`,
        );
      },
    );
  }

  /** Whether the volume has drifted from the desired state. */
  needsReconcile(): boolean {
    return this.reconcileNeeded;
  }

  private async load(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.findings = [];
    this.dormant.clear();

    if (!this.env.OPENBRF_PLUGINS_ENABLED) {
      this.logger.log("Plugins are disabled by OPENBRF_PLUGINS_ENABLED.");
      return;
    }

    if (processRole() === "cli") {
      // A plugin's bundle runs at full process privilege. Listing what is
      // installed is not a reason to execute it, and the command-line tool
      // reads the database rather than this process's loaded set.
      return;
    }

    // Set before anything is required from the volume. Without it a plugin
    // bundle cannot resolve a single host package, because CJS resolution
    // walks up from /data and never reaches the application's node_modules.
    const hostModules = bridgeHostResolution();
    if (hostModules === null) {
      this.logger.error(
        "The host's node_modules could not be located, so module resolution " +
          "for plugins cannot be bridged. No plugins were loaded.",
      );
      return;
    }
    this.logger.log(`Plugin module resolution bridged to ${hostModules}.`);

    if (!(await npmAvailable())) {
      // Reported at boot rather than at the first install: it is a property of
      // the image, and an operator who learns it only when a board tries to
      // install something learns it at the worst possible moment.
      this.logger.warn(
        "The npm CLI is not on PATH. Plugins already installed will load, " +
          "but installing or removing one cannot work until it is present.",
      );
    }

    const paths = dataPaths(this.env.OPENBRF_DATA_DIR);
    const scan = await scanPluginDirectory(paths.plugins);
    const records = await this.registry.list();
    const byId = new Map(records.map((record) => [record.id, record]));

    for (const skipped of scan.skipped) {
      this.note(skipped);
    }

    for (const discovered of scan.plugins) {
      await this.register(discovered, byId);
    }

    // A row the volume does not carry. On a deployment without a persistent
    // /data/plugins volume this is every plugin on every boot, which is
    // exactly what the reinstall option exists for.
    for (const record of records) {
      if (record.status === "INSTALLED" && !this.loaded.has(record.id)) {
        const present = scan.plugins.some((plugin) => plugin.id === record.id);
        if (!present) {
          this.reconcileNeeded = true;
          this.findings.push({
            id: record.id,
            directory: paths.plugins,
            reason: "not-on-volume",
            detail:
              "The plugin is recorded as installed but is not on the data " +
              "volume.",
          });
        }
      }
    }

    this.logger.log(
      `Loaded ${String(this.loaded.size)} plugin(s); ` +
        `${String(this.findings.length)} not loaded.`,
    );
  }

  private note(skipped: SkippedPlugin): void {
    this.findings.push({
      id: null,
      directory: skipped.directory,
      reason: skipped.reason,
      detail: skipped.detail,
    });
    this.logger.warn(
      `Skipping ${skipped.packageName ?? skipped.directory}: ${skipped.detail}`,
    );
  }

  private async register(
    discovered: DiscoveredPlugin,
    byId: Map<string, PluginRecord>,
  ): Promise<void> {
    const record = byId.get(discovered.id);

    if (record === undefined) {
      // On the volume but not in the register of what this instance agreed to
      // run. The database is the desired state, so this is drift to be
      // reconciled away, not a plugin to load.
      this.reconcileNeeded = true;
      this.fail(discovered, "not-consented", "No record of consent to run it.");
      return;
    }

    if (!record.enabled) {
      this.dormant.set(discovered.id, discovered.manifest);
      this.fail(discovered, "disabled", "Disabled in the admin interface.");
      return;
    }

    const consented = new Set(record.consentedPermissions);
    const widened = discovered.manifest.permissions.filter(
      (permission) => !consented.has(permission),
    );
    if (widened.length > 0) {
      // A republished version that asks for more than the board agreed to.
      this.fail(
        discovered,
        "permissions-widened",
        `The installed package asks for ${widened.join(", ")}, which was not ` +
          "consented to. Reinstall it to review the new permissions.",
      );
      return;
    }

    const conflicts = findResolutionConflicts(discovered.directory);
    if (conflicts.length > 0) {
      // Identity, not the absence of an error: a duplicate copy of a host
      // package loads happily and fails much later at a ModuleRef lookup or an
      // instanceof, by which time the cause is unrecoverable from the symptom.
      this.fail(
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

    const locales = await this.mergeLocales(discovered);

    if (discovered.serverEntry === null) {
      // A view-only plugin. Nothing to require, and its client entry is served
      // by the asset controller.
      this.loaded.set(discovered.id, {
        id: discovered.id,
        version: discovered.version,
        manifest: discovered.manifest,
        directory: discovered.directory,
        routes: new Map(),
        host: this.hosts.create(
          discovered.manifest,
          record.consentedPermissions,
        ),
        contribution: {},
        locales,
      });
      return;
    }

    const host = this.hosts.create(
      discovered.manifest,
      record.consentedPermissions,
    );

    let contribution: PluginServerContribution;
    try {
      const factory = requirePluginBundle(discovered.serverEntry);
      if (typeof factory !== "function") {
        this.fail(
          discovered,
          "entry-invalid",
          "The server bundle does not export a createPlugin factory.",
        );
        return;
      }
      contribution = await factory(host);
    } catch (cause) {
      this.fail(discovered, "load-failed", String(cause));
      return;
    }

    const routes = this.indexRoutes(discovered, contribution);

    this.loaded.set(discovered.id, {
      id: discovered.id,
      version: discovered.version,
      manifest: discovered.manifest,
      directory: discovered.directory,
      routes,
      host,
      contribution,
      locales,
    });

    try {
      await contribution.onStart?.();
    } catch (cause) {
      // Already registered: a plugin that fails its own start-up hook keeps
      // its routes, because the alternative is a half-registered plugin whose
      // absence is harder to explain than a logged failure.
      this.logger.error(
        `Plugin "${discovered.id}" failed during onStart.`,
        cause,
      );
    }
  }

  /**
   * Builds the route table for one plugin.
   *
   * Each route's declared capability is raised to the floor implied by the
   * plugin's own permissions, so a plugin that reads contact data cannot
   * expose that reading through a route it declared open to any resident.
   */
  private indexRoutes(
    discovered: DiscoveredPlugin,
    contribution: PluginServerContribution,
  ): Map<string, { route: PluginRoute; capability: string }> {
    const floor = routeCapabilityFloor(discovered.manifest.permissions);
    const routes = new Map<
      string,
      { route: PluginRoute; capability: string }
    >();

    for (const route of contribution.routes ?? []) {
      const path = normalizeRoutePath(route.path);
      const key = `${route.method} ${path}`;
      if (routes.has(key)) {
        this.logger.warn(
          `Plugin "${discovered.id}" declares ${key} more than once; the ` +
            "first declaration is used.",
        );
        continue;
      }
      routes.set(key, {
        route,
        capability:
          route.capability === undefined || route.capability === "self:manage"
            ? floor
            : route.capability,
      });
    }

    return routes;
  }

  /**
   * Merges a plugin's locale files under its own namespace.
   *
   * Absent or unreadable locale files are not a reason to refuse the plugin:
   * i18next falls back to the key, which is a visibly wrong label rather than
   * an instance that will not boot.
   */
  private async mergeLocales(
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
      this.logger.warn(
        `Plugin "${discovered.id}" ships no readable locale files; its labels ` +
          "will show as keys.",
      );
      return resources;
    }

    this.i18n.addPluginResources(discovered.id, resources);
    return resources;
  }

  private fail(
    discovered: DiscoveredPlugin,
    reason: string,
    detail: string,
  ): void {
    this.dormant.set(discovered.id, discovered.manifest);
    this.findings.push({
      id: discovered.id,
      directory: discovered.directory,
      reason,
      detail,
    });
    this.logger.warn(`Plugin "${discovered.id}" not loaded: ${detail}`);
  }
}

/** One spelling for a route path, so a lookup cannot miss by a slash. */
export function normalizeRoutePath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "/" : `/${trimmed}`;
}
