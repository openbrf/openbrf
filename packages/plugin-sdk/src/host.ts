import type { PluginActions } from "./actions.ts";
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
   * The association's published content: its news, its calendar and when
   * its bookable resources are taken (ADR 0032).
   *
   * Added after this contract version shipped, like `actions`: a plugin built
   * against a newer host than the one it is installed on must feature-detect
   * before using them.
   */
  news: PluginNews;
  calendar: PluginCalendar;
  bookings: PluginBookings;
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
