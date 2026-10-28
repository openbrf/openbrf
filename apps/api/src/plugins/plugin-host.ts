import { Logger } from "@nestjs/common";
import {
  type ActionClient,
  type ActionRequest,
  type ActionWithSchemas,
  type ExtensionContributionDefinition,
  type ExtensionContributionSummary,
  type ExtensionGroupMember,
  extensionGroups,
  type ExtensionPointDefinition,
  type ExtensionResult,
  type ExtensionTarget,
  type JsonValue,
  type PluginActionFilter,
  type PluginActionRegistration,
  type PluginActions,
  type PluginAddressBook,
  type PluginAudit,
  type PluginAddresses,
  type PluginBlockRegistration,
  type PluginBlocks,
  type PluginExtensions,
  type PluginBookings,
  type PluginCalendar,
  type PluginDevices,
  type PluginEntitlements,
  PLUGIN_FINANCE_EVENTS,
  type PluginFinances,
  type PluginHost,
  PluginHostUnavailableError,
  type ImportProposalReceipt,
  ImportProposalRefusedError,
  type ImportProposalStatus,
  type PluginImports,
  type PluginInstance,
  type PluginJobs,
  type PluginLogger,
  type PluginMail,
  type PluginMailMessage,
  type PluginManifest,
  type PluginMedia,
  type PluginNews,
  type PluginPermission,
  PluginPermissionError,
  type JsonObject,
  type PluginPersonRecord,
  type PluginPersonRecords,
  type PluginRecipients,
  type PluginRecord,
  PluginRecordSubjectError,
  type PluginRecords,
  type PluginResidentFilter,
  PluginResidentRouteError,
  type PluginResidentRouteRefusedMember,
  type PluginSettings,
  type PluginSettingsValues,
  type PluginSms,
  type PluginSmsMessage,
  type PendingChangeReceipt,
  type PluginThemes,
  readsAddressBook,
  undeclaredAudienceError,
} from "@openbrf/plugin-sdk";

import type {
  ActionCallerFactory,
  RequestWithToken,
} from "../actions/action-caller";
import type { ActionRegistryService } from "../actions/action-registry.service";
import { actionRefusal } from "../actions/action-refusal";
import type { Capability } from "../authorization/capabilities";
import type { DeliveryReceiptService } from "../delivery-receipts/delivery-receipt.service";
import {
  deviceRequestOf,
  isServedDeviceRequest,
} from "../devices/device-request";
import type { DeviceTokenService } from "../devices/device-token.service";
import type { FinanceEventsService } from "../finance-events/finance-events.service";
import { ImportError } from "../import/import-errors";
import type { ImportProposalService } from "../import/import-proposal.service";
import {
  type JobQueueService,
  pluginQueuePrefix,
} from "../jobs/job-queue.service";
import {
  type EntitlementsService,
  licenceReaderOf,
} from "../licences/entitlements.service";
import type { MailService } from "../mail/mail.service";
import type { PendingChangeService } from "../pending-changes/pending-change.service";
import type { SmsService } from "../sms/sms.service";
import type { PluginAddressBookService } from "./plugin-address-book.service";
import type {
  PluginAuditActor,
  PluginAuditDevice,
  PluginAuditService,
} from "./plugin-audit.service";
import type { PluginExtensionsService } from "./plugin-extensions.service";
import type { PluginAddressesService } from "./plugin-addresses.service";
import type { PluginBookingsService } from "./plugin-bookings.service";
import type { PluginCalendarService } from "./plugin-calendar.service";
import type { ContentReader } from "./plugin-content";
import { pluginReceiptOf } from "./plugin-delivery-receipt";
import type { PluginFinancesService } from "./plugin-finances.service";
import type { PluginInstanceService } from "./plugin-instance.service";
import { pluginMail } from "./plugin-mail.template";
import type { PluginMediaService } from "./plugin-media.service";
import type { PluginNewsService } from "./plugin-news.service";
import type { PluginRecipientsService } from "./plugin-recipients.service";
import type { PluginPersonRecordsService } from "./plugin-person-records.service";
import type { PluginRecordsService } from "./plugin-records.service";
import type { PluginRegistryService } from "./plugin-registry.service";
import type { PluginSettingsService } from "./plugin-settings.service";
import type { PluginThemesService } from "./plugin-themes.service";
import {
  residentRouteOf,
  residentRouteOfHostCall,
} from "./resident-route-scope";

/**
 * The host object a plugin receives, and the late binding behind it.
 *
 * A plugin's module factory runs before the application exists. That is not a
 * compromise but the order the system requires: a plugin's NestJS module has
 * to be in the graph when `NestFactory.create` builds it, or its controllers
 * are never registered and its routes are never served. Installing a plugin
 * ends by replacing the process, so a plugin is only ever loaded during a
 * boot, from what is on the data volume - there is no later moment to load one
 * at.
 *
 * The factory therefore receives an object whose members resolve out of the
 * application when they are used rather than when it is built. The services
 * are bound once, between `NestFactory.create` and `app.init()`, which is
 * after every provider has been constructed and before any lifecycle hook or
 * request handler runs. What a plugin may do with the object follows from
 * that: everything from `onModuleInit` onwards, nothing from a constructor.
 */

/** The application services a plugin's host object reads through. */
export interface PluginHostServices {
  registry: PluginRegistryService;
  settings: PluginSettingsService;
  jobs: JobQueueService;
  mail: MailService;
  sms: SmsService;
  addressBook: PluginAddressBookService;
  news: PluginNewsService;
  calendar: PluginCalendarService;
  bookings: PluginBookingsService;
  media: PluginMediaService;
  addresses: PluginAddressesService;
  instance: PluginInstanceService;
  records: PluginRecordsService;
  personRecords: PluginPersonRecordsService;
  finances: PluginFinancesService;
  receipts: DeliveryReceiptService;
  financeEvents: FinanceEventsService;
  actions: ActionRegistryService;
  callers: ActionCallerFactory;
  audit: PluginAuditService;
  recipients: PluginRecipientsService;
  pendingChanges: PendingChangeService;
  extensions: PluginExtensionsService;
  importProposals: ImportProposalService;
  devices: DeviceTokenService;
  themes: PluginThemesService;
  entitlements: EntitlementsService;
}

