import { Injectable, Logger } from "@nestjs/common";
import {
  composedActionName,
  type PluginBlockDeclaration as ManifestBlock,
  type PluginBlockRegistration,
  pluginBlockType,
} from "@openbrf/plugin-sdk";
import type {
  NamespacedBlockType,
  PluginBlockDeclaration,
} from "@openbrf/shared";

import { ActionCallerFactory } from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { DeliveryReceiptService } from "../delivery-receipts/delivery-receipt.service";
import { DeviceTokenService } from "../devices/device-token.service";
import { FinanceEventsService } from "../finance-events/finance-events.service";
import { JobQueueService } from "../jobs/job-queue.service";
import { EntitlementsService } from "../licences/entitlements.service";
import { failureFrames, failureName } from "../logging/failure";
import { MailService } from "../mail/mail.service";
import { ImportProposalService } from "../import/import-proposal.service";
import { PendingChangeService } from "../pending-changes/pending-change.service";
import {
  type RegisteredSiteBlock,
  SiteBlocksService,
} from "../site/site-blocks.service";
import { SmsService } from "../sms/sms.service";
import { PluginAddressBookService } from "./plugin-address-book.service";
import { PluginFinancesService } from "./plugin-finances.service";
import { PluginHostBinding, routeCapabilityFloor } from "./plugin-host";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRecordsService } from "./plugin-records.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { PluginThemesService } from "./plugin-themes.service";

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
 * was a registry to put them in. So are the render functions of its website
 * blocks, into the website's block registry.
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
    private readonly records: PluginRecordsService,
    private readonly finances: PluginFinancesService,
    private readonly receipts: DeliveryReceiptService,
    private readonly financeEvents: FinanceEventsService,
    private readonly actions: ActionRegistryService,
    private readonly callers: ActionCallerFactory,
    private readonly pendingChanges: PendingChangeService,
    private readonly importProposals: ImportProposalService,
    private readonly loader: PluginLoaderService,
    private readonly siteBlocks: SiteBlocksService,
    private readonly devices: DeviceTokenService,
    private readonly themes: PluginThemesService,
    private readonly entitlements: EntitlementsService,
  ) {}

  bind(): void {
    this.binding.bind({
      registry: this.registry,
      jobs: this.jobs,
      mail: this.mail,
      sms: this.sms,
      addressBook: this.addressBook,
      records: this.records,
      finances: this.finances,
      receipts: this.receipts,
      financeEvents: this.financeEvents,
      actions: this.actions,
      callers: this.callers,
      pendingChanges: this.pendingChanges,
      importProposals: this.importProposals,
      devices: this.devices,
      themes: this.themes,
      entitlements: this.entitlements,
    });

    /*
     * Whether a plugin is serving, read at the moment a fee run or a charge
     * commits: a plugin the board switched off is not sent its events, as it is
     * no longer answered by any other service.
     */
    this.financeEvents.bindServing(
      (pluginId) => this.loader.get(pluginId)?.context.serving === true,
    );

    this.flushActions();
    this.flushBlocks();

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
                /*
                 * In the plugin's own namespace, as the name is. An alias is
                 * a name a caller reaches the action by, and one a plugin
                 * chose freely could claim a core action's name - taken first,
                 * it would stop the core registering its own and the instance
                 * starting at all.
                 */
                deprecatedAliases:
                  registration.definition.deprecatedAliases?.map((alias) =>
                    composedActionName(plugin.id, alias),
                  ),
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

  /**
   * Registers the website blocks each serving plugin declared and gave a
   * render function for.
   *
   * After the actions, so a plugin an action refused is not registered here
   * at all. A render function for a name the manifest does not declare, or a
   * second one for the same name, is the plugin's defect: it is refused as
   * `block-refused` and stops serving, as an action that cannot be registered
   * does. A declared block with no render function is not, because nothing it
   * could do is at stake: it is left out of the registry, so the editor does
   * not offer it and a page that holds one shows nothing in its place.
   */
  private flushBlocks(): void {
    for (const plugin of this.loader.list()) {
      const declared = new Map(
        plugin.manifest.blocks.map((block) => [block.name, block]),
      );
      const renderers = new Map<string, PluginBlockRegistration["render"]>();
      let refused = false;

      for (const registration of plugin.context.bufferedBlocks) {
        const name: unknown = registration.name;
        const render: unknown = registration.render;
        if (
          typeof name !== "string" ||
          !declared.has(name) ||
          renderers.has(name) ||
          typeof render !== "function"
        ) {
          this.refuseBlock(
            plugin.id,
            String(name),
            new Error(
              `"${String(name)}" was registered but the manifest declares no such block, or it was registered twice.`,
            ),
          );
          refused = true;
          break;
        }
        renderers.set(name, (context) =>
          (render as PluginBlockRegistration["render"]).call(
            registration,
            context,
          ),
        );
      }
      if (refused || declared.size === 0) {
        continue;
      }

      const blocks: RegisteredSiteBlock[] = [];
      for (const [name, block] of declared) {
        const render = renderers.get(name);
        if (render === undefined) {
          this.logger.warn(
            `Plugin "${plugin.id}" declares the website block "${name}" and registered no render function for it; it is not offered.`,
          );
          continue;
        }
        blocks.push({ declaration: siteBlock(plugin.id, block), render });
      }

      try {
        this.siteBlocks.registerPlugin(
          plugin.id,
          () => plugin.context.serving,
          blocks,
        );
      } catch (cause) {
        this.refuseBlock(plugin.id, [...declared.keys()].join(", "), cause);
      }
    }
  }

  private refuseBlock(pluginId: string, name: string, cause: unknown): void {
    this.logger.error(
      `Plugin "${pluginId}" registered a website block that could not be registered: ` +
        `${name} (${failureName(cause)})`,
      failureFrames(cause),
    );
    this.loader.refuse(pluginId, "block-refused", { blocks: [name] });
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

/**
 * A block as the manifest declares it, as the website registers it.
 *
 * The type id composed from the plugin's id and the block's name, and the
 * settings form the manifest declares, which the website reads as the fields
 * of the block rather than as the plugin's own settings.
 */
function siteBlock(
  pluginId: string,
  block: ManifestBlock,
): PluginBlockDeclaration {
  return {
    type: pluginBlockType(pluginId, block.name) as NamespacedBlockType,
    pluginId,
    labelKey: block.labelKey,
    icon: block.icon,
    category: block.category,
    fields: block.settingsSchema.fields,
  };
}
