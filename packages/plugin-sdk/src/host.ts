import type { ActionRequest, PluginActions } from "./actions.ts";
import type { PluginBlocks } from "./blocks.ts";
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
  /**
   * The body, as text.
   *
   * Blank lines separate paragraphs; the host renders them in the house style
   * and escapes them. There is no markup parameter, and that is the point: a
   * message sent here leaves under the cooperative's own address and passes
   * its DKIM signature, so a link, an image or a styled block a plugin put in
   * it would be a link, an image or a styled block the cooperative appears to
   * have written. A plugin that interpolates a resident's own text into a
   * body - the ordinary case, and the one that actually happens - cannot turn
   * it into markup from here.
   */
  text: string;
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

export interface PluginSmsMessage {
  /** The recipient's number in E.164 form. */
  to: string;
  /**
   * The whole message, as text.
   *
   * SMS carries no markup, no subject and no alternative part, so what is
   * written here is literally what the recipient reads. Its length is the
   * plugin's own decision and is not bounded by the host: a text message is
   * billed by length, and what a message may cost the association is the
   * plugin's business to keep in hand rather than something a silent
   * truncation can settle.
   */
  text: string;
}

/**
 * Sends text messages through the instance's configured SMS provider.
 *
 * The sender the message presents is the instance's and is not a parameter,
 * for the reason the mail from address is not one: a text message from a
 * housing cooperative's system has to be attributable to the cooperative.
 *
 * An instance with no provider configured cannot send at all, and the send
 * fails rather than being dropped. Having no provider is the ordinary state of
 * a housing cooperative that only ever mails its members, so a plugin whose
 * work depends on SMS should read `permissions` and degrade, or treat the
 * failure as the answer. Requires the sms:send permission.
 */
export interface PluginSms {
  send(message: PluginSmsMessage): Promise<void>;
}

/**
 * Background work. Queue names are namespaced with the plugin's id by the
 * host, so two plugins cannot collide on a name and no plugin can subscribe to
 * a core queue. A name is 1-64 letters, digits, `_`, `.` or `-`; any other
 * name is refused with a RangeError. Requires the jobs:schedule permission.
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
  /**
   * The family name alone, for a reader that shows no first names: a household
   * as the name on the door shows it, without the first names that say who
   * lives alone and name the children.
   */
  lastName: string;
  /** MEMBER holds the tenant-ownership; RESIDENT occupies without holding it. */
  role: "MEMBER" | "RESIDENT";
  apartment: PluginApartment | null;
  movedInOn: string | null;
  movedOutOn: string | null;
  /** Present only with the addressBook:readContact permission. */
  email?: string | null;
  /** Present only with the addressBook:readContact permission. */
  phone?: string | null;
  /**
   * Whether a publication consent to the person's name on screens inside the
   * building stands (the `NAME_IN_BUILDING` scope), recorded by the board on
   * the person's panel like every other scope. A different consent from a name
   * on the website, because the two are different things to agree to.
   */
  nameInBuilding: boolean;
}