/**
 * Holds the services until the application has built them.
 *
 * An explicit holder rather than a proxy over the injector: the failure a
 * plugin author will actually hit is calling the host from a constructor, and
 * a named error saying so is worth more than a lazily-thrown injection
 * failure from somewhere inside the framework.
 */
export class PluginHostBinding {
  private services: PluginHostServices | null = null;

  bind(services: PluginHostServices): void {
    this.services = services;
  }

  get bound(): boolean {
    return this.services !== null;
  }

  resolve(pluginId: string): PluginHostServices {
    if (this.services === null) {
      throw new PluginHostUnavailableError(
        pluginId,
        "before the application had finished starting. Host services are " +
          "available from onModuleInit onwards, not from a constructor.",
      );
    }
    return this.services;
  }
}

/**
 * The process's binding.
 *
 * One per process because there is one application per process, and the
 * plugins are loaded before there is a container to hold it in. Provided to
 * the injector by PluginsModule so that nothing else reaches for it directly.
 */
export const pluginHostBinding = new PluginHostBinding();

/**
 * One plugin's mutable state, shared between the host object and the loader.
 *
 * `serving` is what a board switching a plugin off changes. It is read on
 * every call rather than captured, so disabling reaches a plugin's own
 * background worker as well as its routes - the code stays in the process
 * until the next boot, but everything it could reach the association's data
 * through stops answering it.
 */
export interface PluginHostContext {
  manifest: PluginManifest;
  consented: readonly PluginPermission[];
  serving: boolean;
  /**
   * Registrations made before the application existed.
   *
   * A plugin's module factory runs long before the container is built, and
   * `register` is the one host member a plugin will reasonably want to call
   * there - it is a declaration, not work. So it is buffered here and flushed
   * into the registry by the binder, inside the same window the other services
   * are bound in. Every other member keeps the ordinary gate.
   */
  bufferedActions: PluginActionRegistration[];
  /**
   * The render functions of the plugin's website blocks, kept the same way
   * and flushed by the binder in the same window. A block is a declaration
   * too: the render function is not called until somebody reads a page.
   */
  bufferedBlocks: PluginBlockRegistration[];
  /**
   * The schemas of the plugin's extension points and the handlers it
   * contributes to other plugins' points (ADR 0030), kept the same way and
   * flushed by the binder in the same window: both are declarations, and
   * nothing is called until the application is up.
   */
  bufferedExtensionPoints: {
    point: string;
    definition: ExtensionPointDefinition<unknown, unknown>;
  }[];
  bufferedContributions: {
    target: ExtensionTarget;
    contribution: ExtensionContributionDefinition<unknown, unknown>;
  }[];
}

export function createPluginHost(
  binding: PluginHostBinding,
  context: PluginHostContext,
): PluginHost {
  const pluginId = context.manifest.id;
  const granted = new Set(context.consented);

  /**
   * The gate every service passes through.
   *
   * Three questions in one place: is the application up, is this plugin still
   * switched on, and did its manifest declare what it is reaching for. Any
   * service that skipped one of them would be the hole the other two exist to
   * close.
   */
  const services = (
    permission: PluginPermission | null,
    /** A second permission that satisfies the same gate. */
    alternative?: PluginPermission,
  ): PluginHostServices => {
    const resolved = binding.resolve(pluginId);
    if (!context.serving) {
      throw new PluginHostUnavailableError(
        pluginId,
        "after it stopped serving. A plugin the board switched off keeps no " +
          "access to the register, the association's content, the mail " +
          "server, the SMS provider, the job queue or its own records.",
      );
    }
    if (
      permission !== null &&
      !granted.has(permission) &&
      (alternative === undefined || !granted.has(alternative))
    ) {
      // Named after the permission a declaration would normally carry, which
      // is the one a plugin author will recognise from the manifest.
      throw new PluginPermissionError(pluginId, permission);
    }
    return resolved;
  };

  const entitlements = pluginEntitlements(context, services);
  const reader = contentReaderOf(context.manifest);
  return {
    id: pluginId,
    permissions: [...granted],
    logger: pluginLogger(pluginId),
    actions: pluginActions(context, services),
    blocks: pluginBlocks(context),
    extensions: pluginExtensions(context, services),
    settings: pluginSettings(context, services),
    mail: pluginMailService(pluginId, services),
    sms: pluginSmsService(services),
    jobs: pluginJobService(pluginId, services),
    addressBook: pluginAddressBook(context, granted, services),
    audit: pluginAudit(context, services),
    news: pluginNews(reader, services),
    calendar: pluginCalendar(reader, services),
    bookings: pluginBookings(reader, services),
    media: pluginMedia(services),
    addresses: pluginAddresses(services),
    records: pluginRecords(context, services),
    personRecords: pluginPersonRecords(context, services),
    finances: pluginFinances(pluginId, services),
    recipients: pluginRecipients(context, services),
    devices: pluginDevices(context, services),
    themes: pluginThemes(context, services),
    imports: pluginImports(pluginId, services),
    instance: pluginInstance(services),
    ...(entitlements === null ? {} : { entitlements }),
  };
}

/**
 * The plugin's licence, judged by the host (ADR 0042).
 *
 * Only on a plugin whose manifest declares a licence, which is how a plugin
 * tells a host that judges licences from one that does not. Its entitlement
 * and its keys are the manifest's, so a plugin reads only licences its own
 * keys verified and presents only the entitlement it declares. Behind the
 * ordinary gate: a plugin the board switched off reads nothing.
 */
