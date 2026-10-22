import { Logger } from "@nestjs/common";
import {
  type ActionClient,
  type ActionRequest,
  type ActionWithSchemas,
  defaultSettings,
  type JsonValue,
  type PluginActionFilter,
  type PluginActionRegistration,
  type PluginActions,
  type PluginAddressBook,
  type PluginBlockRegistration,
  type PluginBlocks,
  type PluginDevices,
  type PluginEntitlements,
  PLUGIN_FINANCE_EVENTS,
  type PluginFinances,
  type PluginHost,
  PluginHostUnavailableError,
  type PluginJobs,
  type PluginLogger,
  type PluginMail,
  type PluginMailMessage,
  type PluginManifest,
  type PluginPermission,
  PluginPermissionError,
  type PluginRecord,
  type PluginRecords,
  type PluginSettings,
  type PluginSettingsValues,
  type PluginSms,
  type PluginSmsMessage,
  type PluginThemes,
  settingsValidator,
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
import { deviceRequestOf } from "../devices/device-request";
import type { DeviceTokenService } from "../devices/device-token.service";
import type { FinanceEventsService } from "../finance-events/finance-events.service";
import type { JobQueueService } from "../jobs/job-queue.service";
import {
  type EntitlementsService,
  licenceReaderOf,
} from "../licences/entitlements.service";
import type { MailService } from "../mail/mail.service";
import type { SmsService } from "../sms/sms.service";
import type { PluginAddressBookService } from "./plugin-address-book.service";
import { pluginReceiptOf } from "./plugin-delivery-receipt";
import type { PluginFinancesService } from "./plugin-finances.service";
import { pluginMail } from "./plugin-mail.template";
import type { PluginRecordsService } from "./plugin-records.service";
import type { PluginRegistryService } from "./plugin-registry.service";
import type { PluginThemesService } from "./plugin-themes.service";

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
  jobs: JobQueueService;
  mail: MailService;
  sms: SmsService;
  addressBook: PluginAddressBookService;
  records: PluginRecordsService;
  finances: PluginFinancesService;
  receipts: DeliveryReceiptService;
  financeEvents: FinanceEventsService;
  actions: ActionRegistryService;
  callers: ActionCallerFactory;
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
          "access to the register, the mail server, the SMS provider, the " +
          "job queue or its own records.",
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
  return {
    id: pluginId,
    permissions: [...granted],
    logger: pluginLogger(pluginId),
    actions: pluginActions(context, services),
    blocks: pluginBlocks(context),
    settings: pluginSettings(context, services),
    mail: pluginMailService(pluginId, services),
    sms: pluginSmsService(services),
    jobs: pluginJobService(pluginId, services),
    addressBook: pluginAddressBook(granted, services),
    records: pluginRecords(pluginId, services),
    finances: pluginFinances(pluginId, services),
    devices: pluginDevices(context, services),
    themes: pluginThemes(context, services),
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
      const { registry } = services(null);
      const schema = context.manifest.settingsSchema;
      if (schema === undefined) {
        return {};
      }
      const record = await registry.find(context.manifest.id);
      const parsed = settingsValidator(schema).safeParse(
        record?.settings ?? {},
      );
      return parsed.success ? parsed.data : defaultSettings(schema);
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
    return `plugin/${pluginId}/${name}`;
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
 */
function pluginAddressBook(
  granted: ReadonlySet<PluginPermission>,
  services: (
    permission: PluginPermission | null,
    alternative?: PluginPermission,
  ) => PluginHostServices,
): PluginAddressBook {
  const contact = granted.has("addressBook:readContact");
  const read = (): PluginHostServices =>
    services("addressBook:read", "addressBook:readContact");

  return {
    apartments: async () => {
      const { addressBook } = read();
      return addressBook.apartments();
    },
    residents: async () => {
      const { addressBook } = read();
      return addressBook.residents({ contact });
    },
    summary: async () => {
      const { addressBook } = read();
      return addressBook.summary();
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
  pluginId: string,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginRecords {
  return {
    get: async <Value extends JsonValue>(collection: string, key: string) => {
      const { records } = services(null);
      return (await records.get(
        pluginId,
        collection,
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
        collection,
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
        collection,
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
        collection,
        key,
        options?.expectedRevision,
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
  if (
    permissions.includes("addressBook:read") ||
    permissions.includes("addressBook:readContact")
  ) {
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
 * Dispatch, as a plugin sees it.
 *
 * `register` is the exception to the rule that the host answers nothing before
 * the application is built: a declaration made in a module factory is buffered
 * and flushed by the binder. `list` and `invoke` keep the ordinary gate, since
 * a route serving a request means the application exists.
 *
 * Neither `list` nor `invoke` takes a person. They take the request the
 * plugin's own route received, and the caller is read from the mark core put on
 * it - so a plugin dispatches as whoever is actually on the other end of the
 * request it is serving, and cannot dispatch as anybody else.
 *
 * Nor through any channel but its own. Whether the dispatch is a plugin's or
 * the AI package's is read from the manifest in this context, which the loader
 * holds and the plugin's code never wrote, so no argument to either function
 * can change it.
 */
function pluginActions(
  context: PluginHostContext,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginActions {
  // Read once, as the host is built: the dispatcher is fixed for the life of
  // this host object.
  const dispatcher = { ai: context.manifest.ai };
  return {
    register(registration: PluginActionRegistration): void {
      context.bufferedActions.push(registration);
    },
    async list(
      request: ActionRequest,
      filter?: PluginActionFilter,
    ): Promise<ActionWithSchemas[]> {
      const resolved = services(null);
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
    client(request: ActionRequest): ActionClient | null {
      // From a caller minted for the request, so the answer is the one a
      // dispatch on it would be recorded with, and a token the plugin wrote
      // onto the request, or took off it, changes neither.
      const { callers } = services(null);
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
 */
function pluginThemes(
  context: PluginHostContext,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginThemes {
  return {
    install: async (request, archive, options) => {
      const { themes } = services("themes:install");
      return themes.install(
        context.manifest.id,
        { ai: context.manifest.ai },
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
