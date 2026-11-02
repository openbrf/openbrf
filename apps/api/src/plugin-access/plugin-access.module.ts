import { Module } from "@nestjs/common";

import { PluginsModule } from "../plugins/plugins.module";
import { PluginAccessController } from "./plugin-access.controller";
import { PluginAccessService } from "./plugin-access.service";

/**
 * Plugin accesses (tilläggsåtkomst, ADR 0053): the board's grant to one person
 * who has never lived here, such as somebody who rents a parking space, to be
 * served by one plugin's resident routes, and its withdrawal.
 *
 * It owns the store and the grant. Whom a resident route then serves is the
 * plugin system's to decide, from this table among others, and ending an
 * access when a residency is recorded is done by the paths that record one,
 * through `endPluginAccesses`.
 *
 * PluginsModule for `PLUGIN_ACCESS_CLASS`, which plugins a grant may name. The
 * database client and the audit log come from global modules.
 */
@Module({
  imports: [PluginsModule],
  controllers: [PluginAccessController],
  providers: [PluginAccessService],
  exports: [PluginAccessService],
})
export class PluginAccessModule {}
