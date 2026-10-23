import type { ActionRequest, PluginActions } from "./actions.ts";
import type { PluginBlocks } from "./blocks.ts";
import type { PluginExtensions } from "./extensions.ts";
import type { PluginEntitlements } from "./entitlements.ts";
import type { PluginFinances } from "./finances.ts";
import type { PluginImports } from "./imports.ts";
import type {
  PluginPermission,
  PluginPersonalDataCategory,
} from "./permissions.ts";
import type { PluginRecords } from "./records.ts";
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
 * Who a news item or an event is for: the members, or anyone at all.
 *
 * On every item the content services return, because the host cannot know
 * where the plugin puts it. A screen inside the building may show a members'
 * item and a public calendar feed should not; which of the two the plugin is
 * doing is what its consent screen tells the board (ADR 0032).
 */
export type PluginContentAudience = "anyone" | "members";

/** One published news item, as a plugin reads it. */
export interface PluginNewsItem {
  readonly id: string;
  readonly title: string;
  /** The body's text, one string per paragraph or heading, in order. */
  readonly paragraphs: readonly string[];
  /**
   * The pictures the body shows, in order.
   *
   * Empty while a news body holds prose only, which is all the core's news
   * editor writes and all the website shows of one.
   */
  readonly pictures: readonly { mediaFileId: string; alt: string }[];
  readonly audience: PluginContentAudience;
  /** ISO 8601 instant. */
  readonly publishedAt: string;
}

/**
 * The association's published news. Requires the news:read permission.
 *
 * What the website publishes and nothing more: a draft, an item taken down, a
 * deleted one and one the board wrote to Styrelsen or Administratörer in the
 * feed are absent. Never an author, a comment, a like or who has read an item.
 *
 * To a plugin that declares a device route, an item whose title, paragraphs or
 * picture alt texts name somebody the register holds, one of their email
 * addresses or phone numbers, or an apartment number is absent as well, and
 * the read goes on to older items to make up the count, as far back as the
 * newest 500 published items (ADR 0032).
 */
export interface PluginNews {
  /**
   * Published items, newest first.
   *
   * `limit` is 1 to 50 and defaults to 50. `since` is an ISO 8601 instant and
   * keeps the items published at or after it. `audience` keeps only the items
   * for that audience; without it both are returned, each saying which it is.
   * A value outside those bounds is refused with a RangeError.
   */
  published(options?: {
    audience?: PluginContentAudience;
    limit?: number;
    since?: string;
  }): Promise<readonly PluginNewsItem[]>;
}

/** One occurrence of a published event. */
export interface PluginOccurrence {
  readonly eventId: string;
  readonly occurrenceId: string;
  /** The board's own words, as written and never translated. */
  readonly title: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly location: string | null;
  /** ISO 8601 instant. */
  readonly startsAt: string;
  /** ISO 8601 instant. */
  readonly endsAt: string;
  /** Whether the board has called this one occurrence off. */
  readonly calledOff: boolean;
  /**
   * Places left when the event takes sign-ups with a limit, and null when it
   * takes none or has no limit. Never who took them.
   */
  readonly placesLeft: number | null;
  readonly audience: PluginContentAudience;
}

/**
 * The notice of a general meeting the board has called.
 *
 * What the notice states (EFL 6 kap. 22 §): the time, the place, how to take
 * part digitally and the matters on the agenda. Never who was summoned, who
 * attended, the voting register or a proxy.
 */
export interface PluginMeetingNotice {
  readonly meetingId: string;
  readonly kind: "ordinary" | "extraordinary";
  /** ISO 8601 instant. */
  readonly startsAt: string;
  readonly place: string;
  readonly digitalParticipation: string | null;
  readonly agenda: readonly { position: number; title: string }[];
}

/**
 * The association's calendar. Requires the calendar:read permission.
 *
 * Published events only: a series that is not published is absent, and an
 * occurrence the board called off is present and says so.
 *
 * To a plugin that declares a device route, an event whose title,
 * description, category or location names somebody the register holds or an
 * apartment number is absent with every occurrence, and a notice whose place,
 * digital participation or any agenda title does is absent whole (ADR 0032).
 */
export interface PluginCalendar {
  /**
   * Occurrences starting in [from, to), soonest first.
   *
   * `from` and `to` are ISO 8601 instants at most 92 days apart, and
   * `audience` works as it does for the news. A range that is not one is
   * refused with a RangeError.
   */
  occurrences(range: {
    from: string;
    to: string;
    audience?: PluginContentAudience;
  }): Promise<readonly PluginOccurrence[]>;
  /**
   * Notices of the general meetings called and not yet held, soonest first.
   *
   * A notice summons the members, so every one of them is for the members.
   */
  meetingNotices(): Promise<readonly PluginMeetingNotice[]>;
}

