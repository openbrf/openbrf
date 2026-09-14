import { Injectable, Logger } from "@nestjs/common";
import { composedActionName } from "@openbrf/plugin-sdk";

import { ActionCallerFactory } from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureFrames, failureName } from "../logging/failure";
import { MailService } from "../mail/mail.service";
import { SmsService } from "../sms/sms.service";
import { PluginAddressBookService } from "./plugin-address-book.service";
import { PluginHostBinding, routeCapabilityFloor } from "./plugin-host";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * Connects the host objects the plugins already hold to the application.
 *
 * The plugins were loaded before the application existed, so each one holds an
 * object whose services are resolved on use rather than on construction. This
 * is what fills that in, and it is called once from the bootstrap between
 * `NestFactory.create` and `app.init()` - after every provider has been
 * constructed, and before any lifecycle hook or request handler can run.
 *
 * A single call site on purpose. Binding from a lifecycle hook of its own
 * would put the timing at the mercy of module ordering, and the failure that
 * produces - a plugin reading a half-built application - is exactly the one
 * the late binding exists to make impossible.
 *
 * It is also where the actions a plugin declared in its module factory are
 * flushed into the registry, for the same reason: the factory ran before there
 * was a registry to put them in.
 */
@Injectable()
export class PluginHostBinder {
  private readonly logger = new Logger(PluginHostBinder.name);

  constructor(
    private readonly binding: PluginHostBinding,
    private readonly registry: PluginRegistryService,
    private readonly jobs: JobQueueService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
    private readonly addressBook: PluginAddressBookService,
    private readonly actions: ActionRegistryService,
    private readonly callers: ActionCallerFactory,
    private readonly loader: PluginLoaderService,
  ) {}

  bind(): void {
    this.binding.bind({
      registry: this.registry,
      jobs: this.jobs,
      mail: this.mail,
      sms: this.sms,
      addressBook: this.addressBook,
      actions: this.actions,
      callers: this.callers,
    });

    this.flushActions();

    /*
     * Whether a plugin is serving, and which of its actions an administrator
     * has switched on, both read at the moment of the call.
     *
     * A lookup rather than a snapshot, which is what makes disarming bite at
     * once - the same reason dispatch reads `context.serving` on every call
     * rather than capturing it. The floor is computed here so that the registry
     * imports nothing from this directory.
     */
    this.actions.bindLiveness({
      get: async (pluginId: string) => {
        const loaded = this.loader.get(pluginId);
        if (loaded === null) {
          return null;
        }
        const record = await this.registry.find(pluginId);
        if (record === null) {
          return null;
        }
        return {
          serving: loaded.context.serving,
          /*
           * Stored as the ids the board sees on the plugin's screen, and
           * matched by the registry as the public names a caller uses. The
           * composition happens here because it is the same folding the
           * registration used, and doing it in one place is what keeps the two
           * from disagreeing about which action was armed.
           */
          armedActions: record.armedActions.map((actionId) =>
            composedActionName(pluginId, actionId),
          ),
          capabilityFloor: routeCapabilityFloor(record.consentedPermissions),
        };
      },
    });
  }

  /**
   * Registers what each plugin's module factory declared.
   *
   * A refusal here is the plugin's defect rather than the platform's, and it
   * must not stop the instance: the bootstrap's retry loop would rethrow
   * anything escaping this, and `main.ts` has no handler for it. So every
   * refusal is caught, recorded as a finding the board can read, and the
   * plugin stops serving - which is what the contract promises for a plugin
   * that cannot be loaded.
   */
  private flushActions(): void {
    for (const plugin of this.loader.list()) {
      const declared = new Map(
        plugin.manifest.actions.map((action) => [action.id, action]),
      );

      for (const registration of plugin.context.bufferedActions) {
        try {
          const declaration = declared.get(registration.id);
          if (declaration === undefined) {
            throw new Error(
              `"${registration.id}" was registered but the manifest declares no such action.`,
            );
          }

          this.actions.registerFor(
            plugin.id,
            {
              ...registration,
              definition: {
                ...registration.definition,
                name: composedActionName(plugin.id, registration.id),
              },
            },
            {
              capability: declaration.capability,
              effect: declaration.effect,
              personalData: declaration.personalData,
              surfaces: declaration.surfaces,
            },
          );
        } catch (cause) {
          this.refuse(plugin.id, registration.id, cause);
          break;
        }
      }
    }
  }

  private refuse(pluginId: string, actionId: string, cause: unknown): void {
    // The code and the ids, never the message: a refusal composed inside a
    // plugin's bundle is its own words, and the contract says those go to the
    // server log rather than across the wire.
    this.logger.error(
      `Plugin "${pluginId}" declared an action that could not be registered: ` +
        `${actionId} (${failureName(cause)})`,
      failureFrames(cause),
    );
    this.actions.unregisterOwner({ kind: "plugin", pluginId });
    this.loader.refuse(pluginId, "action-refused", { actions: [actionId] });
  }
}