/** Narrows a read of the residents. */
export interface PluginResidentFilter {
  /**
   * Only the residents of this entrance, so a plugin that shows one entrance
   * never loads the others. An id no address has returns nobody.
   */
  addressId?: string;
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
 *
 * A person who has objected to this plugin's processing, and whose objection
 * the board granted, is absent as well (ADR 0035) - absent, not flagged, so a
 * plugin cannot list who objected. Closing the objection brings the person
 * back on the next read.
 */
export interface PluginAddressBook {
  apartments(): Promise<PluginApartment[]>;
  /**
   * Current residencies only. Moved-out rows are not plugin business.
   *
   * The filter was added after this contract version shipped; an older host
   * ignores it and returns every entrance, so a plugin that must not load the
   * others filters the result by `apartment.address.id` as well.
   */
  residents(filter?: PluginResidentFilter): Promise<PluginResident[]>;
  summary(): Promise<PluginOccupancySummary>;
}

/** The bounds `host.audit.record` holds an entry to. */
export const PLUGIN_AUDIT_LIMITS = {
  /** Characters in `event`, which is also part of a text key. */
  event: 64,
  /** Characters in `targetKind`. */
  targetKind: 64,
  /** Characters in `targetId`. */
  targetId: 200,
  /** Values in `detail`. */
  detailValues: 8,
  /** Characters in a key of `detail`. */
  detailKey: 64,
  /** Characters in a string value of `detail`. */
  detailValue: 200,
} as const;

/** One entry a plugin writes to the instance's audit log. */
export interface PluginAuditEntry {
  /**
   * What happened, as lowercase letters, digits, dots and hyphens, starting
   * with a letter: `screen.residents-enabled`. The audit log shows it through
   * the plugin's own text key `audit.<event>`.
   */
  event: string;
  /** What the act was done to, in the plugin's own words: `screen`. */
  targetKind?: string;
  /** Which one: the screen's id. */
  targetId?: string;
  /**
   * At most eight values about the act, never a copy of what the plugin read.
   * A person is named as the actor, never here, and a value holding a personal
   * identity number is refused.
   */
  detail?: Record<string, string | number | boolean>;
}

/**
 * Writing to the instance's audit log (ADR 0035).
 *
 * The entry is written as `PLUGIN_RECORDED`, with the plugin's id and the
 * event, on the plugin channel. With a request, the actor is the person the
 * host marked on it, as for `actions`; with `null`, the entry has no actor - a
 * plugin's own job, say. An entry that breaks a bound is refused with a
 * RangeError and nothing is written. Needs no permission: an entry is about
 * what the plugin did, which the association is entitled to a record of.
 */
export interface PluginAudit {
  record(request: ActionRequest | null, entry: PluginAuditEntry): Promise<void>;
}

/**
 * The host object a plugin's module factory receives.
 *
 * It is late-bound: the services behind it are the application's own, and the
 * application is built after the factory has run. Every member below is
 * therefore usable from a lifecycle hook (`onModuleInit` onwards), a guard or
 * a request handler, and not from a provider's constructor - which is where
 * NestJS asks for work to be done in any case. A call made too early throws
 * rather than reading a half-built application.
 *
 * A plugin the board has switched off keeps its object, and every service on
 * it refuses. Disabling has to bite immediately, and a plugin whose own timer
 * outlived the switch must not still be reading the register through it.
 */
export interface PluginHost {
  /** The plugin's own id, as declared in its manifest. */
  id: string;
  /** What the manifest declared and the board consented to. */
  permissions: readonly PluginPermission[];
  logger: PluginLogger;
  settings: PluginSettings;
  mail: PluginMail;
  sms: PluginSms;
  jobs: PluginJobs;
  addressBook: PluginAddressBook;
  /**
   * The actions this plugin declared, and dispatch for every action it may
   * reach.
   *
   * Added after this contract version shipped, so a plugin built against a
   * newer host than the one it is installed on must feature-detect before
   * using it - `isSupportedApiVersion` cannot see a member added to an
   * interface, and the failure would otherwise surface as a load-failed
   * finding with the message deliberately withheld.
   */
  actions: PluginActions;
  /**
   * The website blocks this plugin declared, and their render functions.
   *
   * Added after this contract version shipped, like `actions`: a plugin built
   * against a newer host than the one it is installed on must feature-detect
   * before using it.
   */
  blocks: PluginBlocks;
  /**
   * The instance's audit log, for what this plugin did.
   *
   * Added after this contract version shipped, like `actions`: a plugin built
   * against a newer host than the one it is installed on must feature-detect
   * before using it.
   */
  audit: PluginAudit;
}

/**
 * A host service was used before the application finished starting, or after
 * the plugin stopped serving.
 *
 * Both cases are the plugin reaching for the host at a moment the host cannot
 * answer for: the first is work done in a constructor that belongs in
 * `onModuleInit`, the second is a plugin the board switched off.
 */
export class PluginHostUnavailableError extends Error {
  constructor(
    readonly pluginId: string,
    readonly detail: string,
  ) {
    super(`Plugin "${pluginId}" used a host service ${detail}`);
    this.name = "PluginHostUnavailableError";
  }
}
