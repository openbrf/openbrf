import { Logger } from "@nestjs/common";
import {
  defaultSettings,
  type PluginAddressBook,
  type PluginHost,
  PluginHostUnavailableError,
  type PluginJobs,
  type PluginLogger,
  type PluginMail,
  type PluginMailMessage,
  type PluginManifest,
  type PluginPermission,
  PluginPermissionError,
  type PluginSettings,
  type PluginSettingsValues,
  settingsValidator,
} from "@openbrf/plugin-sdk";

import type { JobQueueService } from "../jobs/job-queue.service";
import type { MailService } from "../mail/mail.service";
import type { PluginAddressBookService } from "./plugin-address-book.service";
import { pluginMail } from "./plugin-mail.template";
import type { PluginRegistryService } from "./plugin-registry.service";

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
  addressBook: PluginAddressBookService;
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
          "access to the register, the mail server or the job queue.",
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

  return {
    id: pluginId,
    permissions: [...granted],
    logger: pluginLogger(pluginId),
    settings: pluginSettings(context, services),
    mail: pluginMailService(pluginId, services),
    jobs: pluginJobService(pluginId, services),
    addressBook: pluginAddressBook(granted, services),
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
 * Background work, on queues named for the plugin.
 *
 * The prefix is applied here rather than trusted to the plugin, so two plugins
 * cannot collide on a queue name and no plugin can subscribe to a core queue
 * and consume the association's move-out reminders.
 */
function pluginJobService(
  pluginId: string,
  services: (permission: PluginPermission | null) => PluginHostServices,
): PluginJobs {
  const queue = (name: string): string => `plugin:${pluginId}:${name}`;

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
 * The core capability a caller needs before a plugin's route may run.
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
): "addressBook:read" | "self:manage" {
  if (
    permissions.includes("addressBook:read") ||
    permissions.includes("addressBook:readContact")
  ) {
    return "addressBook:read";
  }
  return "self:manage";
}