function pluginEntitlements(
  context: PluginHostContext,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginEntitlements | null {
  const reader = licenceReaderOf(context.manifest);
  if (reader === null) {
    return null;
  }
  return {
    get: async () => services(null).entitlements.get(reader),
    present: async (audience: string) => {
      if (!reader.licence.audiences.includes(audience)) {
        throw undeclaredAudienceError();
      }
      return services(null).entitlements.present(reader, audience);
    },
  };
}

/**
 * A logger tagged with the plugin's id.
 *
 * Not gated on the binding: logging is the one thing a plugin must be able to
 * do at any moment, including from the constructor that is about to fail.
 * A plugin reaching for console would produce output indistinguishable from
 * the core's, and an operator reading a log needs to know which plugin
 * produced a line before they can decide whether to disable it.
 */
function pluginLogger(pluginId: string): PluginLogger {
  const logger = new Logger(`plugin:${pluginId}`);
  return {
    debug: (message) => {
      logger.debug(message);
    },
    info: (message) => {
      logger.log(message);
    },
    warn: (message) => {
      logger.warn(message);
    },
    error: (message, cause) => {
      logger.error(message, cause);
    },
  };
}

/**
 * The plugin's own settings.
 *
 * Read on every call rather than cached, so a value changed in the admin
 * interface reaches a long-running worker without a restart. Validated
 * against the declared schema on the way out as well as on the way in: the
 * column is JSON, and a plugin that shipped a new settingsSchema in an upgrade
 * would otherwise be handed values shaped for the old one.
 */
function pluginSettings(
  context: PluginHostContext,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginSettings {
  return {
    read: async (): Promise<PluginSettingsValues> => {
      const { settings } = services(null);
      const schema = context.manifest.settingsSchema;
      if (schema === undefined) {
        return {};
      }
      return await settings.forPlugin(context.manifest.id, schema);
    },
    /*
     * Behind the same gate as every other service, so a plugin the board
     * switched off cannot go on writing credentials into the instance.
     */
    writeSecret: async (key: string, value: string | null): Promise<void> => {
      const { settings } = services(null);
      await settings.writeFromPlugin(
        context.manifest.id,
        context.manifest.settingsSchema,
        key,
        value,
      );
    },
  };
}

function pluginMailService(
  pluginId: string,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginMail {
  return {
    send: async (message: PluginMailMessage): Promise<void> => {
      const { mail } = services("mail:send");
      await mail.send({
        to: message.to,
        // A plugin composes its own message and is responsible for having
        // written it in the recipient's language; there is no template for
        // the host to render per locale.
        locale: null,
        template: pluginMail,
        props: {
          subject: message.subject,
          text: message.text,
          pluginId,
        },
      });
    },
  };
}

/**
 * Text messages, through whichever provider the board configured.
 *
 * No template and no footer, which is where this parts company with plugin
 * mail: an SMS carries no markup to escape and is billed by its length, so a
 * line the host added naming the plugin would cost the housing cooperative a
 * segment on every message. What identifies the sender is the sender name on
 * the housing cooperative's provider contract, which the SMS service applies
 * and no caller chooses.
 *
 * The unconfigured instance is not handled here either. Whether a send without
 * a provider fails, is logged or is suppressed is the sending service's own
 * decision, taken once for every caller in the application; a plugin is not a
 * reason for a second answer to it, so this passes the failure through as the
 * news mailing does.
 */
function pluginSmsService(
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginSms {
  return {
    send: async (message: PluginSmsMessage): Promise<void> => {
      const { sms } = services("sms:send");
      await sms.send({ to: message.to, body: message.text });
    },
  };
}

/** One segment of a queue name, in the characters the job queue accepts. */
const PLUGIN_QUEUE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Background work, on queues named for the plugin.
 *
 * The prefix is applied here rather than trusted to the plugin, so two plugins
 * cannot collide on a queue name and no plugin can subscribe to a core queue
 * and consume the association's move-out reminders.
 *
 * Separated by `/`, which no core queue name contains and the job queue
 * accepts - it refuses a `:`, which is what every plugin queue name used to
 * carry. The plugin's own part is one segment, so it cannot add a level of its
 * own to the prefix.
 */
function pluginJobService(
  pluginId: string,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginJobs {
  const queue = (name: string): string => {
    if (!PLUGIN_QUEUE_NAME.test(name)) {
      // The name is left out: a plugin may pass anything here, a resident's
      // address included, and the error ends up in the log.
      throw new RangeError(
        `Plugin "${pluginId}" named a job queue the job queue refuses; ` +
          "a queue name is 1-64 letters, digits, '_', '.' or '-'.",
      );
    }
    return `${pluginQueuePrefix(pluginId)}${name}`;
  };

  return {
    work: async (name, handler) => {
      const { jobs } = services("jobs:schedule");
      await jobs.work(queue(name), handler);
    },
    send: async (name, data) => {
      const { jobs } = services("jobs:schedule");
      await jobs.send(queue(name), data);
    },
    sendAt: async (name, data, runAt) => {
      const { jobs } = services("jobs:schedule");
      await jobs.sendAt(queue(name), data, runAt);
    },
    schedule: async (name, cron, data) => {
      const { jobs } = services("jobs:schedule");
      await jobs.schedule(queue(name), cron, data);
    },
  };
}

/**
 * Reading the register, scoped to what the plugin declared.
 *
 * Three rules hold on every method regardless of permission, because they are
 * the product's own and a plugin is not a reason to relax them: a person with
 * protected personal data never appears, a personal identity number is never
 * returned, and nothing is writable. The contact fields are present only when
 * the plugin declared addressBook:readContact, which is decided here and not
 * by the caller.
 *
 * Either address-book permission opens the gate. The manifest schema accepts
 * addressBook:readContact on its own, and it is strictly the wider of the two
 * - it adds email and phone to the same rows - so a plugin declaring only that
 * asks for more than addressBook:read and must not be refused the reads that
 * one would have allowed.
 *
 * The plugin's id goes with every read, from the host object and never from
 * the plugin, because it decides who is left out: a person whose objection to
 * this plugin's processing stands is absent from what it reads (ADR 0035).
 */
function pluginAddressBook(
  context: PluginHostContext,
  granted: ReadonlySet<PluginPermission>,
  services: (
    permission: PluginPermission | null,
    alternative?: PluginPermission,
  ) => PluginHostServices,
): PluginAddressBook {
  const pluginId = context.manifest.id;
  const contact = granted.has("addressBook:readContact");
  const read = (): PluginHostServices =>
    services("addressBook:read", "addressBook:readContact");

  return {
    apartments: async () => {
      const { addressBook } = read();
      await refuseOnResidentRoute(pluginId, "addressBook.apartments");
      return addressBook.apartments();
    },
    residents: async (filter?: PluginResidentFilter) => {
      const { addressBook } = read();
      await refuseOnResidentRoute(pluginId, "addressBook.residents");
      return addressBook.residents(pluginId, {
        contact,
        filter: residentFilter(pluginId, filter),
      });
    },
    summary: async () => {
      const { addressBook } = read();
      await refuseOnResidentRoute(pluginId, "addressBook.summary");
      return addressBook.summary(pluginId);
    },
    /*
     * The person is the one core marked on the request, read through the same
     * mark `actions` and `audit` read, so a plugin cannot ask about anybody
     * but whoever it is serving. On a resident route, only the request the
     * route is serving.
     */
    caller: async (request) => {
      const resolved = read();
      await heldToServedRequest(pluginId, request, "addressBook.caller");
      return resolved.addressBook.caller(
        pluginId,
        markedPerson(resolved, context, request),
        { contact },
      );
    },
  };
}

/**
 * Refuses a register read on a resident route of the plugin's (ADR 0051).
 *
 * `residents()` would give every resident a second resident directory, and
 * `apartments()` and `summary()` name nobody but have no use there: a listed
 * count read before and after a neighbour moves in says whether the address
 * book lists that neighbour. Made elsewhere while a resident route of the
 * plugin's has yet to answer, the read waits for that answer first, and is
 * refused if it does not come in time (`residentRouteOfHostCall`).
 */
async function refuseOnResidentRoute(
  pluginId: string,
  member: PluginResidentRouteRefusedMember,
): Promise<void> {
  if ((await residentRouteOfHostCall(pluginId, member)) !== null) {
    throw new PluginResidentRouteError(pluginId, member);
  }
}

/**
 * Refuses, on a resident route of the plugin's (ADR 0051), a request other
 * than the one the route is serving.
 *
 * A plugin that kept another request it was handed, in a singleton for "the
 * current request" as a NestJS service often does, would otherwise read the
 * person behind it, dispatch an action with their capabilities, or name them
 * as the actor of the resident's act. The mark core puts on a request ends
 * with its response, so only a request still being served could be used this
 * way, and that is the one refused here. Made elsewhere while a resident route
 * of the plugin's has yet to answer, the call waits for that answer first, and
 * is refused if it does not come in time (`residentRouteOfHostCall`).
 */
async function heldToServedRequest(
  pluginId: string,
  request: unknown,
  member: PluginResidentRouteRefusedMember,
): Promise<void> {
  const scope = await residentRouteOfHostCall(pluginId, member);
  if (scope !== null && request !== scope.request) {
    throw new PluginResidentRouteError(pluginId, member);
  }
}

/**
 * The person core marked on a request a plugin is serving, or null where it
 * marked nobody: a device, or a request that did not come through core.
 */
function markedPerson(
  resolved: PluginHostServices,
  context: PluginHostContext,
  request: unknown,
): string | null {
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const caller = resolved.callers.resolve(
    resolved.callers.forPlugin(request as RequestWithToken, {
      id: context.manifest.id,
      ai: context.manifest.ai,
    }),
  );
  return caller?.personId ?? null;
}

/**
 * The filter as the address book reads it, or a TypeError.
 *
 * A plugin is JavaScript whatever its types say, and an `addressId` that is
 * not a string would reach the query as something other than an id. Only the
 * keys the contract defines are read, so a filter the host does not know
 * narrows nothing it could misread.
 */
function residentFilter(
  pluginId: string,
  filter: unknown,
): PluginResidentFilter | undefined {
  if (filter === undefined || filter === null) {
    return undefined;
  }
  const addressId: unknown =
    typeof filter === "object" ? Reflect.get(filter, "addressId") : null;
  if (addressId === undefined) {
    return undefined;
  }
  if (typeof addressId !== "string") {
    throw new TypeError(
      `Plugin "${pluginId}" filtered the residents by something other than ` +
        "an object whose addressId is a string.",
    );
  }
  return { addressId };
}

/**
 * The audit log, as a plugin sees it (ADR 0035).
 *
 * The actor is read from the mark core put on the request, as `actions` reads
 * the caller, so a plugin can name as the actor only whoever is on the other
 * end of a request it is serving. A request one of its own device routes
 * received names nobody, and spends the device's budget rather than the
 * plugin's own, so that whoever holds a device's token cannot stop the plugin
 * by making it audit them; it is held to being served as a person's is, so a
 * request kept past its response cannot stand in for a job's. With no request
 * there is no actor. Gated like every other service on the application being
 * up and the plugin serving, and on no permission: what a plugin did is
 * something the association is entitled to a record of. An entry that names a
 * `subject` is the exception and needs an address-book permission (ADR 0047):
 * whether it is accepted tells the plugin whether that person is listed to it,
 * which is the address book's answer.
 */
function pluginAudit(
  context: PluginHostContext,
  services: (
    permission: PluginPermission | null,
    alternative?: PluginPermission,
  ) => PluginHostServices,
): PluginAudit {
  const pluginId = context.manifest.id;
  const dispatcher = { id: pluginId, ai: context.manifest.ai };
  /** Whose request the entry is written on, or a refusal of the request. */
  function writtenOn(
    request: object,
    callers: PluginHostServices["callers"],
  ): PluginAuditActor | PluginAuditDevice {
    const device = deviceRequestOf(request);
    if (device?.pluginId === pluginId) {
      if (!isServedDeviceRequest(request)) {
        throw new Error(
          "This request has been answered, and acts for nobody once its " +
            "response is sent; act on a request only while serving it.",
        );
      }
      return { deviceTokenId: device.device.id };
    }
    // Throws for a request core did not authenticate, a device's on another
    // plugin's route among them, and for one it has since answered.
    const caller = callers.resolve(
      callers.forPlugin(request as RequestWithToken, dispatcher),
    );
    return {
      personId: caller.personId,
      clientId: caller.client?.clientId ?? null,
      clientHost: caller.client?.clientHost ?? null,
    };
  }

  return {
    async record(request, entry): Promise<void> {
      /*
       * Copied once, before anything waits, and the copy is both what is
       * checked and what is written: the plugin keeps its object and may
       * change it, or answer through a getter, so reading it a second time
       * could name a person the check never saw. Anything but an object -
       * an array included - is passed on as it is, never asked for a
       * subject, for the service to refuse as the shape it is.
       */
      const copy: Record<string, unknown> | null =
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? { ...entry }
          : null;
      const subject: unknown = copy?.["subject"];
      // Before the permission or the subject is looked at, so whether the
      // entry waits here, or is refused, turns on its shape alone. The actor
      // is held as `heldToServedRequest` holds it.
      if (request !== null || subject !== undefined) {
        const resident = await residentRouteOfHostCall(
          pluginId,
          "audit.record",
        );
        if (
          resident !== null &&
          request !== null &&
          request !== resident.request
        ) {
          throw new PluginResidentRouteError(pluginId, "audit.record");
        }
      }
      const resolved =
        subject === undefined
          ? services(null)
          : services("addressBook:read", "addressBook:readContact");
      if (
        subject !== undefined &&
        (typeof subject !== "string" ||
          !(await resolved.personRecords.mayName(pluginId, subject)))
      ) {
        throw new PluginRecordSubjectError(pluginId);
      }
      await resolved.audit.record(
        pluginId,
        request === null ? null : writtenOn(request, resolved.callers),
        copy ?? entry,
      );
    },
  };
}

/**
 * The association's published content (ADR 0032).
 *
 * Each read passes the same gate as every other service and nothing more: none
 * of the five is a register read, so the three rules above have nothing to
 * add here, and what each service selects is what keeps a person out of it.
 * What a plugin passes is read by the service and refused there with a
 * RangeError when it is not what the contract says.
 *
 * The one thing the host adds is who is reading. A plugin that declares a
 * device route is handed only what passes the register check, and no booking
 * that has ended; the host tells the service so from the manifest, which the
 * plugin cannot change once it is loaded.
 */
function contentReaderOf(manifest: PluginManifest): ContentReader {
  return { forDevices: manifest.deviceRoutes.length > 0 };
}

function pluginNews(
  reader: ContentReader,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginNews {
  return {
    published: async (options) => {
      const { news } = services("news:read");
      return news.published(options ?? {}, reader);
    },
  };
}

function pluginCalendar(
  reader: ContentReader,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginCalendar {
  return {
    occurrences: async (range) => {
      const { calendar } = services("calendar:read");
      return calendar.occurrences(range, reader);
    },
    meetingNotices: async () => {
      const { calendar } = services("calendar:read");
      return calendar.meetingNotices(reader);
    },
  };
}

function pluginBookings(
  reader: ContentReader,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginBookings {
  return {
    resources: async () => {
      const { bookings } = services("bookings:readAvailability");
      return bookings.resources(reader);
    },
    busy: async (range) => {
      const { bookings } = services("bookings:readAvailability");
      return bookings.busy(range, reader);
    },
  };
}

function pluginMedia(
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginMedia {
  return {
    open: async (mediaFileId) => {
      const { media } = services("media:read");
      return media.open(mediaFileId);
    },
  };
}

function pluginAddresses(
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginAddresses {
  return {
    list: async () => {
      const { addresses } = services("addresses:read");
      return addresses.list();
    },
  };
}

/**
 * The association's name and the instance's public origin.
 *
 * No permission, and behind the ordinary gate all the same: a plugin the board
 * switched off has nothing left to introduce the instance to.
 */
function pluginInstance(
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginInstance {
  return {
    read: async () => services(null).instance.read(),
  };
}

/**
 * The way out to the plugin's declared recipients.
 *
 * Behind the gate with no permission: the declaration is what the board
 * consented to, and the loader refuses a manifest that declares more than the
 * consent did, so the manifest is what is held to here. A plugin switched off
 * reaches nobody through it.
 */
function pluginRecipients(
  context: PluginHostContext,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginRecipients {
  return {
    fetch: async (id, path, init) => {
      const { recipients } = services(null);
      return recipients.fetch(
        context.manifest.id,
        context.manifest.recipients,
        id,
        path,
        init,
      );
    },
  };
}

/**
 * The plugin's own records (ADR 0033).
 *
 * No permission: a plugin's records reach nobody else's data, and the id the
 * store is keyed by is this object's, never one the plugin passes. The gate
 * still refuses before the application is up and after the board has switched
 * the plugin off, so a timer the plugin left running cannot write either.
 */
function pluginRecords(
  context: PluginHostContext,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginRecords {
  const pluginId = context.manifest.id;
  /*
   * A collection declared under `personRecords` belongs to that store, and
   * reaching it from here would hand its records over without the rules about
   * who may read them (ADR 0047).
   */
  const own = (collection: string): string => {
    if (
      context.manifest.personRecords.some(
        (declared) => declared.collection === collection,
      )
    ) {
      throw new RangeError(
        `Plugin "${pluginId}" reached a collection of records about a person ` +
          "through host.records; it is read through host.personRecords.",
      );
    }
    return collection;
  };
  return {
    get: async <Value extends JsonValue>(collection: string, key: string) => {
      const { records } = services(null);
      return (await records.get(
        pluginId,
        own(collection),
        key,
      )) as PluginRecord<Value> | null;
    },
    list: async <Value extends JsonValue>(
      collection: string,
      options?: { after?: string; limit?: number },
    ) => {
      const { records } = services(null);
      return (await records.list(
        pluginId,
        own(collection),
        options,
      )) as PluginRecord<Value>[];
    },
    put: async <Value extends JsonValue>(
      collection: string,
      key: string,
      value: Value,
      options?: { expectedRevision?: number | null },
    ) => {
      const { records } = services(null);
      return (await records.put(
        pluginId,
        own(collection),
        key,
        value,
        options?.expectedRevision,
      )) as PluginRecord<Value>;
    },
    delete: async (
      collection: string,
      key: string,
      options?: { expectedRevision?: number },
    ) => {
      const { records } = services(null);
      return records.delete(
        pluginId,
        own(collection),
        key,
        options?.expectedRevision,
      );
    },
  };
}

/**
 * The plugin's records about a person (ADR 0047).
 *
 * No permission of its own, as for its own records: what it may keep is what
 * its manifest declares under `personRecords`, which the board consented to,
 * and the declaration is the manifest's, never one the plugin passes. A
 * manifest that declares any also asks for an address-book permission, which
 * the manifest schema holds (`personRecordsRuleIssues`). Behind the same
 * gate, so a plugin the board switched off reads and writes none, while the
 * host's purge, erasure and access report carry on without it.
 */
function pluginPersonRecords(
  context: PluginHostContext,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginPersonRecords {
  const pluginId = context.manifest.id;
  const declared = context.manifest.personRecords;
  return {
    get: async <Value extends JsonObject>(collection: string, key: string) => {
      const { personRecords } = services(null);
      return (await personRecords.get(
        pluginId,
        declared,
        collection,
        key,
      )) as PluginPersonRecord<Value> | null;
    },
    list: async <Value extends JsonObject>(
      collection: string,
      options?: { subject?: string; after?: string; limit?: number },
    ) => {
      const { personRecords } = services(null);
      return (await personRecords.list(
        pluginId,
        declared,
        collection,
        options,
      )) as PluginPersonRecord<Value>[];
    },
    put: async <Value extends JsonObject>(
      collection: string,
      key: string,
      record: { subject: string; eraseOn: string; value: Value },
      options?: { expectedRevision?: number | null; expectedIdentity?: string },
    ) => {
      const { personRecords } = services(null);
      return (await personRecords.put(
        pluginId,
        declared,
        collection,
        key,
        record,
        options?.expectedRevision,
        options?.expectedIdentity,
      )) as PluginPersonRecord<Value>;
    },
    delete: async (
      collection: string,
      key: string,
      options?: { expectedRevision?: number; expectedIdentity?: string },
    ) => {
      const { personRecords } = services(null);
      return personRecords.delete(
        pluginId,
        declared,
        collection,
        key,
        options?.expectedRevision,
        options?.expectedIdentity,
      );
    },
  };
}

/**
 * The association's finances, scoped to what the plugin declared.
 *
 * The reads and the events behind finances:read, the receipt behind
 * finances:recordDelivery, and both through the same gate as every other
 * service: switched off, the plugin reads nothing, records nothing and hears
 * nothing - the gate is passed again on every event delivered, not only when
 * the plugin subscribed.
 *
 * The plugin's id is the host's and never the plugin's own say: it is what a
 * receipt and its audit entry name, whose receipt references a read shows, and
 * what the events queue is named for.
 */
function pluginFinances(
  pluginId: string,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginFinances {
  const read = (): PluginHostServices => services("finances:read");

  return {
    notifications: async () => read().finances.notifications(),
    notification: async (id) => read().finances.notification(pluginId, id),
    charges: async (period) => read().finances.charges(pluginId, period),
    charge: async (id) => read().finances.charge(pluginId, id),
    // Visible: the reference is what the plugin has just stated.
    recordDelivery: async (input) =>
      pluginReceiptOf(
        await services("finances:recordDelivery").receipts.record(
          pluginId,
          input,
        ),
        pluginId,
        false,
      ),
    events: {
      supported: Object.freeze({ ...PLUGIN_FINANCE_EVENTS }),
      subscribe: async (handler) => {
        const { financeEvents } = read();
        await financeEvents.listen(pluginId, async (event) => {
          try {
            read();
          } catch (cause) {
            // Dropped and not failed: a failed job is retried for two hours,
            // and would be handed over if the board switched the plugin back
            // on in that time. The contract says a queued event is not.
            if (cause instanceof PluginHostUnavailableError) {
              return;
            }
            throw cause;
          }
          await handler(event);
        });
      },
    },
  };
}

/**
 * The core capabilities a caller needs before a plugin's route may run, all of
 * them.
 *
 * A plugin's routes are reached through the application's own guard, so the
 * caller is already authenticated. This decides how much more than that is
 * required, and it is derived from the plugin's data permissions rather than
 * taken from the route's own declaration alone: a plugin that reads contact
 * details must not be able to expose them through a route it left open to any
 * resident, whether by mistake or otherwise.
 *
 * The floor is raised, never lowered - a route asking for more than its
 * plugin's permissions imply keeps what it asked for.
 */
export function routeCapabilityFloor(
  permissions: readonly PluginPermission[],
): readonly Capability[] {
  const floor: Capability[] = [];
  // The same test the record of processing activities keeps a row by, so a
  // permission that reads the address book added later raises both.
  if (readsAddressBook(permissions)) {
    floor.push("addressBook:read");
  }
  /*
   * Both of the board's money capabilities, because finances:read reads both
   * halves - the notices and the charges - and a caller holding only one would
   * otherwise be shown the other through the plugin. The receipt permission
   * raises the same two: it reads no row, but it writes against a notice or a
   * charge, and a route that records one on a caller's say would let anybody
   * with an account put a delivery beside the board's books.
   */
  if (
    permissions.includes("finances:read") ||
    permissions.includes("finances:recordDelivery")
  ) {
    floor.push("fees:manage", "memberCharges:manage");
  }
  return floor.length === 0 ? ["self:manage"] : floor;
}

/**
 * The floor of every plugin's routes, by id, read from the permissions of the
 * plugins joined to it by extensions and not from its own alone (ADR 0052).
 *
 * An extension carries data both ways, and the host copies it without reading
 * it: an addon that reads the register can answer its host plugin with a name
 * however the point types the field, and the host plugin can hand that name to
 * another of its addons as a point's input. So a plugin that holds no register
 * permission can still hold what one of its group read, and return it from any
 * route. Each member's routes are held to the floor the whole group's
 * permissions imply. No member is granted another's permissions by this: what
 * rises is who may call it.
 */
export function extensionGroupFloors(
  members: readonly (Pick<ExtensionGroupMember, "id" | "extends"> & {
    readonly permissions: readonly PluginPermission[];
  })[],
): Map<string, readonly Capability[]> {
  const floors = new Map<string, readonly Capability[]>();
  for (const group of extensionGroups(members)) {
    const floor = routeCapabilityFloor(
      group.flatMap((member) => member.permissions),
    );
    for (const member of group) {
      floors.set(member.id, floor);
    }
  }
  return floors;
}

/**
 * The installed plugins whose route floor installing `candidate` raises, in
 * the order of `installed` (ADR 0052): what the consent screen names before
 * the board installs it.
 *
 * The floors are compared as `extensionGroupFloors` reads them at the next
 * start, without and then with the candidate, which replaces an installed
 * release of itself. A plugin is named when its floor comes to hold a
 * capability it did not, so an addon that reads the address book names the
 * plugin it extends and that plugin's other addons, and one whose group held
 * that floor already names nothing. The candidate is never named: its own
 * floor is on the screen as its permissions.
 */
export function routeFloorsRaisedBy(
  installed: readonly (ExtensionGroupMember & {
    readonly permissions: readonly PluginPermission[];
  })[],
  candidate: ExtensionGroupMember & {
    readonly permissions: readonly PluginPermission[];
  },
): string[] {
  const others = installed.filter((member) => member.id !== candidate.id);
  const before = extensionGroupFloors(installed);
  const after = extensionGroupFloors([...others, candidate]);
  return others
    .filter((member) => {
      const was = new Set(before.get(member.id));
      // `self:manage` is the floor of a group that reads nothing, which every
      // account holds: an update that stops reading lowers, never raises.
      return (after.get(member.id) ?? []).some(
        (capability) => capability !== "self:manage" && !was.has(capability),
      );
    })
    .map((member) => member.id);
}

/**
 * Dispatch, as a plugin sees it.
 *
 * `register` is the exception to the rule that the host answers nothing before
 * the application is built: a declaration made in a module factory is buffered
 * and flushed by the binder. `list`, `invoke` and `propose` keep the ordinary
 * gate, since a route serving a request means the application exists.
 *
 * None of `list`, `invoke` and `propose` takes a person. They take the request
 * the plugin's own route received, and the caller is read from the mark core
 * put on it - so a plugin dispatches as whoever is actually on the other end
 * of the request it is serving, and cannot dispatch as anybody else.
 *
 * Nor through any channel but its own, nor under any name but its own.
 * Whether the dispatch is a plugin's or the AI package's, and which plugin the
 * audit entry names, are read from the manifest in this context, which the
 * loader holds and the plugin's code never wrote, so no argument to either
 * function can change them.
 */
function pluginActions(
  context: PluginHostContext,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginActions {
  // Read once, as the host is built: the dispatcher is fixed for the life of
  // this host object.
  const dispatcher = { id: context.manifest.id, ai: context.manifest.ai };
  return {
    register(registration: PluginActionRegistration): void {
      context.bufferedActions.push(registration);
    },
    async list(
      request: ActionRequest,
      filter?: PluginActionFilter,
    ): Promise<ActionWithSchemas[]> {
      const resolved = services(null);
      await heldToServedRequest(dispatcher.id, request, "actions.list");
      const caller = resolved.callers.forPlugin(
        request as RequestWithToken,
        dispatcher,
      );
      return resolved.actions.listWithSchemas(caller, filter);
    },
    async invoke<Output>(
      request: ActionRequest,
      name: string,
      input: unknown,
    ): Promise<Output> {
      const resolved = services(null);
      await heldToServedRequest(dispatcher.id, request, "actions.invoke");
      const caller = resolved.callers.forPlugin(
        request as RequestWithToken,
        dispatcher,
      );
      try {
        return await resolved.actions.invoke<Output>(caller, name, input);
      } catch (cause) {
        // Rejected as the published refusal rather than as the host's own
        // classes, which a plugin cannot import.
        throw (
          actionRefusal(
            cause,
            resolved.actions.get(name)?.definition.errors ?? [],
          ) ?? cause
        );
      }
    },
    async propose(
      request: ActionRequest,
      name: string,
      input: unknown,
    ): Promise<PendingChangeReceipt> {
      const resolved = services(null);
      await heldToServedRequest(dispatcher.id, request, "actions.propose");
      const caller = resolved.callers.forPlugin(
        request as RequestWithToken,
        dispatcher,
      );
      let proposed: Awaited<ReturnType<typeof resolved.pendingChanges.propose>>;
      try {
        proposed = await resolved.pendingChanges.propose(caller, name, input);
      } catch (cause) {
        // Refused the same way as invoke, so the connector tells a refused
        // proposal from a fault with the one guard the SDK publishes.
        throw (
          actionRefusal(
            cause,
            resolved.actions.get(name)?.definition.errors ?? [],
          ) ?? cause
        );
      }
      return {
        id: proposed.id,
        expiresAt: proposed.expiresAt,
        // Where the person confirms it: the platform's own screen, under the
        // application's base path. Composed here so no plugin builds it.
        path: `/app/pending-changes/${encodeURIComponent(proposed.id)}`,
      };
    },
    client(request: ActionRequest): ActionClient | null {
      // From a caller minted for the request, so the answer is the one a
      // dispatch on it would be recorded with, and a token the plugin wrote
      // onto the request, or took off it, changes neither.
      const { callers } = services(null);
      // Held to the request a resident route is serving, as dispatch is, so
      // a kept board request does not say which app its member signed in
      // with. Answered at once, so made elsewhere it does not wait: it names
      // an app, and no person or capability.
      const scope = residentRouteOf(dispatcher.id);
      if (scope !== null && request !== scope.request) {
        throw new PluginResidentRouteError(dispatcher.id, "actions.client");
      }
      return callers.resolve(callers.forRequest(request as RequestWithToken))
        .client;
    },
  };
}

/**
 * Theme installs, as a plugin sees them.
 *
 * Like dispatch, `install` takes the request the plugin's route received
 * rather than a person, and installs as whoever is behind it; the service
 * refuses a person who may not install themes. The plugin's id is supplied
 * here and not by the plugin, so the row records the plugin that really
 * installed the theme, and `list` can show it its own themes and no others.
 *
 * `install` is held to the request a resident route is serving, as dispatch
 * is (ADR 0051): a board request the plugin kept would otherwise install a
 * theme as the administrator behind it, at a time a resident chose.
 */
function pluginThemes(
  context: PluginHostContext,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginThemes {
  return {
    install: async (request, archive, options) => {
      const { themes } = services("themes:install");
      await heldToServedRequest(context.manifest.id, request, "themes.install");
      return themes.install(
        { id: context.manifest.id, ai: context.manifest.ai },
        request,
        archive,
        options.sha512,
      );
    },
    list: async () => {
      const { themes } = services("themes:install");
      return themes.list(context.manifest.id);
    },
  };
}

/**
 * Import proposals, as a plugin sees them (ADR 0043).
 *
 * Bound to the plugin's own id, so it proposes, reads and withdraws only its
 * own. What comes back is the receipt, the reason a file was refused, and the
 * state of its own proposals: nothing a row would do, which person it matched
 * or who decided, since each of those is a read of the register and
 * addressBook:proposeImport grants none.
 *
 * The arguments are checked here, because a plugin passes whatever it passes,
 * and a refusal is thrown as the SDK's own error with the reason alone: the
 * core's message can name the limit a file broke, and nothing of the file.
 */
function pluginImports(
  pluginId: string,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginImports {
  const proposals = (): ImportProposalService =>
    services("addressBook:proposeImport").importProposals;
  return {
    propose: async (file): Promise<ImportProposalReceipt> => {
      const service = proposals();
      const candidate = file as Partial<Record<keyof typeof file, unknown>>;
      if (typeof candidate.fileName !== "string") {
        throw new ImportProposalRefusedError("file-name-invalid");
      }
      if (!(candidate.content instanceof Uint8Array)) {
        throw new ImportProposalRefusedError("file-unreadable");
      }
      if (
        candidate.sender !== undefined &&
        candidate.sender !== null &&
        typeof candidate.sender !== "string"
      ) {
        throw new ImportProposalRefusedError("sender-invalid");
      }
      try {
        return await service.propose(pluginId, {
          fileName: candidate.fileName,
          // A view of the plugin's bytes, not a copy: the core reads them in
          // this call and keeps nothing of them.
          content: Buffer.from(
            candidate.content.buffer,
            candidate.content.byteOffset,
            candidate.content.byteLength,
          ),
          sender: candidate.sender ?? null,
        });
      } catch (cause) {
        if (cause instanceof ImportError) {
          throw new ImportProposalRefusedError(cause.reason);
        }
        throw cause;
      }
    },
    status: async (proposalId): Promise<ImportProposalStatus> => {
      const service = proposals();
      if (typeof proposalId !== "string") {
        return { state: "unknown", decidedAt: null };
      }
      return service.status(pluginId, proposalId);
    },
    withdraw: async (proposalId): Promise<boolean> => {
      const service = proposals();
      if (typeof proposalId !== "string") {
        return false;
      }
      return service.withdraw(pluginId, proposalId);
    },
  };
}

/**
 * Website blocks, as a plugin sees them.
 *
 * Only `register`, and it is buffered rather than gated, like an action's:
 * the binder reads the buffer once, while the application starts, and
 * registers each declared block that has a render function. The renderer is
 * called by the website, which checks on every call that the plugin is still
 * serving - so a plugin switched off stops rendering at once, without a gate
 * here.
 */
function pluginBlocks(context: PluginHostContext): PluginBlocks {
  return {
    register(registration: PluginBlockRegistration): void {
      context.bufferedBlocks.push(registration);
    },
  };
}

/**
 * Extension points, as a plugin sees them (ADR 0030).
 *
 * `define` and `contribute` are buffered declarations, flushed by the binder
 * with the actions and blocks. `list` and `invoke` keep the ordinary gate, so
 * a host plugin that is switched off can no longer call its addons, and they
 * refuse a point the plugin's own manifest does not declare: that is the host
 * plugin's mistake and is thrown, unlike anything the addon does.
 *
 * Nothing here hands the host plugin an addon's host object, or the addon the
 * host plugin's. The addon's handler closes over its own, and what crosses
 * between them is data the service copies.
 */
function pluginExtensions(
  context: PluginHostContext,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginExtensions {
  const pluginId = context.manifest.id;
  const declared = (point: string): void => {
    if (!context.manifest.extensionPoints.some((held) => held.id === point)) {
      throw new Error(
        `Plugin "${pluginId}" used the extension point "${point}", which its manifest does not declare.`,
      );
    }
  };

  return {
    define<Input, Output>(
      point: string,
      definition: ExtensionPointDefinition<Input, Output>,
    ): void {
      context.bufferedExtensionPoints.push({
        point,
        definition: definition as ExtensionPointDefinition<unknown, unknown>,
      });
    },
    contribute<Input, Output>(
      target: ExtensionTarget,
      contribution: ExtensionContributionDefinition<Input, Output>,
    ): void {
      context.bufferedContributions.push({
        target,
        contribution: contribution as ExtensionContributionDefinition<
          unknown,
          unknown
        >,
      });
    },
    async list(point: string): Promise<ExtensionContributionSummary[]> {
      const { extensions } = services(null);
      declared(point);
      return [...extensions.list(pluginId, point)];
    },
    async invoke<Output>(
      point: string,
      addon: string,
      input: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<ExtensionResult<Output>> {
      const { extensions } = services(null);
      declared(point);
      return extensions.invoke<Output>(
        pluginId,
        point,
        addon,
        input,
        options?.signal,
      );
    },
  };
}

/**
 * Device tokens, as a plugin sees them (ADR 0031).
 *
 * Bound to the plugin's own id, so it lists and revokes only its own tokens,
 * and issues only for a route its manifest declares. Issuing reads the person
 * from the request the plugin's route received, as `host.actions` does, so a
 * plugin cannot issue a token on its own initiative.
 *
 * `current` keeps no gate: it reads the mark the guard put on a request that
 * reached a device route of this plugin, which only a serving plugin can have
 * been handed.
 */
function pluginDevices(
  context: PluginHostContext,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginDevices {
  const pluginId = context.manifest.id;
  return {
    issue: async (request, options) => {
      const { devices } = services(null);
      return devices.issue(
        pluginId,
        context.manifest.deviceRoutes.map((route) => route.id),
        request,
        options,
      );
    },
    list: async (filter) => {
      const { devices } = services(null);
      return devices.list(pluginId, filter);
    },
    revoke: async (tokenId, request) => {
      const { devices } = services(null);
      return devices.revokeForPlugin(pluginId, tokenId, request);
    },
    current: (request) => {
      const mark = deviceRequestOf(request);
      if (mark?.pluginId !== pluginId) {
        throw new Error(
          `Plugin "${pluginId}" asked which device a request came from, but the request did not reach one of its device routes.`,
        );
      }
      return mark.device;
    },
  };
}
