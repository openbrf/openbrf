import { Inject, Injectable } from "@nestjs/common";
import {
  isSupportedApiVersion,
  type PluginPermission,
  type PluginPersonalDataCategory,
  type PluginSettingsSchema,
  type PluginSettingsValues,
  settingsValidator,
} from "@openbrf/plugin-sdk";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import type { CatalogPluginEntry } from "../packaging/catalog-entry";
import { CatalogClient } from "../packaging/catalog.client";
import { PluginInstallerService } from "./plugin-installer.service";
import {
  type PluginFinding,
  PluginLoaderService,
} from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";
import {
  CatalogEntryNotFoundError,
  PluginApiVersionError,
  PluginConsentMismatchError,
  PluginNotFoundError,
  PluginSettingsUnavailableError,
  PluginsDisabledError,
} from "./plugin.errors";
import { RestartCoordinator } from "./restart-coordinator.service";

export interface PluginSummary {
  id: string;
  packageName: string;
  version: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  /** Whether the plugin's code is running in this process. */
  loaded: boolean;
  permissions: string[];
  personalData: string[];
  installedAt: string;
  hasSettings: boolean;
  view: { module: string; titleKey: string } | null;
}

export interface PluginsOverview {
  /** OPENBRF_PLUGINS_ENABLED. When false nothing is loaded or installable. */
  pluginsEnabled: boolean;
  /** True once an install has asked for the process to be replaced. */
  restartPending: boolean;
  plugins: PluginSummary[];
  /** Every reason a plugin on the volume is not running. */
  findings: PluginFinding[];
}

/** A plugin view the signed-in person may load. */
export interface PluginViewDescriptor {
  id: string;
  titleKey: string;
  module: string;
  /** Same-origin URL of the Module Federation remote entry. */
  remoteEntry: string;
}

export interface CatalogPluginView {
  id: string;
  packageName: string;
  version: string;
  name: { sv: string; en: string };
  description: { sv: string; en: string };
  homepage: string | null;
  deprecated: boolean;
  apiVersion: number;
  permissions: PluginPermission[];
  personalData: PluginPersonalDataCategory[];
  /** False when the entry needs a contract version this host does not have. */
  supported: boolean;
  /** The version currently installed, when there is one. */
  installedVersion: string | null;
}

export interface PluginSettingsView {
  id: string;
  schema: PluginSettingsSchema | null;
  values: PluginSettingsValues;
}

export interface InstallRequest {
  id: string;
  /**
   * What the consent screen showed. Echoed back so an entry that changed
   * between browsing and confirming is refused rather than installed on
   * consent the board never gave.
   *
   * Omitted by the command-line tool, where running the command is itself the
   * consent and there is no earlier screen for the catalog to have changed
   * since. The tool prints the declaration before it acts.
   */
  permissions?: readonly PluginPermission[];
  personalData?: readonly PluginPersonalDataCategory[];
}

/**
 * The admin-facing half of the plugin system.
 *
 * It records what the board consented to and puts a reconcile on the queue; it
 * never touches the data volume itself. Keeping the two apart is what lets the
 * command-line tool drive exactly the same install as the admin screen - both
 * write a row and enqueue the same job - and it is why a crashed install is
 * recoverable: the consent survives independently of the filesystem work.
 */
