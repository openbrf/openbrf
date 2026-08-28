import { Injectable, Logger } from "@nestjs/common";
import {
  defaultSettings,
  type PluginAddressBook,
  type PluginHost,
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

import { JobQueueService } from "../jobs/job-queue.service";
import { MailService } from "../mail/mail.service";
import { PluginAddressBookService } from "./plugin-address-book.service";
import { pluginMail } from "./plugin-mail.template";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * Assembles the host object one plugin receives.
 *
 * Every service is present whether or not the plugin declared the permission
 * it needs, and the ones it did not declare throw. Handing out nulls would put
 * a null check in every call site of a plugin that did declare the permission,
 * for a case its manifest has already ruled out.
 *
 * The permissions used here are the CONSENTED set from the database, not the
 * manifest's. The two are compared by the loader, which refuses a plugin
 * asking for more than the board agreed to; taking the consented set here as
 * well means that even if that comparison were removed, a republished version
 * could not quietly widen its own reach.
 */
@Injectable()
export class PluginHostFactory {
  constructor(
    private readonly registry: PluginRegistryService,
    private readonly jobs: JobQueueService,
    private readonly mail: MailService,
    private readonly addressBook: PluginAddressBookService,
  ) {}

  create(
    manifest: PluginManifest,
    consented: readonly PluginPermission[],
  ): PluginHost {
    const granted = new Set(consented);
    const require = (permission: PluginPermission): void => {
      if (!granted.has(permission)) {
        throw new PluginPermissionError(manifest.id, permission);
      }
    };

    return {
      id: manifest.id,
      permissions: [...granted],
      logger: this.logger(manifest.id),
      settings: this.settings(manifest),
      mail: this.mailService(manifest.id, require),
      jobs: this.jobService(manifest.id, require),
      addressBook: this.addressBookService(granted, require),
    };
  }

  /**
   * A logger tagged with the plugin's id.
   *
   * A plugin reaching for console would produce output indistinguishable from
   * the core's, and an operator reading a log needs to know which plugin
   * produced a line before they can decide whether to disable it.
   */
  private logger(pluginId: string): PluginLogger {
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
   * column is JSON, and a plugin that shipped a new settingsSchema in an
   * upgrade would otherwise be handed values shaped for the old one.
   */
  private settings(manifest: PluginManifest): PluginSettings {
    return {
      read: async (): Promise<PluginSettingsValues> => {
        const schema = manifest.settingsSchema;
        if (schema === undefined) {
          return {};
        }
        const record = await this.registry.find(manifest.id);
        const parsed = settingsValidator(schema).safeParse(
          record?.settings ?? {},
        );
        return parsed.success ? parsed.data : defaultSettings(schema);
      },
    };
  }

  private mailService(
    pluginId: string,
    require: (permission: PluginPermission) => void,
  ): PluginMail {
    return {
      send: async (message: PluginMailMessage): Promise<void> => {
        require("mail:send");
        await this.mail.send({
          to: message.to,
          // A plugin composes its own message and is responsible for having
          // written it in the recipient's language; there is no template for
          // the host to render per locale.
          locale: null,
          template: pluginMail,
          props: {
            subject: message.subject,
            text: message.text,
            html: message.html,
            pluginId,
          },
        });
      },
    };
  }

  /**
   * Background work, on queues named for the plugin.
   *
   * The prefix is applied here rather than trusted to the plugin, so two
   * plugins cannot collide on a queue name and no plugin can subscribe to a
   * core queue and consume the association's move-out reminders.
   */
  private jobService(
    pluginId: string,
    require: (permission: PluginPermission) => void,
  ): PluginJobs {
    const queue = (name: string): string => `plugin:${pluginId}:${name}`;

    return {
      work: async (name, handler) => {
        require("jobs:schedule");
        await this.jobs.work(queue(name), handler);
      },
      send: async (name, data) => {
        require("jobs:schedule");
        await this.jobs.send(queue(name), data);
      },
      sendAt: async (name, data, runAt) => {
        require("jobs:schedule");
        await this.jobs.sendAt(queue(name), data, runAt);
      },
      schedule: async (name, cron, data) => {
        require("jobs:schedule");
        await this.jobs.schedule(queue(name), cron, data);
      },
    };
  }

  private addressBookService(
    granted: ReadonlySet<PluginPermission>,
    require: (permission: PluginPermission) => void,
  ): PluginAddressBook {
    const contact = granted.has("addressBook:readContact");

    return {
      apartments: async () => {
        require("addressBook:read");
        return this.addressBook.apartments();
      },
      residents: async () => {
        require("addressBook:read");
        return this.addressBook.residents({ contact });
      },
      summary: async () => {
        require("addressBook:read");
        return this.addressBook.summary();
      },
    };
  }
}

/**
 * The core capability a caller needs before a plugin route may run.
 *
 * A plugin's route is reached through the application's own guard, so the
 * caller is already authenticated. This decides how much more than that is
 * required, and it is derived from the plugin's data permissions rather than
 * taken from the route's own declaration alone: a plugin that reads contact
 * details must not be able to expose them through a route it declared as open
 * to any resident, whether by mistake or otherwise.
 *
 * The floor is raised, never lowered - a route asking for more than its
 * plugin's permissions imply keeps what it asked for.
 */
export function routeCapabilityFloor(
  permissions: readonly PluginPermission[],
): string {
  if (
    permissions.includes("addressBook:read") ||
    permissions.includes("addressBook:readContact")
  ) {
    return "addressBook:read";
  }
  return "self:manage";
}
