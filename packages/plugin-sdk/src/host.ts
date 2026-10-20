import type { PluginActions } from "./actions.ts";
import type { PluginBlocks } from "./blocks.ts";
import type { PluginFinances } from "./finances.ts";
import type {
  PluginPermission,
  PluginPersonalDataCategory,
} from "./permissions.ts";
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
   *
   * A secret field is in it in clear, which is the one place its value
   * leaves the host: never write it to the log, a job's payload or anything
   * a route returns.
   */
  read(): Promise<PluginSettingsValues>;
  /**
   * Replaces or clears one of the plugin's own secret fields: `null` clears
   * it.
   *
   * For a credential the far end replaces, such as an OAuth refresh token
   * that is new after every use. Only a field the manifest declares as
   * `secret`, checked against its declared bounds; the change is written to
   * the audit log under the field's key, never with its value.
   *
   * Added after this contract version shipped, like `actions`: a plugin built
   * against a newer host than the one it is installed on must feature-detect
   * before using it.
   */
  writeSecret(key: string, value: string | null): Promise<void>;
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

/**
 * What a request to a recipient sends as personal data, and about whom.
 *
 * The host writes one audit entry per subject before anything is sent, and
 * a second after, with the outcome; each reaches that person's data subject
 * access report. A disclosure that names nobody, such as text a board member
 * typed, is recorded once with no person.
 */
export interface PluginDisclosure {
  /**
   * The categories the body carries. One or more, each among those the
   * recipient's declaration says it receives, or nothing is sent.
   */
  personalData: readonly PluginPersonalDataCategory[];
  /**
   * The ids of the persons the body is about, at most 100. Each must be a
   * person the host would hand the plugin: a person with protected personal
   * data, one under a restriction of processing, or an id the register does
   * not hold refuses the request, and the error does not say which.
   */
  subjects: readonly string[];
}

export interface PluginRecipientRequest {
  /** `GET` when left out. */
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Sent as given, apart from the ones the host writes: `host`,
   * `content-length`, `transfer-encoding`, `connection` and the other
   * hop-by-hop headers are refused.
   */
  headers?: Readonly<Record<string, string>>;
  /** At most 16 MiB. */
  body?: string | Uint8Array;
  /**
   * Required whenever the body carries personal data. A request without it
   * is recorded nowhere, which is right for fetching a list of models and
   * wrong for anything about a person.
   */
  disclosure?: PluginDisclosure;
  /**
   * The whole exchange, name lookup and redirects included. 60 seconds when
   * left out, at most 300.
   */
  timeoutMs?: number;
}

export interface PluginRecipientResponse {
  /** Whatever the recipient answered, 4xx and 5xx included. */
  status: number;
  /** Lowercased names; a repeated header is joined with ", ". */
  headers: Readonly<Record<string, string>>;
  /** The whole body, at most 16 MiB. */
  body: Uint8Array;
  /** The body as UTF-8. */
  text(): string;
  /** The body parsed as JSON. */
  json(): unknown;
}

/** Why `host.recipients.fetch` sent nothing, or got no answer. */
export const PLUGIN_RECIPIENT_ERROR_CODES = [
  /** The manifest declares no recipient by that id. */
  "recipient-not-declared",
  /** The path is not a path on the recipient's origin. */
  "path-refused",
  /** The method, a header, the body or the timeout is not one the host sends. */
  "request-refused",
  /** The disclosure names a category the recipient is not declared to receive. */
  "personal-data-not-declared",
  /** The disclosure names a person the plugin may not send data about. */
  "subject-refused",
  /** The origin's host is not an address this instance may connect to. */
  "address-refused",
  /** The recipient redirected to another origin, or more than five times. */
  "redirect-refused",
  /** No answer: the connection failed or the deadline passed. */
  "unreachable",
  /** The answer's body was longer than 16 MiB. */
  "response-too-large",
] as const;

export type PluginRecipientErrorCode =
  (typeof PLUGIN_RECIPIENT_ERROR_CODES)[number];

/**
 * A request to a recipient the host refused or could not complete.
 *
 * The message never repeats the path, a header or the body: a plugin may put
 * a resident's name in any of them, and the error ends up in the log.
 */
export class PluginRecipientError extends Error {
  constructor(
    readonly pluginId: string,
    readonly recipient: string,
    readonly code: PluginRecipientErrorCode,
  ) {
    super(
      `Plugin "${pluginId}" could not reach its recipient "${recipient}": ${code}.`,
    );
    this.name = "PluginRecipientError";
  }
}

/**
 * The way out to the places the manifest's `recipients` declares (ADR 0037).
 *
 * `fetch` reaches the declared origin of the recipient named and nothing
 * else, through the instance's outbound address rules, and follows a
 * redirect only within that origin. A request whose body carries personal
 * data says so in `disclosure`, and the host records it per person before
 * and after the send.
 *
 * Needs no permission: the declaration is what the board consented to.
 * Added after this contract version shipped, like `actions`: a plugin built
 * against a newer host than the one it is installed on must feature-detect
 * before using it.
 */
export interface PluginRecipients {
  fetch(
    id: string,
    /** Starts with `/`, and may carry a query: `/v1/messages?beta=true`. */
    path: string,
    init?: PluginRecipientRequest,
  ): Promise<PluginRecipientResponse>;
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
   * The way out to the recipients this plugin declared.
   *
   * Added after this contract version shipped, like `actions`: a plugin built
   * against a newer host than the one it is installed on must feature-detect
   * before using it.
   */
  recipients: PluginRecipients;
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
