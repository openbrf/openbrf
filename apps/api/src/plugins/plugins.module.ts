import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import { PackagingModule } from "../packaging/packaging.module";
import { PluginAddressBookService } from "./plugin-address-book.service";
import { PluginAdminService } from "./plugin-admin.service";
import { PluginAssetController } from "./plugin-asset.controller";
import { pluginBoot } from "./plugin-boot";
import { PluginErrorInterceptor } from "./plugin-error.interceptor";
import { PluginHostBinding, pluginHostBinding } from "./plugin-host";
import { PluginHostBinder } from "./plugin-host.binder";
import { PluginI18nController } from "./plugin-i18n.controller";
import { PluginInstallerService } from "./plugin-installer.service";
import { PLUGIN_BOOT, PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { PluginServingGuard } from "./plugin-serving.guard";
import {
  PluginsReadController,
  PluginsWriteController,
  PluginViewsController,
} from "./plugins.controller";
import { RestartCoordinator } from "./restart-coordinator.service";

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
 * the platform. Both ignore every route that is not a plugin's.
 */
@Module({
  imports: [PackagingModule],
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
    PluginAddressBookService,
    PluginHostBinder,
    PluginLoaderService,
    PluginInstallerService,
    PluginAdminService,
    RestartCoordinator,
    PluginServingGuard,
    { provide: APP_GUARD, useExisting: PluginServingGuard },
    PluginErrorInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: PluginErrorInterceptor },
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
