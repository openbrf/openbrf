import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { PluginManifest } from "@openbrf/plugin-sdk";

import { I18nService } from "../i18n/i18n.service";
import {
  type BootPlugin,
  type PluginBoot,
  type PluginFinding,
} from "./plugin-boot";

export type { PluginFinding } from "./plugin-boot";

/** A plugin that is loaded and serving. */
export type LoadedPlugin = BootPlugin;

/** Injection token for what this process loaded before the application existed. */
export const PLUGIN_BOOT = Symbol("OPENBRF_PLUGIN_BOOT");

/**
 * What the application knows about the plugins running inside it.
 *
 * The loading itself happened before this service existed - a plugin's NestJS
 * module has to be in the graph when NestFactory builds it, so the scan, the
 * gates and the require all run in plugin-boot.ts ahead of
 * `NestFactory.create`. What is left here is everything that needs the
 * application: publishing each plugin's translations into the running i18n
 * instance, answering which plugins are serving, and switching one off.
 */
@Injectable()
export class PluginLoaderService implements OnModuleInit {
  private readonly logger = new Logger(PluginLoaderService.name);
  private readonly loaded = new Map<string, LoadedPlugin>();
  /**
   * Manifests of plugins present on the volume but not running - disabled, or
   * refused for a reason the board can act on. Kept so the admin screen can
   * still show what a disabled plugin declares and still edit its settings:
   * turning a plugin off is not a reason to lose its settings form.
   */
  private readonly dormant = new Map<string, PluginManifest>();

  constructor(
    @Inject(PLUGIN_BOOT) private readonly boot: PluginBoot,
    private readonly i18n: I18nService,
  ) {
    for (const plugin of boot.plugins) {
      this.loaded.set(plugin.id, plugin);
    }
    for (const [id, manifest] of boot.dormant) {
      this.dormant.set(id, manifest);
    }
  }

  /**
   * Publishes each plugin's strings under its own namespace.
   *
   * In onModuleInit rather than the constructor because it writes into another
   * service, and a plugin's labels are needed by a request rather than by the
   * container being built.
   */
  onModuleInit(): void {
    for (const plugin of this.loaded.values()) {
      if (Object.keys(plugin.locales).length > 0) {
        this.i18n.addPluginResources(plugin.id, plugin.locales);
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
    return [...this.boot.findings];
  }

  /** Whether the volume has drifted from the desired state. */
  needsReconcile(): boolean {
    return this.boot.reconcileNeeded;
  }

  /**
   * Stops serving a plugin without restarting the process.
   *
   * Disabling has to bite immediately - a board that turns a plugin off
   * because it is misbehaving cannot be told to wait for a restart - so the
   * plugin leaves the view list at once, its routes answer as though it were
   * not installed, and every host service it holds refuses. Its NestJS
   * providers stay constructed and its code stays in this process's module
   * cache until the next boot, which is a property of loading CommonJS at all;
   * what it can reach through the host is not.
   */
  unload(id: string): void {
    const plugin = this.loaded.get(id);
    if (plugin === undefined) {
      return;
    }
    plugin.context.serving = false;
    this.loaded.delete(id);
    this.dormant.set(id, plugin.manifest);
    this.logger.log(`Plugin "${id}" stopped serving.`);
  }
}
