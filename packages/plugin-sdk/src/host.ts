import type { ActionRequest, PluginActions } from "./actions.ts";
import type { PluginBlocks } from "./blocks.ts";
import type { PluginFinances } from "./finances.ts";
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

/** What a theme install is told about the package besides its bytes. */
export interface PluginThemeInstallOptions {
  /**
   * The package's sha512, as whoever published it stated it: `sha512-<base64>`
   * or 128 hex characters, the two spellings a catalog entry may use. The
   * bytes are checked against it before anything is unpacked.
   */
  sha512: string;
}

/**
 * A finding the install lint reported without refusing the theme: a token or
 * a manifest field this core does not know, which the token contract says to
 * ignore rather than refuse. Rule codes and numbers, never prose.
 */
export interface PluginThemeInstallWarning {
  rule: string;
  detail: Readonly<Record<string, string | number | boolean>>;
}

export interface PluginThemeInstallResult {
  /** The theme's id, from its manifest. */
  id: string;
  version: string;
  warnings: readonly PluginThemeInstallWarning[];
}

/** A theme this plugin installed, as `host.themes.list` returns it. */
export interface PluginInstalledTheme {
  id: string;
  version: string;
  /** ISO 8601. When the version now installed was installed first. */
  installedAt: string;
}

/**
 * Installing themes on the instance (ADR 0046). Requires themes:install.
 *
 * A theme a plugin hands over takes the path a theme from the catalog takes:
 * its sha512 checked before anything is unpacked, the package read and held to
 * the same install lint, the statutory register contrast included, and the
 * files and the row written together under the same lock per theme id. A
 * package the lint refuses is refused here with the same findings, and what
 * the instance already had stays as it was.
 *
 * `install` takes the request the plugin's own route received and installs as
 * the person behind it, who must hold association:manage, the capability the
 * theme screen requires. A request a connected app's token reached is refused,
 * and a background job has no request, so a plugin installs a theme only when
 * an administrator asks it to.
 *
 * A plugin installs over a theme it installed itself and over nothing else:
 * not the catalog's, not one composed on the instance, not another plugin's.
 * It installs and nothing else. Activating and removing stay on the theme
 * screen, and a theme stays installed when the plugin is removed.
 *
 * A refusal is thrown as an error carrying a `reason` code and, for
 * `lint-failed`, the `findings`. Let it propagate from a route and the client
 * is answered with its status, reason and findings, as the theme screen is.
 */
export interface PluginThemes {
  install(
    request: ActionRequest,
    archive: Uint8Array,
    options: PluginThemeInstallOptions,
  ): Promise<PluginThemeInstallResult>;
  /** The themes this plugin installed, so it can offer an update. */
  list(): Promise<PluginInstalledTheme[]>;
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
   * The association's fee notices and charges, delivery receipts against them,
   * and the events that say one was issued.
   *
   * Added after this contract version shipped, like `actions`: a plugin must
   * feature-detect it (`host.finances === undefined`) before using it.
   */
  finances: PluginFinances;
  /**
   * The website blocks this plugin declared, and their render functions.
   *
   * Added after this contract version shipped, like `actions`: a plugin built
   * against a newer host than the one it is installed on must feature-detect
   * before using it.
   */
  blocks: PluginBlocks;
  /**
   * Installing themes, and listing the ones this plugin installed.
   *
   * Added after this contract version shipped. An older host refuses a
   * manifest asking for themes:install before it loads the plugin, so a plugin
   * that declares the permission never meets a host without this member.
   */
  themes: PluginThemes;
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