@Injectable()
export class PluginAdminService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: PluginRegistryService,
    private readonly loader: PluginLoaderService,
    private readonly installer: PluginInstallerService,
    private readonly catalog: CatalogClient,
    private readonly audit: AuditLogService,
    private readonly restart: RestartCoordinator,
  ) {}

  async overview(): Promise<PluginsOverview> {
    const records = await this.registry.list();

    return {
      pluginsEnabled: this.env.OPENBRF_PLUGINS_ENABLED,
      restartPending: this.restart.restartRequested,
      findings: this.loader.report(),
      plugins: records.map((record) => {
        const loaded = this.loader.get(record.id);
        const manifest = this.loader.manifestFor(record.id);
        return {
          id: record.id,
          packageName: record.packageName,
          version: record.version,
          enabled: record.enabled,
          status: record.status,
          lastError: record.lastError,
          loaded: loaded !== null,
          permissions: record.consentedPermissions,
          personalData: record.declaredPersonalData,
          installedAt: record.installedAt.toISOString(),
          hasSettings: manifest?.settingsSchema !== undefined,
          view: manifest?.view ?? null,
        };
      }),
    };
  }

  /**
   * The views a signed-in person may load.
   *
   * Deliberately not derived from the admin overview: a resident has no
   * business reading the install state of the instance, but does need to know
   * which plugin views to render.
   */
  views(): PluginViewDescriptor[] {
    return this.loader
      .list()
      .filter((plugin) => plugin.manifest.view !== undefined)
      .map((plugin) => ({
        id: plugin.id,
        titleKey: plugin.manifest.view?.titleKey ?? "",
        module: plugin.manifest.view?.module ?? "./View",
        remoteEntry: `/api/plugins/${plugin.id}/client/remoteEntry.js`,
      }));
  }

  async browseCatalog(): Promise<{
    source: string;
    entries: CatalogPluginView[];
  }> {
    const [catalog, installed] = await Promise.all([
      this.catalog.read({ refresh: true }),
      this.registry.list(),
    ]);
    const byId = new Map(installed.map((record) => [record.id, record]));

    return {
      source: this.catalog.resolveUrl(),
      entries: catalog.entries
        .filter((entry): entry is CatalogPluginEntry => entry.type === "plugin")
        .map((entry) => ({
          id: entry.id,
          packageName: entry.packageName,
          version: entry.version,
          name: entry.name,
          description: entry.description,
          homepage: entry.homepage ?? null,
          deprecated: entry.deprecated,
          apiVersion: entry.apiVersion,
          permissions: entry.permissions,
          personalData: entry.personalData,
          supported: isSupportedApiVersion(entry.apiVersion),
          installedVersion: byId.get(entry.id)?.version ?? null,
        })),
    };
  }

  /**
   * Installs from the catalog.
   *
   * Three gates before anything is written: the entry has to exist, its
   * contract version has to be one this host implements, and what the board
   * confirmed has to still match what the catalog says. The third exists
   * because the consent screen and the confirmation are two requests, and a
   * catalog is a file somebody can commit to in between.
   */
  async install(
    request: InstallRequest,
    actorPersonId: string | null,
  ): Promise<{ restarting: boolean }> {
    if (!this.env.OPENBRF_PLUGINS_ENABLED) {
      throw new PluginsDisabledError();
    }

    const entry = await this.catalog.entry(request.id);
    if (entry === null || entry.type !== "plugin") {
      throw new CatalogEntryNotFoundError(request.id);
    }
    if (!isSupportedApiVersion(entry.apiVersion)) {
      throw new PluginApiVersionError(entry.id, entry.apiVersion);
    }
    if (
      request.permissions !== undefined &&
      request.personalData !== undefined &&
      (!sameSet(entry.permissions, request.permissions) ||
        !sameSet(entry.personalData, request.personalData))
    ) {
      throw new PluginConsentMismatchError();
    }

    await this.registry.consent({
      id: entry.id,
      packageName: entry.packageName,
      version: entry.version,
      tarballUrl: entry.artifact.url,
      checksum: entry.artifact.sha512,
      permissions: entry.permissions,
      personalData: entry.personalData,
    });

    await this.audit.record({
      action: "PLUGIN_INSTALLED",
      actorPersonId,
      targetKind: "plugin",
      targetId: entry.id,
      context: {
        version: entry.version,
        permissions: entry.permissions,
        personalData: entry.personalData,
      },
    });

    await this.installer.enqueue({
      reason: `install:${entry.id}`,
      restart: true,
    });

    return { restarting: true };
  }

  async uninstall(
    id: string,
    actorPersonId: string | null,
  ): Promise<{ restarting: boolean }> {
    const removed = await this.registry.remove(id);
    if (!removed) {
      throw new PluginNotFoundError(id);
    }

    await this.audit.record({
      action: "PLUGIN_REMOVED",
      actorPersonId,
      targetKind: "plugin",
      targetId: id,
    });

    await this.installer.enqueue({ reason: `remove:${id}`, restart: true });
    return { restarting: true };
  }

  /**
   * Turns a plugin off without uninstalling it.
   *
   * Takes effect immediately for everything the host controls - its routes
   * stop answering, its view disappears - without waiting for a restart. Code
   * already loaded into this process stays loaded until the next one, which is
   * why a disabled plugin's own background worker is stopped by the host
   * rather than trusted to stop itself.
   */
  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ restarting: boolean }> {
    const record = await this.registry.setEnabled(id, enabled);
    if (record === null) {
      throw new PluginNotFoundError(id);
    }

    // Disabling takes effect at once: the dispatcher and the view list both
    // read the loaded set, and both drop the plugin as soon as the row says
    // so. Enabling cannot - the code was never required into this process -
    // so the process is replaced, exactly as an install does it.
    const needsRestart = enabled && this.loader.get(id) === null;
    if (needsRestart) {
      // The row is already committed; there is no job whose completion has to
      // land first. Not awaited: the coordinator drains the server, and this
      // request is one of the connections it is draining.
      void this.restart.restartWhenCommitted(async () => true);
    } else if (!enabled) {
      this.loader.unload(id);
    }

    return { restarting: needsRestart };
  }

  async readSettings(id: string): Promise<PluginSettingsView> {
    const record = await this.registry.find(id);
    if (record === null) {
      throw new PluginNotFoundError(id);
    }
    const schema = this.loader.manifestFor(id)?.settingsSchema ?? null;
    if (schema === null) {
      return { id, schema: null, values: {} };
    }

    const parsed = settingsValidator(schema).safeParse(record.settings);
    return {
      id,
      schema,
      values: parsed.success ? parsed.data : {},
    };
  }

  async writeSettings(
    id: string,
    values: unknown,
  ): Promise<PluginSettingsView> {
    const record = await this.registry.find(id);
    if (record === null) {
      throw new PluginNotFoundError(id);
    }
    const schema = this.loader.manifestFor(id)?.settingsSchema;
    if (schema === undefined) {
      throw new PluginSettingsUnavailableError(id);
    }

    // Throws a ZodError, which the domain exception filter answers as a 400
    // listing the failing fields.
    const parsed = settingsValidator(schema).parse(values);
    await this.registry.writeSettings(id, parsed);
    return { id, schema, values: parsed };
  }

  /** Re-runs the reconcile, for the CLI and for a failed install. */
  async reconcile(restart: boolean): Promise<void> {
    await this.installer.enqueue({ reason: "manual", restart });
  }
}

/** Set equality, so the order the catalog lists permissions in is not a gate. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const seen = new Set(left);
  return right.every((value) => seen.has(value));
}
