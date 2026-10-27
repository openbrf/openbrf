import { Module } from "@nestjs/common";

import { DataProtectionModule } from "../data-protection/data-protection.module";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import { ActionsModule } from "../actions/actions.module";
import { EntitlementsModule } from "../licences/entitlements.module";
import { ChargesModule } from "../charges/charges.module";
import { DeliveryReceiptsModule } from "../delivery-receipts/delivery-receipts.module";
import { DevicesModule } from "../devices/devices.module";
import { FeesModule } from "../fees/fees.module";
import { FinanceEventsModule } from "../finance-events/finance-events.module";
import { ImportModule } from "../import/import.module";
import { MediaModule } from "../media/media.module";
import { PackagingModule } from "../packaging/packaging.module";
import { PendingChangesModule } from "../pending-changes/pending-changes.module";
import { RegisterCheckModule } from "../register-check/register-check.module";
import { SiteBlocksModule } from "../site/site-blocks.module";
import { ThemesModule } from "../themes/themes.module";
import { PluginAddressBookService } from "./plugin-address-book.service";
import { PluginAuditService } from "./plugin-audit.service";
import { PluginAddressesService } from "./plugin-addresses.service";
import { PluginAdminService } from "./plugin-admin.service";
import { PluginAssetController } from "./plugin-asset.controller";
import { pluginBoot } from "./plugin-boot";
import { PluginBookingsService } from "./plugin-bookings.service";
import { PluginCalendarService } from "./plugin-calendar.service";
import { PluginErrorInterceptor } from "./plugin-error.interceptor";
import { PluginExtensionsService } from "./plugin-extensions.service";
import { PluginFinancesService } from "./plugin-finances.service";
import { PluginHostBinding, pluginHostBinding } from "./plugin-host";
import { PluginHostBinder } from "./plugin-host.binder";
import { PluginI18nController } from "./plugin-i18n.controller";
import { PluginInstallerService } from "./plugin-installer.service";
import { PluginInstanceService } from "./plugin-instance.service";
import { PLUGIN_BOOT, PluginLoaderService } from "./plugin-loader.service";
import { PluginMediaService } from "./plugin-media.service";
import { PluginNewsService } from "./plugin-news.service";
import {
  PluginRecipientsService,
  RECIPIENT_NETWORK,
  recipientNetwork,
} from "./plugin-recipients.service";
import { PluginPersonRecordsService } from "./plugin-person-records.service";
import { PluginRecordsPurgeService } from "./plugin-records-purge.service";
import { PluginRecordsService } from "./plugin-records.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { PluginSettingsService } from "./plugin-settings.service";
import { PluginServingGuard } from "./plugin-serving.guard";
import { PluginThemesService } from "./plugin-themes.service";
import {
  PluginsReadController,
  PluginsWriteController,
  PluginViewsController,
} from "./plugins.controller";
import { RestartCoordinator } from "./restart-coordinator.service";
import { ResidentRouteInterceptor } from "./resident-route.interceptor";

/**
 * The plugin system.
 *
 * Four responsibilities, deliberately in separate services: the registry holds
 * the desired state, the installer reconciles the data volume to it, the
 * loader knows what is running, and the admin service is what the screen and
 * the CLI both drive. Keeping them apart is what makes the flow idempotent -
 * the board's consent is recorded independently of any filesystem work, so a
 * crashed install converges on the next boot rather than needing to be undone.
 *
 * The loading itself is not here. A plugin contributes a NestJS module, and a
 * module has to be in the graph when NestFactory builds it, so the scan and
 * the gates run in plugin-boot.ts before the application exists and hand their
 * result to this module through PLUGIN_BOOT.
 *
 * The global guard and interceptor are the two halves of what the host keeps
 * over a plugin's own controllers once they are ordinary NestJS routes: one
 * stops serving them the moment the board switches the plugin off, the other
 * answers a plugin's own failure as a bad gateway rather than as a fault in
 * the platform. Both ignore every route that is not a plugin's. A second
 * interceptor serves a plugin's resident route inside the scope that narrows
 * its host object there (ADR 0051), and ignores every other route.
 */
@Module({
  // ActionsModule is imported explicitly rather than made global, so that a
  // loaded plugin cannot resolve the registry by type from the root injector.
  // SiteBlocksModule for the same reason: a plugin's website blocks are
  // registered into it, and it is imported where it is needed. So is
  // PendingChangesModule: a plugin proposes through host.actions and must not
  // resolve the service that confirms. MediaModule for the pictures a plugin
  // holding media:read opens, through the host. DevicesModule too: a plugin
  // reaches device tokens through its host object only. And EntitlementsModule:
  // it holds the instance key a licence is presented with. ThemesModule for the
  // theme installer `host.themes` reaches, which no other module is given.
  imports: [
    ActionsModule,
    PendingChangesModule,
    MediaModule,
    PackagingModule,
    DataProtectionModule,
    SiteBlocksModule,
    DevicesModule,
    EntitlementsModule,
    // The finance read, the receipt and the events behind `host.finances`.
    FeesModule,
    ChargesModule,
    DeliveryReceiptsModule,
    FinanceEventsModule,
    ThemesModule,
    // The register check the content services run for a plugin with a
    // device route (ADR 0032).
    RegisterCheckModule,
    // The import proposals behind `host.imports` (ADR 0043).
    ImportModule,
  ],
  controllers: [
    PluginsReadController,
    PluginsWriteController,
    PluginViewsController,
    PluginI18nController,
    PluginAssetController,
  ],
  providers: [
    { provide: PLUGIN_BOOT, useFactory: pluginBoot },
    { provide: PluginHostBinding, useValue: pluginHostBinding },
    PluginRegistryService,
    PluginSettingsService,
    PluginAddressBookService,
    PluginAuditService,
    PluginExtensionsService,
    PluginNewsService,
    PluginCalendarService,
    PluginBookingsService,
    PluginMediaService,
    PluginAddressesService,
    PluginInstanceService,
    PluginRecordsService,
    PluginPersonRecordsService,
    PluginRecordsPurgeService,
    PluginFinancesService,
    PluginRecipientsService,
    { provide: RECIPIENT_NETWORK, useValue: recipientNetwork },
    PluginThemesService,
    PluginHostBinder,
    PluginLoaderService,
    PluginInstallerService,
    PluginAdminService,
    RestartCoordinator,
    PluginServingGuard,
    { provide: APP_GUARD, useExisting: PluginServingGuard },
    PluginErrorInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: PluginErrorInterceptor },
    // Serves a resident route's request in its scope (ADR 0051).
    { provide: APP_INTERCEPTOR, useClass: ResidentRouteInterceptor },
  ],
  exports: [
    PluginAdminService,
    PluginHostBinder,
    PluginLoaderService,
    PluginRegistryService,
    RestartCoordinator,
  ],
})
export class PluginsModule {}
