import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DynamicModule } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import {
  type PluginDeviceRoute,
  type PluginFindingDetail,
  type PluginFindingReason,
  type PluginHost,
  type PluginManifest,
  recipientsBeyondConsent,
} from "@openbrf/plugin-sdk";

import type { Capability } from "../authorization/capabilities";
import type { Env } from "../config/env";
import { deviceRoutePath } from "../devices/device-routes";
import { processRole } from "../config/process-role";
import { PrismaService } from "../database/prisma.service";
import { type Locale, SUPPORTED_LOCALES } from "../i18n/i18n.service";
import { failureFrames, failureName } from "../logging/failure";
import { dataPaths } from "../packaging/data-paths";
import { npmAvailable } from "../packaging/npm-install";
import {
  type DiscoveredPlugin,
  isConsentedPackage,
  pluginModulesDirectory,
  scanPluginDirectory,
  type SkippedPlugin,
} from "./plugin-directory";
import {
  createPluginHost,
  type PluginHostBinding,
  type PluginHostContext,
  routeCapabilityFloor,
} from "./plugin-host";
import {
  canonicalDeviceRoute,
  checkDeclaredActions,
} from "./plugin-action-gate";
import { keysRefused, licenceRefusal } from "./plugin-licence-gate";
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
  /**
   * The capabilities every one of its routes requires at least, from what the
   * board consented to. Its view is offered in the navigation on the same.
   */
  routeFloor: readonly Capability[];
  /** The plugin's merged locale files, served lazily to the browser. */
  locales: Partial<Record<Locale, Record<string, unknown>>>;
  /**
   * When the board installed it. Carried through from the record because the
   * OAuth protected resource is decided by seniority: where two plugins both
   * declare one, the older install keeps it.
   */
  installedAt: Date;
}

/**
 * Why a plugin present on the volume is not running.
 *
 * A code and the values its sentence needs, never a sentence. This is served
 * to the admin screen, which is Swedish by default while this process is
 * English throughout: a sentence composed here would be an English sentence in
 * a board member's panel, so the browser owns the wording and the codes are
 * the contract's own.
 */
