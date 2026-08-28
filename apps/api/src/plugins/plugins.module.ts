import { Module } from "@nestjs/common";

import { PackagingModule } from "../packaging/packaging.module";
import { PluginAddressBookService } from "./plugin-address-book.service";
import { PluginAdminService } from "./plugin-admin.service";
import { PluginAssetController } from "./plugin-asset.controller";
import { PluginHostFactory } from "./plugin-host.factory";
import { PluginI18nController } from "./plugin-i18n.controller";
import { PluginInstallerService } from "./plugin-installer.service";
import { PluginLoaderService } from "./plugin-loader.service";
import { PluginRegistryService } from "./plugin-registry.service";
import { PluginRouteController } from "./plugin-route.controller";
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
 * loader runs what is there, and the admin service is what the screen and the
 * CLI both drive. Keeping them apart is what makes the flow idempotent - the
 * board's consent is recorded independently of any filesystem work, so a
 * crashed install converges on the next boot rather than needing to be undone.
 */
@Module({
  imports: [PackagingModule],
  controllers: [
    PluginsReadController,
    PluginsWriteController,
    PluginViewsController,
    PluginI18nController,
    PluginAssetController,
    PluginRouteController,
  ],
  providers: [
    PluginRegistryService,
    PluginAddressBookService,
    PluginHostFactory,
    PluginLoaderService,
    PluginInstallerService,
    PluginAdminService,
    RestartCoordinator,
  ],
  exports: [
    PluginAdminService,
    PluginLoaderService,
    PluginRegistryService,
    RestartCoordinator,
  ],
})
export class PluginsModule {}