/** A bookable resource the house offers, and how it is booked. */
export interface PluginBookableResource {
  readonly id: string;
  /** The board's own name for it, as written. */
  readonly name: string;
  readonly mode: "timeSlots" | "wholeDay" | "dateRange";
  /** The slot length in the time-slot mode, and null otherwise. */
  readonly slotMinutes: number | null;
  /** Minutes after local midnight the resource opens, in the time-slot mode. */
  readonly opensAtMinute: number | null;
  /** Minutes after local midnight the resource closes, in the time-slot mode. */
  readonly closesAtMinute: number | null;
}

/** A period a resource is taken. Never by whom. */
export interface PluginBusyInterval {
  readonly resourceId: string;
  /** ISO 8601 instant. */
  readonly start: string;
  /** ISO 8601 instant. */
  readonly end: string;
}

/**
 * Free and busy for the house's bookable resources. Requires the
 * bookings:readAvailability permission.
 *
 * Less than a resident's own booking screen shows: when a resource is taken,
 * and nothing about who took it - no booker, no apartment and no booking's
 * identifier.
 *
 * To a plugin that declares a device route, a resource whose name names
 * somebody the register holds or an apartment number is absent from both
 * reads, and `busy` starts no earlier than the moment of the call, so no
 * booking that has ended is in it (ADR 0032).
 */
export interface PluginBookings {
  /** The resources open for booking, by name. A withdrawn one is absent. */
  resources(): Promise<readonly PluginBookableResource[]>;
  /**
   * When each resource is taken in [from, to), per resource and in order.
   *
   * `from` and `to` are ISO 8601 instants at most 31 days apart, refused with
   * a RangeError otherwise. Bookings that overlap or touch are merged into one
   * interval, so a run of slots cannot be read as one household's habits. A
   * resource id that is not an offered resource's answers nothing.
   */
  busy(range: {
    from: string;
    to: string;
    resourceIds?: readonly string[];
  }): Promise<readonly PluginBusyInterval[]>;
}

/**
 * The bytes of a picture, as a web stream of `Uint8Array` chunks.
 *
 * The host hands a real `ReadableStream`. This package compiles against the
 * language alone and cannot name the platform's type, so it is looked up in the
 * plugin's own program, as the block's abort signal is: where that has a
 * `ReadableStream`, from the DOM library or from Node's types, this is it, and
 * the stream can go into a `Response` or `Readable.fromWeb` as it is. Where it
 * has none, this is the part of one a plugin can read without them.
 */
export type PluginMediaStream = typeof globalThis extends {
  readonly ReadableStream: { readonly prototype: infer Stream };
}
  ? Stream
  : PluginMediaStreamShape;

/** What every `ReadableStream` has, for a program without the platform's types. */
interface PluginMediaStreamShape {
  readonly locked: boolean;
  cancel(reason?: unknown): Promise<void>;
  getReader(): {
    read(): Promise<
      { done: false; value: Uint8Array } | { done: true; value?: undefined }
    >;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
}

/**
 * A stored picture the plugin opened.
 *
 * What a reply serving it needs and nothing else: not the name it was uploaded
 * under, which is somebody's own words, and not who uploaded it.
 */
export interface PluginMediaFile {
  /** Identified from the bytes when they were uploaded: an image type. */
  readonly contentType: string;
  /** The size of the picture as uploaded, in bytes. */
  readonly byteSize: number;
  /**
   * A keyed hash of the bytes, hex encoded. The same value the core serves the
   * picture's entity tag from, so a plugin may use it as one too.
   */
  readonly checksum: string;
  /**
   * The picture's bytes. Read it to the end or cancel it: the host holds the
   * stored file open until one or the other.
   */
  readonly stream: PluginMediaStream;
}

/**
 * The association's stored pictures. Requires the media:read permission.
 *
 * Only a picture held for anyone or for the members whose upload declared that
 * it shows no identifiable person (ADR 0032). A photograph of people needs a
 * publication consent, and the consent the core records is for the website,
 * not for wherever a plugin puts the picture. Nothing here lists or finds a
 * picture: a plugin opens one whose id it already holds, such as one the board
 * picked in the plugin's own view.
 */
export interface PluginMedia {
  /**
   * Opens one picture.
   *
   * Null when the file does not exist and when it is not one a plugin may
   * read, the two alike, so the answer says nothing about a file the plugin
   * may not see. A `mediaFileId` that is not a string is refused with a
   * RangeError.
   */
  open(mediaFileId: string): Promise<PluginMediaFile | null>;
}

/** One of the association's addresses: an entrance, and nobody behind it. */
export interface PluginAddress {
  readonly id: string;
  readonly street: string;
  /** The street number, as written: "12", "12 B". */
  readonly number: string;
}

/**
 * The association's addresses. Requires the addresses:read permission.
 *
 * A fact about the building: never an apartment, a resident or a member, which
 * is what addressBook:read is for.
 */
export interface PluginAddresses {
  /** Every address, in the order the core's own screens show them. */
  list(): Promise<readonly PluginAddress[]>;
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
 * One device token, as the plugin and the board see it. Never the token.
 */
export interface DeviceTokenSummary {
  readonly id: string;
  /** The id of the device route it was issued for. */
  readonly route: string;
  /** The plugin's own name for the device, such as its screen id. */
  readonly subject: string;
  /** The board's name for it, such as "Entrance B, ground floor". */
  readonly label: string;
  readonly issuedAt: string;
  /** Updated at most once a minute while the device calls. */
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * Device tokens for the plugin's own device routes (ADR 0031).
 *
 * A device token reaches one device route of this plugin, names a device and
 * never a person, and is cut at once when revoked. The plugin issues one only
 * on a board member's request, and the board can revoke any of them from the
 * core's own devices screen, whatever the plugin's screen says.
 */
export interface PluginDevices {
  /**
   * Issues a device token, and returns it once. It is stored as a digest and
   * cannot be read again.
   *
   * `request` is the one the plugin's own route received. It has to come from
   * the web interface, not a connected app's token, from a person who holds
   * `site:manage` at that moment; anything else is refused. `route` is the id
   * of one of the plugin's declared device routes. `subject` is the plugin's
   * handle on the device, 1 to 64 letters, digits, `.`, `_`, `:` or `-`, and
   * `label` the board's name for it, at most 80 characters. A plugin holds at
   * most 200 live tokens.
   */
  issue(
    request: ActionRequest,
    options: { route: string; subject: string; label: string },
  ): Promise<{ token: string; device: DeviceTokenSummary }>;