export interface PluginFinding {
  id: string | null;
  directory: string;
  reason: PluginFindingReason;
  detail: PluginFindingDetail;
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
export async function readPluginRecords(env: Env): Promise<PluginRecords> {
  const prisma = new PrismaService(env);
  try {
    await prisma.$connect();
    const registry = new PluginRegistryService(prisma);
    return {
      records: await registry.list(),
      deviceRoutePaths: await registry.consentedDeviceRoutePaths(),
    };
  } finally {
    await prisma.$disconnect();
  }
}

export interface PluginRecords {
  records: PluginRecord[];
  /**
   * Every path the board consented to as a plugin's device route, by plugin
   * id, the plugins that were removed included, which go on answering with
   * the device route headers (ADR 0031).
   */
  deviceRoutePaths: Map<string, PluginDeviceRoute[]>;
}

export function noPluginRecords(): PluginRecords {
  return { records: [], deviceRoutePaths: new Map() };
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

  const modules = pluginModulesDirectory(paths.plugins);
  for (const discovered of scan.plugins) {
    await register(boot, logger, binding, discovered, byId, modules);
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
        detail: {},
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
    `Skipping ${skipped.packageName ?? skipped.directory}: ` +
      `${describe(skipped.reason, skipped.detail)}`,
  );
}

/**
 * Records a refusal.
 *
 * `log` is separate from `detail` because the two have different readers. The
 * detail is what a translated sentence is completed with and crosses the wire;
 * the log is English prose for whoever is reading the container's output, and
 * naming a NestJS decorator there is useful in a way it never is on a board's
 * screen.
 */
function fail(
  boot: PluginBoot,
  logger: Logger,
  discovered: DiscoveredPlugin,
  reason: PluginFindingReason,
  detail: PluginFindingDetail = {},
  log = describe(reason, detail),
): void {
  boot.dormant.set(discovered.id, discovered.manifest);
  refuse(boot, logger, discovered, reason, detail, log);
}

/**
 * Records a refusal without keeping the package's manifest.
 *
 * For a package the board did not consent to under its id, whether no record
 * names the id or the record is for another package, and for a consented
 * package refused over the issuer or keys of its licence (`keysRefused`): the
 * admin screen reads a dormant manifest as that plugin's, and would draw the
 * plugin's settings form, and validate what the board saves, against a schema
 * the board never agreed to; and the licence screen would verify licences with
 * its key.
 */
function refuse(
  boot: PluginBoot,
  logger: Logger,
  discovered: DiscoveredPlugin,
  reason: PluginFindingReason,
  detail: PluginFindingDetail = {},
  log = describe(reason, detail),
): void {
  boot.findings.push({
    id: discovered.id,
    directory: discovered.directory,
    reason,
    detail,
  });
  logger.warn(`Plugin "${discovered.id}" not loaded: ${log}`);
}

/**
 * What an operator needs to place a bundle that threw while it was loading.
 *
 * The plugin wrote the message its bundle threw, and a plugin that reads the
 * register through its consented host services can have a resident's details
 * in hand when it does. So the message is not here and never reaches the log:
 * what does is the class of the failure, the file that was required, and the
 * call frames - enough to say which package, where in it, and what kind of
 * fault, without any of what it was holding.
 */
function loadFailureLog(discovered: DiscoveredPlugin, cause: unknown): string {
  const frames = failureFrames(cause);
  const entry = discovered.serverEntry ?? discovered.directory;
  return (
    `its bundle threw ${failureName(cause)} while being loaded from ${entry}` +
    (frames === undefined ? "" : `\n${frames}`)
  );
}

/** A finding as one line, for the log. */
function describe(reason: string, detail: PluginFindingDetail): string {
  const values = Object.entries(detail).map(([name, value]) =>
    Array.isArray(value)
      ? `${name}=${value.join(",")}`
      : `${name}=${String(value)}`,
  );
  return values.length === 0 ? reason : `${reason} (${values.join(" ")})`;
}

async function register(
  boot: PluginBoot,
  logger: Logger,
  binding: PluginHostBinding,
  discovered: DiscoveredPlugin,
  byId: Map<string, PluginRecord>,
  modules: string,
): Promise<void> {
  const record = byId.get(discovered.id);

  if (record === undefined) {
    /*
     * On the volume but not in the register of what this instance agreed to
     * run. The database is the desired state, so this is drift to be
     * reconciled away, not a plugin to load.
     *
     * Nor is it an installed plugin that is merely not running, so its
     * manifest is not kept: the licence screen tries a licence against every
     * kept manifest's key, and a package the board never consented to must
     * not verify one (ADR 0042).
     */
    boot.reconcileNeeded = true;
    refuse(boot, logger, discovered, "not-consented");
    return;
  }

  if (!isConsentedPackage(discovered, record, modules)) {
    /*
     * Another package, or another release of this one, under the same id is
     * not what the board agreed to run; the reconcile puts the consented one
     * back. Being held to one directory is also what keeps a second copy
     * under the same id from loading beside the first.
     */
    boot.reconcileNeeded = true;
    refuse(
      boot,
      logger,
      discovered,
      "not-consented",
      {},
      `the volume holds ${discovered.packageName}@${discovered.version} ` +
        `at ${discovered.directory}, and consent is for ` +
        `${record.packageName}@${record.version}`,
    );
    return;
  }

  /*
   * The issuer and the keys of the licence it declares (ADR 0042), decided
   * before any gate that keeps the manifest. The licence screen verifies a
   * licence with the keys of every manifest it is given, dormant ones too, so
   * a key the board did not consent to must verify nothing: a package that is
   * also disabled, or also widens something else, is refused here and keeps no
   * manifest. A refusal over audiences alone leaves the keys as consented and
   * is decided where the licence is read, below.
   */
  const licenceRefused = licenceRefusal(
    discovered.manifest.licence,
    record.consentedLicence,
  );
  if (
    licenceRefused !== null &&
    keysRefused(licenceRefused, record.consentedLicence)
  ) {
    refuse(
      boot,
      logger,
      discovered,
      licenceRefused.reason,
      licenceRefused.detail,
    );
    return;
  }

  if (!record.enabled) {
    fail(boot, logger, discovered, "disabled");
    return;
  }

  const consented = new Set(record.consentedPermissions);
  const widened = discovered.manifest.permissions.filter(
    (permission) => !consented.has(permission),
  );
  if (widened.length > 0) {
    // A republished version that asks for more than the board agreed to.
    fail(boot, logger, discovered, "permissions-widened", {
      permissions: widened,
    });
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
     * that declared only a name - and the board's samtycke to a stated set of
     * personal data is the legal basis for that processing. The stored
     * snapshot is what it agreed to, so anything beyond it needs fresh
     * consent rather than a boot.
     */
    fail(boot, logger, discovered, "personal-data-widened", {
      categories: added,
    });
    return;
  }

  /*
   * The same gate again, on the third half of the declaration.
   *
   * An action is the widest thing a manifest can declare: it names a
   * capability and offers it to callers the board decided on. A republished
   * version that keeps its permissions and its personal-data categories
   * unchanged can still declare an action the board never saw, so the stored
   * snapshot is what it agreed to and anything beyond it needs fresh consent.
   *
   * The manifest-only refusals ride with it, for the loader's own reason:
   * nothing that can refuse a plugin may run after the code that executes it.
   */
  const actionRefusal = checkDeclaredActions(
    discovered.manifest,
    record.consentedActions,
  );
  if (actionRefusal !== null) {
    fail(
      boot,
      logger,
      discovered,
      actionRefusal.reason,
      { actions: actionRefusal.actions },
      actionRefusal.reason === "action-refused" ? actionRefusal.why : undefined,
    );
    return;
  }

  /*
   * And on where the plugin connects to (ADR 0037). A recipient the board
   * never saw, one moved to another origin under the same id, or one that now
   * receives a category it did not, is the plugin's data going somewhere the
   * consent did not describe. One that receives fewer categories than it did
   * is within the consent, as a narrowed `personalData` is above. Purpose
   * wording is not compared: it is shown, and the canonical form leaves it out.
   */
  const newRecipients = recipientsBeyondConsent(
    discovered.manifest.recipients,
    record.consentedRecipients,
  );
  if (newRecipients.length > 0) {
    fail(boot, logger, discovered, "recipients-widened", {
      recipients: newRecipients.map((recipient) => recipient.origin),
    });
    return;
  }

  /*
   * And on the device routes (ADR 0031). A device route takes a credential no
   * person holds and answers without the session check, so one the board has
   * not seen - added, or moved to another path - needs its consent first,
   * whatever else the version kept. One it no longer declares passes, and the
   * loader revokes that route's tokens once the plugin is known to be serving
   * (`PluginLoaderService.onApplicationBootstrap`).
   */
  const consentedRoutes = new Set(record.consentedDeviceRoutes);
  const widenedRoutes = discovered.manifest.deviceRoutes.filter(
    (route) => !consentedRoutes.has(canonicalDeviceRoute(route)),
  );
  if (widenedRoutes.length > 0) {
    fail(boot, logger, discovered, "device-routes-widened", {
      deviceRoutes: widenedRoutes.map((route) => route.id),
    });
    return;
  }

  /*
   * And whether it is an AI package, compared both ways, because both are a
   * consent nobody gave. A package that came to declare it would have its
   * writes recorded as the AI package's; one that stopped would dispatch as a
   * plain plugin and reach every action offered on this instance's own
   * screens, where the board was told it would reach only what is offered to
   * the AI package. The channel is derived from the manifest at dispatch, so
   * this is where it is held to the consent.
   */
  if (discovered.manifest.ai !== record.consentedAi) {
    fail(boot, logger, discovered, "ai-changed", {});
    return;
  }

  /*
   * And the licence it reads (ADR 0042). The audiences are the services the
   * plugin may present the association's licence to, and the board was told
   * each one by name. A republished version naming another, or reading
   * another entitlement, would present the licence somewhere the board never
   * agreed to; the host's `present()` takes its audiences from the manifest,
   * so this is where they are held to the consent. So are the issuer and its
   * keys, which the host judges a licence with: a package that declares
   * another issuer's key would read that issuer's licence for the same
   * entitlement and present it to an audience the board did consent to.
   */
  if (licenceRefused !== null) {
    // Audiences alone: the keys are as consented, so the manifest stays dormant.
    fail(
      boot,
      logger,
      discovered,
      licenceRefused.reason,
      licenceRefused.detail,
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
      { packages: conflicts.map((conflict) => conflict.package) },
      // The resolved paths are what an operator needs to see and are of no use
      // to a board, so they go to the log rather than onto the wire.
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
    bufferedActions: [],
    bufferedBlocks: [],
  };
  const host = createPluginHost(binding, context);
  const locales = await readLocales(logger, discovered);
  // Read for a view-only plugin as well, which has no routes to raise to it:
  // its view is offered in the navigation on the floor its routes would have.
  const routeFloor = routeCapabilityFloor(record.consentedPermissions);

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
      routeFloor,
      locales,
      installedAt: record.installedAt,
    });
    return;
  }

  /*
   * From here the plugin's own code may hold its host object - a timer or a
   * promise its factory left behind - so a refusal also stops the host
   * answering, as switching the plugin off does.
   */
  let contributed: unknown;
  let source: string;
  try {
    // For the seal, which freezes the base classes the entry defines.
    source = await readFile(discovered.serverEntry, "utf8");
    const factory = requirePluginBundle(discovered.serverEntry);
    if (typeof factory !== "function") {
      context.serving = false;
      fail(boot, logger, discovered, "entry-invalid");
      return;
    }
    contributed = await (factory as (host: PluginHost) => unknown)(host);
  } catch (cause) {
    context.serving = false;
    fail(
      boot,
      logger,
      discovered,
      "load-failed",
      {},
      loadFailureLog(discovered, cause),
    );
    return;
  }

  const sealed = sealPluginModule(contributed, {
    pluginId: discovered.id,
    floor: routeFloor,
    deviceRoutes: discovered.manifest.deviceRoutes.map((route) =>
      deviceRoutePath(discovered.id, route.path),
    ),
    source,
  });
  if (!sealed.ok) {
    context.serving = false;
    fail(boot, logger, discovered, sealed.reason, {}, sealed.log);
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
    routeFloor,
    locales,
    installedAt: record.installedAt,
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
