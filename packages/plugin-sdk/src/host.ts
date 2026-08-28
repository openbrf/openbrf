import type { PluginPermission } from "./permissions.ts";
import type { PluginSettingsValues } from "./settings-schema.ts";

/**
 * The host services a plugin receives.
 *
 * Every service is present on the object whether or not the plugin declared
 * the permission it needs; the ones it did not declare throw
 * PluginPermissionError on use. Handing out nulls instead would push a
 * null-check into every call site of a plugin that did declare the permission,
 * for the sake of a case the plugin author has already ruled out by writing
 * the manifest. `permissions` is on the object for the plugin that genuinely
 * wants to degrade rather than fail.
 */

export class PluginPermissionError extends Error {
  constructor(
    readonly pluginId: string,
    readonly permission: PluginPermission,
  ) {
    super(
      `Plugin "${pluginId}" used a service requiring the "${permission}" ` +
        `permission, which its manifest does not declare.`,
    );
    this.name = "PluginPermissionError";
  }
}

/**
 * Writes to the host's log, tagged with the plugin's id.
 *
 * A plugin must not reach for console: its output would be indistinguishable
 * from the core's, and an operator reading a log needs to know which plugin
 * produced a line before they can decide whether to disable it.
 */
export interface PluginLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, cause?: unknown): void;
}

/** The plugin's own settings, validated against its declared settingsSchema. */
export interface PluginSettings {
  /**
   * The stored values, with declared defaults applied. Reads the current
   * values on each call rather than caching, so a change made in the admin
   * interface reaches a long-running job without a restart.
   */
  read(): Promise<PluginSettingsValues>;
}

export interface PluginMailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Sends mail through the instance's configured SMTP server.
 *
 * The from address is the instance's and is not a parameter: mail from a
 * housing cooperative's system has to be attributable to the cooperative.
 * Requires the mail:send permission.
 */
export interface PluginMail {
  send(message: PluginMailMessage): Promise<void>;
}

/**
 * Background work. Queue names are namespaced with the plugin's id by the
 * host, so two plugins cannot collide on a name and no plugin can subscribe to
 * a core queue. Requires the jobs:schedule permission.
 */
export interface PluginJobs {
  work<Data extends object>(
    name: string,
    handler: (data: Data) => Promise<void> | void,
  ): Promise<void>;
  send<Data extends object>(name: string, data: Data): Promise<void>;
  sendAt<Data extends object>(
    name: string,
    data: Data,
    runAt: Date,
  ): Promise<void>;
  schedule<Data extends object>(
    name: string,
    cron: string,
    data: Data,
  ): Promise<void>;
}

export interface PluginApartment {
  id: string;
  number: string;
  floor: number | null;
  address: { id: string; street: string; number: string };
}

export interface PluginResident {
  personId: string;
  name: string;
  /** MEMBER holds the tenant-ownership; RESIDENT occupies without holding it. */
  role: "MEMBER" | "RESIDENT";
  apartment: PluginApartment | null;
  movedInOn: string | null;
  movedOutOn: string | null;
  /** Present only with the addressBook:readContact permission. */
  email?: string | null;
  /** Present only with the addressBook:readContact permission. */
  phone?: string | null;
}

export interface PluginOccupancySummary {
  apartments: number;
  /** Distinct persons with a current residency. */
  residents: number;
  /** Distinct persons holding a current tenant-ownership. */
  members: number;
}

/**
 * Reading the register, scoped to what the plugin declared.
 *
 * Three rules hold on every method here regardless of permission, because
 * they are the product's own (plan section 4.4) and a plugin is not a reason
 * to relax them: a person with protected personal data never appears, a
 * personal identity number is never returned, and nothing is writable.
 * Requires addressBook:read; the contact fields additionally require
 * addressBook:readContact.
 */
export interface PluginAddressBook {
  apartments(): Promise<PluginApartment[]>;
  /** Current residencies only. Moved-out rows are not plugin business. */
  residents(): Promise<PluginResident[]>;
  summary(): Promise<PluginOccupancySummary>;
}

export interface PluginHost {
  /** The plugin's own id, as declared in its manifest. */
  id: string;
  /** What the manifest declared and the board consented to. */
  permissions: readonly PluginPermission[];
  logger: PluginLogger;
  settings: PluginSettings;
  mail: PluginMail;
  jobs: PluginJobs;
  addressBook: PluginAddressBook;
}

/**
 * One HTTP route a plugin contributes.
 *
 * Mounted by the host under `/api/plugins/<id>/`, inside the application's own
 * authorization guard rather than beside it, so a plugin route cannot be the
 * one endpoint on the instance that forgot to check a session.
 */
export interface PluginRoute {
  method: "GET" | "POST";
  /** Relative to the plugin's mount point. Leading slash optional. */
  path: string;
  /**
   * The capability a caller needs. Defaults to "self:manage", i.e. any signed
   * in account. The host raises it to the floor implied by the plugin's own
   * permissions, so a plugin that reads the register cannot expose that
   * reading to a caller the core would not let read it.
   */
  capability?: string;
  /**
   * Answers the request. The returned value is serialised as JSON by the host.
   *
   * `unknown` alone rather than a union with a promise: `unknown` already
   * covers both, and the host awaits whatever comes back.
   */
  handle(request: PluginRequest): unknown;
}

export interface PluginRequest {
  /** Parsed query string. */
  query: Record<string, string>;
  /** Parsed JSON body, or null for a request without one. */
  body: unknown;
  /** The signed-in person's id. */
  personId: string;
}

/**
 * What a plugin's server entry point returns.
 *
 * Routes are the whole of the backend surface in v0. A plugin declares them,
 * the host mounts them inside its own authorization guard, and the plugin
 * never registers a controller of its own - which is what makes it impossible
 * for a plugin endpoint to be the one on the instance that skipped the
 * session check.
 */
export interface PluginServerContribution {
  routes?: readonly PluginRoute[];
  /** Run once after the plugin is registered, at host start-up. */
  onStart?(): Promise<void> | void;
  /** Run when the host shuts down, before the process exits. */
  onStop?(): Promise<void> | void;
}

/** The factory a plugin's server bundle exports as `createPlugin`. */
export type PluginServerFactory = (
  host: PluginHost,
) => PluginServerContribution | Promise<PluginServerContribution>;
