import { Module } from "@nestjs/common";

import { PluginsModule } from "../plugins/plugins.module";
import { EntitlementsModule } from "./entitlements.module";
import { LicenceAdminService } from "./licence-admin.service";
import { LicencesController } from "./licences.controller";

/**
 * The licence screen and the command-line tool's licences (ADR 0042):
 * entering a licence file, listing and removing what is entered, and
 * checking a file against the keys of the plugins installed since.
 *
 * PluginsModule for the loader, whose installed manifests carry the keys a
 * licence is verified with.
 */
@Module({
  imports: [EntitlementsModule, PluginsModule],
  controllers: [LicencesController],
  providers: [LicenceAdminService],
  exports: [LicenceAdminService],
})
export class LicencesModule {}