  /** The plugin's own tokens, newest first. Revoked ones included. */
  list(filter?: {
    route?: string;
    subject?: string;
  }): Promise<readonly DeviceTokenSummary[]>;

  /**
   * Revokes one of the plugin's own tokens, at once. True when it was live.
   *
   * Pass the request when a person asked for it, so the audit log names them;
   * without one the revocation is recorded as the plugin's.
   */
  revoke(tokenId: string, request?: ActionRequest): Promise<boolean>;

  /**
   * Which token a request on one of the plugin's device routes came with.
   * Throws for any other request.
   */
  current(request: object): DeviceTokenSummary;
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
   * The extension points this plugin offers or extends (ADR 0030): a host
   * plugin defines its points and calls the addons serving there, and an
   * addon contributes its handler.
   *
   * Added after this contract version shipped, like `actions`: a plugin built
   * against a newer host than the one it is installed on must feature-detect
   * before using it.
   */
  extensions: PluginExtensions;
  /**
   * The association's published content: its news, its calendar, when its
   * bookable resources are taken, its pictures and its addresses (ADR 0032).
   *
   * Added after this contract version shipped, like `actions`: a plugin built
   * against a newer host than the one it is installed on must feature-detect
   * before using them.
   */
  news: PluginNews;
  calendar: PluginCalendar;
  bookings: PluginBookings;
  media: PluginMedia;
  addresses: PluginAddresses;
  /**
   * The way out to the recipients this plugin declared.
   *
   * Added after this contract version shipped, like `actions`: a plugin built
   * against a newer host than the one it is installed on must feature-detect
   * before using it.
   */
  recipients: PluginRecipients;
  /**
   * The plugin's own records: configuration it keeps under a collection and a
   * key, and never anything about a person (ADR 0033).
   *
   * Added after this contract version shipped, like `actions`: a plugin built
   * against a newer host than the one it is installed on must feature-detect
   * before using it.
   */
  records: PluginRecords;
  /**
   * Device tokens for the plugin's declared device routes.
   *
   * Added after this contract version shipped, like `actions`: a plugin built
   * against a newer host than the one it is installed on must feature-detect
   * before using it.
   */
  devices: PluginDevices;
  /**
   * Installing themes, and listing the ones this plugin installed.
   *
   * Added after this contract version shipped. An older host refuses a
   * manifest asking for themes:install before it loads the plugin, so a plugin
   * that declares the permission never meets a host without this member.
   */
  themes: PluginThemes;
  /**
   * Handing a member list to the board for review (ADR 0043).
   *
   * Added after this contract version shipped. An older host refuses a
   * manifest asking for addressBook:proposeImport before it loads the plugin,
   * so a plugin that declares the permission never meets a host without this
   * member; checking for it is a defensive guard only.
   */
  imports: PluginImports;
  /**
   * The plugin's licence, judged by the host (ADR 0042).
   *
   * Present only on a plugin whose manifest declares a `licence`, and added
   * after this contract version shipped, so a plugin feature-detects it as it
   * does `actions`. A paid plugin on a host without it has no way to tell a
   * licensed instance from an unlicensed one, and should stay dormant.
   */
  entitlements?: PluginEntitlements;
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
